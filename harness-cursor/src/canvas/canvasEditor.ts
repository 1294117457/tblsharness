import * as vscode from 'vscode';
import type { DiagramRef, DiagramService } from '../diagram/diagramService';
import type { ModelStore, StoreChange } from '../model/store';
import {
  applyCanvasEdit,
  DESIGN_SOURCE,
  DIAGRAM_CARD_SIZE,
  nodeId,
  parseCanvas,
  parseNodeId,
  partitionContents,
  renameTableInCanvas,
  ROOT_SCOPE,
  serializeCanvas,
  type CanvasEdit,
  type CanvasFile,
  type ItemRef,
  type MoveItem,
  type Viewport,
} from '../shared/canvas';
import { ClipboardError, planCopy, planCut, type ClipboardData, type Position } from '../shared/clipboard';
import { copyTableOps, type ConflictStrategy } from '../shared/copyTables';
import { serializeDiagram } from '../shared/diagram';
import { applyDesignOps, DesignOpError, serializeDesign, type DesignOp } from '../shared/designOps';
import type { ClipboardInfo, ComparisonData, DesignContext, DiagramData, ExportRequest, HostMessage, RevealTarget, SourceData, WebviewMessage, WorkspaceCatalog } from '../shared/protocol';
import { SyncError } from '../shared/sync';
import { readTextIfExists, writeText } from '../workspace/fsUtil';
import { renameDesignTable, type OpenCanvasRegistry } from '../workspace/refactor';
import type { HarnessStorage } from '../workspace/storage';
import { renderWebviewHtml, webviewOptions } from '../webview/html';

export const CANVAS_VIEW_TYPE = 'harness.canvas';

/** Files a change already wrote besides schema/ext/layout (diagram copies or deletions), and how to revert them. */
export interface FileEffects {
  undo(): Promise<void>;
  redo(): Promise<void>;
}

/** One user action on a design: design ops, a layout edit and optional file effects, undone as a whole. */
export interface DesignChange {
  label: string;
  ops: DesignOp[];
  edit: CanvasEdit;
  files?: FileEffects;
  /** Deletes were already confirmed by the caller. */
  confirmed?: boolean;
}

export class CanvasDocument implements vscode.CustomDocument {
  private readonly contentEmitter = new vscode.EventEmitter<{ echo: boolean }>();
  readonly onDidChangeContent = this.contentEmitter.event;
  viewports: Record<string, Viewport>;
  private version = 0;
  private savedVersion = 0;

  constructor(
    readonly uri: vscode.Uri,
    public state: CanvasFile,
    readonly workspaceId: string | undefined,
    readonly designId: string | undefined,
  ) {
    this.viewports = rootViewport(state);
  }

  get isDirty(): boolean {
    return this.version !== this.savedVersion;
  }

  setState(next: CanvasFile, echo: boolean): void {
    this.state = next;
    this.contentEmitter.fire({ echo });
  }

  bumpVersion(): void {
    this.version++;
  }

  markSaved(): void {
    this.savedVersion = this.version;
  }

  serialize(): string {
    return serializeCanvas({ ...this.state, viewports: this.viewports });
  }

  dispose(): void {
    this.contentEmitter.dispose();
  }
}

export class CanvasEditorProvider implements vscode.CustomEditorProvider<CanvasDocument>, OpenCanvasRegistry {
  private readonly editEmitter = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<CanvasDocument>>();
  readonly onDidChangeCustomDocument = this.editEmitter.event;
  private readonly documents = new Map<string, CanvasDocument>();
  private readonly sessions = new Map<string, CanvasSession>();
  private readonly layoutEmitter = new vscode.EventEmitter<{ workspace: string; design: string }>();
  /** An open layout changed in memory (possibly unsaved); the tree shows partitions from it. */
  readonly onDidChangeLayout = this.layoutEmitter.event;
  private clipboardData: ClipboardData | undefined;

  constructor(
    readonly context: vscode.ExtensionContext,
    readonly storage: HarnessStorage,
    readonly store: ModelStore,
    readonly diagrams: DiagramService,
  ) {
    context.subscriptions.push(
      store.onDidChange((change) => this.onStoreChange(change)),
      diagrams.onDidChange((ref) => {
        for (const session of this.sessions.values()) session.onDiagramChange(ref);
      }),
      diagrams.onDidCreateTables(({ ref, tables }) => void this.placeNearDiagram(ref, tables).catch(() => undefined)),
    );
  }

  static register(context: vscode.ExtensionContext, storage: HarnessStorage, store: ModelStore, diagrams: DiagramService): CanvasEditorProvider {
    const provider = new CanvasEditorProvider(context, storage, store, diagrams);
    context.subscriptions.push(
      vscode.window.registerCustomEditorProvider(CANVAS_VIEW_TYPE, provider, {
        supportsMultipleEditorsPerDocument: false,
        webviewOptions: { retainContextWhenHidden: true },
      }),
    );
    return provider;
  }

  async openCustomDocument(uri: vscode.Uri, openContext: vscode.CustomDocumentOpenContext): Promise<CanvasDocument> {
    const source = openContext.backupId ? vscode.Uri.parse(openContext.backupId) : uri;
    const text = (await readTextIfExists(source)) ?? '';
    const located = this.storage.locate(uri);
    const inDesign = located?.kind === 'canvas';
    const doc = new CanvasDocument(uri, parseCanvas(text), inDesign ? located.workspace : undefined, inDesign ? located.design : undefined);
    this.documents.set(uri.toString(), doc);
    doc.onDidChangeContent(() => {
      if (doc.workspaceId && doc.designId) this.layoutEmitter.fire({ workspace: doc.workspaceId, design: doc.designId });
    });
    return doc;
  }

  resolveCustomEditor(document: CanvasDocument, panel: vscode.WebviewPanel): void {
    const session = new CanvasSession(this, document, panel);
    this.sessions.set(document.uri.toString(), session);
    panel.onDidDispose(() => {
      this.sessions.delete(document.uri.toString());
      this.documents.delete(document.uri.toString());
      session.dispose();
      if (document.workspaceId && document.designId) this.layoutEmitter.fire({ workspace: document.workspaceId, design: document.designId });
    });
  }

  async saveCustomDocument(document: CanvasDocument): Promise<void> {
    const text = document.serialize();
    this.store.noteOwnWrite(document.uri, text);
    await writeText(document.uri, text);
    document.markSaved();
  }

  async saveCustomDocumentAs(document: CanvasDocument, destination: vscode.Uri): Promise<void> {
    await writeText(destination, document.serialize());
  }

  async revertCustomDocument(document: CanvasDocument): Promise<void> {
    const canvas = parseCanvas((await readTextIfExists(document.uri)) ?? '');
    document.viewports = rootViewport(canvas);
    document.markSaved();
    document.setState(canvas, true);
  }

  async backupCustomDocument(document: CanvasDocument, context: vscode.CustomDocumentBackupContext): Promise<vscode.CustomDocumentBackup> {
    await writeText(context.destination, document.serialize());
    return {
      id: context.destination.toString(),
      delete: () => void vscode.workspace.fs.delete(context.destination).then(undefined, () => undefined),
    };
  }

  recordEdit(document: CanvasDocument, label: string, undo: () => void | Thenable<void>, redo: () => void | Thenable<void>): void {
    document.bumpVersion();
    this.editEmitter.fire({
      document,
      label,
      undo: async () => {
        document.bumpVersion();
        await undo();
      },
      redo: async () => {
        document.bumpVersion();
        await redo();
      },
    });
  }

  transformIfOpen(uri: vscode.Uri, transform: (canvas: CanvasFile) => CanvasFile, skip?: vscode.Uri): boolean {
    if (skip && skip.toString() === uri.toString()) return true;
    const doc = this.documents.get(uri.toString());
    if (!doc) return false;
    const next = transform(doc.state);
    if (next !== doc.state) doc.setState(next, true);
    return doc.isDirty;
  }

  openDocument(uri: vscode.Uri): CanvasDocument | undefined {
    return this.documents.get(uri.toString());
  }

  private layoutUri(workspace: string, design: string): vscode.Uri {
    return this.storage.workspace(workspace).design(design).layoutUri;
  }

  private session(workspace: string, design: string): CanvasSession | undefined {
    return this.sessions.get(this.layoutUri(workspace, design).toString());
  }

  /** The layout as the user sees it: an open editor wins over the file. */
  async layout(workspace: string, design: string): Promise<CanvasFile> {
    return this.documents.get(this.layoutUri(workspace, design).toString())?.state ?? this.storage.workspace(workspace).design(design).readLayout();
  }

  isOpen(workspace: string, design: string): boolean {
    return !!this.session(workspace, design);
  }

  /** Opens the design's single editor tab; with a target, selects it and zooms the canvas to it. */
  async open(workspace: string, design: string, target?: RevealTarget): Promise<void> {
    const uri = await this.storage.workspace(workspace).design(design).ensureLayout();
    await vscode.commands.executeCommand('vscode.openWith', uri, CANVAS_VIEW_TYPE);
    if (target) this.sessions.get(uri.toString())?.reveal(target);
  }

  async revealTable(workspace: string, design: string, source: string, table: string, column?: string): Promise<void> {
    await this.open(workspace, design, { item: { kind: 'table', id: nodeId(source, table) }, column });
  }

  // ── Export ────────────────────────────────────────────────────────

  /** Pushes the inventory to an open canvas webview. False when the design is not open. */
  requestExport(workspace: string, design: string, request: ExportRequest): boolean {
    const session = this.session(workspace, design);
    if (!session) return false;
    session.openExport(request);
    return true;
  }

  /** Sends a path pick result or an export outcome back to the dialog. */
  async postExportResult(requestId: string, result: { path?: string; message?: string; error?: string }): Promise<void> {
    if (!requestId) return;
    for (const session of this.sessions.values()) session.postExportResult(requestId, result);
  }

  /** Applies a design change: through the open editor (undoable) or straight to disk. Returns an error message. */
  async applyChange(workspace: string, design: string, change: DesignChange): Promise<string | undefined> {
    const session = this.session(workspace, design);
    if (session) return session.applyChange(change);
    try {
      const ops = change.ops;
      if (ops.length) {
        const before = await this.store.designDoc(workspace, design);
        const after = applyDesignOps(before, ops);
        await this.store.writeDesignDoc(workspace, design, after);
        for (const op of ops) {
          if (op.op === 'table.rename') await renameDesignTable(this.storage.workspace(workspace).design(design), this, op.from, op.to);
        }
      }
      const removed = ops.filter((o) => o.op === 'table.delete').map((o) => nodeId(DESIGN_SOURCE, (o as { table: string }).table));
      const edit: CanvasEdit = removed.length ? [{ op: 'nodes.remove', ids: removed }, ...change.edit] : change.edit;
      if (edit.length) {
        const d = this.storage.workspace(workspace).design(design);
        const before = await d.readLayout();
        const after = applyCanvasEdit(before, edit);
        if (after !== before) {
          const text = serializeCanvas(after);
          this.store.noteOwnWrite(d.layoutUri, text);
          await writeText(d.layoutUri, text);
        }
      }
      this.store.invalidate({ workspace, kind: 'canvas', id: design, design });
      return undefined;
    } catch (err) {
      return err instanceof DesignOpError ? err.message : `执行失败：${(err as Error).message}`;
    }
  }

  /** Layout-only change; undoable when the editor is open. */
  async editLayout(workspace: string, design: string, label: string, edit: CanvasEdit): Promise<void> {
    const error = await this.applyChange(workspace, design, { label, ops: [], edit });
    if (error) throw new Error(error);
  }

  // ── Clipboard ─────────────────────────────────────────────────────

  get clipboard(): ClipboardData | undefined {
    return this.clipboardData;
  }

  setClipboard(data: ClipboardData | undefined): void {
    this.clipboardData = data?.items.length ? data : undefined;
    void vscode.commands.executeCommand('setContext', 'harness.clipboard', this.clipboardData ? `${this.clipboardData.workspace}/${this.clipboardData.design}` : '');
    for (const session of this.sessions.values()) session.pushClipboard();
  }

  clipboardInfo(workspace: string | undefined, design: string | undefined): ClipboardInfo | undefined {
    const c = this.clipboardData;
    return c && c.workspace === workspace && c.design === design ? { mode: c.mode, count: c.items.length } : undefined;
  }

  /** Pastes the clipboard into a level of the same design. Returns a short summary for the user. */
  async paste(workspace: string, design: string, target: string | undefined, at?: Position, positions?: Record<string, Position>): Promise<string> {
    const clip = this.clipboardData;
    if (!clip) throw new ClipboardError('剪贴板是空的');
    if (clip.workspace !== workspace || clip.design !== design) throw new ClipboardError('目前只能粘贴到同一个设计画布里');
    const message = await this.pasteItems(workspace, design, clip.mode, clip.items, target, at, positions);
    if (clip.mode === 'cut') this.setClipboard(undefined);
    return message;
  }

  /** Copy or move items to a level of the same design (tree drag and drop uses this without the clipboard). */
  async pasteItems(
    workspace: string,
    design: string,
    mode: ClipboardData['mode'],
    items: ItemRef[],
    target: string | undefined,
    at?: Position,
    positions?: Record<string, Position>,
  ): Promise<string> {
    const canvas = await this.layout(workspace, design);
    const schema = (await this.store.source(workspace, 'design', design)).schema;
    if (!schema) throw new ClipboardError('还没有加载设计库');
    const ctx = { canvas, schema, target, at, positions };

    if (mode === 'cut') {
      const probe = planCut(ctx, items, false);
      let rename = false;
      if (probe.renames.length) {
        const list = probe.renames.slice(0, 12).map((r) => `${r.from} → ${r.to}`).join('\n');
        const pick = await vscode.window.showInformationMessage(
          `移动后有 ${probe.renames.length} 张表的命名空间变了，要同时改成目标命名空间的表名吗？`,
          { modal: true, detail: `${list}${probe.renames.length > 12 ? '\n…' : ''}\n\n改名会同时修改 schema.json 中的真实表名。` },
          '改名',
          '保持原名',
        );
        if (!pick) throw new ClipboardError('已取消');
        rename = pick === '改名';
      }
      const plan = rename ? planCut(ctx, items, true) : probe;
      if (!plan.edit.length || (plan.edit[0].op === 'move' && !plan.edit[0].items.length)) return '已经在这个分区画布里了';
      const ops: DesignOp[] = rename ? plan.renames.map((r) => ({ op: 'table.rename', from: r.from, to: r.to })) : [];
      const error = await this.applyChange(workspace, design, { label: '移动', ops, edit: plan.edit });
      if (error) throw new Error(error);
      return rename ? `已移动，并改名 ${plan.renames.length} 张表` : '已移动';
    }

    const dbSchemas: Record<string, NonNullable<typeof schema>> = {};
    for (const source of new Set(items.filter((i) => i.kind === 'table').map((i) => parseNodeId(i.id).source))) {
      if (source === DESIGN_SOURCE) continue;
      const db = (await this.store.source(workspace, 'db', source)).schema;
      if (db) dbSchemas[source] = db;
    }
    const plan = planCopy({ ...ctx, dbSchemas }, items);
    const d = this.storage.workspace(workspace).design(design);
    const created: { id: string; text: string }[] = [];
    for (const copy of plan.diagrams) {
      const file = await this.diagrams.read({ workspace, design, diagram: copy.from });
      const next = {
        ...file,
        meta: { ...file.meta, name: copy.renamed ? `${file.meta.name} 副本` : file.meta.name, refs: file.meta.refs.map((r) => plan.tables.get(r) ?? r), ignored: [] },
      };
      const text = serializeDiagram(next);
      const id = await d.createDiagram(text);
      created.push({ id, text });
      plan.edit.push({ op: 'diagrams.put', diagrams: [{ id, ...copy.placement }] });
    }
    const touch = () => this.store.invalidate({ workspace, kind: 'diagram', id: design });
    const files: FileEffects | undefined = created.length
      ? {
          undo: async () => {
            for (const c of created) await d.removeDiagram(c.id).catch(() => undefined);
            touch();
          },
          redo: async () => {
            for (const c of created) await writeText(d.diagramUri(c.id), c.text);
            touch();
          },
        }
      : undefined;
    if (created.length) touch();
    const error = await this.applyChange(workspace, design, { label: '粘贴', ops: plan.ops, edit: plan.edit, files, confirmed: true });
    if (error) {
      await files?.undo();
      throw new Error(error);
    }
    const parts = [
      plan.partitions.length && `${plan.partitions.length} 个分区画布`,
      plan.tables.size && `${plan.tables.size} 张表`,
      plan.fromDb.size && `${plan.fromDb.size} 张数据库表（已成为设计表）`,
      created.length && `${created.length} 张设计图`,
    ].filter(Boolean);
    const skipped = plan.skippedDb.length ? `；分区里的 ${plan.skippedDb.length} 张数据库表没有复制（数据库表在一个画布里只能出现一次）` : '';
    return `已粘贴 ${parts.join('、') || '便签'}${skipped}`;
  }

  /** Moves items to exact spots on other levels (canvas drag); asks before renaming tables for a new namespace. */
  async moveItems(workspace: string, design: string, moves: MoveItem[]): Promise<string | undefined> {
    if (!moves.length) return undefined;
    const canvas = await this.layout(workspace, design);
    const schema = (await this.store.source(workspace, 'design', design)).schema;
    if (!schema) throw new ClipboardError('还没有加载设计库');
    const targets = new Map<string, MoveItem[]>();
    for (const m of moves) targets.set(m.partition ?? '', [...(targets.get(m.partition ?? '') ?? []), m]);
    const renames: { from: string; to: string }[] = [];
    for (const [target, group] of targets) {
      const designItems = group.filter((m) => m.kind !== 'table' || m.id.startsWith(`${DESIGN_SOURCE}/`));
      if (designItems.length) renames.push(...planCut({ canvas, schema, target: target || undefined, at: { x: 0, y: 0 } }, designItems, false).renames);
    }
    let rename = false;
    if (renames.length) {
      const list = renames.slice(0, 12).map((r) => `${r.from} → ${r.to}`).join('\n');
      const pick = await vscode.window.showInformationMessage(
        `移动后有 ${renames.length} 张表的命名空间变了，要同时改成目标命名空间的表名吗？`,
        { modal: true, detail: `${list}${renames.length > 12 ? '\n…' : ''}\n\n改名会同时修改 schema.json 中的真实表名。` },
        '改名',
        '保持原名',
      );
      if (!pick) throw new ClipboardError('已取消');
      rename = pick === '改名';
    }
    const map = new Map(rename ? renames.map((r) => [nodeId(DESIGN_SOURCE, r.from), nodeId(DESIGN_SOURCE, r.to)]) : []);
    const items = moves.map((m) => (m.kind === 'table' && map.has(m.id) ? { ...m, id: map.get(m.id)! } : m));
    const ops: DesignOp[] = rename ? renames.map((r) => ({ op: 'table.rename', from: r.from, to: r.to })) : [];
    const error = await this.applyChange(workspace, design, { label: '移动到分区画布', ops, edit: [{ op: 'move', items }] });
    if (error) throw new Error(error);
    return rename ? `已移动，并改名 ${renames.length} 张表` : undefined;
  }

  // ── Partitions ────────────────────────────────────────────────────

  /** Deletes a partition with everything inside it, after a modal listing the impact. */
  async deletePartition(workspace: string, design: string, id: string): Promise<void> {
    const canvas = await this.layout(workspace, design);
    const partition = canvas.partitions.find((p) => p.id === id);
    if (!partition) throw new Error('分区画布不存在');
    const contents = partitionContents(canvas, id);
    const schema = (await this.store.source(workspace, 'design', design)).schema;
    const known = new Set((schema?.tables ?? []).map((t) => t.key));
    const tables = contents.designTables.filter((t) => known.has(t));
    const inside = new Set(tables);
    const cross = (schema?.relations ?? []).filter((r) => inside.has(r.from.table) !== inside.has(r.to.table));
    const diagramNames = await Promise.all(contents.diagrams.map(async (dg) => (await this.diagrams.read({ workspace, design, diagram: dg })).meta.name));

    const lines: string[] = [];
    if (contents.partitions.length > 1) lines.push(`子分区画布 ${contents.partitions.length - 1} 个`);
    if (tables.length) lines.push(`设计表 ${tables.length} 张（从表结构中删除）：${preview(tables)}`);
    if (diagramNames.length) lines.push(`设计图 ${diagramNames.length} 张（删除文件）：${preview(diagramNames)}`);
    if (contents.dbNodes.length) lines.push(`数据库表 ${contents.dbNodes.length} 张（只从画布移除）`);
    if (contents.notes) lines.push(`便签 ${contents.notes} 个`);
    if (cross.length) lines.push(`跨分区的关系 ${cross.length} 条会一起删除：${preview(cross.map((r) => `${r.from.table} → ${r.to.table}`))}`);
    const undoable = this.isOpen(workspace, design);
    lines.push('', undoable ? '可以在画布中按 Ctrl+Z 撤销。' : '画布没有打开，删除后不能撤销。');
    const ok = await vscode.window.showWarningMessage(`确定删除分区画布"${partition.name}"及其中的全部内容吗？`, { modal: true, detail: lines.join('\n') }, '删除');
    if (ok !== '删除') throw new ClipboardError('已取消');

    const d = this.storage.workspace(workspace).design(design);
    const saved: { id: string; text: string }[] = [];
    for (const dg of contents.diagrams) {
      const text = await readTextIfExists(d.diagramUri(dg));
      if (text === undefined) continue;
      saved.push({ id: dg, text });
      await closeTab(d.diagramUri(dg));
      await d.removeDiagram(dg);
    }
    const touch = () => this.store.invalidate({ workspace, kind: 'diagram', id: design });
    const files: FileEffects | undefined = saved.length
      ? {
          undo: async () => {
            for (const s of saved) await writeText(d.diagramUri(s.id), s.text);
            touch();
          },
          redo: async () => {
            for (const s of saved) await d.removeDiagram(s.id).catch(() => undefined);
            touch();
          },
        }
      : undefined;
    if (saved.length) touch();
    const error = await this.applyChange(workspace, design, {
      label: `删除分区画布 ${partition.name}`,
      ops: tables.map((t) => ({ op: 'table.delete', table: t })),
      edit: [{ op: 'partition.remove', id }],
      files,
      confirmed: true,
    });
    if (error) {
      await files?.undo();
      throw new Error(error);
    }
  }

  /** Puts a new diagram's card on a level: at `at`, or below what is already there. */
  async placeDiagram(workspace: string, design: string, diagram: string, partition: string | undefined, at?: Position): Promise<void> {
    const canvas = await this.layout(workspace, design);
    let pos = at;
    if (!pos) {
      const bottoms = [
        ...canvas.diagrams.filter((d) => d.partition === partition).map((d) => d.y + d.height),
        ...canvas.nodes.filter((n) => n.partition === partition).map((n) => n.y + 200),
        ...canvas.partitions.filter((p) => p.parent === partition).map((p) => p.y + 300),
      ];
      pos = { x: 0, y: bottoms.length ? Math.max(...bottoms) + 60 : 0 };
    }
    await this.editLayout(workspace, design, '新建设计图', [
      { op: 'diagrams.put', diagrams: [{ id: diagram, x: pos.x, y: pos.y, ...DIAGRAM_CARD_SIZE, partition }] },
    ]);
  }

  /** Deletes a diagram file and its card; undoable when the editor is open. */
  async deleteDiagram(workspace: string, design: string, id: string): Promise<void> {
    const d = this.storage.workspace(workspace).design(design);
    const uri = d.diagramUri(id);
    const text = await readTextIfExists(uri);
    await closeTab(uri);
    if (text !== undefined) await d.removeDiagram(id);
    const touch = () => this.store.invalidate({ workspace, kind: 'diagram', id: design, diagram: id });
    touch();
    const files: FileEffects | undefined =
      text === undefined
        ? undefined
        : {
            undo: async () => {
              await writeText(uri, text);
              touch();
            },
            redo: async () => {
              await d.removeDiagram(id).catch(() => undefined);
              touch();
            },
          };
    const error = await this.applyChange(workspace, design, { label: '删除设计图', ops: [], edit: [{ op: 'diagrams.remove', ids: [id] }], files, confirmed: true });
    if (error) throw new Error(error);
  }

  /** New tables from an ER sync go to the level of that ER diagram, next to its card. */
  async placeNearDiagram(ref: DiagramRef, tables: string[]): Promise<void> {
    const edit = placeNear(await this.layout(ref.workspace, ref.design), ref.diagram, tables);
    if (edit.length) await this.editLayout(ref.workspace, ref.design, '放置同步的表', edit);
  }

  private onStoreChange(change: StoreChange): void {
    if (change.kind === 'canvas' && change.workspace && change.design) {
      const doc = this.documents.get(this.layoutUri(change.workspace, change.design).toString());
      if (doc && !doc.isDirty) void this.revertCustomDocument(doc).catch(() => undefined);
    }
    for (const session of this.sessions.values()) session.onStoreChange(change);
  }
}

/** The canvas is one surface now; per-level viewports from older files are dropped. */
function rootViewport(canvas: CanvasFile): Record<string, Viewport> {
  const root = canvas.viewports?.[ROOT_SCOPE];
  return root ? { [ROOT_SCOPE]: root } : {};
}

function preview(names: string[]): string {
  return names.length > 8 ? `${names.slice(0, 8).join('、')} 等` : names.join('、');
}

async function closeTab(uri: vscode.Uri): Promise<void> {
  const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => (t.input as { uri?: vscode.Uri } | undefined)?.uri?.toString() === uri.toString());
  if (tabs.length) await vscode.window.tabGroups.close(tabs);
}

export function placeNear(canvas: CanvasFile, diagram: string, tables: string[]): CanvasEdit {
  const fresh = tables.filter((t) => !canvas.nodes.some((n) => n.source === DESIGN_SOURCE && n.table === t));
  if (!fresh.length) return [];
  const card = canvas.diagrams.find((d) => d.id === diagram);
  const x = card ? card.x + card.width + 60 : 0;
  const y = card ? card.y : 0;
  return [{ op: 'nodes.put', nodes: fresh.map((table, i) => ({ source: DESIGN_SOURCE, table, x: x + (i % 3) * 300, y: y + Math.floor(i / 3) * 220, partition: card?.partition })) }];
}

class CanvasSession implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private ready = false;
  private pendingReveal: RevealTarget | undefined;
  private sentSources = new Set<string>();
  private sentComparison = '';
  private sentDiagrams = '';
  /** Inventory for the export dialog, held until the webview says it is ready. */
  private exportRequest: ExportRequest | undefined;
  level: string | undefined;

  constructor(
    private readonly provider: CanvasEditorProvider,
    private readonly document: CanvasDocument,
    private readonly panel: vscode.WebviewPanel,
  ) {
    panel.webview.options = webviewOptions(provider.context);
    panel.webview.html = renderWebviewHtml({ webview: panel.webview, context: provider.context, title: '设计画布' });
    panel.iconPath = vscode.Uri.joinPath(provider.context.extensionUri, 'media', 'harness.svg');
    this.disposables.push(
      panel.webview.onDidReceiveMessage((msg: WebviewMessage) => void this.onMessage(msg)),
      document.onDidChangeContent(({ echo }) => void this.afterCanvasChange(echo)),
    );
    void this.updateTitle();
  }

  private get store(): ModelStore {
    return this.provider.store;
  }

  private get workspaceId(): string | undefined {
    return this.document.workspaceId;
  }

  private get designId(): string | undefined {
    return this.document.designId;
  }

  private async updateTitle(): Promise<void> {
    if (!this.workspaceId || !this.designId) return;
    const meta = await this.provider.storage.workspace(this.workspaceId).design(this.designId).readMeta().catch(() => undefined);
    if (meta) this.panel.title = meta.name;
  }

  reveal(target: RevealTarget): void {
    if (this.ready) this.post({ type: 'reveal', target });
    else this.pendingReveal = target;
  }

  pushClipboard(): void {
    if (this.ready) this.post({ type: 'clipboard', clipboard: this.provider.clipboardInfo(this.workspaceId, this.designId) });
  }

  // ── Export dialog ─────────────────────────────────────────────────

  /** The dialog is opened by a command; opening before `ready` would drop the payload. */
  openExport(request: ExportRequest): void {
    this.exportRequest = request;
    if (this.ready) this.post({ type: 'export/items', request });
  }

  postExportResult(requestId: string, result: { path?: string; message?: string; error?: string }): void {
    void requestId;
    this.post({ type: 'export/result', ...result });
  }

  onDiagramChange(ref: DiagramRef): void {
    if (ref.workspace !== this.workspaceId || ref.design !== this.designId) return;
    this.schedulePending();
  }

  private pendingTimer: NodeJS.Timeout | undefined;
  private sentPending = '';

  private schedulePending(): void {
    clearTimeout(this.pendingTimer);
    this.pendingTimer = setTimeout(() => void this.pushPending(), 300);
  }

  /** Pending ER syncs feed both the 待同步 panel and the badges on the diagram cards. */
  private async pushPending(): Promise<void> {
    if (!this.ready || !this.workspaceId || !this.designId) return;
    const groups = await this.provider.diagrams.pending(this.workspaceId, this.designId);
    const signature = JSON.stringify(groups);
    if (signature !== this.sentPending) {
      this.sentPending = signature;
      this.post({ type: 'pendingSync', groups });
    }
    await this.pushDiagrams(groups);
  }

  private async loadDiagrams(groups?: { diagram: string; result: { items: unknown[] } }[]): Promise<DiagramData[]> {
    if (!this.workspaceId || !this.designId) return [];
    const pending = new Map((groups ?? []).map((g) => [g.diagram, g.result.items.length]));
    const list = await this.provider.diagrams.list(this.workspaceId, this.designId);
    return list.map(({ id, file }) => ({
      id,
      name: file.meta.name,
      type: file.meta.type,
      code: file.code,
      description: file.meta.description,
      pending: pending.get(id) || undefined,
    }));
  }

  private async pushDiagrams(groups?: { diagram: string; result: { items: unknown[] } }[]): Promise<void> {
    const diagrams = await this.loadDiagrams(groups);
    const signature = JSON.stringify(diagrams);
    if (signature === this.sentDiagrams) return;
    this.sentDiagrams = signature;
    this.post({ type: 'diagrams', diagrams });
  }

  onStoreChange(change: StoreChange): void {
    if (!this.ready || !this.workspaceId || (change.workspace && change.workspace !== this.workspaceId)) return;
    if (change.kind === 'canvas') return;
    if (change.kind === 'diagram') {
      if (change.design === this.designId || change.id === this.designId) this.schedulePending();
      return;
    }
    if (change.kind === 'design' && change.id === this.designId) {
      this.schedulePending();
      this.sentSources.delete(DESIGN_SOURCE);
      void this.pushSources().then(() => this.pushComparison(true));
      void this.pushDesignContext();
      void this.updateTitle();
      return;
    }
    if (change.kind === 'db' || change.kind === 'workspace' || change.kind === undefined) {
      void this.pushCatalog();
      if (change.kind === 'db' && change.id) this.sentSources.delete(change.id);
      else this.sentSources.clear();
      void this.pushSources().then(() => this.pushComparison(true));
    }
    if (change.kind === 'comparisons') void this.pushComparison(true);
  }

  private post(msg: HostMessage): void {
    void this.panel.webview.postMessage(msg);
  }

  private reply(requestId: string, error?: string, message?: string): boolean {
    this.post({ type: 'reply', requestId, ok: !error, error, message });
    return !error;
  }

  private async onMessage(msg: WebviewMessage): Promise<void> {
    try {
      switch (msg.type) {
        case 'ready':
          this.ready = true;
          await this.sendInit();
          if (this.pendingReveal) {
            this.post({ type: 'reveal', target: this.pendingReveal });
            this.pendingReveal = undefined;
          }
          // A command may have asked for the dialog before the webview existed.
          if (this.exportRequest) this.post({ type: 'export/items', request: this.exportRequest });
          this.sentPending = '';
          await this.pushPending();
          return;
        case 'level':
          this.level = msg.level;
          return;
        case 'export/open':
          return await vscode.commands.executeCommand('harness.export.open', {
            kind: 'design',
            workspace: this.workspaceId,
            design: this.designId,
          });        case 'export/pickPath':
          return await vscode.commands.executeCommand('harness.export.pickPath', { requestId: msg.requestId });
        case 'export/run':
          // The webview only sends keys; the host resolves them against its own inventory.
          return await vscode.commands.executeCommand('harness.export.run', { requestId: msg.requestId, keys: msg.keys, path: msg.path });
        case 'sync/apply': {
          const ref: DiagramRef = { workspace: this.workspaceId ?? '', design: this.designId ?? '', diagram: msg.diagram };
          return await this.applySync(msg.requestId, ref, msg.ids, msg.choices);
        }
        case 'sync/ignore': {
          const ref: DiagramRef = { workspace: this.workspaceId ?? '', design: this.designId ?? '', diagram: msg.diagram };
          await this.provider.diagrams.ignore(ref, msg.ids, msg.clear);
          this.reply(msg.requestId);
          this.schedulePending();
          return;
        }
        case 'diagram/openInTab':
          await vscode.commands.executeCommand('harness.diagram.openInTab', this.diagramArg(msg.diagram));
          return;
        case 'diagram/copyForAI':
          await vscode.commands.executeCommand('harness.diagram.copyForAI', this.diagramArg(msg.diagram));
          return;
        case 'diagram/code':
          return await this.writeDiagram(msg.diagram, (f) => (f.code === msg.code ? f : { ...f, code: msg.code }));
        case 'diagram/meta':
          return await this.writeDiagram(msg.diagram, (f) => {
            const meta = { ...f.meta };
            const name = msg.name?.trim();
            if (name) meta.name = name;
            if (msg.description !== undefined) meta.description = msg.description.trim() || undefined;
            return JSON.stringify(meta) === JSON.stringify(f.meta) ? f : { ...f, meta };
          });
        case 'diagram/create':
          await vscode.commands.executeCommand('harness.diagram.create', {
            kind: 'design',
            workspace: this.workspaceId,
            id: this.designId,
            type: msg.diagramType,
            partition: msg.partition,
            at: msg.at,
          });
          return;
        case 'diagram/delete':
          await vscode.commands.executeCommand('harness.diagram.delete', { kind: 'diagram', workspace: this.workspaceId, design: this.designId, id: msg.diagram });
          this.reply(msg.requestId);
          return;
        case 'canvas/edit':
          return this.applyCanvasEdit(msg.label, msg.edit);
        case 'design/op':
          this.reply(msg.requestId, await this.applyChange({ label: msg.label, ops: msg.ops, edit: msg.canvasEdit ?? [] }));
          return;
        case 'diff/accept':
          return await this.acceptDiff(msg.requestId, msg.id, msg.accepted);
        case 'viewport':
          this.document.viewports = { [ROOT_SCOPE]: msg.viewport };
          return;
        case 'db/sync':
          if (msg.source !== DESIGN_SOURCE) await vscode.commands.executeCommand('harness.db.sync', { workspace: this.workspaceId, id: msg.source });
          return;
        case 'openRaw':
          return await this.openRaw(msg.source);
        case 'source/add':
          return await this.addDbSource(msg.requestId, msg.dbId);
        case 'source/remove':
          return await this.removeDbSource(msg.requestId, msg.dbId);
        case 'design/rename':
          return await this.renameDesign(msg.requestId, msg.name);
        case 'table/copyToDesign':
          return await this.copyTablesToDesign(msg.requestId, msg.source, msg.tables, msg.partition, msg.at);
        case 'clipboard/set':
          if (this.workspaceId && this.designId) this.provider.setClipboard({ workspace: this.workspaceId, design: this.designId, mode: msg.mode, items: msg.items });
          return;
        case 'clipboard/paste':
          return await this.guarded(msg.requestId, () => this.provider.paste(this.workspaceId ?? '', this.designId ?? '', msg.partition, msg.at, msg.positions));
        case 'partition/delete':
          return await this.guarded(msg.requestId, async () => {
            await this.provider.deletePartition(this.workspaceId ?? '', this.designId ?? '', msg.id);
            return undefined;
          });
        case 'partition/namespace':
          await vscode.commands.executeCommand('harness.partition.setNamespace', { kind: 'partition', workspace: this.workspaceId, design: this.designId, id: msg.id });
          return;
        case 'items/move':
          return await this.guarded(msg.requestId, () => this.provider.moveItems(this.workspaceId ?? '', this.designId ?? '', msg.items));
      }
    } catch (err) {
      vscode.window.showErrorMessage(`Harness：${(err as Error).message}`);
    }
  }

  private diagramWrites: Promise<void> = Promise.resolve();

  /** Side-panel edits are written one after another so fast typing cannot interleave read-modify-write cycles. */
  private writeDiagram(diagram: string, fn: Parameters<DiagramService['modify']>[1]): Promise<void> {
    const run = this.diagramWrites.then(() => this.provider.diagrams.modify(this.diagramRef(diagram), fn));
    this.diagramWrites = run.catch(() => undefined);
    return run;
  }

  private diagramRef(diagram: string): DiagramRef {
    return { workspace: this.workspaceId ?? '', design: this.designId ?? '', diagram };
  }

  private diagramArg(diagram: string) {
    return { kind: 'diagram', workspace: this.workspaceId, design: this.designId, id: diagram };
  }

  private async guarded(requestId: string, run: () => Promise<string | undefined>): Promise<void> {
    try {
      const message = await run();
      this.reply(requestId, undefined, message);
    } catch (err) {
      this.reply(requestId, (err as Error).message);
    }
  }

  private async sendInit(): Promise<void> {
    this.sentSources.clear();
    this.sentComparison = '';
    this.sentDiagrams = '';
    if (!this.workspaceId || !this.designId) {
      this.post({
        type: 'init',
        canvas: this.document.state,
        design: { workspace: '', design: '', name: '?' },
        sources: [],
        diagrams: [],
        error: '这个文件不在 Harness 的设计画布目录中，无法读取数据源。',
      });
      return;
    }
    const sources = await this.loadAllSources();
    for (const s of sources) this.sentSources.add(s.source);
    const comparison = await this.computeComparison();
    this.sentComparison = comparisonSignature(this.document.state);
    const diagrams = await this.loadDiagrams();
    this.sentDiagrams = JSON.stringify(diagrams);
    this.post({
      type: 'init',
      canvas: this.document.state,
      design: await this.buildDesignContext(),
      sources,
      diagrams,
      catalog: await this.catalog(),
      comparison,
      clipboard: this.provider.clipboardInfo(this.workspaceId, this.designId),
    });
  }

  private async loadAllSources(): Promise<SourceData[]> {
    if (!this.workspaceId || !this.designId) return [];
    const result: SourceData[] = [];
    const designData = await this.store.source(this.workspaceId, 'design', this.designId);
    result.push({ source: DESIGN_SOURCE, name: designData.name, schema: designData.schema, error: designData.error });
    const meta = await this.provider.storage.workspace(this.workspaceId).design(this.designId).readMeta();
    for (const dbId of meta.sources ?? []) {
      const dbData = await this.store.source(this.workspaceId, 'db', dbId);
      result.push({ source: dbId, name: dbData.name, schema: dbData.schema, snapshot: dbData.snapshot, error: dbData.error });
    }
    return result;
  }

  private async pushSources(): Promise<void> {
    if (!this.workspaceId || !this.designId) return;
    for (const s of await this.loadAllSources()) {
      if (this.sentSources.has(s.source)) continue;
      this.sentSources.add(s.source);
      this.post({ type: 'source', source: s });
    }
  }

  private async pushComparison(force: boolean): Promise<void> {
    const signature = comparisonSignature(this.document.state);
    if (!force && signature === this.sentComparison) return;
    this.sentComparison = signature;
    this.post({ type: 'comparison', comparison: await this.computeComparison() });
  }

  private async pushCatalog(): Promise<void> {
    const catalog = await this.catalog();
    if (catalog) this.post({ type: 'catalog', catalog });
  }

  private async pushDesignContext(): Promise<void> {
    if (!this.workspaceId || !this.designId) return;
    this.post({ type: 'design', design: await this.buildDesignContext() });
  }

  private async buildDesignContext(): Promise<DesignContext> {
    if (!this.workspaceId || !this.designId) return { workspace: '', design: '', name: '?' };
    const meta = await this.provider.storage.workspace(this.workspaceId).design(this.designId).readMeta();
    const designSchema = await this.store.source(this.workspaceId, 'design', this.designId);
    return { workspace: this.workspaceId, design: this.designId, name: meta.name, driver: designSchema.schema?.driver?.name };
  }

  private async computeComparison(): Promise<ComparisonData | undefined> {
    const c = this.document.state.comparison;
    if (!c || !this.workspaceId || !this.designId) return undefined;
    return this.store.comparison(this.workspaceId, this.designId, c.db);
  }

  private async catalog(): Promise<WorkspaceCatalog | undefined> {
    return this.workspaceId ? buildCatalog(this.provider.storage, this.store, this.workspaceId) : undefined;
  }

  private async afterCanvasChange(echo: boolean): Promise<void> {
    if (!this.ready) return;
    if (echo) this.post({ type: 'canvas', canvas: this.document.state });
    await this.pushSources();
    await this.pushComparison(false);
  }

  private applyCanvasEdit(label: string, edit: CanvasEdit): void {
    const before = this.document.state;
    const after = applyCanvasEdit(before, edit);
    if (after === before) return;
    this.document.setState(after, false);
    this.provider.recordEdit(
      this.document,
      label,
      () => this.document.setState(before, true),
      () => this.document.setState(after, true),
    );
  }

  private async applySync(requestId: string, ref: DiagramRef, ids: string[], choices: Record<string, string>): Promise<void> {
    if (!this.workspaceId || !this.designId) {
      this.reply(requestId, '画布没有关联到设计画布');
      return;
    }
    const diagrams = this.provider.diagrams;
    let prepared;
    try {
      diagrams.assertNotDirty(ref.workspace, ref.design);
      prepared = await diagrams.prepare(ref, { ids, choices });
      const meta = await this.provider.storage.workspace(ref.workspace).design(ref.design).readMeta();
      if (!(await diagrams.confirmDeletes(prepared.ops, meta.name))) throw new SyncError('已取消');
    } catch (err) {
      this.reply(requestId, (err as Error).message);
      return;
    }
    const created = prepared.ops.filter((o) => o.op === 'table.add').map((o) => (o as { table: string }).table);
    const edit = placeNear(this.document.state, ref.diagram, created);
    const error = await this.applyChange({ label: prepared.label, ops: prepared.ops, edit, confirmed: true });
    this.reply(requestId, error);
    if (!error) await diagrams.setRefs(ref, prepared.refs).catch(() => undefined);
  }

  /** Design ops + layout edit + file effects as one undo step. Returns an error message. */
  async applyChange(change: DesignChange): Promise<string | undefined> {
    const workspaceId = this.workspaceId;
    const designId = this.designId;
    if (!workspaceId || !designId) return '画布没有关联到设计画布';
    const { label, ops, files } = change;

    if (!ops.length) {
      const before = this.document.state;
      const after = applyCanvasEdit(before, change.edit);
      if (after === before && !files) return undefined;
      this.document.setState(after, true);
      this.provider.recordEdit(
        this.document,
        label,
        async () => {
          this.document.setState(before, true);
          await files?.undo();
        },
        async () => {
          await files?.redo();
          this.document.setState(after, true);
        },
      );
      return undefined;
    }

    const design = this.provider.storage.workspace(workspaceId).design(designId);
    const dirty = vscode.workspace.textDocuments.find(
      (d) => d.isDirty && (d.uri.toString() === design.schemaFile.toString() || d.uri.toString() === design.extFile.toString()),
    );
    if (dirty) return `请先保存或放弃 ${dirty.uri.fsPath.split(/[\\/]/).pop()} 中未保存的修改`;

    const deletes = ops.filter((o): o is Extract<DesignOp, { op: 'table.delete' }> => o.op === 'table.delete');
    if (deletes.length && !change.confirmed) {
      const meta = await design.readMeta();
      const ok = await vscode.window.showWarningMessage(
        `确定从设计画布"${meta.name}"中删除表 ${deletes.map((d) => d.table).join('、')} 吗？`,
        { modal: true, detail: '涉及这些表的关系也会一起删除。可以用撤销恢复。' },
        '删除',
      );
      if (!ok) return '已取消';
    }

    let before;
    let after;
    try {
      before = await this.store.designDoc(workspaceId, designId);
      after = applyDesignOps(before, ops);
    } catch (err) {
      return err instanceof DesignOpError ? err.message : `执行失败：${(err as Error).message}`;
    }
    const renames = ops.filter((o): o is Extract<DesignOp, { op: 'table.rename' }> => o.op === 'table.rename');
    const canvasBefore = this.document.state;
    let canvasAfter = canvasBefore;
    for (const r of renames) canvasAfter = renameTableInCanvas(canvasAfter, r.from, r.to);
    const removed = deletes.map((d) => nodeId(DESIGN_SOURCE, d.table));
    if (removed.length) canvasAfter = applyCanvasEdit(canvasAfter, [{ op: 'nodes.remove', ids: removed }]);
    canvasAfter = applyCanvasEdit(canvasAfter, change.edit);

    const self = this.document.uri;
    const registry: OpenCanvasRegistry = { transformIfOpen: (uri, fn) => this.provider.transformIfOpen(uri, fn, self) };
    const text = (d: typeof before) => {
      const s = serializeDesign(d);
      return s.schema + s.ext;
    };
    const afterText = text(after);
    const beforeText = text(before);
    const renameAll = async (forward: boolean) => {
      for (const r of forward ? renames : [...renames].reverse()) {
        await renameDesignTable(design, registry, forward ? r.from : r.to, forward ? r.to : r.from);
      }
    };
    const guard = async (expected: string, run: () => Promise<void>) => {
      if (text(await this.store.designDoc(workspaceId, designId)) !== expected) {
        vscode.window.showWarningMessage(`Harness：设计画布在这次修改之后又被改动过，无法撤销或重做"${label}"。`);
        return;
      }
      await run();
    };

    await this.store.writeDesignDoc(workspaceId, designId, after);
    await renameAll(true);
    if (canvasAfter !== canvasBefore) this.document.setState(canvasAfter, true);
    this.provider.recordEdit(
      this.document,
      label,
      () =>
        guard(afterText, async () => {
          await this.store.writeDesignDoc(workspaceId, designId, before);
          await renameAll(false);
          this.document.setState(canvasBefore, true);
          await files?.undo();
        }),
      () =>
        guard(beforeText, async () => {
          await files?.redo();
          await this.store.writeDesignDoc(workspaceId, designId, after);
          await renameAll(true);
          this.document.setState(canvasAfter, true);
        }),
    );
    return undefined;
  }

  private async acceptDiff(requestId: string, id: string, accepted: boolean): Promise<void> {
    const c = this.document.state.comparison;
    if (!this.workspaceId || !this.designId || !c) {
      this.reply(requestId, '画布没有开启对比');
      return;
    }
    const design = this.provider.storage.workspace(this.workspaceId).design(this.designId);
    const entry = await design.comparisonEntry(c.db);
    const set = new Set(entry.acceptedDiffs ?? []);
    if (accepted) set.add(id);
    else set.delete(id);
    await design.writeComparisonEntry(c.db, { ...entry, acceptedDiffs: [...set].sort() });
    this.store.invalidate({ workspace: this.workspaceId, kind: 'comparisons' });
    this.reply(requestId);
  }

  private async renameDesign(requestId: string, name: string): Promise<void> {
    const trimmed = name.trim();
    if (!this.workspaceId || !this.designId || !trimmed) return;
    const design = this.provider.storage.workspace(this.workspaceId).design(this.designId);
    const meta = await design.readMeta();
    if (meta.name !== trimmed) {
      await design.writeMeta({ ...meta, name: trimmed });
      this.store.invalidate({ workspace: this.workspaceId, kind: 'design', id: this.designId });
    }
    this.reply(requestId);
  }

  private async addDbSource(requestId: string, dbId: string): Promise<void> {
    if (!this.workspaceId || !this.designId) return;
    const design = this.provider.storage.workspace(this.workspaceId).design(this.designId);
    const meta = await design.readMeta();
    const sources = new Set(meta.sources ?? []);
    if (!sources.has(dbId)) {
      sources.add(dbId);
      await design.writeMeta({ ...meta, sources: [...sources] });
      this.store.invalidate({ workspace: this.workspaceId, kind: 'design', id: this.designId });
      this.sentSources.delete(dbId);
      await this.pushSources();
    }
    this.reply(requestId);
  }

  private async removeDbSource(requestId: string, dbId: string): Promise<void> {
    if (!this.workspaceId || !this.designId) return;
    const design = this.provider.storage.workspace(this.workspaceId).design(this.designId);
    const meta = await design.readMeta();
    await design.writeMeta({ ...meta, sources: (meta.sources ?? []).filter((s) => s !== dbId) });
    this.store.invalidate({ workspace: this.workspaceId, kind: 'design', id: this.designId });
    this.sentSources.delete(dbId);
    this.reply(requestId);
  }

  /** New design tables land at the level of the database table they came from. */
  private async copyTablesToDesign(requestId: string, source: string, tables: string[], partition?: string, at?: Position): Promise<void> {
    if (!this.workspaceId || !this.designId) {
      this.reply(requestId, '画布没有关联到设计画布');
      return;
    }
    const db = this.provider.storage.workspace(this.workspaceId).db(source);
    const snapshotFile = await db.latestSnapshot();
    if (!snapshotFile) {
      this.reply(requestId, '数据库快照不可用');
      return;
    }
    const snapshot = await db.readSnapshot(snapshotFile);
    const nameSet = new Set(tables);
    const srcTables = snapshot.tables.filter((t) => nameSet.has(t.name));
    if (!srcTables.length) {
      this.reply(requestId);
      return;
    }

    const designData = await this.store.source(this.workspaceId, 'design', this.designId);
    const existingTables = (designData.schema?.tables ?? []).map((t) => t.key);
    let onConflict: ConflictStrategy = 'skip';
    if (srcTables.some((t) => existingTables.includes(t.name))) {
      const pick = await vscode.window.showWarningMessage(
        '部分表名在设计中已存在',
        { modal: true, detail: '可以跳过已存在的表，或者自动改名后添加。' },
        '跳过已存在的',
        '自动改名',
      );
      if (!pick) {
        this.reply(requestId, '已取消');
        return;
      }
      onConflict = pick === '自动改名' ? 'rename' : 'skip';
    }

    const result = copyTableOps(srcTables, snapshot.relations ?? [], { existingTables, onConflict });
    if (!result.ops.length) {
      this.reply(requestId);
      return;
    }
    const level = this.document.state.nodes.filter((n) => n.partition === partition);
    const origin = at ?? { x: level.length ? Math.max(...level.map((n) => n.x)) + 300 : 0, y: 0 };
    const edit: CanvasEdit = result.copied.length
      ? [{ op: 'nodes.put', nodes: result.copied.map((table, i) => ({ source: DESIGN_SOURCE, table, x: origin.x, y: origin.y + i * 160, partition })) }]
      : [];
    this.reply(requestId, await this.applyChange({ label: '复制数据库表到设计', ops: result.ops, edit }));
  }

  private async openRaw(source: string): Promise<void> {
    if (!this.workspaceId || !this.designId) return;
    const ws = this.provider.storage.workspace(this.workspaceId);
    let uri: vscode.Uri | undefined;
    if (source === DESIGN_SOURCE) {
      uri = ws.design(this.designId).schemaFile;
    } else {
      const db = ws.db(source);
      const file = await db.latestSnapshot();
      uri = file ? db.snapshotUri(file) : undefined;
    }
    if (uri) await vscode.window.showTextDocument(uri, { viewColumn: vscode.ViewColumn.Beside, preview: true });
  }

  dispose(): void {
    clearTimeout(this.pendingTimer);
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }
}

function comparisonSignature(canvas: CanvasFile): string {
  return canvas.comparison?.db ?? '';
}

export async function buildCatalog(storage: HarnessStorage, store: ModelStore, workspaceId: string): Promise<WorkspaceCatalog> {
  const ws = storage.workspace(workspaceId);
  const [meta, dbIds] = await Promise.all([ws.readMeta(), ws.dbIds()]);
  const db = await Promise.all(
    dbIds.map(async (id) => {
      const s = await store.source(workspaceId, 'db', id);
      return { id, name: s.name, tableCount: s.schema?.tables.length, hasSnapshot: !!s.snapshot };
    }),
  );
  return { workspace: { id: workspaceId, name: meta.name }, db };
}
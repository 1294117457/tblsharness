import * as vscode from 'vscode';
import type { ModelStore } from '../model/store';
import { parseDiagram, serializeDiagram, type DiagramFile } from '../shared/diagram';
import { applyDesignOps, DesignOpError, serializeDesign, type DesignDoc, type DesignOp } from '../shared/designOps';
import { collectSyncOps, SyncError, type SyncGroup, type SyncSelection } from '../shared/sync';
import { readTextIfExists, writeText } from '../workspace/fsUtil';
import type { HarnessStorage } from '../workspace/storage';
import { computeErSync } from './erSync';

export interface DiagramRef {
  workspace: string;
  design: string;
  diagram: string;
}

export interface PreparedSync {
  ops: DesignOp[];
  label: string;
  count: number;
  /** Tables the diagram is about after the sync; written back to its `refs`. */
  refs: string[];
}

interface UndoEntry {
  label: string;
  before: DesignDoc;
  afterText: string;
}

/** Everything about diagrams that both the diagram editor and the ER canvas need. */
export class DiagramService implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<DiagramRef>();
  /** A diagram's text changed, including unsaved edits in an open editor. */
  readonly onDidChange = this.emitter.event;
  private readonly createdEmitter = new vscode.EventEmitter<{ ref: DiagramRef; tables: string[] }>();
  /** A sync from the diagram editor added tables; the layout places them at the diagram's level. */
  readonly onDidCreateTables = this.createdEmitter.event;
  private readonly subscriptions: vscode.Disposable[] = [];
  /** Last sync applied from a diagram editor, per design. Canvas syncs use the canvas undo stack instead. */
  private readonly undo = new Map<string, UndoEntry>();

  constructor(
    readonly storage: HarnessStorage,
    readonly store: ModelStore,
  ) {
    const fire = (uri: vscode.Uri) => {
      const ref = this.locate(uri);
      if (ref) this.emitter.fire(ref);
    };
    this.subscriptions.push(
      vscode.workspace.onDidChangeTextDocument((e) => e.contentChanges.length && fire(e.document.uri)),
      store.onDidChange((c) => {
        if (c.kind === 'diagram' && c.workspace && c.id && c.diagram) this.emitter.fire({ workspace: c.workspace, design: c.id, diagram: c.diagram });
      }),
    );
  }

  locate(uri: vscode.Uri): DiagramRef | undefined {
    const l = this.storage.locate(uri);
    return l?.kind === 'diagram' && l.diagram ? { workspace: l.workspace, design: l.id, diagram: l.diagram } : undefined;
  }

  uri(ref: DiagramRef): vscode.Uri {
    return this.storage.workspace(ref.workspace).design(ref.design).diagramUri(ref.diagram);
  }

  private openDocument(ref: DiagramRef): vscode.TextDocument | undefined {
    const key = this.uri(ref).toString();
    return vscode.workspace.textDocuments.find((d) => d.uri.toString() === key);
  }

  /** The text as the user currently sees it: an open editor wins over the file on disk. */
  async text(ref: DiagramRef): Promise<string> {
    return this.openDocument(ref)?.getText() ?? (await readTextIfExists(this.uri(ref))) ?? '';
  }

  async read(ref: DiagramRef): Promise<DiagramFile> {
    return parseDiagram(await this.text(ref), ref.diagram);
  }

  async list(workspace: string, design: string): Promise<{ id: string; file: DiagramFile }[]> {
    const ids = await this.storage.workspace(workspace).design(design).diagramIds();
    return Promise.all(ids.map(async (id) => ({ id, file: await this.read({ workspace, design, diagram: id }) })));
  }

  async compute(ref: DiagramRef, choices?: Record<string, string>): Promise<SyncGroup> {
    const [file, meta] = await Promise.all([this.read(ref), this.storage.workspace(ref.workspace).design(ref.design).readMeta().catch(() => undefined)]);
    const group: SyncGroup = {
      workspace: ref.workspace,
      design: ref.design,
      designName: meta?.name ?? ref.design,
      diagram: ref.diagram,
      diagramName: file.meta.name,
      result: { items: [], problems: file.problems.map((message) => ({ line: 1, message })), ignored: 0 },
    };
    if (file.meta.type !== 'er') return group;
    try {
      const doc = await this.store.designDoc(ref.workspace, ref.design);
      const result = computeErSync(doc, file, choices);
      group.result = { ...result, problems: [...group.result.problems, ...result.problems] };
    } catch (err) {
      group.error = (err as Error).message;
    }
    return group;
  }

  /** ER diagrams of a design that currently propose something (or have problems). */
  async pending(workspace: string, design: string): Promise<SyncGroup[]> {
    const ids = await this.storage.workspace(workspace).design(design).diagramIds();
    const groups: SyncGroup[] = [];
    for (const diagram of ids) {
      const ref = { workspace, design, diagram };
      if ((await this.read(ref)).meta.type !== 'er') continue;
      const g = await this.compute(ref);
      if (g.result.items.length || g.result.problems.length || g.error) groups.push(g);
    }
    return groups;
  }

  /** Re-detects against the current texts so a stale panel can never apply something that is no longer proposed. */
  async prepare(ref: DiagramRef, selection: SyncSelection): Promise<PreparedSync> {
    if (!selection.ids.length) throw new SyncError('没有勾选要同步的内容');
    const file = await this.read(ref);
    if (file.meta.type !== 'er') throw new SyncError('只有 ER 图可以同步到表结构');
    const doc = await this.store.designDoc(ref.workspace, ref.design);
    const { items } = computeErSync(doc, file, selection.choices);
    const ops = collectSyncOps(items, selection.ids);
    const drawn = new Set(file.meta.refs);
    for (const op of ops) {
      if (op.op === 'table.add') drawn.add(op.table);
      if (op.op === 'table.delete') drawn.delete(op.table);
    }
    return { ops, count: selection.ids.length, label: `从设计图“${file.meta.name}”同步 ${selection.ids.length} 项`, refs: [...drawn] };
  }

  /** Asks before destructive changes; resolves false when the user cancels. */
  async confirmDeletes(ops: DesignOp[], designName: string): Promise<boolean> {
    const tables = ops.filter((o) => o.op === 'table.delete').map((o) => (o as { table: string }).table);
    const columns = ops.filter((o) => o.op === 'column.delete').map((o) => `${(o as { table: string }).table}.${(o as { column: string }).column}`);
    const relations = ops.filter((o) => o.op === 'relation.delete').length;
    if (!tables.length && !columns.length && !relations) return true;
    const parts = [tables.length && `表 ${tables.join('、')}`, columns.length && `字段 ${columns.join('、')}`, relations && `${relations} 条关系`].filter(Boolean);
    const ok = await vscode.window.showWarningMessage(
      `确定从“${designName}”中删除${parts.join('，')}吗？`,
      { modal: true, detail: '这些删除来自设计图的同步。可以撤销。' },
      '删除并同步',
    );
    return ok === '删除并同步';
  }

  assertNotDirty(workspace: string, design: string): void {
    const source = this.storage.workspace(workspace).design(design);
    const dirty = vscode.workspace.textDocuments.find(
      (d) => d.isDirty && (d.uri.toString() === source.schemaFile.toString() || d.uri.toString() === source.extFile.toString()),
    );
    if (dirty) throw new SyncError(`请先保存或放弃 ${dirty.uri.fsPath.split(/[\\/]/).pop()} 中未保存的修改`);
  }

  /** Applies a sync started from a diagram editor; it can be undone once from the same panel. */
  async applyFromEditor(ref: DiagramRef, selection: SyncSelection): Promise<PreparedSync> {
    this.assertNotDirty(ref.workspace, ref.design);
    const prepared = await this.prepare(ref, selection);
    const meta = await this.storage.workspace(ref.workspace).design(ref.design).readMeta();
    if (!(await this.confirmDeletes(prepared.ops, meta.name))) throw new SyncError('已取消');
    const before = await this.store.designDoc(ref.workspace, ref.design);
    let after: DesignDoc;
    try {
      after = applyDesignOps(before, prepared.ops);
    } catch (err) {
      throw new SyncError(err instanceof DesignOpError ? err.message : `执行失败：${(err as Error).message}`);
    }
    await this.store.writeDesignDoc(ref.workspace, ref.design, after);
    const text = serializeDesign(after);
    this.undo.set(`${ref.workspace}/${ref.design}`, { label: prepared.label, before, afterText: text.schema + text.ext });
    await this.setRefs(ref, prepared.refs);
    const created = prepared.ops.filter((o) => o.op === 'table.add').map((o) => (o as { table: string }).table);
    if (created.length) this.createdEmitter.fire({ ref, tables: created });
    return prepared;
  }

  undoLabel(workspace: string, design: string): string | undefined {
    return this.undo.get(`${workspace}/${design}`)?.label;
  }

  async undoLast(workspace: string, design: string): Promise<string> {
    const key = `${workspace}/${design}`;
    const entry = this.undo.get(key);
    if (!entry) throw new SyncError('没有可以撤销的同步');
    const current = serializeDesign(await this.store.designDoc(workspace, design));
    if (current.schema + current.ext !== entry.afterText) {
      this.undo.delete(key);
      throw new SyncError('表结构在这次同步之后又被修改过，不能撤销');
    }
    this.assertNotDirty(workspace, design);
    await this.store.writeDesignDoc(workspace, design, entry.before);
    this.undo.delete(key);
    return entry.label;
  }

  forgetUndo(workspace: string, design: string): void {
    this.undo.delete(`${workspace}/${design}`);
  }

  async setRefs(ref: DiagramRef, refs: string[]): Promise<void> {
    await this.modify(ref, (f) => {
      const same = f.meta.refs.length === refs.length && f.meta.refs.every((r) => refs.includes(r));
      return same ? f : { ...f, meta: { ...f.meta, refs: [...refs].sort() } };
    });
  }

  async ignore(ref: DiagramRef, ids: string[], clear = false): Promise<void> {
    await this.modify(ref, (f) => {
      const ignored = clear ? [] : [...new Set([...f.meta.ignored, ...ids])].sort();
      return { ...f, meta: { ...f.meta, ignored } };
    });
  }

  /**
   * Rewrites a diagram. When it is open in an editor the change goes through that document (and is saved),
   * so the editor's own undo keeps working and no unsaved text is overwritten.
   */
  async modify(ref: DiagramRef, fn: (file: DiagramFile) => DiagramFile): Promise<void> {
    const open = this.openDocument(ref);
    const text = open?.getText() ?? (await readTextIfExists(this.uri(ref)));
    if (text === undefined) throw new SyncError('设计图文件不存在');
    const file = parseDiagram(text, ref.diagram);
    const next = fn(file);
    if (next === file) return;
    const out = serializeDiagram(next);
    if (out === text) return;
    if (open) {
      const edit = new vscode.WorkspaceEdit();
      edit.replace(open.uri, new vscode.Range(open.positionAt(0), open.positionAt(text.length)), out);
      await vscode.workspace.applyEdit(edit);
      await open.save();
    } else {
      await writeText(this.uri(ref), out);
    }
  }

  dispose(): void {
    while (this.subscriptions.length) this.subscriptions.pop()?.dispose();
    this.emitter.dispose();
    this.createdEmitter.dispose();
  }
}

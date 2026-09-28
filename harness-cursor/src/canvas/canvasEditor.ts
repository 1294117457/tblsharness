import * as vscode from 'vscode';
import type { ModelStore, StoreChange } from '../model/store';
import {
  applyCanvasEdit,
  parseCanvas,
  renameTableInCanvas,
  serializeCanvas,
  type CanvasEdit,
  type CanvasFile,
  type Viewport,
} from '../shared/canvas';
import { applyDesignOps, DesignOpError, serializeDesign, type DesignOp } from '../shared/designOps';
import type { HostMessage, SourceData, WebviewMessage, WorkspaceCatalog } from '../shared/protocol';
import { renameDesignTable, type OpenCanvasRegistry } from '../workspace/refactor';
import { readText, writeText } from '../workspace/fsUtil';
import type { HarnessStorage } from '../workspace/storage';
import { renderWebviewHtml, webviewOptions } from '../webview/html';

export const CANVAS_VIEW_TYPE = 'harness.canvas';

export class CanvasDocument implements vscode.CustomDocument {
  private readonly contentEmitter = new vscode.EventEmitter<{ echo: boolean }>();
  /** Fired when `state` changes for any reason other than an edit the webview already applied itself. */
  readonly onDidChangeContent = this.contentEmitter.event;
  viewport: Viewport | undefined;
  private version = 0;
  private savedVersion = 0;

  constructor(
    readonly uri: vscode.Uri,
    public state: CanvasFile,
    readonly workspaceId: string | undefined,
  ) {
    this.viewport = state.viewport;
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
    return serializeCanvas({ ...this.state, viewport: this.viewport });
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
  private readonly nameEmitter = new vscode.EventEmitter<void>();
  /** A canvas name changed in an open editor (edit, undo, revert) or an editor closed. */
  readonly onDidChangeOpenName = this.nameEmitter.event;

  constructor(
    readonly context: vscode.ExtensionContext,
    readonly storage: HarnessStorage,
    readonly store: ModelStore,
  ) {
    context.subscriptions.push(store.onDidChange((change) => this.onStoreChange(change)));
  }

  static register(context: vscode.ExtensionContext, storage: HarnessStorage, store: ModelStore): CanvasEditorProvider {
    const provider = new CanvasEditorProvider(context, storage, store);
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
    let text = '';
    try {
      text = await readText(source);
    } catch {
      text = '';
    }
    const located = this.storage.locate(uri);
    const doc = new CanvasDocument(uri, parseCanvas(text), located?.kind === 'canvas' ? located.workspace : undefined);
    this.documents.set(uri.toString(), doc);
    let name = doc.state.name;
    doc.onDidChangeContent(() => {
      if (doc.state.name === name) return;
      name = doc.state.name;
      this.nameEmitter.fire();
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
      this.nameEmitter.fire();
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
    const canvas = parseCanvas(await readText(document.uri));
    document.viewport = canvas.viewport;
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

  /** An undoable canvas edit initiated by a command rather than the webview. */
  applyHostEdit(document: CanvasDocument, label: string, edit: CanvasEdit): void {
    const before = document.state;
    const after = applyCanvasEdit(before, edit);
    if (after === before) return;
    document.setState(after, true);
    this.recordEdit(
      document,
      label,
      () => document.setState(before, true),
      () => document.setState(after, true),
    );
  }

  transformIfOpen(uri: vscode.Uri, transform: (canvas: CanvasFile) => CanvasFile, skip?: vscode.Uri): boolean {
    if (skip && skip.toString() === uri.toString()) return true;
    const doc = this.documents.get(uri.toString());
    if (!doc) return false;
    const next = transform(doc.state);
    if (next !== doc.state) doc.setState(next, true);
    // Clean documents are also rewritten on disk by the caller; dirty ones keep their changes until saved.
    return doc.isDirty;
  }

  /** Opens the canvas (if needed) and selects the table. */
  async reveal(uri: vscode.Uri, focus?: { alias: string; table: string; column?: string }): Promise<void> {
    await vscode.commands.executeCommand('vscode.openWith', uri, CANVAS_VIEW_TYPE);
    if (focus) this.sessions.get(uri.toString())?.focus(focus);
  }

  openDocument(uri: vscode.Uri): CanvasDocument | undefined {
    return this.documents.get(uri.toString());
  }

  private onStoreChange(change: StoreChange): void {
    if (change.kind === 'canvas' && change.workspace && change.id) {
      const uri = this.storage.workspace(change.workspace).canvasUri(change.id);
      const doc = this.documents.get(uri.toString());
      if (doc && !doc.isDirty) void this.revertCustomDocument(doc).catch(() => undefined);
    }
    for (const session of this.sessions.values()) session.onStoreChange(change);
  }
}

class CanvasSession implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private ready = false;
  private pendingFocus: { alias: string; table: string; column?: string } | undefined;
  /** What the webview currently has, so we only resend what changed. */
  private sentSources = new Map<string, string>();
  private sentComparison = '';

  constructor(
    private readonly provider: CanvasEditorProvider,
    private readonly document: CanvasDocument,
    private readonly panel: vscode.WebviewPanel,
  ) {
    panel.webview.options = webviewOptions(provider.context);
    panel.webview.html = renderWebviewHtml({ webview: panel.webview, context: provider.context, title: document.state.name });
    panel.iconPath = vscode.Uri.joinPath(provider.context.extensionUri, 'media', 'harness.svg');
    this.disposables.push(
      panel.webview.onDidReceiveMessage((msg: WebviewMessage) => void this.onMessage(msg)),
      document.onDidChangeContent(({ echo }) => void this.afterCanvasChange(echo)),
    );
  }

  private get store(): ModelStore {
    return this.provider.store;
  }

  private get workspaceId(): string | undefined {
    return this.document.workspaceId;
  }

  focus(target: { alias: string; table: string; column?: string }): void {
    if (this.ready) this.post({ type: 'focus', ...target });
    else this.pendingFocus = target;
  }

  onStoreChange(change: StoreChange): void {
    if (!this.ready || !this.workspaceId || (change.workspace && change.workspace !== this.workspaceId)) return;
    if (change.kind === 'canvas') return;
    if (change.kind === 'design' || change.kind === 'db' || change.kind === 'workspace' || change.kind === undefined) {
      void this.pushCatalog();
      const affected = this.document.state.sources.filter(
        (s) => change.kind === 'workspace' || change.kind === undefined || (s.kind === change.kind && s.ref === change.id),
      );
      for (const s of affected) this.sentSources.delete(s.alias);
      void this.pushSources().then(() => this.pushComparison(affected.length > 0));
      return;
    }
    if (change.kind === 'comparisons') void this.pushComparison(true);
  }

  private post(msg: HostMessage): void {
    void this.panel.webview.postMessage(msg);
  }

  private async onMessage(msg: WebviewMessage): Promise<void> {
    try {
      switch (msg.type) {
        case 'ready':
          this.ready = true;
          await this.sendInit();
          if (this.pendingFocus) {
            this.post({ type: 'focus', ...this.pendingFocus });
            this.pendingFocus = undefined;
          }
          return;
        case 'canvas/edit':
          return this.applyCanvasEdit(msg.label, msg.edit);
        case 'design/op':
          return await this.applyDesignOps(msg.requestId, msg.alias, msg.ops, msg.label, msg.canvasEdit);
        case 'diff/accept':
          return await this.acceptDiff(msg.requestId, msg.id, msg.accepted);
        case 'viewport':
          this.document.viewport = msg.viewport;
          return;
        case 'db/sync': {
          const s = this.sourceByAlias(msg.alias);
          if (s?.kind === 'db') await vscode.commands.executeCommand('harness.db.sync', { workspace: this.workspaceId, id: s.ref });
          return;
        }
        case 'openRaw':
          return await this.openRaw(msg.alias);
        case 'source/create':
          await vscode.commands.executeCommand(msg.kind === 'design' ? 'harness.design.create' : 'harness.db.create', {
            workspace: this.workspaceId,
          });
          return;
        case 'source/rename':
          return await this.renameSource(msg.alias, msg.name);
      }
    } catch (err) {
      vscode.window.showErrorMessage(`Harness：${(err as Error).message}`);
    }
  }

  private sourceByAlias(alias: string) {
    return this.document.state.sources.find((s) => s.alias === alias);
  }

  private async sendInit(): Promise<void> {
    this.sentSources.clear();
    this.sentComparison = '';
    if (!this.workspaceId) {
      this.post({ type: 'init', canvas: this.document.state, sources: [], error: '这个画布文件不在 Harness 的工作区目录中，无法读取数据源。' });
      return;
    }
    const sources = await Promise.all(this.document.state.sources.map((s) => this.loadSource(s)));
    for (const s of sources) this.sentSources.set(s.alias, sourceSignature(this.sourceByAlias(s.alias)));
    const comparison = await this.computeComparison();
    this.sentComparison = comparisonSignature(this.document.state);
    this.post({ type: 'init', canvas: this.document.state, sources, catalog: await this.catalog(), comparison });
  }

  private async loadSource(s: CanvasFile['sources'][number]): Promise<SourceData> {
    const loaded = await this.store.source(this.workspaceId!, s.kind, s.ref, s.kind === 'db' ? s.snapshot : undefined);
    return { alias: s.alias, kind: s.kind, ref: s.ref, name: loaded.name, schema: loaded.schema, snapshot: loaded.snapshot, error: loaded.error };
  }

  private async pushSources(): Promise<void> {
    for (const s of this.document.state.sources) {
      const signature = sourceSignature(s);
      if (this.sentSources.get(s.alias) === signature) continue;
      this.sentSources.set(s.alias, signature);
      this.post({ type: 'source', source: await this.loadSource(s) });
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

  private async computeComparison() {
    const c = this.document.state.comparison;
    if (!c || !this.workspaceId) return undefined;
    const design = this.sourceByAlias(c.design);
    const db = this.sourceByAlias(c.db);
    if (design?.kind !== 'design' || db?.kind !== 'db') return undefined;
    return this.store.comparison(this.workspaceId, design.ref, db.ref, db.snapshot);
  }

  private async catalog(): Promise<WorkspaceCatalog | undefined> {
    return this.workspaceId ? buildCatalog(this.provider.storage, this.store, this.workspaceId) : undefined;
  }

  private async afterCanvasChange(echo: boolean): Promise<void> {
    if (!this.ready) return;
    if (echo) this.post({ type: 'canvas', canvas: this.document.state });
    for (const alias of [...this.sentSources.keys()]) {
      if (!this.sourceByAlias(alias)) this.sentSources.delete(alias);
    }
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

  private async applyDesignOps(
    requestId: string,
    alias: string,
    ops: DesignOp[],
    label: string,
    canvasEdit: CanvasEdit | undefined,
  ): Promise<void> {
    const reply = (error?: string) => this.post({ type: 'reply', requestId, ok: !error, error });
    const source = this.sourceByAlias(alias);
    const workspaceId = this.workspaceId;
    if (!source || source.kind !== 'design' || !workspaceId) {
      return reply('只能编辑设计数据源中的表');
    }
    const design = this.provider.storage.workspace(workspaceId).design(source.ref);
    const dirty = vscode.workspace.textDocuments.find(
      (d) => d.isDirty && (d.uri.toString() === design.schemaFile.toString() || d.uri.toString() === design.extFile.toString()),
    );
    if (dirty) {
      return reply(`请先保存或放弃 ${dirty.uri.fsPath.split(/[\\/]/).pop()} 中未保存的修改`);
    }

    const deletes = ops.filter((o): o is Extract<DesignOp, { op: 'table.delete' }> => o.op === 'table.delete');
    if (deletes.length) {
      const names = deletes.map((d) => d.table).join('、');
      const ok = await vscode.window.showWarningMessage(
        `确定从设计库“${(await design.readMeta()).name}”中删除表 ${names} 吗？`,
        { modal: true, detail: '涉及这些表的关系也会一起删除。其他画布中的这些表会显示为“缺失”。可以用撤销恢复。' },
        '删除',
      );
      if (!ok) return reply('已取消');
    }

    let before;
    let after;
    try {
      before = await this.store.designDoc(workspaceId, source.ref);
      after = applyDesignOps(before, ops);
    } catch (err) {
      return reply(err instanceof DesignOpError ? err.message : `执行失败：${(err as Error).message}`);
    }
    const renames = ops.filter((o): o is Extract<DesignOp, { op: 'table.rename' }> => o.op === 'table.rename');
    const canvasBefore = this.document.state;
    let canvasAfter = canvasBefore;
    for (const r of renames) canvasAfter = renameTableInCanvas(canvasAfter, 'design', source.ref, r.from, r.to);
    if (canvasEdit) canvasAfter = applyCanvasEdit(canvasAfter, canvasEdit);

    const storage = this.provider.storage;
    const self = this.document.uri;
    const registry: OpenCanvasRegistry = { transformIfOpen: (uri, fn) => this.provider.transformIfOpen(uri, fn, self) };
    const afterText = serializeDesign(after).schema + serializeDesign(after).ext;
    const beforeText = serializeDesign(before).schema + serializeDesign(before).ext;

    const apply = async (doc: typeof before, canvas: CanvasFile, forward: boolean) => {
      await this.store.writeDesignDoc(workspaceId, source.ref, doc);
      for (const r of forward ? renames : [...renames].reverse()) {
        await renameDesignTable(storage, registry, workspaceId, source.ref, forward ? r.from : r.to, forward ? r.to : r.from);
      }
      this.document.setState(canvas, true);
    };
    const guard = async (expected: string, run: () => Promise<void>) => {
      const current = serializeDesign(await this.store.designDoc(workspaceId, source.ref));
      if (current.schema + current.ext !== expected) {
        vscode.window.showWarningMessage(`Harness：设计库在这次修改之后又被改动过，无法撤销或重做“${label}”。`);
        return;
      }
      await run();
    };

    await this.store.writeDesignDoc(workspaceId, source.ref, after);
    for (const r of renames) await renameDesignTable(storage, registry, workspaceId, source.ref, r.from, r.to);
    if (canvasAfter !== canvasBefore) this.document.setState(canvasAfter, true);
    this.provider.recordEdit(
      this.document,
      label,
      () => guard(afterText, () => apply(before, canvasBefore, false)),
      () => guard(beforeText, () => apply(after, canvasAfter, true)),
    );
    reply();
  }

  private async acceptDiff(requestId: string, id: string, accepted: boolean): Promise<void> {
    const c = this.document.state.comparison;
    const design = c && this.sourceByAlias(c.design);
    const db = c && this.sourceByAlias(c.db);
    if (!this.workspaceId || !design || !db) {
      this.post({ type: 'reply', requestId, ok: false, error: '画布没有开启对比' });
      return;
    }
    const ws = this.provider.storage.workspace(this.workspaceId);
    await ws.updatePair(design.ref, db.ref, (p) => {
      const set = new Set(p.acceptedDiffs);
      if (accepted) set.add(id);
      else set.delete(id);
      return { ...p, acceptedDiffs: [...set].sort() };
    });
    this.store.invalidate({ workspace: this.workspaceId, kind: 'comparisons' });
    this.post({ type: 'reply', requestId, ok: true });
  }

  /** Renames the design source itself (its source.yml), not just its label on this canvas. Db names come from the connection. */
  private async renameSource(alias: string, name: string): Promise<void> {
    const s = this.sourceByAlias(alias);
    const trimmed = name.trim();
    if (s?.kind !== 'design' || !this.workspaceId || !trimmed) return;
    const source = this.provider.storage.workspace(this.workspaceId).design(s.ref);
    const meta = await source.readMeta();
    if (meta.name === trimmed) return;
    await source.writeMeta({ ...meta, name: trimmed });
    this.store.invalidate({ workspace: this.workspaceId, kind: 'design', id: s.ref });
  }

  private async openRaw(alias: string): Promise<void> {
    const s = this.sourceByAlias(alias);
    if (!s || !this.workspaceId) return;
    const ws = this.provider.storage.workspace(this.workspaceId);
    let uri: vscode.Uri | undefined;
    if (s.kind === 'design') {
      uri = ws.design(s.ref).schemaFile;
    } else {
      const db = ws.db(s.ref);
      const file = s.snapshot ?? (await db.latestSnapshot());
      uri = file ? db.snapshotUri(file) : undefined;
    }
    if (uri) await vscode.window.showTextDocument(uri, { viewColumn: vscode.ViewColumn.Beside, preview: true });
  }

  dispose(): void {
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }
}

function sourceSignature(s: CanvasFile['sources'][number] | undefined): string {
  return s ? `${s.kind}:${s.ref}@${s.snapshot ?? ''}` : '';
}

function comparisonSignature(canvas: CanvasFile): string {
  const c = canvas.comparison;
  if (!c) return '';
  const d = canvas.sources.find((s) => s.alias === c.design);
  const b = canvas.sources.find((s) => s.alias === c.db);
  return `${sourceSignature(d)}|${sourceSignature(b)}`;
}

export async function buildCatalog(storage: HarnessStorage, store: ModelStore, workspaceId: string): Promise<WorkspaceCatalog> {
  const ws = storage.workspace(workspaceId);
  const [meta, designIds, dbIds] = await Promise.all([ws.readMeta(), ws.designIds(), ws.dbIds()]);
  const design = await Promise.all(
    designIds.map(async (id) => {
      const s = await store.source(workspaceId, 'design', id);
      return { id, name: s.name, tableCount: s.schema?.tables.length ?? 0 };
    }),
  );
  const db = await Promise.all(
    dbIds.map(async (id) => {
      const s = await store.source(workspaceId, 'db', id);
      return { id, name: s.name, tableCount: s.schema?.tables.length, hasSnapshot: !!s.snapshot };
    }),
  );
  return { workspace: { id: workspaceId, name: meta.name }, design, db };
}

import * as vscode from 'vscode';
import type { DiagramRef, DiagramService } from '../diagram/diagramService';
import type { ModelStore, StoreChange } from '../model/store';
import { SyncError } from '../shared/sync';
import {
  applyCanvasEdit,
  DESIGN_SOURCE,
  parseCanvas,
  renameTableInCanvas,
  serializeCanvas,
  type CanvasEdit,
  type CanvasFile,
  type Viewport,
} from '../shared/canvas';
import { copyTableOps, type ConflictStrategy } from '../shared/copyTables';
import { applyDesignOps, DesignOpError, serializeDesign, type DesignOp } from '../shared/designOps';
import type { ComparisonData, DesignContext, HostMessage, SourceData, WebviewMessage, WorkspaceCatalog } from '../shared/protocol';
import { renameDesignTable, type OpenCanvasRegistry } from '../workspace/refactor';
import { readText, writeText } from '../workspace/fsUtil';
import type { HarnessStorage } from '../workspace/storage';
import { renderWebviewHtml, webviewOptions } from '../webview/html';

export const CANVAS_VIEW_TYPE = 'harness.canvas';

export class CanvasDocument implements vscode.CustomDocument {
  private readonly contentEmitter = new vscode.EventEmitter<{ echo: boolean }>();
  readonly onDidChangeContent = this.contentEmitter.event;
  viewport: Viewport | undefined;
  private version = 0;
  private savedVersion = 0;

  constructor(
    readonly uri: vscode.Uri,
    public state: CanvasFile,
    readonly workspaceId: string | undefined,
    readonly designId: string | undefined,
    readonly canvasId: string | undefined,
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
  readonly onDidChangeOpenName = this.nameEmitter.event;

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
    let text = '';
    try {
      text = await readText(source);
    } catch {
      text = '';
    }
    const located = this.storage.locate(uri);
    let workspaceId: string | undefined;
    let designId: string | undefined;
    let canvasId: string | undefined;
    if (located?.kind === 'canvas' && located.design) {
      workspaceId = located.workspace;
      designId = located.design;
      canvasId = located.id;
    }
    const doc = new CanvasDocument(uri, parseCanvas(text), workspaceId, designId, canvasId);
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
    if (document.workspaceId && document.designId && document.canvasId) {
      const design = this.storage.workspace(document.workspaceId).design(document.designId);
      const meta = await design.readMeta();
      if (meta.lastCanvas !== document.canvasId) {
        await design.writeMeta({ ...meta, lastCanvas: document.canvasId });
      }
    }
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
    return doc.isDirty;
  }

  async reveal(uri: vscode.Uri, focus?: { source: string; table: string; column?: string }): Promise<void> {
    await vscode.commands.executeCommand('vscode.openWith', uri, CANVAS_VIEW_TYPE);
    if (focus) this.sessions.get(uri.toString())?.focus(focus);
  }

  openDocument(uri: vscode.Uri): CanvasDocument | undefined {
    return this.documents.get(uri.toString());
  }

  /** Find all open documents belonging to a specific design. */
  documentsForDesign(workspaceId: string, designId: string): CanvasDocument[] {
    return [...this.documents.values()].filter((d) => d.workspaceId === workspaceId && d.designId === designId);
  }

  private onStoreChange(change: StoreChange): void {
    if (change.kind === 'canvas' && change.workspace && change.id && change.design) {
      const uri = this.storage.workspace(change.workspace).design(change.design).canvasUri(change.id);
      const doc = this.documents.get(uri.toString());
      if (doc && !doc.isDirty) void this.revertCustomDocument(doc).catch(() => undefined);
    }
    for (const session of this.sessions.values()) session.onStoreChange(change);
  }
}

class CanvasSession implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private ready = false;
  private pendingFocus: { source: string; table: string; column?: string } | undefined;
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

  private get designId(): string | undefined {
    return this.document.designId;
  }

  focus(target: { source: string; table: string; column?: string }): void {
    if (this.ready) this.post({ type: 'focus', ...target });
    else this.pendingFocus = target;
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

  private async pushPending(): Promise<void> {
    if (!this.ready || !this.workspaceId || !this.designId) return;
    const groups = await this.provider.diagrams.pending(this.workspaceId, this.designId);
    const signature = JSON.stringify(groups);
    if (signature === this.sentPending) return;
    this.sentPending = signature;
    this.post({ type: 'pendingSync', groups });
  }

  onStoreChange(change: StoreChange): void {
    if (!this.ready || !this.workspaceId || (change.workspace && change.workspace !== this.workspaceId)) return;
    if (change.kind === 'canvas') return;
    if (change.kind === 'diagram') {
      if (change.design === this.designId) this.schedulePending();
      return;
    }
    if (change.kind === 'design' && change.id === this.designId) {
      this.schedulePending();
      this.sentSources.delete(DESIGN_SOURCE);
      void this.pushSources().then(() => this.pushComparison(true));
      void this.pushDesignContext();
      return;
    }
    if (change.kind === 'db' || change.kind === 'workspace' || change.kind === undefined) {
      void this.pushCatalog();
      if (change.kind === 'db' && change.id) {
        this.sentSources.delete(change.id);
      } else {
        this.sentSources.clear();
      }
      void this.pushSources().then(() => this.pushComparison(true));
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
          this.sentPending = '';
          await this.pushPending();
          return;
        case 'sync/apply': {
          const ref: DiagramRef = { workspace: this.workspaceId ?? '', design: this.designId ?? '', diagram: msg.diagram };
          return await this.applySync(msg.requestId, ref, msg.ids, msg.choices);
        }
        case 'sync/ignore': {
          const ref: DiagramRef = { workspace: this.workspaceId ?? '', design: this.designId ?? '', diagram: msg.diagram };
          await this.provider.diagrams.ignore(ref, msg.ids, msg.clear);
          this.post({ type: 'reply', requestId: msg.requestId, ok: true });
          this.schedulePending();
          return;
        }
        case 'diagram/open':
          await vscode.commands.executeCommand('harness.diagram.open', {
            kind: 'diagram',
            workspace: this.workspaceId,
            design: this.designId,
            id: msg.diagram,
          });
          return;
        case 'diagram/create':
          await vscode.commands.executeCommand('harness.diagram.create', {
            kind: 'design',
            workspace: this.workspaceId,
            id: this.designId,
            type: 'er',
            blank: true,
          });
          return;
        case 'canvas/edit':
          return this.applyCanvasEdit(msg.label, msg.edit);
        case 'design/op':
          await this.applyDesignOps(msg.requestId, msg.ops, msg.label, msg.canvasEdit);
          return;
        case 'diff/accept':
          return await this.acceptDiff(msg.requestId, msg.id, msg.accepted);
        case 'viewport':
          this.document.viewport = msg.viewport;
          return;
        case 'db/sync':
          if (msg.source !== DESIGN_SOURCE) {
            await vscode.commands.executeCommand('harness.db.sync', { workspace: this.workspaceId, id: msg.source });
          }
          return;
        case 'openRaw':
          return await this.openRaw(msg.source);
        case 'source/add':
          return await this.addDbSource(msg.requestId, msg.dbId);
        case 'source/remove':
          return await this.removeDbSource(msg.requestId, msg.dbId);
        case 'design/rename':
          return await this.renameDesign(msg.requestId, msg.name);
        case 'canvas/switch':
          if (this.workspaceId && this.designId) {
            const uri = this.provider.storage.workspace(this.workspaceId).design(this.designId).canvasUri(msg.canvasId);
            await vscode.commands.executeCommand('vscode.openWith', uri, CANVAS_VIEW_TYPE);
          }
          return;
        case 'canvas/new':
          if (this.workspaceId && this.designId) {
            await vscode.commands.executeCommand('harness.canvas.create', { workspace: this.workspaceId, design: this.designId });
          }
          return;
        case 'canvas/copy':
          // TODO: implement canvas copy
          return;
        case 'table/copyToDesign':
          return await this.copyTablesToDesign(msg.requestId, msg.source, msg.tables);
      }
    } catch (err) {
      vscode.window.showErrorMessage(`Harness：${(err as Error).message}`);
    }
  }

  private async sendInit(): Promise<void> {
    this.sentSources.clear();
    this.sentComparison = '';
    if (!this.workspaceId || !this.designId) {
      this.post({
        type: 'init',
        canvas: this.document.state,
        design: { workspace: '', design: '', name: '?', canvases: [] },
        sources: [],
        error: '这个画布文件不在 Harness 的设计画布目录中，无法读取数据源。',
      });
      return;
    }
    const sources = await this.loadAllSources();
    for (const s of sources) this.sentSources.set(s.source, sourceSignature(s.source));
    const comparison = await this.computeComparison();
    this.sentComparison = comparisonSignature(this.document.state);
    const designCtx = await this.buildDesignContext();
    this.post({ type: 'init', canvas: this.document.state, design: designCtx, sources, catalog: await this.catalog(), comparison });
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
    const sources = await this.loadAllSources();
    for (const s of sources) {
      const sig = sourceSignature(s.source);
      if (this.sentSources.get(s.source) === sig) continue;
      this.sentSources.set(s.source, sig);
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
    if (!this.workspaceId || !this.designId) return { workspace: '', design: '', name: '?', canvases: [] };
    const ws = this.provider.storage.workspace(this.workspaceId);
    const design = ws.design(this.designId);
    const meta = await design.readMeta();
    const canvasIds = await design.canvasIds();
    const canvases: { id: string; name: string }[] = [];
    for (const cid of canvasIds) {
      try {
        const c = parseCanvas(await readText(design.canvasUri(cid)));
        canvases.push({ id: cid, name: c.name });
      } catch {
        canvases.push({ id: cid, name: cid });
      }
    }
    const designSchema = await this.store.source(this.workspaceId, 'design', this.designId);
    return { workspace: this.workspaceId, design: this.designId, name: meta.name, driver: designSchema.schema?.driver?.name, canvases };
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
    this.schedulePending();
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
      this.post({ type: 'reply', requestId, ok: false, error: '画布没有关联到设计画布' });
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
      this.post({ type: 'reply', requestId, ok: false, error: (err as Error).message });
      return;
    }
    if (await this.applyDesignOps(requestId, prepared.ops, prepared.label, undefined, true)) {
      await diagrams.setRefs(ref, prepared.refs).catch(() => undefined);
    }
  }

  private async applyDesignOps(
    requestId: string,
    ops: DesignOp[],
    label: string,
    canvasEdit: CanvasEdit | undefined,
    confirmed = false,
  ): Promise<boolean> {
    const reply = (error?: string) => {
      this.post({ type: 'reply', requestId, ok: !error, error });
      return !error;
    };
    const workspaceId = this.workspaceId;
    const designId = this.designId;
    if (!workspaceId || !designId) return reply('画布没有关联到设计画布');

    const design = this.provider.storage.workspace(workspaceId).design(designId);
    const dirty = vscode.workspace.textDocuments.find(
      (d) => d.isDirty && (d.uri.toString() === design.schemaFile.toString() || d.uri.toString() === design.extFile.toString()),
    );
    if (dirty) {
      return reply(`请先保存或放弃 ${dirty.uri.fsPath.split(/[\\/]/).pop()} 中未保存的修改`);
    }

    const deletes = ops.filter((o): o is Extract<DesignOp, { op: 'table.delete' }> => o.op === 'table.delete');
    if (deletes.length && !confirmed) {
      const meta = await design.readMeta();
      const names = deletes.map((d) => d.table).join('、');
      const ok = await vscode.window.showWarningMessage(
        `确定从设计画布"${meta.name}"中删除表 ${names} 吗？`,
        { modal: true, detail: '涉及这些表的关系也会一起删除。可以用撤销恢复。' },
        '删除',
      );
      if (!ok) return reply('已取消');
    }

    let before;
    let after;
    try {
      before = await this.store.designDoc(workspaceId, designId);
      after = applyDesignOps(before, ops);
    } catch (err) {
      return reply(err instanceof DesignOpError ? err.message : `执行失败：${(err as Error).message}`);
    }
    const renames = ops.filter((o): o is Extract<DesignOp, { op: 'table.rename' }> => o.op === 'table.rename');
    const canvasBefore = this.document.state;
    let canvasAfter = canvasBefore;
    for (const r of renames) canvasAfter = renameTableInCanvas(canvasAfter, r.from, r.to);
    if (canvasEdit) canvasAfter = applyCanvasEdit(canvasAfter, canvasEdit);

    const storage = this.provider.storage;
    const self = this.document.uri;
    const registry: OpenCanvasRegistry = { transformIfOpen: (uri, fn) => this.provider.transformIfOpen(uri, fn, self) };
    const afterText = serializeDesign(after).schema + serializeDesign(after).ext;
    const beforeText = serializeDesign(before).schema + serializeDesign(before).ext;

    const apply = async (doc: typeof before, canvas: CanvasFile, forward: boolean) => {
      await this.store.writeDesignDoc(workspaceId, designId, doc);
      for (const r of forward ? renames : [...renames].reverse()) {
        await renameDesignTable(storage.workspace(workspaceId).design(designId), registry, forward ? r.from : r.to, forward ? r.to : r.from);
      }
      this.document.setState(canvas, true);
    };
    const guard = async (expected: string, run: () => Promise<void>) => {
      const current = serializeDesign(await this.store.designDoc(workspaceId, designId));
      if (current.schema + current.ext !== expected) {
        vscode.window.showWarningMessage(`Harness：设计画布在这次修改之后又被改动过，无法撤销或重做"${label}"。`);
        return;
      }
      await run();
    };

    await this.store.writeDesignDoc(workspaceId, designId, after);
    for (const r of renames) await renameDesignTable(storage.workspace(workspaceId).design(designId), registry, r.from, r.to);
    if (canvasAfter !== canvasBefore) this.document.setState(canvasAfter, true);
    this.provider.recordEdit(
      this.document,
      label,
      () => guard(afterText, () => apply(before, canvasBefore, false)),
      () => guard(beforeText, () => apply(after, canvasAfter, true)),
    );
    return reply();
  }

  private async acceptDiff(requestId: string, id: string, accepted: boolean): Promise<void> {
    const c = this.document.state.comparison;
    if (!this.workspaceId || !this.designId || !c) {
      this.post({ type: 'reply', requestId, ok: false, error: '画布没有开启对比' });
      return;
    }
    const design = this.provider.storage.workspace(this.workspaceId).design(this.designId);
    const entry = await design.comparisonEntry(c.db);
    const set = new Set(entry.acceptedDiffs ?? []);
    if (accepted) set.add(id);
    else set.delete(id);
    await design.writeComparisonEntry(c.db, { ...entry, acceptedDiffs: [...set].sort() });
    this.store.invalidate({ workspace: this.workspaceId, kind: 'comparisons' });
    this.post({ type: 'reply', requestId, ok: true });
  }

  private async renameDesign(requestId: string, name: string): Promise<void> {
    const trimmed = name.trim();
    if (!this.workspaceId || !this.designId || !trimmed) return;
    const design = this.provider.storage.workspace(this.workspaceId).design(this.designId);
    const meta = await design.readMeta();
    if (meta.name === trimmed) return;
    await design.writeMeta({ ...meta, name: trimmed });
    this.store.invalidate({ workspace: this.workspaceId, kind: 'design', id: this.designId });
    this.post({ type: 'reply', requestId, ok: true });
  }

  private async addDbSource(requestId: string, dbId: string): Promise<void> {
    if (!this.workspaceId || !this.designId) return;
    const design = this.provider.storage.workspace(this.workspaceId).design(this.designId);
    const meta = await design.readMeta();
    const sources = new Set(meta.sources ?? []);
    if (sources.has(dbId)) {
      this.post({ type: 'reply', requestId, ok: true });
      return;
    }
    sources.add(dbId);
    await design.writeMeta({ ...meta, sources: [...sources] });
    this.store.invalidate({ workspace: this.workspaceId, kind: 'design', id: this.designId });
    this.sentSources.delete(dbId);
    await this.pushSources();
    this.post({ type: 'reply', requestId, ok: true });
  }

  private async removeDbSource(requestId: string, dbId: string): Promise<void> {
    if (!this.workspaceId || !this.designId) return;
    const design = this.provider.storage.workspace(this.workspaceId).design(this.designId);
    const meta = await design.readMeta();
    const sources = (meta.sources ?? []).filter((s) => s !== dbId);
    await design.writeMeta({ ...meta, sources });
    this.store.invalidate({ workspace: this.workspaceId, kind: 'design', id: this.designId });
    this.sentSources.delete(dbId);
    this.post({ type: 'reply', requestId, ok: true });
  }

  private async copyTablesToDesign(requestId: string, source: string, tables: string[]): Promise<void> {
    if (!this.workspaceId || !this.designId) {
      this.post({ type: 'reply', requestId, ok: false, error: '画布没有关联到设计画布' });
      return;
    }
    const ws = this.provider.storage.workspace(this.workspaceId);
    const db = ws.db(source);
    const snapshotFile = await db.latestSnapshot();
    if (!snapshotFile) {
      this.post({ type: 'reply', requestId, ok: false, error: '数据库快照不可用' });
      return;
    }
    const snapshot = await db.readSnapshot(snapshotFile);
    const nameSet = new Set(tables);
    const srcTables = snapshot.tables.filter((t) => nameSet.has(t.name));
    if (!srcTables.length) {
      this.post({ type: 'reply', requestId, ok: true });
      return;
    }

    const designData = await this.store.source(this.workspaceId, 'design', this.designId);
    const existingTables = (designData.schema?.tables ?? []).map((t) => t.key);
    const hasConflict = srcTables.some((t) => existingTables.includes(t.name));

    let onConflict: ConflictStrategy = 'skip';
    if (hasConflict) {
      const pick = await vscode.window.showWarningMessage(
        '部分表名在设计中已存在',
        { modal: true, detail: '可以跳过已存在的表，或者自动改名后添加。' },
        '跳过已存在的',
        '自动改名',
      );
      if (!pick) {
        this.post({ type: 'reply', requestId, ok: false, error: '已取消' });
        return;
      }
      onConflict = pick === '自动改名' ? 'rename' : 'skip';
    }

    const result = copyTableOps(srcTables, snapshot.relations ?? [], { existingTables, onConflict });
    if (!result.ops.length) {
      this.post({ type: 'reply', requestId, ok: true });
      return;
    }

    const canvasEdit: CanvasEdit = [];
    if (result.copied.length) {
      const existing = this.document.state.nodes;
      const maxX = existing.length ? Math.max(...existing.map((n) => n.x)) : 0;
      const nodes = result.copied.map((name, i) => ({
        source: DESIGN_SOURCE,
        table: name,
        x: maxX + 300,
        y: i * 120,
      }));
      canvasEdit.push({ op: 'nodes.put', nodes });
    }

    await this.applyDesignOps(requestId, result.ops, '复制数据库表到设计', canvasEdit.length ? canvasEdit : undefined);
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

function sourceSignature(source: string): string {
  return source;
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

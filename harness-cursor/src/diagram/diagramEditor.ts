import * as vscode from 'vscode';
import type { ModelStore } from '../model/store';
import { parseDiagram, serializeDiagram, type DiagramFile } from '../shared/diagram';
import type { DiagramContext, DiagramDocState, DiagramHostMessage, DiagramWebviewMessage } from '../shared/diagramProtocol';
import { generateErDiagram } from '../shared/mermaid/er';
import { driverLabel } from '../shared/workspace';
import { renderWebviewHtml, webviewOptions } from '../webview/html';
import type { DiagramRef, DiagramService } from './diagramService';

export const DIAGRAM_EDITOR_VIEW_TYPE = 'harness.diagram';

/**
 * Text-backed editor for `design/<id>/diagrams/<diagramN>.md`: the file stays the source of truth,
 * so agents can edit it directly and VS Code's own undo/save/dirty handling applies.
 */
export class DiagramEditorProvider implements vscode.CustomTextEditorProvider {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly diagrams: DiagramService,
    private readonly store: ModelStore,
  ) {}

  static register(context: vscode.ExtensionContext, diagrams: DiagramService, store: ModelStore): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(DIAGRAM_EDITOR_VIEW_TYPE, new DiagramEditorProvider(context, diagrams, store), {
      webviewOptions: { retainContextWhenHidden: true },
    });
  }

  resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): void {
    const session = new DiagramSession(this.context, this.diagrams, this.store, document, panel);
    panel.onDidDispose(() => session.dispose());
  }
}

function docState(file: DiagramFile): DiagramDocState {
  return { meta: file.meta, code: file.code, problems: file.problems };
}

class DiagramSession implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly ref: DiagramRef | undefined;
  private ready = false;
  /** Code the webview sent last; its echo from onDidChangeTextDocument is not sent back. */
  private lastFromWebview: string | undefined;
  private syncTimer: NodeJS.Timeout | undefined;

  constructor(
    context: vscode.ExtensionContext,
    private readonly diagrams: DiagramService,
    private readonly store: ModelStore,
    private readonly document: vscode.TextDocument,
    private readonly panel: vscode.WebviewPanel,
  ) {
    this.ref = diagrams.locate(document.uri);
    panel.webview.options = webviewOptions(context);
    panel.webview.html = renderWebviewHtml({ webview: panel.webview, context, title: this.file().meta.name, view: 'diagram' });
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'harness.svg');
    this.disposables.push(
      panel.webview.onDidReceiveMessage((msg: DiagramWebviewMessage) => void this.onMessage(msg)),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.toString() !== document.uri.toString() || !e.contentChanges.length) return;
        this.onDocumentChange();
      }),
      store.onDidChange((c) => {
        if (!this.ref || c.workspace !== this.ref.workspace || c.id !== this.ref.design) return;
        if (c.kind === 'design') {
          void this.pushContext();
          this.scheduleSync();
        }
      }),
    );
  }

  private file(): DiagramFile {
    return parseDiagram(this.document.getText(), this.ref?.diagram ?? '设计图');
  }

  private post(msg: DiagramHostMessage): void {
    void this.panel.webview.postMessage(msg);
  }

  private onDocumentChange(): void {
    const file = this.file();
    this.panel.title = file.meta.name;
    // Saving trims trailing whitespace; sending that back would eat the newline the user just typed.
    const echo = this.lastFromWebview !== undefined && file.code === this.lastFromWebview.replace(/\s+$/, '');
    this.post({ type: 'doc', doc: { ...docState(file), code: echo ? this.lastFromWebview! : file.code } });
    this.scheduleSync();
  }

  private async contextInfo(): Promise<DiagramContext | undefined> {
    if (!this.ref) return undefined;
    const loaded = await this.store.source(this.ref.workspace, 'design', this.ref.design);
    return { designName: loaded.name, driver: driverLabel(loaded.schema?.driver?.name), tableCount: loaded.schema?.tables.length ?? 0 };
  }

  private async pushContext(): Promise<void> {
    const context = await this.contextInfo();
    if (context && this.ready) this.post({ type: 'context', context });
  }

  private scheduleSync(): void {
    clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => void this.pushSync(), 250);
  }

  private async pushSync(): Promise<void> {
    if (!this.ready || !this.ref) return;
    const group = await this.diagrams.compute(this.ref);
    this.post({ type: 'sync', group, undo: this.diagrams.undoLabel(this.ref.workspace, this.ref.design) });
  }

  private async onMessage(msg: DiagramWebviewMessage): Promise<void> {
    const reply = (requestId: string, error?: string, message?: string) => this.post({ type: 'reply', requestId, ok: !error, error, message });
    switch (msg.type) {
      case 'ready': {
        this.ready = true;
        const file = this.file();
        const error = this.ref ? undefined : '这个文件不在 Harness 设计库的 diagrams 目录中，只能预览，不能同步到表结构。';
        this.post({ type: 'init', doc: docState(file), context: await this.contextInfo(), error });
        await this.pushSync();
        return;
      }
      case 'code':
        this.lastFromWebview = msg.code;
        await this.rewrite((f) => ({ ...f, code: msg.code }));
        return;
      case 'meta':
        await this.rewrite((f) => ({
          ...f,
          meta: { ...f.meta, name: msg.name?.trim() || f.meta.name, description: msg.description !== undefined ? msg.description.trim() || undefined : f.meta.description },
        }));
        return;
      case 'sync/apply':
        if (!this.ref) return reply(msg.requestId, '这个设计图不属于任何设计库');
        try {
          const done = await this.diagrams.applyFromEditor(this.ref, { ids: msg.ids, choices: msg.choices });
          reply(msg.requestId, undefined, `已同步 ${done.count} 项到表结构`);
        } catch (err) {
          reply(msg.requestId, (err as Error).message);
        }
        await this.pushSync();
        return;
      case 'sync/ignore':
        if (!this.ref) return reply(msg.requestId, '这个设计图不属于任何设计库');
        await this.rewrite((f) => ({
          ...f,
          meta: { ...f.meta, ignored: msg.clear ? [] : [...new Set([...f.meta.ignored, ...msg.ids])].sort() },
        }));
        reply(msg.requestId);
        return;
      case 'sync/undo':
        if (!this.ref) return reply(msg.requestId, '这个设计图不属于任何设计库');
        try {
          const label = await this.diagrams.undoLast(this.ref.workspace, this.ref.design);
          reply(msg.requestId, undefined, `已撤销：${label}`);
        } catch (err) {
          reply(msg.requestId, (err as Error).message);
        }
        await this.pushSync();
        return;
      case 'regenerate':
        return reply(msg.requestId, await this.regenerate());
      case 'command':
        return this.runCommand(msg.command);
    }
  }

  /** Replaces the ER code with what the tables currently are (for `refs`, or all tables when there are none). */
  private async regenerate(): Promise<string | undefined> {
    if (!this.ref) return '这个设计图不属于任何设计库';
    const loaded = await this.store.source(this.ref.workspace, 'design', this.ref.design);
    if (!loaded.schema) return loaded.error ?? '表结构读取失败';
    const file = this.file();
    const keys = new Set(loaded.schema.tables.map((t) => t.key));
    const refs = file.meta.refs.filter((r) => keys.has(r));
    const tables = refs.length ? refs : loaded.schema.tables.map((t) => t.key);
    const ok = await vscode.window.showWarningMessage(
      `用表结构重新生成“${file.meta.name}”吗？`,
      { modal: true, detail: `会用 ${tables.length} 张表的当前结构替换图里的 Mermaid 代码。还没同步的改动会丢失（可以 Ctrl+Z 撤回）。` },
      '重新生成',
    );
    if (ok !== '重新生成') return '已取消';
    this.lastFromWebview = undefined;
    await this.rewrite((f) => ({ ...f, code: generateErDiagram(loaded.schema!, tables), meta: { ...f.meta, refs: tables, ignored: [] } }));
    return undefined;
  }

  private async runCommand(command: 'copyForAI' | 'openText' | 'openCanvas'): Promise<void> {
    const arg = this.ref && { kind: 'diagram', workspace: this.ref.workspace, design: this.ref.design, id: this.ref.diagram };
    switch (command) {
      case 'copyForAI':
        if (arg) await vscode.commands.executeCommand('harness.diagram.copyForAI', arg);
        return;
      case 'openText':
        await vscode.window.showTextDocument(this.document.uri, { viewColumn: vscode.ViewColumn.Beside, preview: false });
        return;
      case 'openCanvas':
        if (this.ref) await vscode.commands.executeCommand('harness.design.open', { kind: 'design', workspace: this.ref.workspace, id: this.ref.design });
        return;
    }
  }

  private async rewrite(fn: (file: DiagramFile) => DiagramFile): Promise<void> {
    const text = this.document.getText();
    const next = serializeDiagram(fn(parseDiagram(text, this.ref?.diagram ?? '设计图')));
    if (next === text) return;
    const edit = new vscode.WorkspaceEdit();
    edit.replace(this.document.uri, new vscode.Range(this.document.positionAt(0), this.document.positionAt(text.length)), next);
    await vscode.workspace.applyEdit(edit);
  }

  dispose(): void {
    clearTimeout(this.syncTimer);
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }
}

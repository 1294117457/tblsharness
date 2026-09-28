import * as vscode from 'vscode';
import type { Harness } from '../commands/common';
import { LAST_DESIGN_DRIVER_KEY } from '../commands/design';
import { parseCanvas, serializeCanvas, type CanvasFile } from '../shared/canvas';
import type { EditHostMessage, EditInit, EditKind, EditValues, EditWebviewMessage } from '../shared/editProtocol';
import { DESIGN_DRIVERS, driverLabel } from '../shared/workspace';
import { readText, writeText } from '../workspace/fsUtil';
import type { HarnessWorkspace } from '../workspace/storage';
import { renderWebviewHtml, webviewOptions } from '../webview/html';

const KIND_LABEL: Record<EditKind, string> = { workspace: '工作区', design: '设计库', canvas: '画布' };

/** One edit page per workspace / design / canvas; opening it again just focuses it. */
export class EditPanels implements vscode.Disposable {
  private readonly panels = new Map<string, EditPanel>();

  constructor(readonly h: Harness) {}

  open(kind: EditKind, ws: HarnessWorkspace, id?: string): void {
    const key = `${kind}:${ws.id}:${id ?? ''}`;
    const existing = this.panels.get(key);
    if (existing) {
      existing.panel.reveal();
      return;
    }
    const panel = new EditPanel(this.h, kind, ws, id);
    this.panels.set(key, panel);
    panel.panel.onDidDispose(() => {
      this.panels.delete(key);
      panel.dispose();
    });
  }

  dispose(): void {
    for (const p of this.panels.values()) p.panel.dispose();
  }
}

class EditPanel implements vscode.Disposable {
  readonly panel: vscode.WebviewPanel;
  private disposed = false;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly h: Harness,
    private readonly kind: EditKind,
    private readonly ws: HarnessWorkspace,
    private readonly id?: string,
  ) {
    const context = h.context;
    this.panel = vscode.window.createWebviewPanel('harness.edit', `编辑${KIND_LABEL[kind]}`, vscode.ViewColumn.Active, webviewOptions(context));
    this.panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'harness.svg');
    this.panel.webview.html = renderWebviewHtml({ webview: this.panel.webview, context, title: this.panel.title, view: 'edit' });
    this.disposables.push(this.panel.webview.onDidReceiveMessage((msg: EditWebviewMessage) => void this.onMessage(msg)));
  }

  private post(msg: EditHostMessage): void {
    if (!this.disposed) void this.panel.webview.postMessage(msg);
  }

  private async onMessage(msg: EditWebviewMessage): Promise<void> {
    switch (msg.type) {
      case 'ready':
        try {
          const init = await this.load();
          this.panel.title = `编辑${KIND_LABEL[this.kind]} · ${init.name}`;
          this.post({ type: 'init', ...init });
        } catch (err) {
          vscode.window.showErrorMessage(`Harness：${(err as Error).message}`);
          this.panel.dispose();
        }
        return;
      case 'save':
        try {
          await this.save(msg);
          this.post({ type: 'result', requestId: msg.requestId, ok: true });
          this.panel.dispose();
        } catch (err) {
          this.post({ type: 'result', requestId: msg.requestId, ok: false, message: (err as Error).message });
        }
        return;
      case 'close':
        this.panel.dispose();
        return;
    }
  }

  private get canvasUri(): vscode.Uri {
    return this.ws.canvasUri(this.id!);
  }

  private async readCanvas(): Promise<CanvasFile> {
    return this.h.canvases.openDocument(this.canvasUri)?.state ?? parseCanvas(await readText(this.canvasUri));
  }

  private async load(): Promise<EditInit> {
    const wsMeta = await this.ws.readMeta();
    switch (this.kind) {
      case 'workspace':
        return { kind: 'workspace', workspaceName: wsMeta.name, name: wsMeta.name, description: wsMeta.description };
      case 'canvas': {
        const canvas = await this.readCanvas();
        return { kind: 'canvas', workspaceName: wsMeta.name, name: canvas.name, description: canvas.description };
      }
      case 'design': {
        const meta = await this.ws.design(this.id!).readMeta();
        const doc = await this.h.store.designDoc(this.ws.id, this.id!);
        const driver = doc.schema.driver?.name;
        const drivers = driver && !DESIGN_DRIVERS.some((d) => d.name === driver) ? [...DESIGN_DRIVERS, { name: driver, label: driverLabel(driver) ?? driver }] : DESIGN_DRIVERS;
        return {
          kind: 'design',
          workspaceName: wsMeta.name,
          name: meta.name,
          description: meta.description,
          driver,
          drivers,
          tableCount: doc.schema.tables.length,
        };
      }
    }
  }

  private async save(values: EditValues): Promise<void> {
    const name = values.name.trim();
    if (!name) throw new Error('名称不能为空');
    const description = values.description.trim() || undefined;
    switch (this.kind) {
      case 'workspace': {
        const meta = await this.ws.readMeta();
        if (meta.name !== name || meta.description !== description) await this.ws.writeMeta({ ...meta, name, description });
        this.h.store.invalidate({ workspace: this.ws.id, kind: 'workspace' });
        return;
      }
      case 'canvas': {
        const update = (c: CanvasFile) => (c.name === name && c.description === description ? c : { ...c, name, description });
        if (!this.h.canvases.transformIfOpen(this.canvasUri, update)) {
          const current = parseCanvas(await readText(this.canvasUri));
          const next = update(current);
          if (next !== current) await writeText(this.canvasUri, serializeCanvas(next));
        }
        this.h.store.invalidate({ workspace: this.ws.id, kind: 'canvas', id: this.id });
        return;
      }
      case 'design': {
        const source = this.ws.design(this.id!);
        const meta = await source.readMeta();
        if (meta.name !== name || meta.description !== description) await source.writeMeta({ ...meta, name, description });
        const doc = await this.h.store.designDoc(this.ws.id, this.id!);
        const driver = values.driver;
        if (driver && driver !== doc.schema.driver?.name) {
          await this.h.store.writeDesignDoc(this.ws.id, this.id!, { ...doc, schema: { ...doc.schema, driver: { ...doc.schema.driver, name: driver } } });
          await this.h.context.globalState.update(LAST_DESIGN_DRIVER_KEY, driver);
        }
        this.h.store.invalidate({ workspace: this.ws.id, kind: 'design', id: this.id });
        return;
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }
}

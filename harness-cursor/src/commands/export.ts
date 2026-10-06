/**
 * `harness.export.*`: the "export for AI" entry points.
 *
 * The dialog lives in the canvas webview, so the flow is: collect the inventory, hand it to
 * the webview, and take back a set of keys plus a target path. Only keys come back — the
 * webview is untrusted and must not be able to rename a table or claim a different source.
 *
 * Entry: `harness.export.open` is fired by the `⬇ 导出` button on the data source panel
 * (see `SourcePanel.vue`). It is *not* exposed in the command palette: an export only makes
 * sense from a design canvas, and the panel is always there. `pickPath` / `run` are webview
 * ⇄ host protocol commands and likewise never appear in the palette.
 */
import * as vscode from 'vscode';
import { buildExport } from '../export/builder';
import { collectExport, defaultExportDir, stamp, type CollectedExport } from '../export/collect';
import { reportExport, uniqueTargetDir, writeExport } from '../export/run';
import { exportKey, type ExportItem } from '../shared/protocol';
import { pickSourceId, pickWorkspace, register, type Harness, type NodeArg } from './common';

/** Kept so a later `export/run` resolves the same keys against the same inventory. */
const pending = new Map<string, { collected: CollectedExport }>();

async function targetFrom(h: Harness, requested: string, designName: string): Promise<vscode.Uri> {
  const root = defaultExportDir(h.context);
  await vscode.workspace.fs.createDirectory(root);
  if (requested.trim()) {
    // The webview sent a path; treat it as a parent folder to put the snapshot in.
    const parent = vscode.Uri.file(requested.trim());
    return uniqueTargetDir(parent, `${designName}-${stamp(new Date())}`);
  }
  return uniqueTargetDir(root, `${designName}-${stamp(new Date())}`);
}

export function registerExportCommands(h: Harness): void {
  /**
   * Opens the tree dialog on the design canvas. The data source panel of the canvas is
   * the only entry point — the command palette deliberately hides it (`commandPalette`
   * `when:false` in `package.json`). With no canvas open we surface a helpful error rather
   * than try to keep the QuickPick fallback alive.
   */
  register(h, 'harness.export.open', async (arg?: NodeArg) => {
    const ws = await pickWorkspace(h, arg);
    const design = await pickSourceId(h, ws, 'design', arg);
    const collected = await collectExport(h, ws.id, design);
    if (!collected.request.items.length) throw new Error('这个设计画布还没有可以导出的内容。');

    // The id lives on the request so the dialog can echo it; the host files the inventory under it.
    const requestId = `export-${Date.now().toString(36)}`;
    collected.request.requestId = requestId;
    pending.set(requestId, { collected });
    const opened = h.canvases.requestExport(ws.id, design, collected.request);
    if (!opened) throw new Error('请先在画布里打开这个设计库，然后再导出。');
  });

  /** The webview asked for a different folder. */
  register(h, 'harness.export.pickPath', async (arg?: NodeArg & { requestId?: string }) => {
    const picked = await vscode.window.showOpenDialog({
      title: '选择导出位置（会在此目录下新建一个带时间戳的文件夹）',
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      defaultUri: defaultExportDir(h.context),
    });
    const folder = picked?.[0];
    if (!folder) return;
    await h.canvases.postExportResult(arg?.requestId ?? '', { path: folder.fsPath });
  });

  /** The webview confirmed a selection. */
  register(h, 'harness.export.run', async (arg?: NodeArg & { requestId?: string; keys?: string[]; path?: string }) => {
    const requestId = arg?.requestId ?? '';
    const entry = requestId ? pending.get(requestId) : undefined;
    if (!entry) {
      await h.canvases.postExportResult(requestId, { error: '这次导出已经过期了，请重新打开导出对话框。' });
      return;
    }
    pending.delete(requestId);
    try {
      const summary = await runExport(h, entry, arg?.keys ?? [], arg?.path ?? '');
      await h.canvases.postExportResult(requestId, { message: summary });
    } catch (err) {
      await h.canvases.postExportResult(requestId, { error: (err as Error).message });
    }
  });
}

/** Turns the chosen keys into an export, resolving each key against the host's own inventory. */
async function runExport(h: Harness, entry: { collected: CollectedExport }, keys: string[], requestedPath: string): Promise<string> {
  const { collected } = entry;
  const chosen = new Set(keys);
  const picked = (item: ExportItem): boolean => chosen.has(exportKey(item));

  // Narrow the inventory to the selection; the builder then groups and renders it.
  const items = collected.request.items.filter(picked);
  if (!items.length) throw new Error('没有勾选任何内容。');

  const result = buildExport({
    designName: collected.request.designName,
    driverLabel: collected.request.driverLabel,
    generatedAt: new Date(),
    levels: collected.request.levels,
    tables: collected.tables.filter((t) => picked(t.item)),
    designRelations: collected.designRelations,
    dbRelations: collected.dbRelations,
    diagrams: collected.diagrams.filter((d) => picked(d.item)),
  });

  const target = await targetFrom(h, requestedPath, collected.request.designName);
  await writeExport(target, result.files);
  await reportExport({
    target,
    readme: vscode.Uri.joinPath(target, 'README.md'),
    files: result.files,
    counts: result.counts,
  });
  return `已导出到 ${target.fsPath}`;
}

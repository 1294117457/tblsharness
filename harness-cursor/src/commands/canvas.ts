import * as vscode from 'vscode';
import { emptyCanvas, nextAlias, parseCanvas, serializeCanvas, type CanvasEdit, type CanvasFile } from '../shared/canvas';
import { nextDefaultName, type SourceKind } from '../shared/workspace';
import { readText, writeText } from '../workspace/fsUtil';
import type { HarnessWorkspace } from '../workspace/storage';
import { canvasNames, closeTabsUnder, confirm, pickWorkspace, promptName, register, required, revealInTree, type Harness, type NodeArg } from './common';

export function registerCanvasCommands(h: Harness): void {
  register(h, 'harness.canvas.create', async (arg) => {
    const ws = await pickWorkspace(h, arg);
    const uri = await newCanvas(h, ws);
    await h.canvases.reveal(uri);
  });

  register(h, 'harness.canvas.open', async (arg) => {
    const ws = await pickWorkspace(h, arg);
    const id = arg?.id ?? (await pickCanvas(ws));
    await h.canvases.reveal(ws.canvasUri(id));
  });

  register(h, 'harness.canvas.rename', async (arg) => {
    const ws = await pickWorkspace(h, arg);
    const id = arg?.id ?? (await pickCanvas(ws));
    const uri = ws.canvasUri(id);
    const current = parseCanvas(await readText(uri));
    const name = await promptName('重命名画布', current.name);
    const rename = (c: CanvasFile) => ({ ...c, name });
    if (!h.canvases.transformIfOpen(uri, rename)) {
      await writeText(uri, serializeCanvas(rename(parseCanvas(await readText(uri)))));
    }
    h.store.invalidate({ workspace: ws.id, kind: 'canvas', id });
  });

  register(h, 'harness.canvas.delete', async (arg) => {
    const ws = await pickWorkspace(h, arg);
    const id = arg?.id ?? (await pickCanvas(ws));
    const uri = ws.canvasUri(id);
    const canvas = parseCanvas(await readText(uri));
    await confirm(`确定删除画布“${canvas.name}”吗？`, '只删除画布的布局和注释，不会影响任何数据源。', '删除');
    await closeTabsUnder(uri);
    await vscode.workspace.fs.delete(uri);
    h.store.invalidate({ workspace: ws.id, kind: 'canvas', id });
  });

  register(h, 'harness.source.addToCanvas', async (arg) => {
    const { ws, kind, ref, table } = await sourceFromArg(h, arg);
    const canvasId = await pickCanvas(ws, true);
    const uri = canvasId ? ws.canvasUri(canvasId) : await newCanvas(h, ws);
    await h.canvases.reveal(uri);
    await addToOpenCanvas(h, uri, kind, ref, table);
  });

  register(h, 'harness.table.revealInCanvas', async (arg) => {
    const { ws, kind, ref, table } = await sourceFromArg(h, arg);
    if (!table) throw new Error('请选择一张表');
    const matches: { id: string; name: string; alias: string }[] = [];
    for (const id of await ws.canvasIds()) {
      const uri = ws.canvasUri(id);
      const canvas = h.canvases.openDocument(uri)?.state ?? parseCanvas(await readText(uri));
      const source = canvas.sources.find((s) => s.kind === kind && s.ref === ref);
      if (source && (source.tables === 'all' || canvas.nodes.some((n) => n.source === source.alias && n.table === table))) {
        matches.push({ id, name: canvas.name, alias: source.alias });
      }
    }
    if (!matches.length) {
      const add = await vscode.window.showInformationMessage(`还没有画布包含表 ${table}，要添加到画布吗？`, '添加到画布…');
      if (add) await vscode.commands.executeCommand('harness.source.addToCanvas', arg);
      return;
    }
    const open = matches.find((m) => h.canvases.openDocument(ws.canvasUri(m.id)));
    const target =
      open ??
      (matches.length === 1
        ? matches[0]
        : required(await vscode.window.showQuickPick(matches.map((m) => ({ label: m.name, description: m.id, m })), { title: '在哪个画布中定位？' })).m);
    await h.canvases.reveal(ws.canvasUri(target.id), { alias: target.alias, table });
  });
}

async function newCanvas(h: Harness, ws: HarnessWorkspace): Promise<vscode.Uri> {
  const name = nextDefaultName('画布', await canvasNames(h, ws));
  const id = await ws.createCanvas(emptyCanvas(name));
  h.store.invalidate({ workspace: ws.id, kind: 'canvas', id });
  void revealInTree(h, { kind: 'canvas', workspace: ws.id, id });
  return ws.canvasUri(id);
}

async function pickCanvas(ws: HarnessWorkspace): Promise<string>;
async function pickCanvas(ws: HarnessWorkspace, allowNew: true): Promise<string | undefined>;
async function pickCanvas(ws: HarnessWorkspace, allowNew = false): Promise<string | undefined> {
  const ids = await ws.canvasIds();
  const items = await Promise.all(
    ids.map(async (id) => {
      let name = id;
      try {
        name = parseCanvas(await readText(ws.canvasUri(id))).name;
      } catch {
        // fall back to the id
      }
      return { label: `$(type-hierarchy) ${name}`, description: id, id: id as string | undefined };
    }),
  );
  if (allowNew) items.push({ label: '$(add) 新建画布…', description: '', id: undefined });
  if (!items.length) throw new Error('这个工作区还没有画布');
  return required(await vscode.window.showQuickPick(items, { title: '选择画布' })).id;
}

async function sourceFromArg(h: Harness, arg?: NodeArg): Promise<{ ws: HarnessWorkspace; kind: SourceKind; ref: string; table?: string }> {
  const ws = await pickWorkspace(h, arg);
  if (arg?.kind === 'table' && arg.source && arg.id) return { ws, kind: arg.source, ref: arg.id, table: arg.table?.key };
  if ((arg?.kind === 'design' || arg?.kind === 'db') && arg.id) return { ws, kind: arg.kind, ref: arg.id };
  throw new Error('请在侧边栏中选择一个数据源或表');
}

/** Adds the source (and table) to an open canvas as one undoable edit. */
async function addToOpenCanvas(h: Harness, uri: vscode.Uri, kind: SourceKind, ref: string, table?: string): Promise<void> {
  const doc = h.canvases.openDocument(uri);
  if (!doc) return;
  const edit: CanvasEdit = [];
  let source = doc.state.sources.find((s) => s.kind === kind && s.ref === ref);
  if (!source) {
    source = { alias: nextAlias(doc.state, kind), kind, ref, tables: table ? 'picked' : 'all' };
    edit.push({ op: 'source.add', source });
  }
  if (table && source.tables === 'picked' && !doc.state.nodes.some((n) => n.source === source!.alias && n.table === table)) {
    const maxX = Math.max(0, ...doc.state.nodes.map((n) => n.x + 320));
    const minY = Math.min(0, ...doc.state.nodes.map((n) => n.y));
    edit.push({ op: 'nodes.put', nodes: [{ source: source.alias, table, x: maxX, y: minY }] });
  }
  if (edit.length) h.canvases.applyHostEdit(doc, table ? `添加表 ${table}` : '添加数据源', edit);
  if (table) await h.canvases.reveal(uri, { alias: source.alias, table });
}

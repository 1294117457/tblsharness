import * as vscode from 'vscode';
import { DESIGN_SOURCE, emptyCanvas, parseCanvas, serializeCanvas, type CanvasEdit, type CanvasFile } from '../shared/canvas';
import { nextDefaultName, uniqueName, type SourceKind } from '../shared/workspace';
import { readText, writeText } from '../workspace/fsUtil';
import type { Design, HarnessWorkspace } from '../workspace/storage';
import {
  canvasNames,
  closeTabsUnder,
  confirm,
  pickSourceId,
  pickWorkspace,
  promptName,
  register,
  required,
  revealInTree,
  type Harness,
  type NodeArg,
} from './common';

export function registerCanvasCommands(h: Harness): void {
  register(h, 'harness.canvas.create', async (arg) => {
    const ws = await pickWorkspace(h, arg);
    const designId = await pickDesign(h, ws, arg);
    const design = ws.design(designId);
    const uri = await newCanvas(h, design, ws.id, designId);
    await h.canvases.reveal(uri);
  });

  register(h, 'harness.canvas.open', async (arg) => {
    const ws = await pickWorkspace(h, arg);
    const designId = await pickDesign(h, ws, arg);
    const design = ws.design(designId);
    const canvasId = arg?.id && arg.kind === 'canvas' ? arg.id : await pickCanvas(design);
    await h.canvases.reveal(design.canvasUri(canvasId));
  });

  register(h, 'harness.canvas.rename', async (arg) => {
    const ws = await pickWorkspace(h, arg);
    const designId = await pickDesign(h, ws, arg);
    const design = ws.design(designId);
    const canvasId = arg?.id && arg.kind === 'canvas' ? arg.id : await pickCanvas(design);
    const uri = design.canvasUri(canvasId);
    const current = parseCanvas(await readText(uri));
    const name = await promptName('重命名画布', current.name);
    const rename = (c: CanvasFile) => ({ ...c, name });
    if (!h.canvases.transformIfOpen(uri, rename)) {
      await writeText(uri, serializeCanvas(rename(parseCanvas(await readText(uri)))));
    }
    h.store.invalidate({ workspace: ws.id, kind: 'canvas', id: canvasId, design: designId });
  });

  register(h, 'harness.canvas.delete', async (arg) => {
    const ws = await pickWorkspace(h, arg);
    const designId = await pickDesign(h, ws, arg);
    const design = ws.design(designId);
    const canvasId = arg?.id && arg.kind === 'canvas' ? arg.id : await pickCanvas(design);
    const uri = design.canvasUri(canvasId);
    const canvas = parseCanvas(await readText(uri));
    await confirm(`确定删除画布"${canvas.name}"吗？`, '只删除画布的布局和注释，不会影响设计表结构。', '删除');
    await closeTabsUnder(uri);
    await vscode.workspace.fs.delete(uri);
    h.store.invalidate({ workspace: ws.id, kind: 'canvas', id: canvasId, design: designId });
  });

  register(h, 'harness.source.addToCanvas', async (arg) => {
    const { ws, kind, ref, table } = await sourceFromArg(h, arg);
    if (kind === 'design') {
      throw new Error('设计表已在画布中，无需再次添加。');
    }
    const designId = await pickDesign(h, ws, arg);
    const design = ws.design(designId);
    const canvasId = await pickCanvas(design, true);
    const uri = canvasId ? design.canvasUri(canvasId) : await newCanvas(h, design, ws.id, designId);
    await h.canvases.reveal(uri);
    await addDbToOpenCanvas(h, uri, ref, table);
  });

  /** Opens the last canvas of a design, or an existing canvas, or creates a new one. */
  register(h, 'harness.design.open', async (arg) => {
    const ws = await pickWorkspace(h, arg);
    const designId = await pickSourceId(h, ws, 'design', arg);
    const design = ws.design(designId);
    const meta = await design.readMeta();

    if (meta.lastCanvas) {
      try {
        const uri = design.canvasUri(meta.lastCanvas);
        await h.canvases.reveal(uri);
        return;
      } catch {
        // last canvas no longer exists; fall through
      }
    }

    const canvasIds = await design.canvasIds();
    if (canvasIds.length > 0) {
      await h.canvases.reveal(design.canvasUri(canvasIds[0]));
      return;
    }

    const canvas = emptyCanvas(uniqueName(meta.name, await canvasNames(h, design)));
    canvas.designTables = 'all';
    const id = await design.createCanvas(serializeCanvas(canvas));
    h.store.invalidate({ workspace: ws.id, kind: 'canvas', id, design: designId });
    await h.canvases.reveal(design.canvasUri(id));
  });

  register(h, 'harness.table.revealInCanvas', async (arg) => {
    const { ws, kind, ref, table } = await sourceFromArg(h, arg);
    if (!table) throw new Error('请选择一张表');

    const source = kind === 'design' ? DESIGN_SOURCE : ref;
    const matches: { designId: string; canvasId: string; name: string }[] = [];

    for (const designId of await ws.designIds()) {
      const design = ws.design(designId);
      for (const canvasId of await design.canvasIds()) {
        const uri = design.canvasUri(canvasId);
        try {
          const canvas = h.canvases.openDocument(uri)?.state ?? parseCanvas(await readText(uri));
          const hasDesignAll = kind === 'design' && canvas.designTables === 'all';
          const hasNode = canvas.nodes.some((n) => n.source === source && n.table === table);
          if (hasDesignAll || hasNode) {
            matches.push({ designId, canvasId, name: canvas.name });
          }
        } catch {
          // unreadable canvas: skip
        }
      }
    }

    if (!matches.length) {
      const add = await vscode.window.showInformationMessage(`还没有画布包含表 ${table}，要添加到画布吗？`, '添加到画布…');
      if (add) await vscode.commands.executeCommand('harness.source.addToCanvas', arg);
      return;
    }

    const open = matches.find((m) => h.canvases.openDocument(ws.design(m.designId).canvasUri(m.canvasId)));
    const target =
      open ??
      (matches.length === 1
        ? matches[0]
        : required(await vscode.window.showQuickPick(matches.map((m) => ({ label: m.name, description: m.canvasId, ...m })), { title: '在哪个画布中定位？' })));
    await h.canvases.reveal(ws.design(target.designId).canvasUri(target.canvasId), { source, table });
  });
}

async function newCanvas(h: Harness, design: Design, workspaceId: string, designId: string): Promise<vscode.Uri> {
  const name = nextDefaultName('画布', await canvasNames(h, design));
  const canvas = emptyCanvas(name);
  canvas.designTables = 'picked';
  const id = await design.createCanvas(serializeCanvas(canvas));
  h.store.invalidate({ workspace: workspaceId, kind: 'canvas', id, design: designId });
  void revealInTree(h, { kind: 'canvas', workspace: workspaceId, design: designId, id });
  return design.canvasUri(id);
}

async function pickDesign(h: Harness, ws: HarnessWorkspace, arg?: NodeArg): Promise<string> {
  if (arg?.design) return arg.design;
  return pickSourceId(h, ws, 'design', arg);
}

async function pickCanvas(design: Design): Promise<string>;
async function pickCanvas(design: Design, allowNew: true): Promise<string | undefined>;
async function pickCanvas(design: Design, allowNew = false): Promise<string | undefined> {
  const ids = await design.canvasIds();
  const items = await Promise.all(
    ids.map(async (id) => {
      let name = id;
      try {
        name = parseCanvas(await readText(design.canvasUri(id))).name;
      } catch {
        // fall back to the id
      }
      return { label: `$(type-hierarchy) ${name}`, description: id, id: id as string | undefined };
    }),
  );
  if (allowNew) items.push({ label: '$(add) 新建画布…', description: '', id: undefined });
  if (!items.length) throw new Error('这个设计画布还没有画布');
  return required(await vscode.window.showQuickPick(items, { title: '选择画布' })).id;
}

async function sourceFromArg(h: Harness, arg?: NodeArg): Promise<{ ws: HarnessWorkspace; kind: SourceKind; ref: string; table?: string }> {
  const ws = await pickWorkspace(h, arg);
  if (arg?.kind === 'table' && arg.source && arg.id) return { ws, kind: arg.source, ref: arg.id, table: arg.table?.key };
  if ((arg?.kind === 'design' || arg?.kind === 'db') && arg.id) return { ws, kind: arg.kind, ref: arg.id };
  throw new Error('请在侧边栏中选择一个数据源或表');
}

/** Adds a database source (and table) to an open canvas as one undoable edit. */
async function addDbToOpenCanvas(h: Harness, uri: vscode.Uri, dbId: string, table?: string): Promise<void> {
  const doc = h.canvases.openDocument(uri);
  if (!doc) return;
  const edit: CanvasEdit = [];
  if (table && !doc.state.nodes.some((n) => n.source === dbId && n.table === table)) {
    const maxX = Math.max(0, ...doc.state.nodes.map((n) => n.x + 320));
    const minY = Math.min(0, ...doc.state.nodes.map((n) => n.y));
    edit.push({ op: 'nodes.put', nodes: [{ source: dbId, table, x: maxX, y: minY }] });
  }
  if (edit.length) h.canvases.applyHostEdit(doc, table ? `添加表 ${table}` : '添加数据库', edit);
  if (table) await h.canvases.reveal(uri, { source: dbId, table });
}

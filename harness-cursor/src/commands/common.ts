import * as vscode from 'vscode';
import type { CanvasEditorProvider } from '../canvas/canvasEditor';
import type { ConnectionPanels } from '../connection/connectionPanel';
import type { DiagramService } from '../diagram/diagramService';
import type { EditPanels } from '../edit/editPanel';
import type { ModelStore } from '../model/store';
import type { SourceKind } from '../shared/workspace';
import type { TreeNode, WorkspaceTreeProvider } from '../views/workspaceTree';
import type { HarnessStorage, HarnessWorkspace } from '../workspace/storage';

export interface Harness {
  context: vscode.ExtensionContext;
  storage: HarnessStorage;
  store: ModelStore;
  tree: WorkspaceTreeProvider;
  treeView: vscode.TreeView<TreeNode>;
  canvases: CanvasEditorProvider;
  connections: ConnectionPanels;
  editors: EditPanels;
  diagrams: DiagramService;
}

/** Selects a freshly created node; waits for the debounced tree refresh first so the node exists. */
export async function revealInTree(h: Harness, node: TreeNode): Promise<void> {
  await new Promise((r) => setTimeout(r, 250));
  try {
    await h.treeView.reveal(node, { select: true, focus: false, expand: node.kind === 'workspace' ? 2 : false });
  } catch {
    // The view may be hidden or the node already gone; selection is only a convenience.
  }
}

export async function workspaceNames(h: Harness): Promise<string[]> {
  return Promise.all((await h.storage.listWorkspaces()).map(async (w) => (await w.readMeta()).name));
}

export async function designNames(ws: HarnessWorkspace): Promise<string[]> {
  return Promise.all((await ws.designIds()).map(async (id) => (await ws.design(id).readMeta()).name));
}

/** Commands receive tree nodes, or `{ workspace, id }` from the canvas webview, or nothing from the palette. */
export interface NodeArg {
  workspace?: string;
  id?: string;
  kind?: string;
  /** For partition/diagram/group nodes: the design they belong to. */
  design?: string;
  source?: SourceKind;
  table?: { key: string };
  /** The level (partition canvas) a node belongs to or points at; missing for the root canvas. */
  partition?: string;
}

export function register(h: Harness, id: string, fn: (arg?: NodeArg) => unknown): void {
  h.context.subscriptions.push(
    vscode.commands.registerCommand(id, async (arg?: NodeArg) => {
      try {
        await fn(arg);
      } catch (err) {
        if (!(err instanceof Cancelled)) vscode.window.showErrorMessage(`Harness：${(err as Error).message}`);
      }
    }),
  );
}

/** Thrown when the user dismisses a prompt; swallowed by `register`. */
export class Cancelled extends Error {}

export function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Cancelled();
  return value;
}

export async function pickWorkspace(h: Harness, arg?: NodeArg): Promise<HarnessWorkspace> {
  if (arg?.workspace) return h.storage.workspace(arg.workspace);
  const all = await h.storage.listWorkspaces();
  if (!all.length) {
    const create = await vscode.window.showInformationMessage('还没有工作区，先新建一个吧。', '新建工作区');
    if (create) await vscode.commands.executeCommand('harness.workspace.create');
    throw new Cancelled();
  }
  if (all.length === 1) return all[0];
  const items = await Promise.all(all.map(async (ws) => ({ label: (await ws.readMeta()).name, description: ws.id, ws })));
  const pick = required(await vscode.window.showQuickPick(items, { title: '选择工作区' }));
  return pick.ws;
}

export async function pickSourceId(h: Harness, ws: HarnessWorkspace, kind: SourceKind, arg?: NodeArg): Promise<string> {
  if (arg?.id && (arg.kind === kind || arg.kind === undefined || (arg.kind === 'table' && (arg.source ?? kind) === kind))) return arg.id;
  if (kind === 'design' && arg?.design) return arg.design;
  const ids = kind === 'design' ? await ws.designIds() : await ws.dbIds();
  if (!ids.length) throw new Error(kind === 'design' ? '这个工作区还没有设计画布' : '这个工作区还没有数据库');
  if (ids.length === 1) return ids[0];
  const items = await Promise.all(ids.map(async (id) => ({ label: await sourceName(h, ws, kind, id), description: id, id })));
  return required(await vscode.window.showQuickPick(items, { title: kind === 'design' ? '选择设计画布' : '选择数据库' })).id;
}

/** Display name; for a db source that is `host:port/db`, derived from its connection. */
export async function sourceName(h: Harness, ws: HarnessWorkspace, kind: SourceKind, id: string): Promise<string> {
  return kind === 'db' ? h.store.dbName(ws.id, id) : (await ws.design(id).readMeta()).name;
}

export async function promptName(title: string, value?: string, placeHolder?: string): Promise<string> {
  const name = await vscode.window.showInputBox({
    title,
    value,
    placeHolder,
    prompt: '显示名称，可以使用中文',
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? undefined : '名称不能为空'),
  });
  return required(name?.trim() || undefined);
}

export async function confirm(message: string, detail: string | undefined, action: string): Promise<void> {
  const ok = await vscode.window.showWarningMessage(message, { modal: true, detail }, action);
  if (ok !== action) throw new Cancelled();
}

/** Closes editor tabs whose file lives under `dir`, e.g. before deleting it. */
export async function closeTabsUnder(dir: vscode.Uri): Promise<void> {
  const prefix = dir.toString().replace(/\/?$/, '/');
  const tabs = vscode.window.tabGroups.all
    .flatMap((g) => g.tabs)
    .filter((t) => {
      const input = t.input as { uri?: vscode.Uri } | undefined;
      return input?.uri && (input.uri.toString().startsWith(prefix) || input.uri.toString() === dir.toString());
    });
  if (tabs.length) await vscode.window.tabGroups.close(tabs);
}

import { reactive, shallowRef } from 'vue';
import { applyCanvasEdit, emptyCanvas, partitionPath, ROOT_SCOPE, type CanvasEdit, type CanvasFile, type ItemRef, type MoveItem, type Viewport } from '@shared/canvas';
import type { ClipboardMode, Position } from '@shared/clipboard';
import type { DesignOp } from '@shared/designOps';
import type { ClipboardInfo, ComparisonData, DesignContext, DiagramData, HostMessage, SourceData, WorkspaceCatalog } from '@shared/protocol';
import type { SyncGroup } from '@shared/sync';
import { post, request, settleReply } from './vscode';

export type Selection =
  | { type: 'table'; nodeId: string }
  | { type: 'column'; nodeId: string; column: string }
  | { type: 'relation'; source: string; key: string }
  | { type: 'note'; id: string }
  | { type: 'diagram'; id: string }
  | { type: 'partition'; id: string }
  | undefined;

export interface FocusRequest {
  /** Vue Flow node ID. */
  nodeId: string;
  column?: string;
  seq: number;
}

interface State {
  loaded: boolean;
  error?: string;
  design?: DesignContext;
  catalog?: WorkspaceCatalog;
  comparison?: ComparisonData;
  sources: Record<string, SourceData>;
  diagrams: DiagramData[];
  /** The level being shown; `undefined` is the root canvas. */
  scope?: string;
  /** Bumped on every scope switch so the canvas can refit. */
  scopeSeq: number;
  clipboard?: ClipboardInfo;
  selection: Selection;
  focus?: FocusRequest;
  toast?: { message: string; level: 'info' | 'error'; seq: number };
  pending: SyncGroup[];
}

/** Kept outside `reactive` because it is replaced wholesale and deep-watching it would be expensive. */
export const canvas = shallowRef<CanvasFile>(emptyCanvas());

export const state = reactive<State>({ loaded: false, sources: {}, diagrams: [], scopeSeq: 0, selection: undefined, pending: [] });

/** Last viewport per level in this session, seeded from `layout.json`. */
export const viewports = new Map<string, Viewport>();

let toastSeq = 0;
let focusSeq = 0;

export function toast(message: string, level: 'info' | 'error' = 'info'): void {
  state.toast = { message, level, seq: ++toastSeq };
}

export function scopeKey(scope: string | undefined): string {
  return scope ?? ROOT_SCOPE;
}

function validScope(scope: string | undefined): string | undefined {
  return scope && partitionPath(canvas.value, scope).length ? scope : undefined;
}

function applyScope(scope: string | undefined): void {
  const next = validScope(scope);
  if (next === state.scope && state.scopeSeq) return;
  state.scope = next;
  state.scopeSeq++;
  state.selection = undefined;
}

export function setScope(scope: string | undefined): void {
  applyScope(scope);
  post({ type: 'scope', scope: state.scope });
}

export function handleHostMessage(msg: HostMessage): void {
  switch (msg.type) {
    case 'init':
      canvas.value = msg.canvas;
      viewports.clear();
      for (const [k, v] of Object.entries(msg.canvas.viewports ?? {})) viewports.set(k, v);
      state.design = msg.design;
      state.sources = Object.fromEntries(msg.sources.map((s) => [s.source, s]));
      state.diagrams = msg.diagrams;
      state.catalog = msg.catalog;
      state.comparison = msg.comparison;
      state.clipboard = msg.clipboard;
      state.error = msg.error;
      state.loaded = true;
      applyScope(msg.scope);
      return;
    case 'canvas':
      canvas.value = msg.canvas;
      if (state.scope && !validScope(state.scope)) setScope(undefined);
      return;
    case 'source':
      state.sources = { ...state.sources, [msg.source.source]: msg.source };
      return;
    case 'design':
      state.design = msg.design;
      return;
    case 'diagrams':
      state.diagrams = msg.diagrams;
      return;
    case 'comparison':
      state.comparison = msg.comparison;
      return;
    case 'catalog':
      state.catalog = msg.catalog;
      return;
    case 'clipboard':
      state.clipboard = msg.clipboard;
      return;
    case 'reply':
      settleReply(msg.requestId, msg.ok, msg.error, msg.message);
      return;
    case 'pendingSync':
      state.pending = msg.groups;
      return;
    case 'scope':
      applyScope(msg.scope);
      if (msg.focus) {
        const id = flowId(msg.focus);
        state.focus = { nodeId: id, seq: ++focusSeq };
      }
      return;
    case 'focus': {
      const id = `${msg.source}/${msg.table}`;
      state.focus = { nodeId: id, column: msg.column, seq: ++focusSeq };
      state.selection = msg.column ? { type: 'column', nodeId: id, column: msg.column } : { type: 'table', nodeId: id };
      return;
    }
  }
}

/** Vue Flow node ID of a layout item. */
export function flowId(ref: ItemRef): string {
  return ref.kind === 'table' ? ref.id : `${ref.kind === 'partition' ? 'part' : ref.kind}:${ref.id}`;
}

export function itemOfFlowId(id: string): ItemRef {
  if (id.startsWith('part:')) return { kind: 'partition', id: id.slice(5) };
  if (id.startsWith('diagram:')) return { kind: 'diagram', id: id.slice(8) };
  if (id.startsWith('note:')) return { kind: 'note', id: id.slice(5) };
  return { kind: 'table', id };
}

export function focusNode(nodeId: string, column?: string): void {
  state.focus = { nodeId, column, seq: ++focusSeq };
}

/** Layout edits are applied locally right away; the host records them for undo and saving. */
export function editCanvas(label: string, edit: CanvasEdit): void {
  if (!edit.length) return;
  const next = applyCanvasEdit(canvas.value, edit);
  if (next === canvas.value) return;
  canvas.value = next;
  post({ type: 'canvas/edit', label, edit });
}

function reportError(err: unknown): void {
  const message = (err as Error).message;
  if (message !== '已取消') toast(message, 'error');
}

/** Design edits wait for the host, which validates them and writes the design source. */
export async function designOp(ops: DesignOp[], label: string, canvasEdit?: CanvasEdit): Promise<boolean> {
  try {
    await request({ type: 'design/op', ops, label, canvasEdit });
    return true;
  } catch (err) {
    reportError(err);
    return false;
  }
}

export function setClipboard(mode: ClipboardMode, items: ItemRef[]): void {
  if (!items.length) return;
  post({ type: 'clipboard/set', mode, items });
  toast(`已${mode === 'copy' ? '复制' : '剪切'} ${items.length} 项，进入目标画布（或选中分区框）后按 Ctrl+V 粘贴`);
}

export async function paste(partition: string | undefined, at?: Position, positions?: Record<string, Position>): Promise<void> {
  try {
    const message = await request({ type: 'clipboard/paste', partition, at, positions });
    if (message) toast(message);
  } catch (err) {
    reportError(err);
  }
}

/** Moves items to other levels; resolves `false` when cancelled or rejected so the caller can snap back. */
export async function moveItems(items: MoveItem[]): Promise<boolean> {
  try {
    const message = await request({ type: 'items/move', items });
    if (message) toast(message);
    return true;
  } catch (err) {
    reportError(err);
    return false;
  }
}

export async function deletePartition(id: string): Promise<void> {
  try {
    await request({ type: 'partition/delete', id });
    if (state.selection?.type === 'partition' && state.selection.id === id) state.selection = undefined;
  } catch (err) {
    reportError(err);
  }
}

export async function deleteDiagram(id: string): Promise<void> {
  try {
    await request({ type: 'diagram/delete', diagram: id });
  } catch (err) {
    reportError(err);
  }
}

export async function applySync(group: SyncGroup, ids: string[], choices: Record<string, string>): Promise<boolean> {
  try {
    await request({ type: 'sync/apply', diagram: group.diagram, ids, choices });
    toast(`已从"${group.diagramName}"同步 ${ids.length} 项到表结构，可以 Ctrl+Z 撤销`);
    return true;
  } catch (err) {
    reportError(err);
    return false;
  }
}

export async function ignoreSync(group: SyncGroup, ids: string[], clear = false): Promise<void> {
  try {
    await request({ type: 'sync/ignore', diagram: group.diagram, ids, clear });
  } catch (err) {
    toast((err as Error).message, 'error');
  }
}

export async function acceptDiff(id: string, accepted: boolean): Promise<void> {
  try {
    await request({ type: 'diff/accept', id, accepted });
  } catch (err) {
    toast((err as Error).message, 'error');
  }
}

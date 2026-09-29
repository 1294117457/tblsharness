import { reactive, shallowRef } from 'vue';
import { applyCanvasEdit, emptyCanvas, type CanvasEdit, type CanvasFile } from '@shared/canvas';
import type { DesignOp } from '@shared/designOps';
import type { ComparisonData, DesignContext, HostMessage, SourceData, WorkspaceCatalog } from '@shared/protocol';
import type { SyncGroup } from '@shared/sync';
import { post, request, settleReply } from './vscode';

export type Selection =
  | { type: 'table'; nodeId: string }
  | { type: 'column'; nodeId: string; column: string }
  | { type: 'relation'; source: string; key: string }
  | { type: 'note'; id: string }
  | { type: 'zone'; id: string }
  | undefined;

export interface FocusRequest {
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
  selection: Selection;
  focus?: FocusRequest;
  toast?: { message: string; level: 'info' | 'error'; seq: number };
  pending: SyncGroup[];
}

/** Kept outside `reactive` because it is replaced wholesale and deep-watching it would be expensive. */
export const canvas = shallowRef<CanvasFile>(emptyCanvas(''));

export const state = reactive<State>({ loaded: false, sources: {}, selection: undefined, pending: [] });

let toastSeq = 0;
let focusSeq = 0;

export function toast(message: string, level: 'info' | 'error' = 'info'): void {
  state.toast = { message, level, seq: ++toastSeq };
}

export function handleHostMessage(msg: HostMessage): void {
  switch (msg.type) {
    case 'init':
      canvas.value = msg.canvas;
      state.design = msg.design;
      state.sources = Object.fromEntries(msg.sources.map((s) => [s.source, s]));
      state.catalog = msg.catalog;
      state.comparison = msg.comparison;
      state.error = msg.error;
      state.loaded = true;
      return;
    case 'canvas':
      canvas.value = msg.canvas;
      return;
    case 'source':
      state.sources = { ...state.sources, [msg.source.source]: msg.source };
      return;
    case 'design':
      state.design = msg.design;
      return;
    case 'comparison':
      state.comparison = msg.comparison;
      return;
    case 'catalog':
      state.catalog = msg.catalog;
      return;
    case 'reply':
      settleReply(msg.requestId, msg.ok, msg.error);
      return;
    case 'pendingSync':
      state.pending = msg.groups;
      return;
    case 'focus':
      state.focus = { nodeId: `${msg.source}/${msg.table}`, column: msg.column, seq: ++focusSeq };
      state.selection = msg.column ? { type: 'column', nodeId: `${msg.source}/${msg.table}`, column: msg.column } : { type: 'table', nodeId: `${msg.source}/${msg.table}` };
      return;
  }
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

/** Design edits wait for the host, which validates them and writes the design source. */
export async function designOp(ops: DesignOp[], label: string, canvasEdit?: CanvasEdit): Promise<boolean> {
  try {
    await request({ type: 'design/op', ops, label, canvasEdit });
    return true;
  } catch (err) {
    const message = (err as Error).message;
    if (message !== '已取消') toast(message, 'error');
    return false;
  }
}

export async function applySync(group: SyncGroup, ids: string[], choices: Record<string, string>): Promise<boolean> {
  try {
    await request({ type: 'sync/apply', diagram: group.diagram, ids, choices });
    toast(`已从"${group.diagramName}"同步 ${ids.length} 项到表结构，可以 Ctrl+Z 撤销`);
    return true;
  } catch (err) {
    const message = (err as Error).message;
    if (message !== '已取消') toast(message, 'error');
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

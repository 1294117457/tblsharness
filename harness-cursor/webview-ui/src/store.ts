import { reactive, shallowRef } from 'vue';
import { applyCanvasEdit, emptyCanvas, type CanvasEdit, type CanvasFile } from '@shared/canvas';
import type { DesignOp } from '@shared/designOps';
import type { ComparisonData, HostMessage, SourceData, WorkspaceCatalog } from '@shared/protocol';
import { post, request, settleReply } from './vscode';

export type Selection =
  | { type: 'table'; nodeId: string }
  | { type: 'column'; nodeId: string; column: string }
  | { type: 'relation'; alias: string; key: string }
  | { type: 'note'; id: string }
  | undefined;

export interface FocusRequest {
  nodeId: string;
  column?: string;
  seq: number;
}

interface State {
  loaded: boolean;
  error?: string;
  catalog?: WorkspaceCatalog;
  comparison?: ComparisonData;
  sources: Record<string, SourceData>;
  selection: Selection;
  focus?: FocusRequest;
  toast?: { message: string; level: 'info' | 'error'; seq: number };
}

/** Kept outside `reactive` because it is replaced wholesale and deep-watching it would be expensive. */
export const canvas = shallowRef<CanvasFile>(emptyCanvas(''));

export const state = reactive<State>({ loaded: false, sources: {}, selection: undefined });

let toastSeq = 0;
let focusSeq = 0;

export function toast(message: string, level: 'info' | 'error' = 'info'): void {
  state.toast = { message, level, seq: ++toastSeq };
}

export function handleHostMessage(msg: HostMessage): void {
  switch (msg.type) {
    case 'init':
      canvas.value = msg.canvas;
      state.sources = Object.fromEntries(msg.sources.map((s) => [s.alias, s]));
      state.catalog = msg.catalog;
      state.comparison = msg.comparison;
      state.error = msg.error;
      state.loaded = true;
      return;
    case 'canvas':
      canvas.value = msg.canvas;
      return;
    case 'source':
      state.sources = { ...state.sources, [msg.source.alias]: msg.source };
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
    case 'focus':
      state.focus = { nodeId: `${msg.alias}/${msg.table}`, column: msg.column, seq: ++focusSeq };
      state.selection = msg.column ? { type: 'column', nodeId: `${msg.alias}/${msg.table}`, column: msg.column } : { type: 'table', nodeId: `${msg.alias}/${msg.table}` };
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
export async function designOp(alias: string, ops: DesignOp[], label: string, canvasEdit?: CanvasEdit): Promise<boolean> {
  try {
    await request({ type: 'design/op', alias, ops, label, canvasEdit });
    return true;
  } catch (err) {
    const message = (err as Error).message;
    if (message !== '已取消') toast(message, 'error');
    return false;
  }
}

export async function acceptDiff(id: string, accepted: boolean): Promise<void> {
  try {
    await request({ type: 'diff/accept', id, accepted });
  } catch (err) {
    toast((err as Error).message, 'error');
  }
}

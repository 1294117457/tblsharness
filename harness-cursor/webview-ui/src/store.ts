import { reactive, shallowRef } from 'vue';
import { applyCanvasEdit, emptyCanvas, partitionOf, partitionPath, ROOT_SCOPE, type CanvasEdit, type CanvasFile, type ItemRef, type MoveItem, type Viewport } from '@shared/canvas';
import type { ClipboardMode, Position } from '@shared/clipboard';
import type { DesignOp } from '@shared/designOps';
import type { ClipboardInfo, ComparisonData, DesignContext, DiagramData, HostMessage, RevealTarget, SourceData, WorkspaceCatalog } from '@shared/protocol';
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

/** Asks the canvas to fit its viewport to these nodes. An empty list fits the current level. */
export interface FocusRequest {
  /** Vue Flow node IDs. */
  nodeIds: string[];
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
  /**
   * The current level: where the left panel lists, toolbar creation and paste go.
   * `undefined` is the root canvas. The whole canvas is always rendered regardless.
   */
  level?: string;
  clipboard?: ClipboardInfo;
  selection: Selection;
  focus?: FocusRequest;
  /** Asks the diagram panel to put the cursor in the Mermaid text. */
  editDiagram?: { id: string; seq: number };
  /** Asks the canvas to replace its selection with these nodes. */
  selectRequest?: { nodeIds: string[]; seq: number };
  toast?: { message: string; level: 'info' | 'error'; seq: number };
  pending: SyncGroup[];
}

/** Kept outside `reactive` because it is replaced wholesale and deep-watching it would be expensive. */
export const canvas = shallowRef<CanvasFile>(emptyCanvas());

export const state = reactive<State>({ loaded: false, sources: {}, diagrams: [], selection: undefined, pending: [] });

/** The root viewport saved in `layout.json`, restored once on load. */
export const savedViewport = shallowRef<Viewport | undefined>();

let toastSeq = 0;
let focusSeq = 0;

export function toast(message: string, level: 'info' | 'error' = 'info'): void {
  state.toast = { message, level, seq: ++toastSeq };
}

function validLevel(level: string | undefined): string | undefined {
  return level && partitionPath(canvas.value, level).length ? level : undefined;
}

export function setLevel(level: string | undefined): void {
  const next = validLevel(level);
  if (next === state.level) return;
  state.level = next;
  post({ type: 'level', level: next });
}

/** The level an item belongs to when selected: a partition is its own level, anything else its container. */
export function levelOfItem(ref: ItemRef): string | undefined {
  return ref.kind === 'partition' ? ref.id : partitionOf(canvas.value, ref);
}

export function select(sel: Selection): void {
  state.selection = sel;
  const ref = selectionItem(sel);
  if (ref) setLevel(levelOfItem(ref));
}

export function selectionItem(sel: Selection): ItemRef | undefined {
  switch (sel?.type) {
    case 'table':
    case 'column':
      return { kind: 'table', id: sel.nodeId };
    case 'note':
      return { kind: 'note', id: sel.id };
    case 'diagram':
      return { kind: 'diagram', id: sel.id };
    case 'partition':
      return { kind: 'partition', id: sel.id };
    default:
      return undefined;
  }
}

/**
 * Fits the viewport to items. Collapsed frames on the way (and a collapsed target frame) are
 * expanded first as one undoable edit, and hidden diagrams are shown, otherwise nothing is rendered to fit.
 */
export function focusItems(refs: ItemRef[], column?: string): void {
  const byId = new Map(canvas.value.partitions.map((p) => [p.id, p]));
  const expand = new Set<string>();
  for (const ref of refs) {
    for (let id = ref.kind === 'partition' ? ref.id : partitionOf(canvas.value, ref); id; id = byId.get(id)?.parent) {
      if (byId.get(id)?.collapsed) expand.add(id);
    }
  }
  const edit: CanvasEdit = [...expand].map((id) => ({ op: 'partition.put', partition: { ...byId.get(id)!, collapsed: false } }));
  const hidden = refs.filter((r) => r.kind === 'diagram' && canvas.value.diagrams.find((d) => d.id === r.id)?.hidden);
  if (hidden.length) edit.push({ op: 'hidden.set', items: hidden, hidden: false });
  if (edit.length) editCanvas(expand.size ? '展开分区画布' : '显示设计图', edit);
  state.focus = { nodeIds: refs.map(flowId), column, seq: ++focusSeq };
}

/** Fits the viewport to a level: a partition's frame, or the whole canvas for the root. */
export function focusLevel(level: string | undefined): void {
  setLevel(level);
  if (level) focusItems([{ kind: 'partition', id: level }]);
  else state.focus = { nodeIds: [], seq: ++focusSeq };
}

export function requestDiagramEdit(id: string): void {
  state.editDiagram = { id, seq: ++focusSeq };
}

/** Selects an item and zooms to it (tree clicks, panel lists, the pending-sync list). */
export function reveal(target: RevealTarget): void {
  const ref = target.item;
  if (!ref) return;
  if (ref.kind === 'table') select(target.column ? { type: 'column', nodeId: ref.id, column: target.column } : { type: 'table', nodeId: ref.id });
  else if (ref.kind === 'diagram') select({ type: 'diagram', id: ref.id });
  else if (ref.kind === 'note') select({ type: 'note', id: ref.id });
  else select({ type: 'partition', id: ref.id });
  state.selectRequest = { nodeIds: [flowId(ref)], seq: ++focusSeq };
  focusItems([ref], target.column);
  if (target.edit && ref.kind === 'diagram') requestDiagramEdit(ref.id);
}

export function handleHostMessage(msg: HostMessage): void {
  switch (msg.type) {
    case 'init':
      canvas.value = msg.canvas;
      savedViewport.value = msg.canvas.viewports?.[ROOT_SCOPE];
      state.design = msg.design;
      state.sources = Object.fromEntries(msg.sources.map((s) => [s.source, s]));
      state.diagrams = msg.diagrams;
      state.catalog = msg.catalog;
      state.comparison = msg.comparison;
      state.clipboard = msg.clipboard;
      state.error = msg.error;
      state.loaded = true;
      state.level = validLevel(state.level);
      return;
    case 'canvas':
      canvas.value = msg.canvas;
      if (state.level && !validLevel(state.level)) setLevel(undefined);
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
    case 'reveal':
      reveal(msg.target);
      return;
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
  focusItems([itemOfFlowId(nodeId)], column);
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
  toast(`已${mode === 'copy' ? '复制' : '剪切'} ${items.length} 项，点选目标层级（分区框或空白处）后按 Ctrl+V 粘贴`);
}

function itemRefs(c: CanvasFile): ItemRef[] {
  return [
    ...c.partitions.map((p) => ({ kind: 'partition' as const, id: p.id })),
    ...c.nodes.map((n) => ({ kind: 'table' as const, id: `${n.source}/${n.table}` })),
    ...c.diagrams.map((d) => ({ kind: 'diagram' as const, id: d.id })),
    ...c.notes.map((n) => ({ kind: 'note' as const, id: n.id })),
  ];
}

/** Pastes into a level and selects what landed there (the host pushes the canvas before it replies). */
export async function paste(partition: string | undefined, at?: Position, positions?: Record<string, Position>): Promise<void> {
  const before = new Set(itemRefs(canvas.value).map(flowId));
  try {
    const message = await request({ type: 'clipboard/paste', partition, at, positions });
    if (message) toast(message);
  } catch (err) {
    reportError(err);
    return;
  }
  const added = itemRefs(canvas.value).filter((r) => !before.has(flowId(r)));
  const top = added.filter((r) => partitionOf(canvas.value, r) === partition);
  if (top.length) selectNodes(top.map(flowId));
}

/** Makes these nodes the canvas's (multi-)selection. */
export function selectNodes(nodeIds: string[]): void {
  state.selectRequest = { nodeIds, seq: ++focusSeq };
  state.selection = nodeIds.length === 1 ? selectionOfFlowId(nodeIds[0]) : undefined;
}

function selectionOfFlowId(id: string): Selection {
  const ref = itemOfFlowId(id);
  if (ref.kind === 'table') return { type: 'table', nodeId: ref.id };
  return { type: ref.kind, id: ref.id } as Selection;
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

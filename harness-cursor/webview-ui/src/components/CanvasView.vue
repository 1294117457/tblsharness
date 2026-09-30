<script setup lang="ts">
import { computed, nextTick, ref, shallowRef, watch } from 'vue';
import { ConnectionMode, MarkerType, VueFlow, useVueFlow, type Connection, type Edge, type GraphNode, type Node } from '@vue-flow/core';
import { Background } from '@vue-flow/background';
import { Controls } from '@vue-flow/controls';
import { nodeId as makeNodeId, parseNodeId, partitionSubtree, type CanvasEdit, type CanvasFile, type MoveItem } from '@shared/canvas';
import type { RelationKind } from '@shared/model';
import { layoutLevel, layoutTables, nodeHeight, placeNewTables, NODE_WIDTH, NOTE_HEIGHT, PART_HEADER, type Position } from '../canvas/layout';
import type { CanvasView, EdgeView, Mark } from '../canvas/viewModel';
import { editCanvas, focusItems, itemOfFlowId, moveItems, requestDiagramEdit, savedViewport, select, setLevel, state } from '../store';
import { post } from '../vscode';
import DiagramNode from './DiagramNode.vue';
import NoteNode from './NoteNode.vue';
import PartitionNode from './PartitionNode.vue';
import TableNode from './TableNode.vue';

const props = defineProps<{ view: CanvasView; canvas: CanvasFile }>();
const emit = defineEmits<{
  connect: [connection: Connection];
  'node-menu': [payload: { id: string; x: number; y: number; flow: Position }];
  'pane-menu': [payload: { x: number; y: number; flow: Position }];
  pending: [diagram: string];
  'resize-partition': [payload: { id: string; width: number; height: number }];
}>();

const FLOW_ID = 'harness-canvas';
/** Zooming in to a single small table beyond this makes it fill the screen. */
const FOCUS_MAX_ZOOM = 1.5;
const MIN_ZOOM = 0.05;
const {
  fitView,
  setViewport,
  screenToFlowCoordinate,
  getSelectedNodes,
  findNode,
  onNodeDrag,
  onNodeDragStop,
  onConnect,
  onNodeClick,
  onNodeDoubleClick,
  onEdgeClick,
  onPaneClick,
  onPaneContextMenu,
  onMoveEnd,
  onNodeContextMenu,
  onNodesInitialized,
} = useVueFlow(FLOW_ID);

const nodes = shallowRef<Node[]>([]);
const edges = shallowRef<Edge[]>([]);
/** Positions of design tables and diagrams without a layout entry (root only); persisted once moved. */
const autoPositions = ref(new Map<string, Position>());
const laying = ref(false);
const dropTarget = ref<string>();

const savedTables = computed(() => new Map(props.canvas.nodes.map((n) => [makeNodeId(n.source, n.table), { x: n.x, y: n.y }])));

/** Position relative to the frame the item sits in. */
function positionOf(id: string): Position | undefined {
  const ref = itemOfFlowId(id);
  switch (ref.kind) {
    case 'table':
      return savedTables.value.get(id) ?? autoPositions.value.get(id);
    case 'diagram': {
      const d = props.view.diagrams.find((x) => x.id === ref.id);
      return d && !d.implicit ? { x: d.x, y: d.y } : autoPositions.value.get(id);
    }
    case 'note': {
      const n = props.canvas.notes.find((x) => x.id === ref.id);
      return n && { x: n.x, y: n.y };
    }
    case 'partition': {
      const p = props.canvas.partitions.find((x) => x.id === ref.id);
      return p && { x: p.x, y: p.y };
    }
  }
}

/** Level an on-screen item belongs to; `undefined` is the root canvas. */
function levelOf(id: string): string | undefined {
  const ref = itemOfFlowId(id);
  switch (ref.kind) {
    case 'table':
      return props.view.tables.find((t) => t.id === id)?.partition;
    case 'diagram':
      return props.view.diagrams.find((d) => d.id === ref.id)?.partition;
    case 'note':
      return props.canvas.notes.find((n) => n.id === ref.id)?.partition;
    case 'partition':
      return props.canvas.partitions.find((p) => p.id === ref.id)?.parent;
  }
}

function parentNodeOf(level: string | undefined): string | undefined {
  return level === undefined ? undefined : `part:${level}`;
}

/** Size of an item from the view data; rendered sizes are unavailable for off-screen nodes. */
function sizeOf(id: string): { w: number; h: number } | undefined {
  const ref = itemOfFlowId(id);
  switch (ref.kind) {
    case 'table': {
      const t = props.view.tables.find((x) => x.id === id);
      return t && { w: NODE_WIDTH, h: nodeHeight(t) };
    }
    case 'diagram': {
      const d = props.view.diagrams.find((x) => x.id === ref.id);
      return d && { w: d.width, h: d.height };
    }
    case 'note': {
      const n = props.view.notes.find((x) => x.id === ref.id);
      return n && { w: n.width, h: NOTE_HEIGHT };
    }
    case 'partition': {
      const p = props.view.partitions.find((x) => x.id === ref.id);
      return p && { w: p.width, h: p.height };
    }
  }
}

/** Absolute box of an item on the canvas, from the view data. */
function boxOf(id: string): { x: number; y: number; w: number; h: number } | undefined {
  const size = sizeOf(id);
  const p = positionOf(id);
  if (!size || !p) return undefined;
  let x = p.x;
  let y = p.y;
  const seen = new Set<string>();
  for (let level = levelOf(id); level && !seen.has(level); level = props.canvas.partitions.find((q) => q.id === level)?.parent) {
    seen.add(level);
    const frame = props.canvas.partitions.find((q) => q.id === level);
    if (!frame) break;
    x += frame.x;
    y += frame.y;
  }
  return { x, y, ...size };
}

const KIND_DASH: Record<RelationKind | 'mapping', string | undefined> = {
  fk: undefined,
  virtual: '6 4',
  logical: '6 4',
  json_array: '2 4',
  polymorphic: '10 4 2 4',
  dictionary: '2 6',
  mapping: '1 5',
};

const MARK_COLOR: Record<Mark, string> = {
  'design-only': 'var(--hn-missing)',
  'db-only': 'var(--hn-db-only)',
  mismatch: 'var(--hn-mismatch)',
  accepted: 'var(--hn-muted)',
};

/** Root items that already have a position, for placing implicit ones (always at the root) next to them. */
function levelBoxes(): { x: number; y: number; w: number }[] {
  const out: { x: number; y: number; w: number }[] = [];
  for (const t of props.view.tables) {
    const p = !t.partition ? positionOf(t.id) : undefined;
    if (p) out.push({ ...p, w: NODE_WIDTH });
  }
  for (const d of props.view.diagrams) if (!d.partition && !d.implicit) out.push({ x: d.x, y: d.y, w: d.width });
  for (const p of props.view.partitions) if (!p.parent) out.push({ x: p.x, y: p.y, w: p.width });
  return out;
}

let placing = 0;
watch(
  () => props.view,
  async (view) => {
    const freshTables = view.tables.filter((t) => t.implicit && !autoPositions.value.has(t.id));
    const freshDiagrams = view.diagrams.filter((d) => d.implicit && !autoPositions.value.has(`diagram:${d.id}`));
    if (freshTables.length || freshDiagrams.length) {
      const run = ++placing;
      laying.value = true;
      const boxes = levelBoxes();
      const existing = new Map(boxes.map((b, i) => [String(i), { x: b.x, y: b.y }]));
      const placed = freshTables.length ? await placeNewTables(freshTables, view.edges, existing) : new Map<string, Position>();
      laying.value = false;
      if (run !== placing) return;
      const next = new Map(autoPositions.value);
      for (const [id, p] of placed) next.set(id, p);
      const right = Math.max(0, ...boxes.map((b) => b.x + b.w), ...[...placed.values()].map((p) => p.x + NODE_WIDTH));
      let y = 0;
      for (const d of freshDiagrams) {
        next.set(`diagram:${d.id}`, { x: right + 80, y });
        y += d.height + 40;
      }
      autoPositions.value = next;
    }
    rebuild();
  },
  { immediate: true },
);

watch(
  () => [state.selection, dropTarget.value],
  () => rebuild(),
);

/** Nodes to select on the next rebuild, from a paste or a reveal. */
let requested: Set<string> | undefined;
watch(
  () => state.selectRequest?.seq,
  () => {
    requested = new Set(state.selectRequest?.nodeIds ?? []);
    rebuild();
  },
);

function rebuild() {
  const sel = state.selection;
  // A box or Ctrl selection of several nodes lives only in Vue Flow; keep it across rebuilds.
  const flowSelected = new Set(getSelectedNodes.value.map((n) => n.id));
  const multi = requested ?? (flowSelected.size > 1 ? flowSelected : undefined);
  const isSelected = (id: string, single: boolean) => (multi ? multi.has(id) : single);
  const partNodes: Node[] = props.view.partitions.map((p) => ({
    id: `part:${p.id}`,
    type: 'partition',
    position: { x: p.x, y: p.y },
    data: p,
    parentNode: p.parent ? `part:${p.parent}` : undefined,
    selected: isSelected(`part:${p.id}`, sel?.type === 'partition' && sel.id === p.id),
  }));
  const tableNodes: Node[] = props.view.tables.map((t) => ({
    id: t.id,
    type: 'table',
    position: positionOf(t.id) ?? { x: 0, y: 0 },
    data: t,
    parentNode: parentNodeOf(t.partition),
    selected: isSelected(t.id, (sel?.type === 'table' || sel?.type === 'column') && sel.nodeId === t.id),
  }));
  const diagramNodes: Node[] = props.view.diagrams.map((d) => ({
    id: `diagram:${d.id}`,
    type: 'diagram',
    position: positionOf(`diagram:${d.id}`) ?? { x: 0, y: 0 },
    data: d,
    parentNode: parentNodeOf(d.partition),
    selected: isSelected(`diagram:${d.id}`, sel?.type === 'diagram' && sel.id === d.id),
  }));
  const noteNodes: Node[] = props.view.notes.map((n) => ({
    id: `note:${n.id}`,
    type: 'note',
    position: { x: n.x, y: n.y },
    data: n,
    parentNode: parentNodeOf(n.partition),
    selected: isSelected(`note:${n.id}`, sel?.type === 'note' && sel.id === n.id),
  }));
  nodes.value = [...partNodes, ...tableNodes, ...diagramNodes, ...noteNodes];
  // The request may come before the view that contains the new nodes; keep it until they exist.
  if (requested && [...requested].every((id) => nodes.value.some((n) => n.id === id))) requested = undefined;
  edges.value = props.view.edges.map((e) => toFlowEdge(e, sel?.type === 'relation' && e.edgeSource === sel.source && e.relationKey === sel.key));
}

function toFlowEdge(e: EdgeView, selected: boolean): Edge {
  const color = e.kind === 'mapping' ? 'var(--hn-accent)' : e.mark ? MARK_COLOR[e.mark] : 'var(--hn-muted)';
  return {
    id: e.id,
    source: e.source,
    sourceHandle: e.sourceHandle,
    target: e.target,
    targetHandle: e.targetHandle,
    type: 'smoothstep',
    label: e.label,
    selectable: e.kind !== 'mapping',
    markerEnd: e.kind === 'mapping' ? undefined : { type: MarkerType.ArrowClosed, color },
    style: { stroke: color, strokeWidth: selected ? 2.5 : e.mark ? 2 : 1.2, strokeDasharray: KIND_DASH[e.kind] },
    zIndex: 5,
  };
}

// ── Viewport and focus ─────────────────────────────────────────────

/** A reveal that arrives with the first render wins over the saved viewport. */
let viewportPending = true;
function applyViewport() {
  if (!viewportPending) return;
  viewportPending = false;
  const vp = savedViewport.value;
  if (vp) void setViewport(vp);
  else void fitView({ padding: 0.1 });
}

onNodesInitialized(() => applyViewport());

let viewportTimer: ReturnType<typeof setTimeout> | undefined;
onMoveEnd(({ flowTransform }) => {
  clearTimeout(viewportTimer);
  const viewport = { x: flowTransform.x, y: flowTransform.y, zoom: flowTransform.zoom };
  viewportTimer = setTimeout(() => post({ type: 'viewport', viewport }), 400);
});

const container = ref<HTMLElement>();

/** Fits the viewport to nodes (all of them when empty), never zooming in beyond {@link FOCUS_MAX_ZOOM}. */
function focusOn(ids: string[]) {
  const all = ids.length ? ids : [...props.view.partitions.filter((p) => !p.parent).map((p) => `part:${p.id}`), ...rootItemIds()];
  const boxes = all.map(boxOf).filter((b): b is NonNullable<typeof b> => !!b);
  const rect = container.value?.getBoundingClientRect();
  if (!boxes.length || !rect?.width || !rect.height) return;
  const x0 = Math.min(...boxes.map((b) => b.x));
  const y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.w));
  const y1 = Math.max(...boxes.map((b) => b.y + b.h));
  const pad = 0.12;
  const zoom = Math.min(FOCUS_MAX_ZOOM, Math.max(MIN_ZOOM, Math.min((rect.width * (1 - 2 * pad)) / (x1 - x0 || 1), (rect.height * (1 - 2 * pad)) / (y1 - y0 || 1))));
  viewportPending = false;
  void setViewport({ x: rect.width / 2 - ((x0 + x1) / 2) * zoom, y: rect.height / 2 - ((y0 + y1) / 2) * zoom, zoom }, { duration: 300 });
}

function rootItemIds(): string[] {
  return [
    ...props.view.tables.filter((t) => !t.partition).map((t) => t.id),
    ...props.view.diagrams.filter((d) => !d.partition).map((d) => `diagram:${d.id}`),
    ...props.view.notes.filter((n) => !n.partition).map((n) => `note:${n.id}`),
  ];
}

watch(
  () => state.focus?.seq,
  async () => {
    const f = state.focus;
    if (!f) return;
    viewportPending = false;
    // Let a just-expanded frame or just-shown card reach the view first.
    await nextTick();
    setTimeout(() => focusOn(f.nodeIds), 60);
  },
);

// ── Dragging into and out of partition frames ─────────────────────

function absRect(id: string): { x: number; y: number; w: number; h: number } | undefined {
  const n = findNode(id);
  if (!n) return undefined;
  if (!n.dimensions.width) return boxOf(id);
  return { x: n.computedPosition.x, y: n.computedPosition.y, w: n.dimensions.width, h: n.dimensions.height };
}

/** Innermost expanded frame under a point, skipping `exclude`. */
function frameAt(point: Position, exclude: Set<string> = new Set()): string | undefined {
  let best: string | undefined;
  let bestDepth = -1;
  for (const p of props.view.partitions) {
    if (p.collapsed || exclude.has(p.id)) continue;
    const r = absRect(`part:${p.id}`);
    if (!r || point.x < r.x || point.x > r.x + r.w || point.y < r.y || point.y > r.y + r.h) continue;
    if (p.depth > bestDepth) {
      best = p.id;
      bestDepth = p.depth;
    }
  }
  return best;
}

/** Converts an absolute flow point to coordinates inside a level (the root uses absolute ones). */
function relativeTo(level: string | undefined, point: Position): Position {
  if (!level) return point;
  const r = absRect(`part:${level}`);
  return r ? { x: point.x - r.x, y: point.y - r.y } : point;
}

/** Whether an absolute flow point lies inside a level's area; the root is unbounded. */
function insideLevel(level: string | undefined, point: Position): boolean {
  if (!level) return true;
  if (props.view.partitions.find((p) => p.id === level)?.collapsed) return false;
  const r = absRect(`part:${level}`);
  return !!r && point.x >= r.x && point.x <= r.x + r.w && point.y >= r.y + PART_HEADER && point.y <= r.y + r.h;
}

function clampInFrame(level: string | undefined, p: Position): Position {
  if (!level) return { x: Math.round(p.x), y: Math.round(p.y) };
  return { x: Math.round(Math.max(8, p.x)), y: Math.round(Math.max(PART_HEADER + 4, p.y)) };
}

function excludedFor(node: GraphNode): Set<string> {
  const ref = itemOfFlowId(node.id);
  return ref.kind === 'partition' ? partitionSubtree(props.canvas, ref.id) : new Set();
}

function centerOf(node: GraphNode): Position {
  return { x: node.computedPosition.x + node.dimensions.width / 2, y: node.computedPosition.y + Math.min(node.dimensions.height / 2, 40) };
}

onNodeDrag(({ node }) => {
  const target = frameAt(centerOf(node), excludedFor(node));
  const next = target !== levelOf(node.id) ? target : undefined;
  if (next !== dropTarget.value) dropTarget.value = next;
});

onNodeDragStop(async ({ nodes: moved }) => {
  dropTarget.value = undefined;
  const movedIds = new Set(moved.map((n) => n.id));
  const edit: CanvasEdit = [];
  const moves: MoveItem[] = [];
  for (const n of moved) {
    const graph = findNode(n.id) ?? n;
    let ancestor = graph.parentNode;
    let covered = false;
    while (ancestor) {
      if (movedIds.has(ancestor)) covered = true;
      ancestor = findNode(ancestor)?.parentNode;
    }
    if (covered) continue;
    const ref = itemOfFlowId(n.id);
    const current = levelOf(n.id);
    const target = frameAt(centerOf(graph), excludedFor(graph));
    if (target === current || (target === undefined && current === undefined)) {
      const p = clampInFrame(current, graph.position);
      switch (ref.kind) {
        case 'table': {
          const { source, table } = parseNodeId(ref.id);
          edit.push({ op: 'nodes.put', nodes: [{ source, table, x: p.x, y: p.y }] });
          break;
        }
        case 'diagram': {
          const d = props.view.diagrams.find((x) => x.id === ref.id);
          if (d) edit.push({ op: 'diagrams.put', diagrams: [{ id: d.id, x: p.x, y: p.y, width: d.width, height: d.height, partition: d.partition }] });
          break;
        }
        case 'note': {
          const note = props.canvas.notes.find((x) => x.id === ref.id);
          if (note) edit.push({ op: 'note.put', note: { ...note, x: p.x, y: p.y } });
          break;
        }
        case 'partition': {
          const part = props.canvas.partitions.find((x) => x.id === ref.id);
          if (part) edit.push({ op: 'partition.put', partition: { ...part, x: p.x, y: p.y } });
          break;
        }
      }
    } else {
      const p = clampInFrame(target, relativeTo(target, graph.computedPosition));
      moves.push({ ...ref, partition: target ?? null, x: p.x, y: p.y });
    }
  }
  if (edit.length) editCanvas(edit.length > 1 ? '移动多个节点' : '移动节点', edit);
  if (moves.length && !(await moveItems(moves))) rebuild();
});

// ── Clicks ─────────────────────────────────────────────────────────

onConnect((connection) => emit('connect', connection));

onNodeClick(({ node }) => {
  requested = undefined;
  const ref = itemOfFlowId(node.id);
  select(ref.kind === 'table' ? { type: 'table', nodeId: node.id } : { type: ref.kind, id: ref.id });
});

onNodeDoubleClick(({ node, event }) => {
  const ref = itemOfFlowId(node.id);
  if (ref.kind === 'diagram') {
    select({ type: 'diagram', id: ref.id });
    requestDiagramEdit(ref.id);
    return;
  }
  if (ref.kind === 'partition') {
    focusItems([ref]);
  }
});

onEdgeClick(({ edge }) => {
  const e = props.view.edges.find((x) => x.id === edge.id);
  if (e?.edgeSource && e.relationKey) state.selection = { type: 'relation', source: e.edgeSource, key: e.relationKey };
});

onPaneClick(() => {
  requested = undefined;
  state.selection = undefined;
  setLevel(undefined);
});

onNodeContextMenu(({ node, event }) => {
  const e = event as MouseEvent;
  e.preventDefault();
  emit('node-menu', { id: node.id, x: e.clientX, y: e.clientY, flow: screenToFlowCoordinate({ x: e.clientX, y: e.clientY }) });
});

onPaneContextMenu((event) => {
  const e = event as MouseEvent;
  e.preventDefault();
  emit('pane-menu', { x: e.clientX, y: e.clientY, flow: screenToFlowCoordinate({ x: e.clientX, y: e.clientY }) });
});

function togglePartition(id: string) {
  const p = props.canvas.partitions.find((x) => x.id === id);
  if (p) editCanvas(p.collapsed ? '展开分区画布' : '折叠分区画布', [{ op: 'partition.put', partition: { ...p, collapsed: !p.collapsed } }]);
}

function resizeDiagram({ id, width, height }: { id: string; width: number; height: number }) {
  const d = props.view.diagrams.find((x) => x.id === id);
  const p = positionOf(`diagram:${id}`) ?? { x: 0, y: 0 };
  if (d) editCanvas('调整设计图大小', [{ op: 'diagrams.put', diagrams: [{ id, x: p.x, y: p.y, width, height, partition: d.partition }] }]);
}

function resizePartition({ id, width, height }: { id: string; width: number; height: number }) {
  const part = props.canvas.partitions.find((x) => x.id === id);
  if (part) editCanvas('调整分区画布大小', [{ op: 'partition.put', partition: { ...part, width, height } }]);
}

// ── Auto layout ────────────────────────────────────────────────────

/** Whole canvas; with `onlySelected`, the inside of a selected frame or the selected tables of one level. */
async function autoLayout(onlySelected: boolean) {
  const edit: CanvasEdit = [];
  const selectedFrames = getSelectedNodes.value.filter((n) => n.id.startsWith('part:'));
  const within = onlySelected && selectedFrames.length === 1 ? selectedFrames[0].id.slice(5) : undefined;
  if (within && props.view.partitions.find((p) => p.id === within)?.collapsed) return;
  if (!onlySelected || within) {
    laying.value = true;
    const positions = await layoutLevel(props.view, within);
    laying.value = false;
    const tables = [];
    for (const [id, p] of positions) {
      const ref = itemOfFlowId(id);
      if (ref.kind === 'table') tables.push({ ...parseNodeId(id), x: p.x, y: p.y });
      else if (ref.kind === 'diagram') {
        const d = props.view.diagrams.find((x) => x.id === ref.id);
        if (d) edit.push({ op: 'diagrams.put', diagrams: [{ id: d.id, x: p.x, y: p.y, width: d.width, height: d.height, partition: d.partition }] });
      } else if (ref.kind === 'note') {
        const n = props.canvas.notes.find((x) => x.id === ref.id);
        if (n) edit.push({ op: 'note.put', note: { ...n, x: p.x, y: p.y } });
      } else {
        const part = props.canvas.partitions.find((x) => x.id === ref.id);
        if (part) edit.push({ op: 'partition.put', partition: { ...part, x: p.x, y: p.y } });
      }
    }
    if (tables.length) edit.unshift({ op: 'nodes.put', nodes: tables });
    editCanvas(within ? '布局分区画布' : '自动布局', edit);
    await nextTick();
    setTimeout(() => focusOn(within ? [`part:${within}`] : []), 80);
    return;
  }
  const selected = new Set(getSelectedNodes.value.map((n) => n.id));
  const picked = props.view.tables.filter((t) => selected.has(t.id));
  if (!picked.length) return;
  const level = picked[0].partition;
  const targets = picked.filter((t) => t.partition === level);
  laying.value = true;
  const positions = await layoutTables(targets, props.view.edges);
  laying.value = false;
  const before = targets.map((t) => positionOf(t.id) ?? { x: 0, y: 0 });
  const ox = Math.min(...before.map((p) => p.x));
  const oy = Math.min(...before.map((p) => p.y));
  editCanvas('布局选中', [{ op: 'nodes.put', nodes: [...positions].map(([id, p]) => ({ ...parseNodeId(id), x: p.x + ox, y: p.y + oy })) }]);
}

function centerPosition(): Position {
  const el = document.querySelector('.canvas') as HTMLElement | null;
  const rect = el?.getBoundingClientRect();
  return screenToFlowCoordinate({ x: (rect?.left ?? 0) + (rect?.width ?? 800) / 2, y: (rect?.top ?? 0) + (rect?.height ?? 600) / 3 });
}

function currentPosition(id: string): Position | undefined {
  return nodes.value.find((n) => n.id === id)?.position ?? positionOf(id);
}

function selectedNodeIds(): string[] {
  return getSelectedNodes.value.map((n) => n.id);
}

defineExpose({
  autoLayout,
  centerPosition,
  currentPosition,
  selectedNodeIds,
  frameAt,
  relativeTo,
  insideLevel,
  focusOn,
  toFlow: (screen: Position) => screenToFlowCoordinate(screen),
});
</script>

<template>
  <div ref="container" class="canvas">
    <VueFlow
      :id="FLOW_ID"
      v-model:nodes="nodes"
      v-model:edges="edges"
      :min-zoom="MIN_ZOOM"
      :max-zoom="2"
      :connection-mode="ConnectionMode.Loose"
      :delete-key-code="null"
      :zoom-on-double-click="false"
      :elevate-edges-on-select="true"
      :only-render-visible-elements="true"
    >
      <template #node-partition="nodeProps">
        <PartitionNode
          :data="nodeProps.data"
          :selected="nodeProps.selected"
          :current="state.level === nodeProps.data.id"
          :drop-target="dropTarget === nodeProps.data.id"
          @focus="focusItems([{ kind: 'partition', id: $event }])"
          @toggle="togglePartition"
          @resize="resizePartition"
        />
      </template>
      <template #node-table="nodeProps">
        <TableNode :data="nodeProps.data" :selected="nodeProps.selected" />
      </template>
      <template #node-diagram="nodeProps">
        <DiagramNode :data="nodeProps.data" :selected="nodeProps.selected" @resize="resizeDiagram" @pending="emit('pending', $event)" />
      </template>
      <template #node-note="nodeProps">
        <NoteNode :data="nodeProps.data" :selected="nodeProps.selected" />
      </template>
      <Background :gap="24" pattern-color="var(--hn-border)" />
      <Controls :show-interactive="false" />
    </VueFlow>
    <div v-if="laying" class="laying">正在布局…</div>
  </div>
</template>

<style scoped>
.canvas {
  position: relative;
  width: 100%;
  height: 100%;
}

.laying {
  position: absolute;
  top: 12px;
  left: 50%;
  transform: translateX(-50%);
  padding: 4px 12px;
  border: 1px solid var(--hn-border);
  border-radius: 12px;
  background: var(--hn-node-bg);
  color: var(--hn-muted);
}
</style>

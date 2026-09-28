<script setup lang="ts">
import { computed, nextTick, ref, shallowRef, watch } from 'vue';
import { ConnectionMode, MarkerType, VueFlow, useVueFlow, type Connection, type Edge, type Node } from '@vue-flow/core';
import { Background } from '@vue-flow/background';
import { Controls } from '@vue-flow/controls';
import { nodeId as makeNodeId, parseNodeId, type CanvasFile, type CanvasNote } from '@shared/canvas';
import type { RelationKind } from '@shared/model';
import { layoutTables, placeNewTables, type Position } from '../canvas/layout';
import type { CanvasView, EdgeView, Mark } from '../canvas/viewModel';
import { editCanvas, state } from '../store';
import { post } from '../vscode';
import NoteNode from './NoteNode.vue';
import TableNode from './TableNode.vue';

const props = defineProps<{ view: CanvasView; canvas: CanvasFile }>();
const emit = defineEmits<{
  connect: [connection: Connection];
  'create-table': [position: Position];
  'node-menu': [payload: { nodeId: string; x: number; y: number }];
}>();

const FLOW_ID = 'harness-canvas';
const {
  fitView,
  setViewport,
  screenToFlowCoordinate,
  getSelectedNodes,
  onNodeDragStop,
  onConnect,
  onNodeClick,
  onEdgeClick,
  onPaneClick,
  onMoveEnd,
  onNodeContextMenu,
  onNodesInitialized,
} = useVueFlow(FLOW_ID);

const nodes = shallowRef<Node[]>([]);
const edges = shallowRef<Edge[]>([]);
/** Positions for tables shown via `tables: 'all'` that the user has not placed yet; never persisted until moved. */
const autoPositions = ref(new Map<string, Position>());
const laying = ref(false);

const saved = computed(() => new Map(props.canvas.nodes.map((n) => [makeNodeId(n.source, n.table), { x: n.x, y: n.y }])));

function positionOf(id: string): Position | undefined {
  return saved.value.get(id) ?? autoPositions.value.get(id);
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

let placing = 0;
watch(
  () => props.view,
  async (view) => {
    const fresh = view.tables.filter((t) => !positionOf(t.id));
    if (fresh.length) {
      const run = ++placing;
      laying.value = true;
      const existing = new Map<string, Position>();
      for (const t of view.tables) {
        const p = positionOf(t.id);
        if (p) existing.set(t.id, p);
      }
      const placed = await placeNewTables(fresh, view.edges, existing);
      laying.value = false;
      if (run !== placing) return;
      const next = new Map(autoPositions.value);
      for (const [id, p] of placed) next.set(id, p);
      autoPositions.value = next;
    }
    rebuild();
  },
  { immediate: true },
);

watch(
  () => [props.canvas.notes, state.selection],
  () => rebuild(),
);

function rebuild() {
  const sel = state.selection;
  const tableNodes: Node[] = props.view.tables.map((t) => ({
    id: t.id,
    type: 'table',
    position: positionOf(t.id) ?? { x: 0, y: 0 },
    data: t,
    selected: (sel?.type === 'table' || sel?.type === 'column') && sel.nodeId === t.id,
  }));
  const noteNodes: Node[] = props.canvas.notes.map((n) => ({
    id: `note:${n.id}`,
    type: 'note',
    position: { x: n.x, y: n.y },
    data: n,
    selected: sel?.type === 'note' && sel.id === n.id,
  }));
  nodes.value = [...tableNodes, ...noteNodes];
  edges.value = props.view.edges.map((e) => toFlowEdge(e, sel?.type === 'relation' && e.alias === sel.alias && e.relationKey === sel.key));
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
  };
}

let initialViewportDone = false;
onNodesInitialized(() => {
  if (initialViewportDone) return;
  initialViewportDone = true;
  if (props.canvas.viewport) void setViewport(props.canvas.viewport);
  else void fitView({ padding: 0.1 });
});

onNodeDragStop(({ nodes: moved }) => {
  const tables = moved.filter((n) => n.type === 'table');
  const notes = moved.filter((n) => n.type === 'note');
  const edit = [];
  if (tables.length) {
    edit.push({
      op: 'nodes.put' as const,
      nodes: tables.map((n) => {
        const { alias, table } = parseNodeId(n.id);
        return { source: alias, table, x: n.position.x, y: n.position.y };
      }),
    });
  }
  for (const n of notes) {
    edit.push({ op: 'note.put' as const, note: { ...(n.data as CanvasNote), x: Math.round(n.position.x), y: Math.round(n.position.y) } });
  }
  editCanvas(tables.length + notes.length > 1 ? '移动多个节点' : '移动节点', edit);
});

onConnect((connection) => emit('connect', connection));

onNodeClick(({ node }) => {
  if (node.type === 'table') state.selection = { type: 'table', nodeId: node.id };
  else if (node.type === 'note') state.selection = { type: 'note', id: (node.data as CanvasNote).id };
});

onEdgeClick(({ edge }) => {
  const e = props.view.edges.find((x) => x.id === edge.id);
  if (e?.alias && e.relationKey) state.selection = { type: 'relation', alias: e.alias, key: e.relationKey };
});

onPaneClick(() => {
  state.selection = undefined;
});

onNodeContextMenu(({ node, event }) => {
  if (node.type !== 'table') return;
  const e = event as MouseEvent;
  e.preventDefault();
  emit('node-menu', { nodeId: node.id, x: e.clientX, y: e.clientY });
});

let viewportTimer: ReturnType<typeof setTimeout> | undefined;
onMoveEnd(({ flowTransform }) => {
  clearTimeout(viewportTimer);
  viewportTimer = setTimeout(() => post({ type: 'viewport', viewport: { x: flowTransform.x, y: flowTransform.y, zoom: flowTransform.zoom } }), 400);
});

watch(
  () => state.focus?.seq,
  async () => {
    const f = state.focus;
    if (!f) return;
    await nextTick();
    if (nodes.value.some((n) => n.id === f.nodeId)) {
      await fitView({ nodes: [f.nodeId], padding: 0.6, duration: 300, maxZoom: 1.2 });
    }
  },
);

function onDoubleClick(event: MouseEvent) {
  if (!(event.target as HTMLElement).classList.contains('vue-flow__pane')) return;
  emit('create-table', screenToFlowCoordinate({ x: event.clientX, y: event.clientY }));
}

async function autoLayout(onlySelected: boolean) {
  const selected = new Set(getSelectedNodes.value.map((n) => n.id));
  const targets = props.view.tables.filter((t) => !onlySelected || selected.has(t.id));
  if (!targets.length) return;
  laying.value = true;
  const positions = await layoutTables(targets, props.view.edges);
  laying.value = false;
  if (onlySelected) {
    // Keep the selection where it was: anchor the new arrangement at its previous top-left corner.
    const before = targets.map((t) => positionOf(t.id) ?? { x: 0, y: 0 });
    const ox = Math.min(...before.map((p) => p.x));
    const oy = Math.min(...before.map((p) => p.y));
    for (const [id, p] of positions) positions.set(id, { x: p.x + ox, y: p.y + oy });
  }
  editCanvas('自动布局', [
    { op: 'nodes.put', nodes: [...positions].map(([id, p]) => ({ source: parseNodeId(id).alias, table: parseNodeId(id).table, x: p.x, y: p.y })) },
  ]);
  if (!onlySelected) await nextTick().then(() => fitView({ padding: 0.1, duration: 300 }));
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

defineExpose({ autoLayout, centerPosition, currentPosition, selectedNodeIds, fitView: () => fitView({ padding: 0.1, duration: 300 }) });
</script>

<template>
  <div class="canvas" @dblclick="onDoubleClick">
    <VueFlow
      :id="FLOW_ID"
      v-model:nodes="nodes"
      v-model:edges="edges"
      :min-zoom="0.05"
      :max-zoom="2"
      :connection-mode="ConnectionMode.Loose"
      :delete-key-code="null"
      :zoom-on-double-click="false"
      :elevate-edges-on-select="true"
      :only-render-visible-elements="view.tables.length > 100"
    >
      <template #node-table="nodeProps">
        <TableNode :data="nodeProps.data" :selected="nodeProps.selected" />
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

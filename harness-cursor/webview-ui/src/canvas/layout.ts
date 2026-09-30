import ELK, { type ElkNode } from 'elkjs/lib/elk.bundled.js';
import type { CanvasView, EdgeView, TableView } from './viewModel';

export const NODE_WIDTH = 260;
export const HEADER_HEIGHT = 30;
export const ROW_HEIGHT = 22;
export const NOTE_HEIGHT = 90;
/** Partition frames: title bar height and inner padding; coordinates inside a frame start at its top-left. */
export const PART_HEADER = 34;
export const PART_PAD = 24;
export const PART_MIN = { width: 320, height: 160 };
export const PART_COLLAPSED = { width: 240, height: 58 };
const GAP = 80;

export type Position = { x: number; y: number };

const elk = new ELK();

export function nodeHeight(table: TableView): number {
  return HEADER_HEIGHT + ROW_HEIGHT * table.visibleColumns.length + 4;
}

const LAYOUT_OPTIONS = {
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  'elk.layered.spacing.nodeNodeBetweenLayers': '90',
  'elk.spacing.nodeNode': '40',
  'elk.spacing.componentComponent': '60',
  'elk.separateConnectedComponents': 'true',
  'elk.edgeRouting': 'ORTHOGONAL',
};

function elkEdges(edges: EdgeView[], ids: Set<string>) {
  return edges
    .filter((e) => ids.has(e.source) && ids.has(e.target) && e.source !== e.target)
    .map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] }));
}

export async function layoutTables(tables: TableView[], edges: EdgeView[]): Promise<Map<string, Position>> {
  if (!tables.length) return new Map();
  const graph = await elk.layout({
    id: 'root',
    layoutOptions: LAYOUT_OPTIONS,
    children: tables.map((t) => ({ id: t.id, width: NODE_WIDTH, height: nodeHeight(t) })),
    edges: elkEdges(edges, new Set(tables.map((t) => t.id))),
  });
  return new Map((graph.children ?? []).map((n) => [n.id, { x: n.x ?? 0, y: n.y ?? 0 }]));
}

/**
 * Lays out the level being shown with every expanded partition frame as an ELK compound node.
 * Keys are Vue Flow node IDs; positions are relative to the frame each item sits in.
 */
export async function layoutLevel(view: CanvasView): Promise<Map<string, Position>> {
  const childrenOf = new Map<string | undefined, ElkNode[]>();
  const push = (level: string | undefined, node: ElkNode) => {
    const key = level === view.scope ? undefined : level;
    childrenOf.set(key, [...(childrenOf.get(key) ?? []), node]);
  };
  for (const t of view.tables) push(t.partition, { id: t.id, width: NODE_WIDTH, height: nodeHeight(t) });
  for (const d of view.diagrams) push(d.partition, { id: `diagram:${d.id}`, width: d.width, height: d.height });
  for (const n of view.notes) push(n.partition, { id: `note:${n.id}`, width: n.width, height: NOTE_HEIGHT });
  for (const p of [...view.partitions].reverse()) {
    const kids = childrenOf.get(p.id);
    const node: ElkNode =
      p.collapsed || !kids?.length
        ? { id: `part:${p.id}`, width: p.collapsed ? PART_COLLAPSED.width : PART_MIN.width, height: p.collapsed ? PART_COLLAPSED.height : PART_MIN.height }
        : {
            id: `part:${p.id}`,
            layoutOptions: { ...LAYOUT_OPTIONS, 'elk.padding': `[top=${PART_HEADER + PART_PAD / 2},left=${PART_PAD},bottom=${PART_PAD},right=${PART_PAD}]` },
            children: kids,
          };
    push(p.parent ?? view.scope, node);
  }
  const roots = childrenOf.get(undefined) ?? [];
  if (!roots.length) return new Map();
  const ids = new Set(view.tables.map((t) => t.id));
  const graph = await elk.layout({
    id: 'root',
    layoutOptions: { ...LAYOUT_OPTIONS, 'elk.hierarchyHandling': 'INCLUDE_CHILDREN' },
    children: roots,
    edges: elkEdges(view.edges, ids),
  });
  const out = new Map<string, Position>();
  const collect = (nodes: ElkNode[] | undefined) => {
    for (const n of nodes ?? []) {
      out.set(n.id, { x: n.x ?? 0, y: n.y ?? 0 });
      collect(n.children);
    }
  };
  collect(graph.children);
  return out;
}

/** Lays out only the new tables, then places that block to the right of what is already on the canvas. */
export async function placeNewTables(fresh: TableView[], edges: EdgeView[], existing: Map<string, Position>): Promise<Map<string, Position>> {
  const positions = await layoutTables(fresh, edges);
  if (!existing.size) return positions;
  let maxX = -Infinity;
  let minY = Infinity;
  for (const p of existing.values()) {
    maxX = Math.max(maxX, p.x + NODE_WIDTH);
    minY = Math.min(minY, p.y);
  }
  const shifted = new Map<string, Position>();
  for (const [id, p] of positions) shifted.set(id, { x: p.x + maxX + GAP, y: p.y + minY });
  return shifted;
}

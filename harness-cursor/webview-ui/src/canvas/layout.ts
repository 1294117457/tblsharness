import ELK from 'elkjs/lib/elk.bundled.js';
import type { EdgeView, TableView } from './viewModel';

export const NODE_WIDTH = 260;
export const HEADER_HEIGHT = 30;
export const ROW_HEIGHT = 22;
const GAP = 80;

export type Position = { x: number; y: number };

const elk = new ELK();

export function nodeHeight(table: TableView): number {
  return HEADER_HEIGHT + ROW_HEIGHT * table.visibleColumns.length + 4;
}

export async function layoutTables(tables: TableView[], edges: EdgeView[]): Promise<Map<string, Position>> {
  if (!tables.length) return new Map();
  const ids = new Set(tables.map((t) => t.id));
  const graph = await elk.layout({
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.layered.spacing.nodeNodeBetweenLayers': '90',
      'elk.spacing.nodeNode': '40',
      'elk.spacing.componentComponent': '60',
      'elk.separateConnectedComponents': 'true',
      'elk.edgeRouting': 'ORTHOGONAL',
    },
    children: tables.map((t) => ({ id: t.id, width: NODE_WIDTH, height: nodeHeight(t) })),
    edges: edges
      .filter((e) => ids.has(e.source) && ids.has(e.target) && e.source !== e.target)
      .map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
  });
  return new Map((graph.children ?? []).map((n) => [n.id, { x: n.x ?? 0, y: n.y ?? 0 }]));
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

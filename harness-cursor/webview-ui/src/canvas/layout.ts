import ELK from 'elkjs/lib/elk.bundled.js';
import type { CanvasNode, CanvasZone } from '@shared/canvas';
import type { EdgeView, TableView } from './viewModel';

export const NODE_WIDTH = 260;
export const HEADER_HEIGHT = 30;
export const ROW_HEIGHT = 22;
const GAP = 80;
const ZONE_PADDING = 40;

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

export async function layoutTables(tables: TableView[], edges: EdgeView[]): Promise<Map<string, Position>> {
  if (!tables.length) return new Map();
  const ids = new Set(tables.map((t) => t.id));
  const graph = await elk.layout({
    id: 'root',
    layoutOptions: LAYOUT_OPTIONS,
    children: tables.map((t) => ({ id: t.id, width: NODE_WIDTH, height: nodeHeight(t) })),
    edges: edges
      .filter((e) => ids.has(e.source) && ids.has(e.target) && e.source !== e.target)
      .map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
  });
  return new Map((graph.children ?? []).map((n) => [n.id, { x: n.x ?? 0, y: n.y ?? 0 }]));
}

/**
 * Layout with zones as ELK compound nodes.
 * Returns table positions and zone positions/sizes.
 */
export async function layoutWithZones(
  tables: TableView[],
  edges: EdgeView[],
  canvasNodes: CanvasNode[],
  zones: CanvasZone[],
): Promise<{ tables: Map<string, Position>; zones: Map<string, { x: number; y: number; width: number; height: number }> }> {
  if (!tables.length) return { tables: new Map(), zones: new Map() };

  const nodeZone = new Map<string, string>();
  for (const n of canvasNodes) {
    if (n.zone) nodeZone.set(`${n.source}/${n.table}`, n.zone);
  }

  const tableById = new Map(tables.map((t) => [t.id, t]));
  const ids = new Set(tables.map((t) => t.id));

  const zoneChildren = new Map<string, typeof tables>();
  const unzoned: typeof tables = [];

  for (const t of tables) {
    const zid = nodeZone.get(`${t.source}/${t.key}`);
    if (zid && zones.some((z) => z.id === zid)) {
      const arr = zoneChildren.get(zid) ?? [];
      arr.push(t);
      zoneChildren.set(zid, arr);
    } else {
      unzoned.push(t);
    }
  }

  const filteredEdges = edges
    .filter((e) => ids.has(e.source) && ids.has(e.target) && e.source !== e.target)
    .map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] }));

  const children: any[] = [];

  for (const z of zones) {
    const members = zoneChildren.get(z.id) ?? [];
    if (!members.length) continue;
    children.push({
      id: `zone:${z.id}`,
      layoutOptions: { ...LAYOUT_OPTIONS, 'elk.padding': `[top=${ZONE_PADDING},left=${ZONE_PADDING},bottom=${ZONE_PADDING / 2},right=${ZONE_PADDING / 2}]` },
      children: members.map((t) => ({ id: t.id, width: NODE_WIDTH, height: nodeHeight(t) })),
      edges: filteredEdges.filter((e) => {
        const s = tableById.get(e.sources[0]);
        const t = tableById.get(e.targets[0]);
        return s && t && members.includes(s) && members.includes(t);
      }),
    });
  }

  for (const t of unzoned) {
    children.push({ id: t.id, width: NODE_WIDTH, height: nodeHeight(t) });
  }

  const graph = await elk.layout({
    id: 'root',
    layoutOptions: LAYOUT_OPTIONS,
    children,
    edges: filteredEdges.filter((e) => {
      const sZone = nodeZone.get(tableById.get(e.sources[0])?.source + '/' + tableById.get(e.sources[0])?.key);
      const tZone = nodeZone.get(tableById.get(e.targets[0])?.source + '/' + tableById.get(e.targets[0])?.key);
      return sZone !== tZone || !sZone;
    }),
  });

  const tablePositions = new Map<string, Position>();
  const zonePositions = new Map<string, { x: number; y: number; width: number; height: number }>();

  for (const child of graph.children ?? []) {
    if (child.id.startsWith('zone:')) {
      const zid = child.id.slice(5);
      const ox = child.x ?? 0;
      const oy = child.y ?? 0;
      zonePositions.set(zid, { x: ox, y: oy, width: child.width ?? 300, height: child.height ?? 200 });
      for (const inner of child.children ?? []) {
        tablePositions.set(inner.id, { x: (inner.x ?? 0) + ox, y: (inner.y ?? 0) + oy });
      }
    } else {
      tablePositions.set(child.id, { x: child.x ?? 0, y: child.y ?? 0 });
    }
  }

  return { tables: tablePositions, zones: zonePositions };
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

export type ColumnDisplay = 'all' | 'keys' | 'none';
export type ComparisonMode = 'overlay' | 'side-by-side';
export type DesignTableMode = 'all' | 'picked';

export interface CanvasNode {
  /** `"design"` for the design's own tables, or a database source ID like `"db1"`. */
  source: string;
  table: string;
  x: number;
  y: number;
  display?: ColumnDisplay;
  /** Zone this node belongs to; undefined means unzoned. */
  zone?: string;
}

export interface CanvasComparison {
  /** Database source ID to compare the design against. */
  db: string;
  mode: ComparisonMode;
}

export interface CanvasZone {
  id: string;
  name: string;
  color?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** When set, this zone is synced with the named viewpoint in `schema.json`. */
  viewpoint?: string;
}

export interface CanvasNote {
  id: string;
  text: string;
  x: number;
  y: number;
  width: number;
}

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

export interface CanvasFile {
  version: 2;
  name: string;
  description?: string;
  /** Whether to show all design tables or only explicitly picked ones. */
  designTables: DesignTableMode;
  nodes: CanvasNode[];
  comparison?: CanvasComparison;
  zones: CanvasZone[];
  notes: CanvasNote[];
  settings: { columnDisplay: ColumnDisplay };
  viewport?: Viewport;
}

/** The fixed source string for the design's own tables. */
export const DESIGN_SOURCE = 'design';

export type CanvasOp =
  | { op: 'nodes.put'; nodes: CanvasNode[] }
  | { op: 'nodes.remove'; ids: string[] }
  | { op: 'nodes.display'; ids: string[]; display?: ColumnDisplay }
  | { op: 'nodes.zone'; ids: string[]; zone?: string }
  | { op: 'comparison.set'; comparison?: CanvasComparison }
  | { op: 'zone.put'; zone: CanvasZone }
  | { op: 'zone.remove'; id: string }
  | { op: 'note.put'; note: CanvasNote }
  | { op: 'note.remove'; id: string }
  | { op: 'settings.set'; settings: Partial<CanvasFile['settings']> }
  | { op: 'meta.set'; name?: string; description?: string }
  | { op: 'designTables.set'; mode: DesignTableMode };

/** One user action; applied atomically and undone as a whole. */
export type CanvasEdit = CanvasOp[];

export function nodeId(source: string, table: string): string {
  return `${source}/${table}`;
}

export function parseNodeId(id: string): { source: string; table: string } {
  const slash = id.indexOf('/');
  return { source: id.slice(0, slash), table: id.slice(slash + 1) };
}

export function emptyCanvas(name: string, designTables: DesignTableMode = 'all', description?: string): CanvasFile {
  return { version: 2, name, description, designTables, nodes: [], zones: [], notes: [], settings: { columnDisplay: 'all' } };
}

export function applyCanvasEdit(canvas: CanvasFile, edit: CanvasEdit): CanvasFile {
  return edit.reduce(applyOp, canvas);
}

function applyOp(c: CanvasFile, op: CanvasOp): CanvasFile {
  switch (op.op) {
    case 'nodes.put': {
      const byId = new Map(c.nodes.map((n) => [nodeId(n.source, n.table), n]));
      for (const n of op.nodes) {
        const id = nodeId(n.source, n.table);
        const prev = byId.get(id);
        byId.set(id, { ...prev, ...n, x: Math.round(n.x), y: Math.round(n.y) });
      }
      return { ...c, nodes: [...byId.values()] };
    }
    case 'nodes.remove': {
      const ids = new Set(op.ids);
      return { ...c, nodes: c.nodes.filter((n) => !ids.has(nodeId(n.source, n.table))) };
    }
    case 'nodes.display': {
      const ids = new Set(op.ids);
      return {
        ...c,
        nodes: c.nodes.map((n) => {
          if (!ids.has(nodeId(n.source, n.table))) return n;
          const { display: _old, ...rest } = n;
          return op.display ? { ...rest, display: op.display } : rest;
        }),
      };
    }
    case 'nodes.zone': {
      const ids = new Set(op.ids);
      return {
        ...c,
        nodes: c.nodes.map((n) => {
          if (!ids.has(nodeId(n.source, n.table))) return n;
          const { zone: _old, ...rest } = n;
          return op.zone ? { ...rest, zone: op.zone } : rest;
        }),
      };
    }
    case 'comparison.set':
      return { ...c, comparison: op.comparison };
    case 'zone.put':
      return { ...c, zones: upsert(c.zones, op.zone) };
    case 'zone.remove': {
      const zoneId = op.id;
      return {
        ...c,
        zones: c.zones.filter((z) => z.id !== zoneId),
        nodes: c.nodes.map((n) => (n.zone === zoneId ? { ...n, zone: undefined } : n)),
      };
    }
    case 'note.put':
      return { ...c, notes: upsert(c.notes, op.note) };
    case 'note.remove':
      return { ...c, notes: c.notes.filter((n) => n.id !== op.id) };
    case 'settings.set':
      return { ...c, settings: { ...c.settings, ...op.settings } };
    case 'meta.set': {
      const name = op.name?.trim() || c.name;
      const description = op.description === undefined ? c.description : op.description.trim() || undefined;
      return name === c.name && description === c.description ? c : { ...c, name, description };
    }
    case 'designTables.set':
      return op.mode === c.designTables ? c : { ...c, designTables: op.mode };
  }
}

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id);
  return i < 0 ? [...list, item] : list.map((x, j) => (j === i ? item : x));
}

/** Rewrites every design node that points at `from`. */
export function renameTableInCanvas(canvas: CanvasFile, from: string, to: string): CanvasFile {
  if (!canvas.nodes.some((n) => n.source === DESIGN_SOURCE && n.table === from)) return canvas;
  return { ...canvas, nodes: canvas.nodes.map((n) => (n.source === DESIGN_SOURCE && n.table === from ? { ...n, table: to } : n)) };
}

/** Remove all nodes that reference the given database source. */
export function removeDbFromCanvas(canvas: CanvasFile, dbId: string): CanvasFile {
  const hasNode = canvas.nodes.some((n) => n.source === dbId);
  const isCompared = canvas.comparison?.db === dbId;
  if (!hasNode && !isCompared) return canvas;
  return {
    ...canvas,
    nodes: hasNode ? canvas.nodes.filter((n) => n.source !== dbId) : canvas.nodes,
    comparison: isCompared ? undefined : canvas.comparison,
  };
}

export function parseCanvas(text: string): CanvasFile {
  const raw = (text.trim() ? JSON.parse(text) : {}) as Partial<CanvasFile>;
  return {
    version: 2,
    name: typeof raw.name === 'string' ? raw.name : '未命名画布',
    description: raw.description,
    designTables: raw.designTables === 'all' ? 'all' : 'picked',
    nodes: Array.isArray(raw.nodes) ? raw.nodes.filter((n) => n && typeof n.source === 'string' && typeof n.table === 'string') : [],
    comparison: raw.comparison,
    zones: Array.isArray(raw.zones) ? raw.zones : [],
    notes: Array.isArray(raw.notes) ? raw.notes : [],
    settings: { columnDisplay: raw.settings?.columnDisplay ?? 'all' },
    viewport: raw.viewport,
  };
}

/** Stable output so saving twice never produces a Git diff. */
export function serializeCanvas(canvas: CanvasFile): string {
  const nodes = [...canvas.nodes]
    .map((n) => ({ ...n, x: Math.round(n.x), y: Math.round(n.y) }))
    .sort((a, b) => a.source.localeCompare(b.source) || a.table.localeCompare(b.table));
  const viewport = canvas.viewport && {
    x: Math.round(canvas.viewport.x),
    y: Math.round(canvas.viewport.y),
    zoom: Math.round(canvas.viewport.zoom * 1000) / 1000,
  };
  const out: CanvasFile = {
    version: 2,
    name: canvas.name,
    description: canvas.description,
    designTables: canvas.designTables,
    nodes,
    comparison: canvas.comparison,
    zones: canvas.zones,
    notes: canvas.notes,
    settings: canvas.settings,
    viewport,
  };
  return `${JSON.stringify(out, null, 2)}\n`;
}

import type { SourceKind } from './workspace';

export type ColumnDisplay = 'all' | 'keys' | 'none';
export type ComparisonMode = 'overlay' | 'side-by-side';

export interface CanvasSource {
  /** Short canvas-local handle; nodes reference sources through it. */
  alias: string;
  kind: SourceKind;
  /** Source id within the same workspace. */
  ref: string;
  /** all: every table is shown, new ones included; picked: only tables listed in `nodes`. */
  tables: 'all' | 'picked';
  /** db only: pin a snapshot file name; null/undefined follows the latest snapshot. */
  snapshot?: string | null;
  color?: string;
}

export interface CanvasNode {
  source: string;
  table: string;
  x: number;
  y: number;
  display?: ColumnDisplay;
}

export interface CanvasComparison {
  design: string;
  db: string;
  mode: ComparisonMode;
}

export interface CanvasGroup {
  id: string;
  label: string;
  color?: string;
  x: number;
  y: number;
  width: number;
  height: number;
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
  version: 1;
  name: string;
  description?: string;
  sources: CanvasSource[];
  nodes: CanvasNode[];
  comparison?: CanvasComparison;
  groups: CanvasGroup[];
  notes: CanvasNote[];
  settings: { columnDisplay: ColumnDisplay };
  viewport?: Viewport;
}

export type CanvasOp =
  | { op: 'source.add'; source: CanvasSource }
  | { op: 'source.update'; alias: string; patch: Partial<Omit<CanvasSource, 'alias' | 'kind' | 'ref'>> }
  | { op: 'source.remove'; alias: string }
  /** Adds the node, or moves it when it is already on the canvas. */
  | { op: 'nodes.put'; nodes: CanvasNode[] }
  | { op: 'nodes.remove'; ids: string[] }
  | { op: 'nodes.display'; ids: string[]; display?: ColumnDisplay }
  | { op: 'comparison.set'; comparison?: CanvasComparison }
  | { op: 'group.put'; group: CanvasGroup }
  | { op: 'group.remove'; id: string }
  | { op: 'note.put'; note: CanvasNote }
  | { op: 'note.remove'; id: string }
  | { op: 'settings.set'; settings: Partial<CanvasFile['settings']> }
  | { op: 'meta.set'; name?: string; description?: string };

/** One user action; applied atomically and undone as a whole. */
export type CanvasEdit = CanvasOp[];

export function nodeId(alias: string, table: string): string {
  return `${alias}/${table}`;
}

export function parseNodeId(id: string): { alias: string; table: string } {
  const slash = id.indexOf('/');
  return { alias: id.slice(0, slash), table: id.slice(slash + 1) };
}

export function emptyCanvas(name: string, description?: string): CanvasFile {
  return { version: 1, name, description, sources: [], nodes: [], groups: [], notes: [], settings: { columnDisplay: 'all' } };
}

export function nextAlias(canvas: CanvasFile, kind: SourceKind): string {
  const prefix = kind === 'design' ? 'd' : 'b';
  const taken = new Set(canvas.sources.map((s) => s.alias));
  for (let i = 1; ; i++) {
    const alias = `${prefix}${i}`;
    if (!taken.has(alias)) {
      return alias;
    }
  }
}

export function applyCanvasEdit(canvas: CanvasFile, edit: CanvasEdit): CanvasFile {
  return edit.reduce(applyOp, canvas);
}

function applyOp(c: CanvasFile, op: CanvasOp): CanvasFile {
  switch (op.op) {
    case 'source.add':
      if (c.sources.some((s) => s.alias === op.source.alias || (s.kind === op.source.kind && s.ref === op.source.ref))) {
        return c;
      }
      return { ...c, sources: [...c.sources, op.source] };
    case 'source.update':
      return { ...c, sources: c.sources.map((s) => (s.alias === op.alias ? { ...s, ...op.patch } : s)) };
    case 'source.remove': {
      const comparison = c.comparison && (c.comparison.design === op.alias || c.comparison.db === op.alias) ? undefined : c.comparison;
      return {
        ...c,
        sources: c.sources.filter((s) => s.alias !== op.alias),
        nodes: c.nodes.filter((n) => n.source !== op.alias),
        comparison,
      };
    }
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
    case 'comparison.set':
      return { ...c, comparison: op.comparison };
    case 'group.put':
      return { ...c, groups: upsert(c.groups, op.group) };
    case 'group.remove':
      return { ...c, groups: c.groups.filter((g) => g.id !== op.id) };
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
  }
}

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id);
  return i < 0 ? [...list, item] : list.map((x, j) => (j === i ? item : x));
}

/** Rewrites every node that points at `from` in sources matching kind/ref. */
export function renameTableInCanvas(canvas: CanvasFile, kind: SourceKind, ref: string, from: string, to: string): CanvasFile {
  const aliases = new Set(canvas.sources.filter((s) => s.kind === kind && s.ref === ref).map((s) => s.alias));
  if (!aliases.size || !canvas.nodes.some((n) => aliases.has(n.source) && n.table === from)) {
    return canvas;
  }
  return { ...canvas, nodes: canvas.nodes.map((n) => (aliases.has(n.source) && n.table === from ? { ...n, table: to } : n)) };
}

export function removeSourceFromCanvas(canvas: CanvasFile, kind: SourceKind, ref: string): CanvasFile {
  const source = canvas.sources.find((s) => s.kind === kind && s.ref === ref);
  return source ? applyOp(canvas, { op: 'source.remove', alias: source.alias }) : canvas;
}

export function parseCanvas(text: string): CanvasFile {
  const raw = (text.trim() ? JSON.parse(text) : {}) as Partial<CanvasFile>;
  return {
    version: 1,
    name: typeof raw.name === 'string' ? raw.name : '未命名画布',
    description: raw.description,
    sources: Array.isArray(raw.sources) ? raw.sources.map((s) => ({ ...s, tables: s.tables === 'all' ? 'all' : 'picked' })) : [],
    nodes: Array.isArray(raw.nodes) ? raw.nodes.filter((n) => n && typeof n.source === 'string' && typeof n.table === 'string') : [],
    comparison: raw.comparison,
    groups: Array.isArray(raw.groups) ? raw.groups : [],
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
    version: 1,
    name: canvas.name,
    description: canvas.description,
    sources: canvas.sources,
    nodes,
    comparison: canvas.comparison,
    groups: canvas.groups,
    notes: canvas.notes,
    settings: canvas.settings,
    viewport,
  };
  return `${JSON.stringify(out, null, 2)}\n`;
}

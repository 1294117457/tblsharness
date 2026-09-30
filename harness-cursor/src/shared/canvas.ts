export type ColumnDisplay = 'all' | 'keys' | 'none';
export type ComparisonMode = 'overlay' | 'side-by-side';
export type NamespaceKind = 'schema' | 'prefix';

export interface CanvasNamespace {
  kind: NamespaceKind;
  /** Schema name (`payment`) or table-name prefix including its separator (`pay_`). */
  value: string;
}

/**
 * A nested design canvas. Coordinates of every item are relative to the frame of the partition
 * it belongs to (or to the root canvas when it has none).
 */
export interface CanvasPartition {
  id: string;
  name: string;
  description?: string;
  parent?: string;
  x: number;
  y: number;
  collapsed?: boolean;
  namespace?: CanvasNamespace;
}

export interface CanvasNode {
  /** `"design"` for the design's own tables, or a database source ID like `"db1"`. */
  source: string;
  table: string;
  x: number;
  y: number;
  display?: ColumnDisplay;
  partition?: string;
  hidden?: boolean;
}

export interface CanvasDiagram {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  partition?: string;
  hidden?: boolean;
}

export interface CanvasNote {
  id: string;
  text: string;
  x: number;
  y: number;
  width: number;
  partition?: string;
}

export interface CanvasComparison {
  /** Database source ID to compare the design against. */
  db: string;
  mode: ComparisonMode;
}

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

/**
 * `layout.json` of a design: where everything sits on the root canvas and its partitions.
 * Design tables and diagrams without an entry are shown at the root.
 */
export interface CanvasFile {
  version: 3;
  /** Last partition number handed out; ids are never reused inside a design. */
  seq?: number;
  partitions: CanvasPartition[];
  nodes: CanvasNode[];
  diagrams: CanvasDiagram[];
  notes: CanvasNote[];
  comparison?: CanvasComparison;
  settings: { columnDisplay: ColumnDisplay };
  /** Keyed by partition ID, or {@link ROOT_SCOPE} for the root canvas. */
  viewports?: Record<string, Viewport>;
}

/** The fixed source string for the design's own tables. */
export const DESIGN_SOURCE = 'design';
export const ROOT_SCOPE = 'root';
export const DIAGRAM_CARD_SIZE = { width: 360, height: 240 };

export type ItemKind = 'table' | 'diagram' | 'note' | 'partition';

/** For tables, `id` is the node ID (`source/table`). */
export interface ItemRef {
  kind: ItemKind;
  id: string;
}

export interface MoveItem extends ItemRef {
  /** Target partition; `null` for the root canvas. */
  partition: string | null;
  x: number;
  y: number;
}

export type CanvasOp =
  | { op: 'nodes.put'; nodes: CanvasNode[] }
  | { op: 'nodes.remove'; ids: string[] }
  | { op: 'nodes.display'; ids: string[]; display?: ColumnDisplay }
  | { op: 'diagrams.put'; diagrams: CanvasDiagram[] }
  | { op: 'diagrams.remove'; ids: string[] }
  | { op: 'hidden.set'; items: ItemRef[]; hidden: boolean }
  | { op: 'move'; items: MoveItem[] }
  | { op: 'partition.put'; partition: CanvasPartition }
  | { op: 'partition.remove'; id: string }
  | { op: 'note.put'; note: CanvasNote }
  | { op: 'note.remove'; id: string }
  | { op: 'comparison.set'; comparison?: CanvasComparison }
  | { op: 'settings.set'; settings: Partial<CanvasFile['settings']> };

/** One user action; applied atomically and undone as a whole. */
export type CanvasEdit = CanvasOp[];

export function nodeId(source: string, table: string): string {
  return `${source}/${table}`;
}

export function parseNodeId(id: string): { source: string; table: string } {
  const i = id.indexOf('/');
  return { source: id.slice(0, i), table: id.slice(i + 1) };
}

export function emptyCanvas(): CanvasFile {
  return { version: 3, partitions: [], nodes: [], diagrams: [], notes: [], settings: { columnDisplay: 'all' } };
}

const PARTITION_PREFIX = 'part';

export function nextPartitionId(canvas: CanvasFile): string {
  let n = canvas.seq ?? 0;
  for (const p of canvas.partitions) n = Math.max(n, partitionNumber(p.id));
  return `${PARTITION_PREFIX}${n + 1}`;
}

function partitionNumber(id: string): number {
  const m = /^part(\d+)$/.exec(id);
  return m ? Number(m[1]) : 0;
}

/** The partition and all partitions nested inside it. */
export function partitionSubtree(canvas: CanvasFile, id: string): Set<string> {
  const out = new Set<string>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of canvas.partitions) {
      if (p.parent && out.has(p.parent) && !out.has(p.id)) {
        out.add(p.id);
        grew = true;
      }
    }
  }
  return out;
}

/** Partitions from the outermost down to `id`; empty for the root. */
export function partitionPath(canvas: CanvasFile, id: string | undefined): CanvasPartition[] {
  const byId = new Map(canvas.partitions.map((p) => [p.id, p]));
  const path: CanvasPartition[] = [];
  const seen = new Set<string>();
  for (let p = id ? byId.get(id) : undefined; p && !seen.has(p.id); p = p.parent ? byId.get(p.parent) : undefined) {
    seen.add(p.id);
    path.unshift(p);
  }
  return path;
}

/** Partition an item lives in; `undefined` is the root. Implicit design tables and diagrams live at the root. */
export function partitionOf(canvas: CanvasFile, ref: ItemRef): string | undefined {
  switch (ref.kind) {
    case 'table':
      return canvas.nodes.find((n) => nodeId(n.source, n.table) === ref.id)?.partition;
    case 'diagram':
      return canvas.diagrams.find((d) => d.id === ref.id)?.partition;
    case 'note':
      return canvas.notes.find((n) => n.id === ref.id)?.partition;
    case 'partition':
      return canvas.partitions.find((p) => p.id === ref.id)?.parent;
  }
}

export function applyCanvasEdit(canvas: CanvasFile, edit: CanvasEdit): CanvasFile {
  let next = canvas;
  for (const op of edit) next = applyOp(next, op);
  return next;
}

/** Copies defined keys only, so a missing or `undefined` field keeps the previous value. */
function merge<T extends object>(prev: T | undefined, patch: T): T {
  const out = { ...(prev ?? {}) } as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) out[k] = v;
  return out as T;
}

function clean<T extends object>(value: T): T {
  const out = { ...value } as Record<string, unknown>;
  for (const k of Object.keys(out)) if (out[k] === undefined || out[k] === false) delete out[k];
  return out as T;
}

function applyOp(canvas: CanvasFile, op: CanvasOp): CanvasFile {
  switch (op.op) {
    case 'nodes.put': {
      if (!op.nodes.length) return canvas;
      const byId = new Map(canvas.nodes.map((n) => [nodeId(n.source, n.table), n]));
      for (const n of op.nodes) {
        const id = nodeId(n.source, n.table);
        byId.set(id, clean(merge(byId.get(id), { ...n, x: Math.round(n.x), y: Math.round(n.y) })));
      }
      return { ...canvas, nodes: [...byId.values()] };
    }
    case 'nodes.remove': {
      const ids = new Set(op.ids);
      const nodes = canvas.nodes.filter((n) => !ids.has(nodeId(n.source, n.table)));
      return nodes.length === canvas.nodes.length ? canvas : { ...canvas, nodes };
    }
    case 'nodes.display': {
      const ids = new Set(op.ids);
      let changed = false;
      const nodes = canvas.nodes.map((n) => {
        if (!ids.has(nodeId(n.source, n.table)) || n.display === op.display) return n;
        changed = true;
        const { display: _old, ...rest } = n;
        return op.display ? { ...rest, display: op.display } : rest;
      });
      return changed ? { ...canvas, nodes } : canvas;
    }
    case 'diagrams.put': {
      if (!op.diagrams.length) return canvas;
      const byId = new Map(canvas.diagrams.map((d) => [d.id, d]));
      for (const d of op.diagrams) {
        byId.set(d.id, clean(merge(byId.get(d.id), { ...d, x: Math.round(d.x), y: Math.round(d.y), width: Math.round(d.width), height: Math.round(d.height) })));
      }
      return { ...canvas, diagrams: [...byId.values()] };
    }
    case 'diagrams.remove': {
      const ids = new Set(op.ids);
      const diagrams = canvas.diagrams.filter((d) => !ids.has(d.id));
      return diagrams.length === canvas.diagrams.length ? canvas : { ...canvas, diagrams };
    }
    case 'hidden.set':
      return setHidden(canvas, op.items, op.hidden);
    case 'move':
      return moveItems(canvas, op.items);
    case 'partition.put': {
      const p = clean({ ...op.partition, x: Math.round(op.partition.x), y: Math.round(op.partition.y) });
      if (!p.name.trim()) return canvas;
      if (p.parent && (p.parent === p.id || !canvas.partitions.some((x) => x.id === p.parent) || partitionSubtree(canvas, p.id).has(p.parent))) return canvas;
      const i = canvas.partitions.findIndex((x) => x.id === p.id);
      if (i >= 0 && JSON.stringify(canvas.partitions[i]) === JSON.stringify(p)) return canvas;
      const partitions = i >= 0 ? canvas.partitions.map((x, j) => (j === i ? p : x)) : [...canvas.partitions, p];
      const seq = Math.max(canvas.seq ?? 0, partitionNumber(p.id)) || undefined;
      return { ...canvas, partitions, seq };
    }
    case 'partition.remove':
      return removePartition(canvas, op.id);
    case 'note.put': {
      const exists = canvas.notes.some((n) => n.id === op.note.id);
      const note = clean(op.note);
      return { ...canvas, notes: exists ? canvas.notes.map((n) => (n.id === note.id ? note : n)) : [...canvas.notes, note] };
    }
    case 'note.remove': {
      const notes = canvas.notes.filter((n) => n.id !== op.id);
      return notes.length === canvas.notes.length ? canvas : { ...canvas, notes };
    }
    case 'comparison.set':
      if (JSON.stringify(canvas.comparison) === JSON.stringify(op.comparison)) return canvas;
      return { ...canvas, comparison: op.comparison };
    case 'settings.set':
      return { ...canvas, settings: { ...canvas.settings, ...op.settings } };
  }
}

function setHidden(canvas: CanvasFile, items: ItemRef[], hidden: boolean): CanvasFile {
  let nodes = canvas.nodes;
  let diagrams = canvas.diagrams;
  for (const ref of items) {
    if (ref.kind === 'table') {
      const i = nodes.findIndex((n) => nodeId(n.source, n.table) === ref.id);
      if (i >= 0) {
        if (!!nodes[i].hidden === hidden) continue;
        nodes = nodes.map((n, j) => (j === i ? clean({ ...n, hidden }) : n));
      } else if (hidden) {
        const { source, table } = parseNodeId(ref.id);
        nodes = [...nodes, { source, table, x: 0, y: 0, hidden: true }];
      }
    } else if (ref.kind === 'diagram') {
      const i = diagrams.findIndex((d) => d.id === ref.id);
      if (i >= 0) {
        if (!!diagrams[i].hidden === hidden) continue;
        diagrams = diagrams.map((d, j) => (j === i ? clean({ ...d, hidden }) : d));
      } else if (hidden) {
        diagrams = [...diagrams, { id: ref.id, x: 0, y: 0, ...DIAGRAM_CARD_SIZE, hidden: true }];
      }
    }
  }
  return nodes === canvas.nodes && diagrams === canvas.diagrams ? canvas : { ...canvas, nodes, diagrams };
}

function moveItems(canvas: CanvasFile, items: MoveItem[]): CanvasFile {
  let next = canvas;
  for (const m of items) {
    const target = m.partition ?? undefined;
    if (target && !next.partitions.some((p) => p.id === target)) continue;
    const x = Math.round(m.x);
    const y = Math.round(m.y);
    switch (m.kind) {
      case 'table': {
        const i = next.nodes.findIndex((n) => nodeId(n.source, n.table) === m.id);
        const { source, table } = parseNodeId(m.id);
        const prev = i >= 0 ? next.nodes[i] : { source, table, x: 0, y: 0 };
        const node = clean({ ...prev, x, y, partition: target });
        next = { ...next, nodes: i >= 0 ? next.nodes.map((n, j) => (j === i ? node : n)) : [...next.nodes, node] };
        break;
      }
      case 'diagram': {
        const i = next.diagrams.findIndex((d) => d.id === m.id);
        const prev = i >= 0 ? next.diagrams[i] : { id: m.id, x: 0, y: 0, ...DIAGRAM_CARD_SIZE };
        const diagram = clean({ ...prev, x, y, partition: target });
        next = { ...next, diagrams: i >= 0 ? next.diagrams.map((d, j) => (j === i ? diagram : d)) : [...next.diagrams, diagram] };
        break;
      }
      case 'note': {
        const i = next.notes.findIndex((n) => n.id === m.id);
        if (i < 0) break;
        const note = clean({ ...next.notes[i], x, y, partition: target });
        next = { ...next, notes: next.notes.map((n, j) => (j === i ? note : n)) };
        break;
      }
      case 'partition': {
        const i = next.partitions.findIndex((p) => p.id === m.id);
        if (i < 0 || (target && partitionSubtree(next, m.id).has(target))) break;
        const partition = clean({ ...next.partitions[i], x, y, parent: target });
        next = { ...next, partitions: next.partitions.map((p, j) => (j === i ? partition : p)) };
        break;
      }
    }
  }
  return next;
}

function removePartition(canvas: CanvasFile, id: string): CanvasFile {
  if (!canvas.partitions.some((p) => p.id === id)) return canvas;
  const gone = partitionSubtree(canvas, id);
  const inside = (p?: string) => !!p && gone.has(p);
  const viewports = canvas.viewports && Object.fromEntries(Object.entries(canvas.viewports).filter(([k]) => !gone.has(k)));
  return {
    ...canvas,
    partitions: canvas.partitions.filter((p) => !gone.has(p.id)),
    nodes: canvas.nodes.filter((n) => !inside(n.partition)),
    diagrams: canvas.diagrams.filter((d) => !inside(d.partition)),
    notes: canvas.notes.filter((n) => !inside(n.partition)),
    viewports: viewports && Object.keys(viewports).length ? viewports : undefined,
  };
}

/** What deleting a partition takes with it; design tables and diagrams also go from the design itself. */
export function partitionContents(canvas: CanvasFile, id: string): { partitions: string[]; designTables: string[]; dbNodes: string[]; diagrams: string[]; notes: number } {
  const gone = partitionSubtree(canvas, id);
  const inside = (p?: string) => !!p && gone.has(p);
  const nodes = canvas.nodes.filter((n) => inside(n.partition));
  return {
    partitions: [...gone],
    designTables: nodes.filter((n) => n.source === DESIGN_SOURCE).map((n) => n.table),
    dbNodes: nodes.filter((n) => n.source !== DESIGN_SOURCE).map((n) => nodeId(n.source, n.table)),
    diagrams: canvas.diagrams.filter((d) => inside(d.partition)).map((d) => d.id),
    notes: canvas.notes.filter((n) => inside(n.partition)).length,
  };
}

/** Keeps the layout entry of a renamed design table. */
export function renameTableInCanvas(canvas: CanvasFile, from: string, to: string): CanvasFile {
  if (!canvas.nodes.some((n) => n.source === DESIGN_SOURCE && n.table === from)) return canvas;
  return { ...canvas, nodes: canvas.nodes.map((n) => (n.source === DESIGN_SOURCE && n.table === from ? { ...n, table: to } : n)) };
}

/** Removes every node of a deleted database and the comparison against it. */
export function removeDbFromCanvas(canvas: CanvasFile, dbId: string): CanvasFile {
  const nodes = canvas.nodes.filter((n) => n.source !== dbId);
  const dropComparison = canvas.comparison?.db === dbId;
  if (nodes.length === canvas.nodes.length && !dropComparison) return canvas;
  const next: CanvasFile = { ...canvas, nodes };
  if (dropComparison) delete next.comparison;
  return next;
}

export function removeDiagramFromCanvas(canvas: CanvasFile, id: string): CanvasFile {
  return applyOp(canvas, { op: 'diagrams.remove', ids: [id] });
}

function num(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

const DISPLAYS: ColumnDisplay[] = ['all', 'keys', 'none'];

function parseNamespace(raw: unknown): CanvasNamespace | undefined {
  const r = raw as Partial<CanvasNamespace> | undefined;
  if (!r || (r.kind !== 'schema' && r.kind !== 'prefix') || !str(r.value)) return undefined;
  return { kind: r.kind, value: String(r.value) };
}

function parseViewport(raw: unknown): Viewport | undefined {
  const v = raw as Partial<Viewport> | undefined;
  if (!v || typeof v !== 'object') return undefined;
  return { x: num(v.x), y: num(v.y), zoom: num(v.zoom, 1) || 1 };
}

/** Tolerant: unknown or broken fields fall back to defaults so a hand-edited file still opens. */
export function parseCanvas(text: string): CanvasFile {
  if (!text.trim()) return emptyCanvas();
  const raw = JSON.parse(text) as Record<string, any>;
  const canvas = emptyCanvas();
  const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);

  canvas.partitions = arr(raw.partitions)
    .filter((p) => str(p?.id))
    .map((p) => clean({ id: String(p.id), name: str(p.name) ?? String(p.id), description: str(p.description), parent: str(p.parent), x: num(p.x), y: num(p.y), collapsed: p.collapsed === true, namespace: parseNamespace(p.namespace) }));
  const partitionIds = new Set(canvas.partitions.map((p) => p.id));
  for (const p of canvas.partitions) if (p.parent && !partitionIds.has(p.parent)) delete p.parent;
  const inPartition = (v: unknown) => {
    const p = str(v);
    return p && partitionIds.has(p) ? p : undefined;
  };

  const seen = new Set<string>();
  canvas.nodes = arr(raw.nodes)
    .filter((n) => str(n?.source) && str(n?.table))
    .map((n) => clean({ source: String(n.source), table: String(n.table), x: num(n.x), y: num(n.y), display: DISPLAYS.includes(n.display) ? n.display : undefined, partition: inPartition(n.partition), hidden: n.hidden === true }))
    .filter((n) => !seen.has(nodeId(n.source, n.table)) && !!seen.add(nodeId(n.source, n.table)));
  canvas.diagrams = arr(raw.diagrams)
    .filter((d) => str(d?.id))
    .map((d) => clean({ id: String(d.id), x: num(d.x), y: num(d.y), width: num(d.width, DIAGRAM_CARD_SIZE.width) || DIAGRAM_CARD_SIZE.width, height: num(d.height, DIAGRAM_CARD_SIZE.height) || DIAGRAM_CARD_SIZE.height, partition: inPartition(d.partition), hidden: d.hidden === true }));
  canvas.notes = arr(raw.notes)
    .filter((n) => str(n?.id))
    .map((n) => clean({ id: String(n.id), text: String(n.text ?? ''), x: num(n.x), y: num(n.y), width: num(n.width, 200) || 200, partition: inPartition(n.partition) }));

  const seq = num(raw.seq);
  if (seq > 0) canvas.seq = seq;
  const c = raw.comparison;
  if (c && str(c.db)) canvas.comparison = { db: String(c.db), mode: c.mode === 'side-by-side' ? 'side-by-side' : 'overlay' };
  if (DISPLAYS.includes(raw.settings?.columnDisplay)) canvas.settings.columnDisplay = raw.settings.columnDisplay;
  if (raw.viewports && typeof raw.viewports === 'object') {
    const viewports: Record<string, Viewport> = {};
    for (const [k, v] of Object.entries(raw.viewports)) {
      const vp = parseViewport(v);
      if (vp && (k === ROOT_SCOPE || partitionIds.has(k))) viewports[k] = vp;
    }
    if (Object.keys(viewports).length) canvas.viewports = viewports;
  }
  return canvas;
}

const round = (v: number) => Math.round(v);
const byNumericId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id, undefined, { numeric: true });

/** Stable output: sorted entries and rounded coordinates keep diffs of `layout.json` small. */
export function serializeCanvas(canvas: CanvasFile): string {
  const out: Record<string, unknown> = { version: 3 };
  if (canvas.seq) out.seq = canvas.seq;
  out.partitions = [...canvas.partitions].sort(byNumericId).map((p) => clean({ ...p, x: round(p.x), y: round(p.y) }));
  out.nodes = [...canvas.nodes]
    .sort((a, b) => nodeId(a.source, a.table).localeCompare(nodeId(b.source, b.table)))
    .map((n) => clean({ ...n, x: round(n.x), y: round(n.y) }));
  out.diagrams = [...canvas.diagrams].sort(byNumericId).map((d) => clean({ ...d, x: round(d.x), y: round(d.y), width: round(d.width), height: round(d.height) }));
  out.notes = [...canvas.notes].sort((a, b) => a.id.localeCompare(b.id)).map((n) => clean({ ...n, x: round(n.x), y: round(n.y) }));
  if (canvas.comparison) out.comparison = canvas.comparison;
  out.settings = canvas.settings;
  if (canvas.viewports && Object.keys(canvas.viewports).length) {
    out.viewports = Object.fromEntries(
      Object.entries(canvas.viewports)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, { x: Math.round(v.x * 100) / 100, y: Math.round(v.y * 100) / 100, zoom: Math.round(v.zoom * 1000) / 1000 }]),
    );
  }
  return `${JSON.stringify(out, null, 2)}\n`;
}

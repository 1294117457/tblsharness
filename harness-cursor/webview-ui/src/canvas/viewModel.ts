import { DESIGN_SOURCE, nodeId, type CanvasFile, type CanvasNote, type ColumnDisplay } from '@shared/canvas';
import type { DiagramType } from '@shared/diagram';
import type { DiffItem, NColumn, NRelation, NTable, RelationKind } from '@shared/model';
import { effectiveNamespace, inNamespace, namespaceLabel, shortName } from '@shared/namespace';
import type { ComparisonData, DiagramData, SourceData } from '@shared/protocol';
import { nodeHeight, NOTE_HEIGHT, NODE_WIDTH, PART_COLLAPSED, PART_HEADER, PART_MIN, PART_PAD } from './layout';

export type Mark = 'design-only' | 'db-only' | 'mismatch' | 'accepted';

export interface ColumnView {
  name: string;
  type: string;
  nullable: boolean;
  primaryKey: boolean;
  unique: boolean;
  foreignKey: boolean;
  comment?: string;
  mark?: Mark;
  note?: string;
  fromDb?: boolean;
}

export interface TableView {
  id: string;
  source: string;
  sourceKind: 'design' | 'db';
  sourceName: string;
  /** Real table name. */
  key: string;
  /** Name shown on the canvas: without the namespace of its level. */
  displayName: string;
  /** Grey tag next to the name when the namespace was stripped. */
  namespaceTag?: string;
  /** Level the table sits in; `undefined` is the root canvas. */
  partition?: string;
  /** No layout entry yet: shown at the root, positioned automatically. */
  implicit: boolean;
  comment?: string;
  isView: boolean;
  editable: boolean;
  missing: boolean;
  display: ColumnDisplay;
  columns: ColumnView[];
  visibleColumns: ColumnView[];
  mark?: Mark;
  note?: string;
  mergedDbTable?: string;
}

export interface EdgeView {
  id: string;
  source: string;
  sourceHandle: string;
  target: string;
  targetHandle: string;
  kind: RelationKind | 'mapping';
  label?: string;
  mark?: Mark;
  edgeSource?: string;
  relationKey?: string;
}

export interface PartitionView {
  id: string;
  name: string;
  description?: string;
  /** Parent frame on screen; `undefined` when it sits directly on the level being shown. */
  parent?: string;
  depth: number;
  collapsed: boolean;
  namespace?: string;
  namespaceInherited: boolean;
  counts: { tables: number; diagrams: number; partitions: number };
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DiagramView {
  id: string;
  name: string;
  type: DiagramType;
  code: string;
  pending?: number;
  partition?: string;
  implicit: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface NoteView extends CanvasNote {}

export interface LevelTable {
  key: string;
  displayName: string;
  namespaceTag?: string;
  comment?: string;
  hidden: boolean;
}

export interface LevelDiagram {
  id: string;
  name: string;
  type: DiagramType;
  hidden: boolean;
}

export interface CanvasView {
  scope?: string;
  /** Rendered items: the level itself plus the content of expanded partitions inside it. */
  tables: TableView[];
  edges: EdgeView[];
  /** Parents before children, as Vue Flow requires. */
  partitions: PartitionView[];
  diagrams: DiagramView[];
  notes: NoteView[];
  /** What the source panel lists: the current level only. */
  level: {
    tables: LevelTable[];
    diagrams: LevelDiagram[];
    /** Database tables shown at this level, by source. */
    db: Record<string, Set<string>>;
    /** Database tables placed on other levels, by source. */
    dbElsewhere: Record<string, Set<string>>;
  };
}

export const TABLE_HANDLE = '__table';

export function handleFor(table: TableView | undefined, column: string, side: 's' | 't'): string {
  const visible = table?.visibleColumns.some((c) => c.name === column);
  return `${visible ? column : TABLE_HANDLE}:${side}`;
}

const KIND_LABELS: Record<RelationKind, string> = {
  fk: '',
  virtual: 'virtual',
  logical: 'logical',
  json_array: 'json[]',
  polymorphic: 'poly',
  dictionary: 'dict',
};

interface Placement {
  partition?: string;
  hidden: boolean;
  implicit: boolean;
}

export function buildView(
  canvas: CanvasFile,
  sources: Record<string, SourceData>,
  comparison: ComparisonData | undefined,
  diagramData: DiagramData[],
  scope: string | undefined,
): CanvasView {
  const byPart = new Map(canvas.partitions.map((p) => [p.id, p]));
  const childrenOf = new Map<string | undefined, string[]>();
  for (const p of canvas.partitions) childrenOf.set(p.parent, [...(childrenOf.get(p.parent) ?? []), p.id]);

  // Frames on screen, parents first; `open` = levels whose content is rendered.
  const shownParts: { id: string; parent?: string; depth: number }[] = [];
  const open = new Set<string | undefined>([scope]);
  const walk = (parent: string | undefined, depth: number) => {
    for (const id of childrenOf.get(parent) ?? []) {
      shownParts.push({ id, parent: parent === scope ? undefined : parent, depth });
      if (!byPart.get(id)!.collapsed) {
        open.add(id);
        walk(id, depth + 1);
      }
    }
  };
  walk(scope, 1);

  const placed = new Map(canvas.nodes.map((n) => [nodeId(n.source, n.table), n]));
  const placement = (id: string): Placement => {
    const n = placed.get(id);
    return n ? { partition: n.partition, hidden: !!n.hidden, implicit: false } : { hidden: false, implicit: true };
  };

  const sourceIds = new Set(canvas.nodes.map((n) => n.source));
  sourceIds.add(DESIGN_SOURCE);

  const tables = new Map<string, TableView>();
  const levelTables: LevelTable[] = [];
  const levelDb: Record<string, Set<string>> = {};
  const dbElsewhere: Record<string, Set<string>> = {};
  const nsCache = new Map<string | undefined, ReturnType<typeof effectiveNamespace>>();
  const nsAt = (level: string | undefined) => {
    if (!nsCache.has(level)) nsCache.set(level, effectiveNamespace(canvas, level));
    return nsCache.get(level);
  };

  for (const src of sourceIds) {
    const data = sources[src];
    const schema = data?.schema;
    const byKey = new Map((schema?.tables ?? []).map((t) => [t.key, t]));
    const fks = foreignKeys(schema?.relations ?? []);
    const isDesign = src === DESIGN_SOURCE;
    const keys = new Set<string>(isDesign ? byKey.keys() : []);
    for (const n of canvas.nodes) if (n.source === src) keys.add(n.table);

    for (const key of keys) {
      const id = nodeId(src, key);
      const p = placement(id);
      if (!isDesign && p.implicit) continue;
      const level = p.partition;
      const ns = isDesign ? nsAt(level) : undefined;
      const displayName = shortName(ns, key);
      const namespaceTag = ns && inNamespace(ns, key) ? namespaceLabel(ns) : undefined;
      if (level === scope) {
        if (isDesign) levelTables.push({ key, displayName, namespaceTag, comment: byKey.get(key)?.comment, hidden: p.hidden });
        else if (!p.hidden) (levelDb[src] ??= new Set()).add(key);
      } else if (!isDesign) {
        (dbElsewhere[src] ??= new Set()).add(key);
      }
      if (p.hidden || !open.has(level)) continue;
      const display = placed.get(id)?.display ?? canvas.settings.columnDisplay;
      tables.set(id, {
        ...mkTableView(id, src, isDesign ? 'design' : 'db', data?.name ?? src, key, byKey.get(key), fks.get(key), display),
        displayName,
        namespaceTag,
        partition: level,
        implicit: p.implicit,
      });
    }
  }
  dedupeDisplayNames(
    [...tables.values()].filter((t) => t.sourceKind === 'design'),
    (t) => t.partition ?? '',
  );
  dedupeDisplayNames(levelTables, () => '');

  const edges: EdgeView[] = [];
  const c = canvas.comparison;
  const hiddenByComparison = new Set<string>();
  if (c && comparison && sources[DESIGN_SOURCE]?.schema && sources[c.db]?.schema) {
    applyComparison(tables, edges, hiddenByComparison, c.db, c.mode, sources, comparison);
  }

  for (const src of sourceIds) {
    const schema = sources[src]?.schema;
    if (!schema) continue;
    const isComparedDb = c && comparison && src === c.db;
    for (const r of schema.relations) {
      let from = nodeId(src, r.from.table);
      let to = nodeId(src, r.to.table);
      if (isComparedDb && c.mode === 'overlay') {
        const item = comparison.diff.items.find((i) => i.kind === 'relation_missing_in_design' && i.relation === r.key);
        if (!item) continue;
        from = redirect(from, tables);
        to = redirect(to, tables);
      }
      if (!tables.has(from) || !tables.has(to) || hiddenByComparison.has(from) || hiddenByComparison.has(to)) continue;
      edges.push(relationEdge(src, r, from, to, tables, relationMark(src, r, c, comparison)));
    }
  }

  const visible = [...tables.values()].filter((t) => !hiddenByComparison.has(t.id));
  for (const t of visible) t.visibleColumns = visibleColumns(t);

  // Diagrams
  const diagramEntries = new Map(canvas.diagrams.map((d) => [d.id, d]));
  const diagrams: DiagramView[] = [];
  const levelDiagrams: LevelDiagram[] = [];
  for (const d of diagramData) {
    const entry = diagramEntries.get(d.id);
    const level = entry?.partition;
    if (level === scope) levelDiagrams.push({ id: d.id, name: d.name, type: d.type, hidden: !!entry?.hidden });
    if (entry?.hidden || !open.has(level)) continue;
    diagrams.push({
      id: d.id,
      name: d.name,
      type: d.type,
      code: d.code,
      pending: d.pending,
      partition: level,
      implicit: !entry,
      x: entry?.x ?? 0,
      y: entry?.y ?? 0,
      width: entry?.width ?? 360,
      height: entry?.height ?? 240,
    });
  }

  const notes = canvas.notes.filter((n) => open.has(n.partition));

  // Frame sizes follow their content, innermost first.
  const sizes = new Map<string, { width: number; height: number }>();
  const counts = new Map<string, PartitionView['counts']>();
  for (const p of canvas.partitions) counts.set(p.id, { tables: 0, diagrams: 0, partitions: (childrenOf.get(p.id) ?? []).length });
  for (const n of canvas.nodes) if (n.source === DESIGN_SOURCE && n.partition) counts.get(n.partition)!.tables++;
  for (const d of canvas.diagrams) if (d.partition && diagramData.some((x) => x.id === d.id)) counts.get(d.partition)!.diagrams++;

  for (const sp of [...shownParts].reverse()) {
    const p = byPart.get(sp.id)!;
    if (p.collapsed) {
      sizes.set(p.id, { ...PART_COLLAPSED });
      continue;
    }
    let right = 0;
    let bottom = 0;
    const grow = (x: number, y: number, w: number, h: number) => {
      right = Math.max(right, x + w);
      bottom = Math.max(bottom, y + h);
    };
    for (const t of visible) {
      if (t.partition !== p.id) continue;
      const n = placed.get(t.id);
      if (n) grow(n.x, n.y, NODE_WIDTH, nodeHeight(t));
    }
    for (const d of diagrams) if (d.partition === p.id) grow(d.x, d.y, d.width, d.height);
    for (const n of notes) if (n.partition === p.id) grow(n.x, n.y, n.width, NOTE_HEIGHT);
    for (const child of childrenOf.get(p.id) ?? []) {
      const cp = byPart.get(child)!;
      const s = sizes.get(child);
      if (s) grow(cp.x, cp.y, s.width, s.height);
    }
    sizes.set(p.id, { width: Math.max(PART_MIN.width, right + PART_PAD), height: Math.max(PART_MIN.height, bottom + PART_PAD, PART_HEADER + PART_PAD) });
  }

  const partitions: PartitionView[] = shownParts.map((sp) => {
    const p = byPart.get(sp.id)!;
    const own = p.namespace;
    const ns = own ?? nsAt(p.id);
    return {
      id: p.id,
      name: p.name,
      description: p.description,
      parent: sp.parent,
      depth: sp.depth,
      collapsed: !!p.collapsed,
      namespace: ns && namespaceLabel(ns),
      namespaceInherited: !own && !!ns,
      counts: counts.get(p.id)!,
      x: p.x,
      y: p.y,
      ...sizes.get(p.id)!,
    };
  });

  return {
    scope,
    tables: visible,
    edges,
    partitions,
    diagrams,
    notes,
    level: { tables: levelTables, diagrams: levelDiagrams, db: levelDb, dbElsewhere },
  };
}

/** Two design tables on one level must not look the same: a shortened name that collides shows the real name. */
function dedupeDisplayNames<T extends { displayName: string; key: string; namespaceTag?: string }>(list: T[], levelOf: (t: T) => string): void {
  const slot = (t: T) => `${levelOf(t)}\n${t.displayName}`;
  const count = new Map<string, number>();
  for (const t of list) count.set(slot(t), (count.get(slot(t)) ?? 0) + 1);
  for (const t of list) {
    if (t.namespaceTag && (count.get(slot(t)) ?? 0) > 1) {
      t.displayName = t.key;
      t.namespaceTag = undefined;
    }
  }
}

function mkTableView(
  id: string,
  source: string,
  sourceKind: 'design' | 'db',
  sourceName: string,
  key: string,
  table: NTable | undefined,
  fks: Set<string> | undefined,
  display: ColumnDisplay,
): Omit<TableView, 'displayName' | 'partition' | 'implicit'> {
  return {
    id,
    source,
    sourceKind,
    sourceName,
    key,
    comment: table?.comment,
    isView: !!table && table.type.toUpperCase().includes('VIEW'),
    editable: sourceKind === 'design' && !!table,
    missing: !table,
    display,
    columns: (table?.columns ?? []).map((col) => columnView(col, fks)),
    visibleColumns: [],
  };
}

function columnView(column: NColumn, fks?: Set<string>): ColumnView {
  return {
    name: column.name,
    type: column.rawType,
    nullable: column.nullable,
    primaryKey: column.primaryKey,
    unique: column.unique,
    foreignKey: fks?.has(column.name) ?? false,
    comment: column.comment,
  };
}

function visibleColumns(t: TableView): ColumnView[] {
  if (t.display === 'none') return [];
  if (t.display === 'keys') return t.columns.filter((c) => c.primaryKey || c.foreignKey || c.mark);
  return t.columns;
}

function foreignKeys(relations: NRelation[]): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const r of relations) {
    const set = map.get(r.from.table) ?? new Set<string>();
    r.from.columns.forEach((c) => set.add(c));
    map.set(r.from.table, set);
  }
  return map;
}

function relationEdge(src: string, r: NRelation, fromId: string, toId: string, tables: Map<string, TableView>, mark?: Mark): EdgeView {
  return {
    id: `${src}|${r.key}`,
    source: toId,
    sourceHandle: handleFor(tables.get(toId), r.to.columns[0], 's'),
    target: fromId,
    targetHandle: handleFor(tables.get(fromId), r.from.columns[0], 't'),
    kind: r.kind,
    label: KIND_LABELS[r.kind] || undefined,
    mark,
    edgeSource: src,
    relationKey: r.key,
  };
}

function markOf(item: DiffItem, mark: Mark): Mark {
  return item.accepted ? 'accepted' : mark;
}

function relationMark(src: string, r: NRelation, c: CanvasFile['comparison'], comparison?: ComparisonData): Mark | undefined {
  if (!c || !comparison || (src !== DESIGN_SOURCE && src !== c.db)) return undefined;
  const kind = src === DESIGN_SOURCE ? 'relation_missing_in_db' : 'relation_missing_in_design';
  const item = comparison.diff.items.find((i) => i.kind === kind && i.relation === r.key);
  return item && markOf(item, src === DESIGN_SOURCE ? 'design-only' : 'db-only');
}

function dbKeyFor(designKey: string, mappings: Record<string, string>): string {
  return mappings[designKey] ?? designKey;
}

function redirect(dbNodeId: string, tables: Map<string, TableView>): string {
  const dbKey = dbNodeId.slice(dbNodeId.indexOf('/') + 1);
  for (const t of tables.values()) {
    if (t.source === DESIGN_SOURCE && t.mergedDbTable === dbKey) return t.id;
  }
  return dbNodeId;
}

function applyComparison(
  tables: Map<string, TableView>,
  edges: EdgeView[],
  hidden: Set<string>,
  dbSource: string,
  mode: 'overlay' | 'side-by-side',
  sources: Record<string, SourceData>,
  comparison: ComparisonData,
): void {
  const mappings = comparison.tableMappings;
  const dbSchema = sources[dbSource].schema!;
  const dbTables = new Map(dbSchema.tables.map((t) => [t.key, t]));
  const dbFks = foreignKeys(dbSchema.relations);
  const designNode = (key: string) => tables.get(nodeId(DESIGN_SOURCE, key));
  const dbNode = (key: string) => tables.get(nodeId(dbSource, key));

  for (const t of tables.values()) {
    if (t.source !== DESIGN_SOURCE || t.missing) continue;
    const dbKey = dbKeyFor(t.key, mappings);
    if (!dbTables.has(dbKey)) continue;
    const counterpart = dbNode(dbKey);
    if (mode === 'overlay') {
      t.mergedDbTable = dbKey;
      if (counterpart) hidden.add(counterpart.id);
    } else if (counterpart) {
      edges.push({
        id: `map|${t.id}|${counterpart.id}`,
        source: t.id,
        sourceHandle: `${TABLE_HANDLE}:s`,
        target: counterpart.id,
        targetHandle: `${TABLE_HANDLE}:t`,
        kind: 'mapping',
      });
    }
  }

  for (const item of comparison.diff.items) {
    switch (item.kind) {
      case 'table_missing_in_db': {
        const t = designNode(item.table);
        if (t) Object.assign(t, { mark: markOf(item, 'design-only'), note: item.message });
        break;
      }
      case 'table_missing_in_design': {
        const t = dbNode(item.table);
        if (t) Object.assign(t, { mark: markOf(item, 'db-only'), note: item.message });
        break;
      }
      case 'column_missing_in_db':
      case 'column_mismatch': {
        const mark = markOf(item, item.kind === 'column_mismatch' ? 'mismatch' : 'design-only');
        const c = designNode(item.table)?.columns.find((col) => col.name === item.column);
        if (c) Object.assign(c, { mark, note: item.message });
        if (mode === 'side-by-side' && item.kind === 'column_mismatch') {
          const d = dbNode(dbKeyFor(item.table, mappings))?.columns.find((col) => col.name === item.column);
          if (d) Object.assign(d, { mark, note: item.message });
        }
        break;
      }
      case 'column_missing_in_design': {
        const dbKey = item.dbTable ?? item.table;
        const mark = markOf(item, 'db-only');
        if (mode === 'overlay') {
          const target = designNode(item.table);
          const source = dbTables.get(dbKey)?.columns.find((col) => col.name === item.column);
          if (target && source) target.columns.push({ ...columnView(source, dbFks.get(dbKey)), mark, note: item.message, fromDb: true });
        } else {
          const c = dbNode(dbKey)?.columns.find((col) => col.name === item.column);
          if (c) Object.assign(c, { mark, note: item.message });
        }
        break;
      }
      default:
        break;
    }
  }
}

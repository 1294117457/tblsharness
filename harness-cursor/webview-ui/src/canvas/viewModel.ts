import { DESIGN_SOURCE, nodeId, type CanvasFile, type ColumnDisplay } from '@shared/canvas';
import type { DiffItem, NColumn, NRelation, NTable, RelationKind } from '@shared/model';
import type { ComparisonData, SourceData } from '@shared/protocol';

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
  key: string;
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

export interface ZoneView {
  id: string;
  name: string;
  color?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  viewpoint?: string;
  tableCount: number;
}

export interface CanvasView {
  tables: TableView[];
  edges: EdgeView[];
  zones: ZoneView[];
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

export function buildView(canvas: CanvasFile, sources: Record<string, SourceData>, comparison?: ComparisonData): CanvasView {
  const tables = new Map<string, TableView>();
  const placed = new Map(canvas.nodes.map((n) => [nodeId(n.source, n.table), n]));

  const sourceIds = new Set(canvas.nodes.map((n) => n.source));
  sourceIds.add(DESIGN_SOURCE);

  for (const src of sourceIds) {
    const data = sources[src];
    const schema = data?.schema;
    const byKey = new Map((schema?.tables ?? []).map((t) => [t.key, t]));
    const fks = foreignKeys(schema?.relations ?? []);
    const isDesign = src === DESIGN_SOURCE;
    const showAll = isDesign && canvas.designTables === 'all';
    const keys = new Set<string>(showAll ? byKey.keys() : []);
    for (const n of canvas.nodes) if (n.source === src) keys.add(n.table);

    const sourceKind: 'design' | 'db' = isDesign ? 'design' : 'db';
    for (const key of keys) {
      const id = nodeId(src, key);
      const table = byKey.get(key);
      const display = placed.get(id)?.display ?? canvas.settings.columnDisplay;
      tables.set(id, mkTableView(id, src, sourceKind, data?.name ?? src, key, table, fks.get(key), display));
    }
  }

  const edges: EdgeView[] = [];
  const c = canvas.comparison;
  const hidden = new Set<string>();
  if (c && comparison && sources[DESIGN_SOURCE]?.schema && sources[c.db]?.schema) {
    applyComparison(tables, edges, hidden, c.db, c.mode, sources, comparison);
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
      if (!tables.has(from) || !tables.has(to) || hidden.has(from) || hidden.has(to)) continue;
      edges.push(relationEdge(src, r, from, to, tables, relationMark(src, r, c, comparison)));
    }
  }

  const visible = [...tables.values()].filter((t) => !hidden.has(t.id));
  for (const t of visible) t.visibleColumns = visibleColumns(t);

  const zonedNodes = new Map<string, number>();
  for (const n of canvas.nodes) {
    if (n.zone) zonedNodes.set(n.zone, (zonedNodes.get(n.zone) ?? 0) + 1);
  }
  const zones: ZoneView[] = canvas.zones.map((z) => ({
    ...z,
    tableCount: zonedNodes.get(z.id) ?? 0,
  }));

  return { tables: visible, edges, zones };
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
): TableView {
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

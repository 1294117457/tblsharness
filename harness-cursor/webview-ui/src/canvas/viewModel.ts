import { nodeId, type CanvasFile, type ColumnDisplay } from '@shared/canvas';
import type { DiffItem, NColumn, NRelation, NTable, RelationKind } from '@shared/model';
import type { ComparisonData, SourceData } from '@shared/protocol';
import type { SourceKind } from '@shared/workspace';

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
  /** Column exists only on the db side and was merged into a design node. */
  fromDb?: boolean;
}

export interface TableView {
  id: string;
  alias: string;
  sourceKind: SourceKind;
  sourceName: string;
  key: string;
  comment?: string;
  isView: boolean;
  editable: boolean;
  missing: boolean;
  display: ColumnDisplay;
  /** All columns; `visibleColumns` is what the node renders. */
  columns: ColumnView[];
  visibleColumns: ColumnView[];
  mark?: Mark;
  note?: string;
  /** Overlay mode: the db table merged into this design node. */
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
  alias?: string;
  relationKey?: string;
}

export interface CanvasView {
  tables: TableView[];
  edges: EdgeView[];
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

  for (const source of canvas.sources) {
    const data = sources[source.alias];
    const schema = data?.schema;
    const byKey = new Map((schema?.tables ?? []).map((t) => [t.key, t]));
    const fks = foreignKeys(schema?.relations ?? []);
    const keys = new Set<string>(source.tables === 'all' ? byKey.keys() : []);
    for (const n of canvas.nodes) if (n.source === source.alias) keys.add(n.table);

    for (const key of keys) {
      const id = nodeId(source.alias, key);
      const table = byKey.get(key);
      const display = placed.get(id)?.display ?? canvas.settings.columnDisplay;
      tables.set(id, tableView(id, source.alias, source.kind, data?.name ?? source.ref, key, table, fks.get(key), display));
    }
  }

  const edges: EdgeView[] = [];
  const c = canvas.comparison;
  const hidden = new Set<string>();
  if (c && comparison && sources[c.design]?.schema && sources[c.db]?.schema) {
    applyComparison(tables, edges, hidden, c.design, c.db, c.mode, sources, comparison);
  }

  for (const source of canvas.sources) {
    const schema = sources[source.alias]?.schema;
    if (!schema) continue;
    const isComparedDb = c && comparison && source.alias === c.db;
    for (const r of schema.relations) {
      let from = nodeId(source.alias, r.from.table);
      let to = nodeId(source.alias, r.to.table);
      if (isComparedDb && c.mode === 'overlay') {
        // Only db relations the design lacks are drawn; they attach to the merged design nodes where possible.
        const item = comparison.diff.items.find((i) => i.kind === 'relation_missing_in_design' && i.relation === r.key);
        if (!item) continue;
        from = redirect(from, tables, c.design);
        to = redirect(to, tables, c.design);
      }
      if (!tables.has(from) || !tables.has(to) || hidden.has(from) || hidden.has(to)) continue;
      edges.push(relationEdge(source.alias, r, from, to, tables, relationMark(source.alias, r, c, comparison)));
    }
  }

  const visible = [...tables.values()].filter((t) => !hidden.has(t.id));
  for (const t of visible) t.visibleColumns = visibleColumns(t);
  return { tables: visible, edges };
}

function tableView(
  id: string,
  alias: string,
  sourceKind: SourceKind,
  sourceName: string,
  key: string,
  table: NTable | undefined,
  fks: Set<string> | undefined,
  display: ColumnDisplay,
): TableView {
  return {
    id,
    alias,
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

function relationEdge(alias: string, r: NRelation, fromId: string, toId: string, tables: Map<string, TableView>, mark?: Mark): EdgeView {
  // Parent on the source side, child on the target side; composite keys are drawn from their first column.
  return {
    id: `${alias}|${r.key}`,
    source: toId,
    sourceHandle: handleFor(tables.get(toId), r.to.columns[0], 's'),
    target: fromId,
    targetHandle: handleFor(tables.get(fromId), r.from.columns[0], 't'),
    kind: r.kind,
    label: KIND_LABELS[r.kind] || undefined,
    mark,
    alias,
    relationKey: r.key,
  };
}

function markOf(item: DiffItem, mark: Mark): Mark {
  return item.accepted ? 'accepted' : mark;
}

function relationMark(alias: string, r: NRelation, c: CanvasFile['comparison'], comparison?: ComparisonData): Mark | undefined {
  if (!c || !comparison || (alias !== c.design && alias !== c.db)) return undefined;
  const kind = alias === c.design ? 'relation_missing_in_db' : 'relation_missing_in_design';
  const item = comparison.diff.items.find((i) => i.kind === kind && i.relation === r.key);
  return item && markOf(item, alias === c.design ? 'design-only' : 'db-only');
}

function dbKeyFor(designKey: string, mappings: Record<string, string>): string {
  return mappings[designKey] ?? designKey;
}

/** In overlay mode a db table is drawn as the design node it merged into, whether or not the db node itself is on the canvas. */
function redirect(dbNodeId: string, tables: Map<string, TableView>, designAlias: string): string {
  const dbKey = dbNodeId.slice(dbNodeId.indexOf('/') + 1);
  for (const t of tables.values()) {
    if (t.alias === designAlias && t.mergedDbTable === dbKey) return t.id;
  }
  return dbNodeId;
}

function applyComparison(
  tables: Map<string, TableView>,
  edges: EdgeView[],
  hidden: Set<string>,
  designAlias: string,
  dbAlias: string,
  mode: 'overlay' | 'side-by-side',
  sources: Record<string, SourceData>,
  comparison: ComparisonData,
): void {
  const mappings = comparison.tableMappings;
  const dbSchema = sources[dbAlias].schema!;
  const dbTables = new Map(dbSchema.tables.map((t) => [t.key, t]));
  const dbFks = foreignKeys(dbSchema.relations);
  const designNode = (key: string) => tables.get(nodeId(designAlias, key));
  const dbNode = (key: string) => tables.get(nodeId(dbAlias, key));

  for (const t of tables.values()) {
    if (t.alias !== designAlias || t.missing) continue;
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

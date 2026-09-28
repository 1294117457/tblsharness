import {
  relationKey,
  type DesignExt,
  type ModelSource,
  type NColumn,
  type NEnum,
  type NRelation,
  type NTable,
  type NormalizedSchema,
  type RelationKind,
} from '../shared/model';
import type { TblsColumn, TblsSchema, TblsTable } from '../shared/tbls';
import { parseColumnType } from './types';

export { relationKey };

export interface NormalizeOptions {
  source: ModelSource;
  defaultSchema?: string;
  /** Only applied to the design model: overrides relation kinds that tbls cannot express. */
  ext?: DesignExt;
}

export function normalize(schema: TblsSchema, options: NormalizeOptions): NormalizedSchema {
  const defaultSchema = options.defaultSchema ?? schema.driver?.meta?.current_schema;
  const stripSchema = (name: string) =>
    defaultSchema && name.startsWith(`${defaultSchema}.`) ? name.slice(defaultSchema.length + 1) : name;

  const enums: NEnum[] = (schema.enums ?? []).map((e) => ({ key: stripSchema(e.name), values: e.values }));
  const enumByKey = new Map(enums.map((e) => [e.key, e.values]));
  const lookupEnum = (rawType: string) => enumByKey.get(stripSchema(rawType.replace(/"/g, '')));

  const tables = schema.tables
    .map((t) => normalizeTable(t, stripSchema, lookupEnum))
    .sort((a, b) => a.key.localeCompare(b.key));

  const relationExt = new Map((options.ext?.relations ?? []).map((r) => [r.key, r]));
  const relations = (schema.relations ?? []).map((r): NRelation => {
    const from = { table: stripSchema(r.table), columns: r.columns };
    const to = { table: stripSchema(r.parent_table), columns: r.parent_columns };
    const key = relationKey(from.table, from.columns, to.table, to.columns);
    const ext = relationExt.get(key);
    return {
      key,
      from,
      to,
      cardinality: r.cardinality ?? '',
      parentCardinality: r.parent_cardinality ?? '',
      kind: ext?.kind ?? defaultRelationKind(options.source, r.virtual),
      def: r.def,
      discriminator: ext?.discriminator,
      note: ext?.note,
    };
  });

  return {
    source: options.source,
    name: schema.name ?? '',
    driver: schema.driver && {
      name: schema.driver.name,
      version: schema.driver.database_version,
      defaultSchema,
    },
    tables,
    relations,
    enums,
  };
}

function defaultRelationKind(source: ModelSource, virtual?: boolean): RelationKind {
  if (!virtual) {
    return 'fk';
  }
  // In the design model a virtual relation means "designed, but not a FOREIGN KEY".
  return source === 'design' ? 'logical' : 'virtual';
}

function normalizeTable(
  table: TblsTable,
  stripSchema: (name: string) => string,
  lookupEnum: (rawType: string) => string[] | undefined,
): NTable {
  const key = stripSchema(table.name);
  const dot = key.lastIndexOf('.');
  const primaryKeys = new Set<string>();
  const uniques = new Set<string>();

  for (const c of table.constraints ?? []) {
    const type = c.type.toUpperCase();
    if (type.includes('PRIMARY')) {
      c.columns?.forEach((col) => primaryKeys.add(col));
    } else if (type.includes('UNIQUE') && c.columns?.length === 1) {
      uniques.add(c.columns[0]);
    }
  }
  for (const idx of table.indexes ?? []) {
    if (/\bUNIQUE\b/i.test(idx.def) && idx.columns.length === 1) {
      uniques.add(idx.columns[0]);
    }
  }

  return {
    key,
    rawName: table.name,
    schema: dot > 0 ? key.slice(0, dot) : undefined,
    type: table.type,
    comment: table.comment || undefined,
    columns: table.columns.map((c) => normalizeColumn(c, primaryKeys, uniques, lookupEnum)),
    indexes: table.indexes ?? [],
  };
}

function normalizeColumn(
  column: TblsColumn,
  primaryKeys: Set<string>,
  uniques: Set<string>,
  lookupEnum: (rawType: string) => string[] | undefined,
): NColumn {
  const parsed = parseColumnType(column.type, lookupEnum(column.type));
  const primaryKey = primaryKeys.has(column.name);
  return {
    name: column.name,
    rawType: column.type,
    ...parsed,
    nullable: column.nullable,
    primaryKey,
    unique: primaryKey || uniques.has(column.name),
    autoIncrement: isAutoIncrement(column),
    default: column.default,
    comment: column.comment || undefined,
  };
}

function isAutoIncrement(column: TblsColumn): boolean {
  return (
    /\bnextval\(/i.test(column.default ?? '') ||
    /auto_increment|autoincrement|\bidentity\b/i.test(column.extra_def ?? '') ||
    /serial/i.test(column.type)
  );
}

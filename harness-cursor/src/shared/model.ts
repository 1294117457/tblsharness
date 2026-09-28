import type { TblsCardinality, TblsIndex } from './tbls';

export type ModelSource = 'db' | 'design';

export type LogicalType =
  | 'integer'
  | 'decimal'
  | 'float'
  | 'string'
  | 'text'
  | 'boolean'
  | 'date'
  | 'time'
  | 'datetime'
  | 'json'
  | 'uuid'
  | 'binary'
  | 'enum'
  | 'array'
  | 'vector'
  | 'other';

/**
 * fk:          a real FOREIGN KEY in the database
 * virtual:     declared in .tbls.yml `relations` (tbls marks it virtual)
 * logical:     designed relation that is intentionally not a FOREIGN KEY
 * json_array:  ids stored in a JSON/array column, e.g. reviewer_ids -> users.id
 * polymorphic: target table depends on a discriminator column
 * dictionary:  points to a code-level dictionary instead of a table
 */
export type RelationKind = 'fk' | 'virtual' | 'logical' | 'json_array' | 'polymorphic' | 'dictionary';

export interface NColumn {
  name: string;
  rawType: string;
  logicalType: LogicalType;
  length?: number;
  precision?: number;
  scale?: number;
  nullable: boolean;
  primaryKey: boolean;
  unique: boolean;
  autoIncrement: boolean;
  default?: string | null;
  comment?: string;
  enumValues?: string[];
}

export interface NTable {
  /** Name with the default schema stripped, e.g. `users` or `pgmq.meta`. Used as the identity for mapping and diff. */
  key: string;
  rawName: string;
  schema?: string;
  type: string;
  comment?: string;
  columns: NColumn[];
  indexes: TblsIndex[];
}

export interface NRelationEnd {
  table: string;
  columns: string[];
}

export function relationKey(fromTable: string, fromColumns: string[], toTable: string, toColumns: string[]): string {
  return `${fromTable}(${fromColumns.join(',')})->${toTable}(${toColumns.join(',')})`;
}

export interface NRelation {
  key: string;
  from: NRelationEnd;
  to: NRelationEnd;
  cardinality: TblsCardinality;
  parentCardinality: TblsCardinality;
  kind: RelationKind;
  def: string;
  discriminator?: string;
  note?: string;
}

export interface NEnum {
  key: string;
  values: string[];
}

export interface NormalizedSchema {
  source: ModelSource;
  name: string;
  driver?: {
    name: string;
    version?: string;
    defaultSchema?: string;
  };
  tables: NTable[];
  relations: NRelation[];
  enums: NEnum[];
}

/** Content of a design source's `ext.json`: everything the tbls format cannot express. */
export interface DesignExt {
  version: 2;
  relations: RelationExt[];
  /** Domain modules of the model itself; unrelated to the visual group boxes on a canvas. */
  modules: GroupExt[];
}

/** How one design source is compared against one db source. Shared by every canvas in the workspace. */
export interface ComparisonPair {
  design: string;
  db: string;
  /** design table key -> db table key, only needed when the names differ. */
  tableMappings: Record<string, string>;
  /** Diff item ids the user has confirmed as intentional. */
  acceptedDiffs: string[];
}

export interface RelationExt {
  /** Matches NRelation.key: `table(col,...)->parent(col,...)`. */
  key: string;
  kind: RelationKind;
  discriminator?: string;
  note?: string;
}

export interface GroupExt {
  name: string;
  desc?: string;
  color?: string;
  tables: string[];
}

export type DiffKind =
  | 'table_missing_in_db'
  | 'table_missing_in_design'
  | 'column_missing_in_db'
  | 'column_missing_in_design'
  | 'column_mismatch'
  | 'relation_missing_in_db'
  | 'relation_missing_in_design';

export interface DiffItem {
  id: string;
  kind: DiffKind;
  /** Design table key, or the db table key when the table only exists in the database. */
  table: string;
  /** Db table key the item was compared against, when it differs from `table` or only exists there. */
  dbTable?: string;
  column?: string;
  relation?: string;
  message: string;
  accepted: boolean;
}

export interface DiffResult {
  items: DiffItem[];
  counts: Record<DiffKind, number>;
}

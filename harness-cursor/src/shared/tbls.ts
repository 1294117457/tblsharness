// Mirrors tbls/spec/tbls.schema.json_schema.json. Keep in sync when upgrading tbls.

export type TblsCardinality = 'zero_or_one' | 'exactly_one' | 'zero_or_more' | 'one_or_more' | '';

export interface TblsLabel {
  name: string;
  virtual?: boolean;
}

export interface TblsColumn {
  name: string;
  type: string;
  nullable: boolean;
  default?: string | null;
  extra_def?: string;
  labels?: TblsLabel[];
  comment?: string;
}

export interface TblsIndex {
  name: string;
  def: string;
  table: string;
  columns: string[];
  comment?: string;
}

export interface TblsConstraint {
  name: string;
  type: string;
  def: string;
  table: string;
  referenced_table?: string;
  columns?: string[];
  referenced_columns?: string[];
  comment?: string;
}

export interface TblsTrigger {
  name: string;
  def: string;
  comment?: string;
}

export interface TblsTable {
  name: string;
  type: string;
  comment?: string;
  columns: TblsColumn[];
  indexes?: TblsIndex[];
  constraints?: TblsConstraint[];
  triggers?: TblsTrigger[];
  def?: string;
  labels?: TblsLabel[];
  referenced_tables?: string[];
}

export interface TblsRelation {
  table: string;
  columns: string[];
  cardinality?: TblsCardinality;
  parent_table: string;
  parent_columns: string[];
  parent_cardinality?: TblsCardinality;
  def: string;
  virtual?: boolean;
}

export interface TblsFunction {
  name: string;
  return_type: string;
  arguments: string;
  type: string;
}

export interface TblsEnum {
  name: string;
  values: string[];
}

export interface TblsDriverMeta {
  current_schema?: string;
  search_paths?: string[];
  dict?: Record<string, string>;
}

export interface TblsDriver {
  name: string;
  database_version?: string;
  meta?: TblsDriverMeta;
}

export interface TblsViewpointGroup {
  name: string;
  desc: string;
  labels?: string[];
  tables?: string[];
  color?: string;
}

export interface TblsViewpoint {
  id?: string;
  name: string;
  desc: string;
  labels?: string[];
  tables?: string[];
  distance?: number;
  groups?: TblsViewpointGroup[];
}

export interface TblsSchema {
  name?: string;
  desc?: string;
  tables: TblsTable[];
  relations?: TblsRelation[];
  functions?: TblsFunction[];
  enums?: TblsEnum[];
  driver?: TblsDriver;
  labels?: TblsLabel[];
  viewpoints?: TblsViewpoint[];
}

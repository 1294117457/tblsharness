import { relationKey, type DiffItem, type DiffKind, type DiffResult, type NColumn, type NRelation, type NormalizedSchema } from '../shared/model';

export interface DiffOptions {
  tableMappings?: Record<string, string>;
  acceptedDiffs?: string[];
}

const DIFF_KINDS: DiffKind[] = [
  'table_missing_in_db',
  'table_missing_in_design',
  'column_missing_in_db',
  'column_missing_in_design',
  'column_mismatch',
  'relation_missing_in_db',
  'relation_missing_in_design',
];

/** Compares by name after mapping design table keys to db table keys via tableMappings. */
export function diffSchemas(design: NormalizedSchema, db: NormalizedSchema, options: DiffOptions = {}): DiffResult {
  const accepted = new Set(options.acceptedDiffs ?? []);
  const mappings = options.tableMappings ?? {};
  const toDbKey = (designKey: string) => mappings[designKey] ?? designKey;
  const items: DiffItem[] = [];
  const push = (item: Omit<DiffItem, 'id' | 'accepted'>) => {
    const id = [item.kind, item.table, item.column ?? item.relation ?? ''].join(':');
    items.push({ ...item, id, accepted: accepted.has(id) });
  };

  const dbTables = new Map(db.tables.map((t) => [t.key, t]));
  const mappedDbKeys = new Set<string>();

  for (const designTable of design.tables) {
    const dbKey = toDbKey(designTable.key);
    const dbTable = dbTables.get(dbKey);
    if (!dbTable) {
      push({ kind: 'table_missing_in_db', table: designTable.key, message: `设计中的表 ${designTable.key} 在数据库中不存在` });
      continue;
    }
    mappedDbKeys.add(dbKey);

    const dbColumns = new Map(dbTable.columns.map((c) => [c.name, c]));
    for (const designColumn of designTable.columns) {
      const dbColumn = dbColumns.get(designColumn.name);
      if (!dbColumn) {
        push({ kind: 'column_missing_in_db', table: designTable.key, column: designColumn.name, message: `字段 ${designTable.key}.${designColumn.name} 在数据库中不存在` });
        continue;
      }
      dbColumns.delete(designColumn.name);
      const differences = compareColumns(designColumn, dbColumn);
      if (differences.length) {
        push({ kind: 'column_mismatch', table: designTable.key, column: designColumn.name, message: `字段 ${designTable.key}.${designColumn.name} 不一致：${differences.join('；')}` });
      }
    }
    for (const extra of dbColumns.values()) {
      push({ kind: 'column_missing_in_design', table: designTable.key, dbTable: dbKey, column: extra.name, message: `数据库字段 ${dbKey}.${extra.name} 未在设计中声明` });
    }
  }

  for (const dbTable of db.tables) {
    if (!mappedDbKeys.has(dbTable.key)) {
      push({ kind: 'table_missing_in_design', table: dbTable.key, message: `数据库中的表 ${dbTable.key} 未在设计中声明` });
    }
  }

  diffRelations(design.relations, db.relations, toDbKey, push);

  const counts = Object.fromEntries(DIFF_KINDS.map((k) => [k, 0])) as Record<DiffKind, number>;
  for (const item of items) {
    if (!item.accepted) {
      counts[item.kind] += 1;
    }
  }
  return { items, counts };
}

function compareColumns(design: NColumn, db: NColumn): string[] {
  const out: string[] = [];
  if (design.logicalType !== db.logicalType) {
    out.push(`类型 ${design.rawType} ≠ ${db.rawType}`);
  } else if (design.length !== undefined && db.length !== undefined && design.length !== db.length) {
    out.push(`长度 ${design.length} ≠ ${db.length}`);
  }
  if (design.nullable !== db.nullable) {
    out.push(design.nullable ? '设计允许为空，数据库不允许' : '设计不允许为空，数据库允许');
  }
  if (design.primaryKey !== db.primaryKey) {
    out.push(design.primaryKey ? '设计是主键，数据库不是' : '数据库是主键，设计不是');
  }
  if (design.logicalType === 'enum' && db.logicalType === 'enum') {
    const missing = (design.enumValues ?? []).filter((v) => !(db.enumValues ?? []).includes(v));
    if (missing.length) {
      out.push(`数据库枚举缺少取值 ${missing.join(', ')}`);
    }
  }
  return out;
}

function diffRelations(
  designRelations: NRelation[],
  dbRelations: NRelation[],
  toDbKey: (designKey: string) => string,
  push: (item: Omit<DiffItem, 'id' | 'accepted'>) => void,
): void {
  const dbKeys = new Set(dbRelations.map((r) => r.key));
  const designKeysInDbTerms = new Set<string>();

  for (const r of designRelations) {
    const key = relationKey(toDbKey(r.from.table), r.from.columns, toDbKey(r.to.table), r.to.columns);
    designKeysInDbTerms.add(key);
    // Only designed FOREIGN KEYs are expected to exist physically; logical/json_array/... relations are not.
    if (r.kind === 'fk' && !dbKeys.has(key)) {
      push({ kind: 'relation_missing_in_db', table: r.from.table, relation: r.key, message: `设计中的外键 ${r.key} 在数据库中不存在` });
    }
  }
  for (const r of dbRelations) {
    if (!designKeysInDbTerms.has(r.key)) {
      push({ kind: 'relation_missing_in_design', table: r.from.table, relation: r.key, message: `数据库中的关系 ${r.key} 未在设计中声明` });
    }
  }
}

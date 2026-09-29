/**
 * Generates DesignOps that copy database tables into the design.
 *
 * Pure function: takes the source schema tables, existing design table names,
 * and produces a flat DesignOp[] that can be applied with `applyDesignOps`.
 */
import type { ColumnInput, DesignOp, RelationEndInput } from './designOps';
import type { TblsColumn, TblsConstraint, TblsRelation, TblsTable } from './tbls';

export interface CopyResult {
  ops: DesignOp[];
  /** Tables that were copied (using the final name, after rename if needed). */
  copied: string[];
  /** Tables that were skipped because they already exist and `onConflict` is `'skip'`. */
  skipped: string[];
}

export type ConflictStrategy = 'skip' | 'rename';

export interface CopyOptions {
  /** What to do when the table name already exists in the design. Default: `'skip'`. */
  onConflict?: ConflictStrategy;
  /** Names of tables already in the design (used for conflict detection). */
  existingTables: string[];
}

/**
 * Produces DesignOps that copy `tables` (from a database snapshot) into the design.
 *
 * Copies: columns (type, nullable, default, comment), primary keys, unique constraints,
 * indexes, table comments, and relations (as `fk`) between the copied tables and/or
 * tables already in the design.
 */
export function copyTableOps(tables: TblsTable[], relations: TblsRelation[], options: CopyOptions): CopyResult {
  const { onConflict = 'skip', existingTables } = options;
  const existing = new Set(existingTables);
  const ops: DesignOp[] = [];
  const copied: string[] = [];
  const skipped: string[] = [];

  const nameMap = new Map<string, string>();

  for (const t of tables) {
    let name = t.name;
    if (existing.has(name)) {
      if (onConflict === 'skip') {
        skipped.push(name);
        nameMap.set(t.name, name);
        continue;
      }
      name = uniqueName(name, existing);
    }
    nameMap.set(t.name, name);
    existing.add(name);

    ops.push({ op: 'table.add', table: name, comment: t.comment, withId: false });

    for (const col of t.columns) {
      ops.push({ op: 'column.add', table: name, column: columnInput(col) });
    }

    const pks = primaryKeyColumns(t);
    for (const pk of pks) {
      ops.push({ op: 'column.update', table: name, column: pk, patch: { primaryKey: true } });
    }

    for (const uq of uniqueColumns(t)) {
      if (pks.length === 1 && uq.length === 1 && uq[0] === pks[0]) continue;
      for (const col of uq) {
        ops.push({ op: 'column.update', table: name, column: col, patch: { unique: true } });
      }
    }

    copied.push(name);
  }

  const copiedSet = new Set(copied);
  const allKnown = new Set([...copiedSet, ...new Set(existingTables)]);

  for (const r of relations) {
    const fromTable = nameMap.get(r.table) ?? r.table;
    const toTable = nameMap.get(r.parent_table) ?? r.parent_table;
    if (!allKnown.has(fromTable) || !allKnown.has(toTable)) continue;
    if (!copiedSet.has(fromTable) && !copiedSet.has(toTable)) continue;

    const from: RelationEndInput = { table: fromTable, columns: r.columns };
    const to: RelationEndInput = { table: toTable, columns: r.parent_columns };
    const op: DesignOp = { op: 'relation.add', from, to, kind: r.virtual ? 'virtual' : 'fk' };
    ops.push(op);
  }

  return { ops, copied, skipped };
}

function columnInput(col: TblsColumn): ColumnInput {
  const input: ColumnInput = { name: col.name, type: col.type, nullable: col.nullable };
  if (col.default !== undefined && col.default !== null) input.default = col.default;
  if (col.comment) input.comment = col.comment;
  return input;
}

function primaryKeyColumns(t: TblsTable): string[] {
  const pk = t.constraints?.find((c) => c.type === 'PRIMARY KEY');
  return pk?.columns ?? [];
}

function uniqueColumns(t: TblsTable): string[][] {
  return (t.constraints ?? []).filter((c): c is TblsConstraint & { columns: string[] } => c.type === 'UNIQUE' && Array.isArray(c.columns) && c.columns.length > 0).map((c) => c.columns);
}

function uniqueName(base: string, taken: Set<string>): string {
  for (let i = 2; ; i++) {
    const candidate = `${base}_${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

import { describe, expect, it } from 'vitest';
import { applyDesignOps, emptyDesignSchema, emptyExt, type DesignDoc } from '../src/shared/designOps';
import { normalize } from '../src/model/normalize';
import { diffSchemas } from '../src/diff/diff';

function design(): DesignDoc {
  return applyDesignOps({ schema: emptyDesignSchema('t', 'postgres'), ext: emptyExt() }, [
    { op: 'table.add', table: 'users' },
    { op: 'column.add', table: 'users', column: { name: 'email', type: 'varchar(255)', nullable: false } },
    { op: 'table.add', table: 'orders' },
    { op: 'column.add', table: 'orders', column: { name: 'user_id', type: 'bigint', nullable: false } },
    { op: 'relation.add', from: { table: 'orders', columns: ['user_id'] }, to: { table: 'users', columns: ['id'] }, kind: 'fk' },
  ]);
}

function run(dbOps: Parameters<typeof applyDesignOps>[1], options?: Parameters<typeof diffSchemas>[2]) {
  const d = design();
  const db = applyDesignOps(d, dbOps);
  return diffSchemas(normalize(d.schema, { source: 'design', ext: d.ext }), normalize(db.schema, { source: 'db' }), options);
}

describe('diffSchemas', () => {
  it('reports nothing for identical schemas', () => {
    expect(run([]).items).toEqual([]);
  });

  it('finds missing tables, columns, relations and type mismatches', () => {
    const result = run([
      { op: 'relation.delete', key: 'orders(user_id)->users(id)' },
      { op: 'column.update', table: 'users', column: 'email', patch: { type: 'text' } },
      { op: 'column.add', table: 'users', column: { name: 'legacy', type: 'integer', nullable: true } },
      { op: 'table.add', table: 'audit' },
    ]);
    const kinds = result.items.map((i) => i.kind).sort();
    expect(kinds).toEqual(['column_mismatch', 'column_missing_in_design', 'relation_missing_in_db', 'table_missing_in_design']);
    expect(result.counts.column_mismatch).toBe(1);
  });

  it('marks accepted items and keeps their ids stable', () => {
    const first = run([{ op: 'table.add', table: 'audit' }]);
    const id = first.items[0].id;
    const second = run([{ op: 'table.add', table: 'audit' }], { acceptedDiffs: [id] });
    expect(second.items[0]).toMatchObject({ id, accepted: true });
  });

  it('compares renamed tables through table mappings', () => {
    const result = run([{ op: 'table.rename', from: 'users', to: 'accounts' }], { tableMappings: { users: 'accounts' } });
    expect(result.items.filter((i) => i.kind.startsWith('table_'))).toEqual([]);
  });
});

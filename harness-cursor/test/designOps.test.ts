import { describe, expect, it } from 'vitest';
import { applyDesignOps, DesignOpError, emptyDesignSchema, emptyExt, serializeDesign, type DesignDoc } from '../src/shared/designOps';
import { normalize } from '../src/model/normalize';

function base(): DesignDoc {
  return applyDesignOps({ schema: emptyDesignSchema('t', 'postgres'), ext: emptyExt() }, [
    { op: 'table.add', table: 'users' },
    { op: 'column.add', table: 'users', column: { name: 'email', type: 'varchar(255)', nullable: false } },
    { op: 'table.add', table: 'orders' },
    { op: 'column.add', table: 'orders', column: { name: 'user_id', type: 'bigint', nullable: false } },
    { op: 'relation.add', from: { table: 'orders', columns: ['user_id'] }, to: { table: 'users', columns: ['id'] }, kind: 'fk' },
  ]);
}

const tableOf = (doc: DesignDoc, name: string) => doc.schema.tables.find((t) => t.name === name)!;

describe('applyDesignOps', () => {
  it('adds a table with a bigint id primary key by default', () => {
    const users = tableOf(base(), 'users');
    expect(users.columns[0]).toEqual({ name: 'id', type: 'bigint', nullable: false });
    expect(users.constraints).toContainEqual(expect.objectContaining({ type: 'PRIMARY KEY', columns: ['id'] }));
  });

  it('does not mutate its input', () => {
    const doc = base();
    const before = JSON.stringify(doc);
    applyDesignOps(doc, [{ op: 'table.delete', table: 'users' }]);
    expect(JSON.stringify(doc)).toBe(before);
  });

  it('creates a foreign key constraint for fk relations', () => {
    const doc = base();
    expect(doc.schema.relations).toHaveLength(1);
    expect(doc.schema.relations![0]).toMatchObject({ table: 'orders', parent_table: 'users', virtual: false, parent_cardinality: 'exactly_one' });
    expect(tableOf(doc, 'orders').constraints).toContainEqual(expect.objectContaining({ type: 'FOREIGN KEY', referenced_table: 'users' }));
    expect(doc.ext.relations).toEqual([]);
  });

  it('records non-fk relations as virtual with an ext entry', () => {
    const doc = applyDesignOps(base(), [
      { op: 'column.add', table: 'users', column: { name: 'role_ids', type: 'jsonb', nullable: true } },
      { op: 'table.add', table: 'roles' },
      { op: 'relation.add', from: { table: 'users', columns: ['role_ids'] }, to: { table: 'roles', columns: ['id'] }, kind: 'json_array' },
    ]);
    const r = doc.schema.relations!.find((x) => x.table === 'users')!;
    expect(r.virtual).toBe(true);
    expect(r.parent_cardinality).toBe('zero_or_one');
    expect(doc.ext.relations).toEqual([{ key: 'users(role_ids)->roles(id)', kind: 'json_array' }]);
    expect(tableOf(doc, 'users').constraints!.some((c) => c.type === 'FOREIGN KEY')).toBe(false);
  });

  it('renames a table everywhere: relations, constraints and ext keys', () => {
    let doc = applyDesignOps(base(), [{ op: 'relation.update', key: 'orders(user_id)->users(id)', patch: { kind: 'logical', note: 'n' } }]);
    doc = applyDesignOps(doc, [{ op: 'table.rename', from: 'users', to: 'accounts' }]);
    expect(tableOf(doc, 'accounts').constraints).toContainEqual(expect.objectContaining({ name: 'accounts_pkey' }));
    expect(doc.schema.relations![0]).toMatchObject({ parent_table: 'accounts', def: 'FOREIGN KEY (user_id) REFERENCES accounts(id)' });
    expect(doc.ext.relations).toEqual([{ key: 'orders(user_id)->accounts(id)', kind: 'logical', note: 'n' }]);
  });

  it('renames a column in the relations that use it', () => {
    const doc = applyDesignOps(base(), [{ op: 'column.update', table: 'orders', column: 'user_id', patch: { name: 'owner_id' } }]);
    expect(doc.schema.relations![0].columns).toEqual(['owner_id']);
    expect(tableOf(doc, 'orders').constraints!.find((c) => c.type === 'FOREIGN KEY')!.columns).toEqual(['owner_id']);
  });

  it('deleting a table drops its relations and the foreign keys pointing at it', () => {
    const doc = applyDesignOps(base(), [{ op: 'table.delete', table: 'users' }]);
    expect(doc.schema.tables.map((t) => t.name)).toEqual(['orders']);
    expect(doc.schema.relations).toEqual([]);
    expect(tableOf(doc, 'orders').constraints!.some((c) => c.type === 'FOREIGN KEY')).toBe(false);
  });

  it('deleting a column drops relations using it', () => {
    const doc = applyDesignOps(base(), [{ op: 'column.delete', table: 'orders', column: 'user_id' }]);
    expect(doc.schema.relations).toEqual([]);
  });

  it('switching a relation between fk and logical adds or removes the constraint', () => {
    const key = 'orders(user_id)->users(id)';
    const logical = applyDesignOps(base(), [{ op: 'relation.update', key, patch: { kind: 'logical' } }]);
    expect(logical.schema.relations![0].virtual).toBe(true);
    expect(tableOf(logical, 'orders').constraints!.some((c) => c.type === 'FOREIGN KEY')).toBe(false);
    const fk = applyDesignOps(logical, [{ op: 'relation.update', key, patch: { kind: 'fk' } }]);
    expect(fk.schema.relations![0].virtual).toBe(false);
    expect(tableOf(fk, 'orders').constraints!.some((c) => c.type === 'FOREIGN KEY')).toBe(true);
    expect(fk.ext.relations).toEqual([]);
  });

  it('primary key and unique flags maintain constraints', () => {
    const doc = applyDesignOps(base(), [
      { op: 'column.update', table: 'users', column: 'email', patch: { unique: true } },
      { op: 'column.update', table: 'users', column: 'id', patch: { primaryKey: false } },
    ]);
    const users = tableOf(doc, 'users');
    expect(users.constraints!.some((c) => c.type === 'PRIMARY KEY')).toBe(false);
    expect(users.constraints).toContainEqual(expect.objectContaining({ type: 'UNIQUE', columns: ['email'] }));
  });

  it('rejects a nullable primary key and duplicate names', () => {
    expect(() => applyDesignOps(base(), [{ op: 'column.update', table: 'users', column: 'id', patch: { nullable: true } }])).toThrow(DesignOpError);
    expect(() => applyDesignOps(base(), [{ op: 'table.add', table: 'users' }])).toThrow('已存在');
    expect(() => applyDesignOps(base(), [{ op: 'table.rename', from: 'users', to: 'orders' }])).toThrow('已存在');
    expect(() => applyDesignOps(base(), [{ op: 'table.add', table: 'bad name' }])).toThrow(DesignOpError);
  });

  it('moves columns', () => {
    const doc = applyDesignOps(base(), [{ op: 'column.move', table: 'users', column: 'email', toIndex: 0 }]);
    expect(tableOf(doc, 'users').columns.map((c) => c.name)).toEqual(['email', 'id']);
  });

  it('serializes deterministically regardless of table order', () => {
    const a = base();
    const b = structuredClone(a);
    b.schema.tables.reverse();
    expect(serializeDesign(a)).toEqual(serializeDesign(b));
  });

  it('normalizes into the model the canvas uses', () => {
    const doc = applyDesignOps(base(), [{ op: 'relation.update', key: 'orders(user_id)->users(id)', patch: { kind: 'logical' } }]);
    const model = normalize(doc.schema, { source: 'design', ext: doc.ext });
    expect(model.relations).toHaveLength(1);
    expect(model.relations[0]).toMatchObject({ key: 'orders(user_id)->users(id)', kind: 'logical' });
    expect(model.tables.find((t) => t.key === 'users')!.columns[0]).toMatchObject({ name: 'id', primaryKey: true });
  });
});

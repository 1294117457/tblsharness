import { describe, expect, it } from 'vitest';
import { copyTableOps, type CopyResult } from '../src/shared/copyTables';
import { applyDesignOps, emptyDesignSchema, emptyExt, type DesignDoc } from '../src/shared/designOps';
import type { TblsRelation, TblsTable } from '../src/shared/tbls';

function usersTable(): TblsTable {
  return {
    name: 'users',
    type: 'TABLE',
    comment: 'All users',
    columns: [
      { name: 'id', type: 'bigint', nullable: false },
      { name: 'email', type: 'varchar(255)', nullable: false, comment: 'Login email' },
      { name: 'name', type: 'varchar(100)', nullable: true, default: "'anon'" },
    ],
    constraints: [
      { name: 'users_pkey', type: 'PRIMARY KEY', def: 'PRIMARY KEY (id)', table: 'users', columns: ['id'] },
      { name: 'users_email_key', type: 'UNIQUE', def: 'UNIQUE (email)', table: 'users', columns: ['email'] },
    ],
    indexes: [{ name: 'users_pkey', def: 'CREATE UNIQUE INDEX users_pkey ON users (id)', table: 'users', columns: ['id'] }],
  };
}

function ordersTable(): TblsTable {
  return {
    name: 'orders',
    type: 'TABLE',
    columns: [
      { name: 'id', type: 'bigint', nullable: false },
      { name: 'user_id', type: 'bigint', nullable: false },
      { name: 'total', type: 'numeric(10,2)', nullable: false, default: '0' },
    ],
    constraints: [
      { name: 'orders_pkey', type: 'PRIMARY KEY', def: 'PRIMARY KEY (id)', table: 'orders', columns: ['id'] },
      { name: 'orders_user_id_fkey', type: 'FOREIGN KEY', def: 'FOREIGN KEY (user_id) REFERENCES users(id)', table: 'orders', referenced_table: 'users', columns: ['user_id'], referenced_columns: ['id'] },
    ],
  };
}

function fkRelation(): TblsRelation {
  return { table: 'orders', columns: ['user_id'], parent_table: 'users', parent_columns: ['id'], def: 'FOREIGN KEY (user_id) REFERENCES users(id)' };
}

function apply(result: CopyResult): DesignDoc {
  return applyDesignOps({ schema: emptyDesignSchema('test', 'postgres'), ext: emptyExt() }, result.ops);
}

describe('copyTableOps', () => {
  it('copies a single table with columns, pk, unique, and comment', () => {
    const result = copyTableOps([usersTable()], [], { existingTables: [] });
    expect(result.copied).toEqual(['users']);
    expect(result.skipped).toEqual([]);

    const doc = apply(result);
    const users = doc.schema.tables.find((t) => t.name === 'users')!;
    expect(users).toBeDefined();
    expect(users.comment).toBe('All users');
    expect(users.columns).toHaveLength(3);
    expect(users.columns[0]).toMatchObject({ name: 'id', type: 'bigint', nullable: false });
    expect(users.columns[1]).toMatchObject({ name: 'email', type: 'varchar(255)', nullable: false, comment: 'Login email' });
    expect(users.columns[2]).toMatchObject({ name: 'name', type: 'varchar(100)', nullable: true, default: "'anon'" });

    const pk = users.constraints?.find((c) => c.type === 'PRIMARY KEY');
    expect(pk?.columns).toEqual(['id']);

    const uq = users.constraints?.find((c) => c.type === 'UNIQUE');
    expect(uq?.columns).toContain('email');
  });

  it('does not add a duplicate unique constraint for a single-column PK', () => {
    const table: TblsTable = {
      name: 'tags',
      type: 'TABLE',
      columns: [{ name: 'id', type: 'int', nullable: false }],
      constraints: [
        { name: 'tags_pkey', type: 'PRIMARY KEY', def: '', table: 'tags', columns: ['id'] },
        { name: 'tags_id_key', type: 'UNIQUE', def: '', table: 'tags', columns: ['id'] },
      ],
    };
    const result = copyTableOps([table], [], { existingTables: [] });
    const doc = apply(result);
    const t = doc.schema.tables.find((t) => t.name === 'tags')!;
    const uqs = t.constraints?.filter((c) => c.type === 'UNIQUE') ?? [];
    expect(uqs).toHaveLength(0);
  });

  it('copies relations between selected tables', () => {
    const result = copyTableOps([usersTable(), ordersTable()], [fkRelation()], { existingTables: [] });
    expect(result.copied).toEqual(['users', 'orders']);

    const doc = apply(result);
    expect(doc.schema.relations).toHaveLength(1);
    expect(doc.schema.relations![0]).toMatchObject({ table: 'orders', parent_table: 'users' });
  });

  it('copies relation when parent table already exists in design', () => {
    const result = copyTableOps([ordersTable()], [fkRelation()], { existingTables: ['users'] });
    expect(result.copied).toEqual(['orders']);

    const doc = applyDesignOps(
      applyDesignOps({ schema: emptyDesignSchema('test', 'postgres'), ext: emptyExt() }, [
        { op: 'table.add', table: 'users', withId: false },
        { op: 'column.add', table: 'users', column: { name: 'id', type: 'bigint', nullable: false } },
      ]),
      result.ops,
    );
    expect(doc.schema.relations).toHaveLength(1);
    expect(doc.schema.relations![0]).toMatchObject({ table: 'orders', parent_table: 'users' });
  });

  it('skips relations to tables not in the design or selection', () => {
    const result = copyTableOps([ordersTable()], [fkRelation()], { existingTables: [] });
    expect(result.copied).toEqual(['orders']);
    const doc = apply(result);
    expect(doc.schema.relations ?? []).toHaveLength(0);
  });

  it('skips tables that already exist when onConflict is skip', () => {
    const result = copyTableOps([usersTable()], [], { existingTables: ['users'], onConflict: 'skip' });
    expect(result.copied).toEqual([]);
    expect(result.skipped).toEqual(['users']);
    expect(result.ops).toEqual([]);
  });

  it('renames tables on conflict when onConflict is rename', () => {
    const result = copyTableOps([usersTable()], [], { existingTables: ['users'], onConflict: 'rename' });
    expect(result.copied).toEqual(['users_2']);
    expect(result.skipped).toEqual([]);

    const doc = apply(result);
    expect(doc.schema.tables.map((t) => t.name)).toContain('users_2');
  });

  it('increments suffix when multiple conflicts', () => {
    const result = copyTableOps([usersTable()], [], { existingTables: ['users', 'users_2'], onConflict: 'rename' });
    expect(result.copied).toEqual(['users_3']);
  });

  it('updates relation table names when renaming', () => {
    const result = copyTableOps([usersTable(), ordersTable()], [fkRelation()], { existingTables: ['users'], onConflict: 'rename' });
    expect(result.copied).toEqual(['users_2', 'orders']);

    const doc = apply(result);
    expect(doc.schema.relations).toHaveLength(1);
    expect(doc.schema.relations![0]).toMatchObject({ table: 'orders', parent_table: 'users_2' });
  });

  it('marks virtual relations from the snapshot', () => {
    const vr: TblsRelation = { ...fkRelation(), virtual: true };
    const result = copyTableOps([usersTable(), ordersTable()], [vr], { existingTables: [] });
    const doc = apply(result);
    expect(doc.schema.relations).toHaveLength(1);
    expect(doc.schema.relations![0].virtual).toBe(true);
  });

  it('copies no auto id column (withId: false)', () => {
    const table: TblsTable = {
      name: 'simple',
      type: 'TABLE',
      columns: [{ name: 'val', type: 'text', nullable: true }],
    };
    const result = copyTableOps([table], [], { existingTables: [] });
    const doc = apply(result);
    const t = doc.schema.tables.find((t) => t.name === 'simple')!;
    expect(t.columns).toHaveLength(1);
    expect(t.columns[0].name).toBe('val');
  });

  it('handles empty input gracefully', () => {
    const result = copyTableOps([], [], { existingTables: [] });
    expect(result.ops).toEqual([]);
    expect(result.copied).toEqual([]);
    expect(result.skipped).toEqual([]);
  });
});

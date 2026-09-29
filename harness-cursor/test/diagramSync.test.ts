import { describe, expect, it } from 'vitest';
import { computeErSync } from '../src/diagram/erSync';
import { normalize } from '../src/model/normalize';
import { emptyDiagram, type DiagramFile } from '../src/shared/diagram';
import { applyDesignOps, emptyDesignSchema, emptyExt, serializeDesign, type DesignDoc } from '../src/shared/designOps';
import { generateErDiagram } from '../src/shared/mermaid/er';
import { collectSyncOps, SyncError } from '../src/shared/sync';

function base(): DesignDoc {
  return applyDesignOps({ schema: emptyDesignSchema('t', 'postgres'), ext: emptyExt() }, [
    { op: 'table.add', table: 'users', comment: '用户' },
    { op: 'column.add', table: 'users', column: { name: 'email', type: 'varchar(255)', nullable: false, comment: '邮箱' } },
    { op: 'column.update', table: 'users', column: 'email', patch: { unique: true, default: "''" } },
    { op: 'table.add', table: 'orders' },
    { op: 'column.add', table: 'orders', column: { name: 'user_id', type: 'bigint', nullable: false } },
    { op: 'relation.add', from: { table: 'orders', columns: ['user_id'] }, to: { table: 'users', columns: ['id'] }, kind: 'fk', note: '下单人' },
  ]);
}

function diagram(code: string, refs: string[] = [], ignored: string[] = []): DiagramFile {
  const d = emptyDiagram('er', 'd', refs);
  d.code = code;
  d.meta.ignored = ignored;
  return d;
}

function generated(doc: DesignDoc, tables?: string[]): DiagramFile {
  const schema = normalize(doc.schema, { source: 'design', ext: doc.ext });
  return diagram(generateErDiagram(schema, tables), tables ?? schema.tables.map((t) => t.key));
}

function sync(doc: DesignDoc, d: DiagramFile, choices?: Record<string, string>) {
  return computeErSync(doc, d, choices);
}

function applyChecked(doc: DesignDoc, d: DiagramFile, choices?: Record<string, string>): DesignDoc {
  const { items } = sync(doc, d, choices);
  return applyDesignOps(doc, collectSyncOps(items, items.filter((i) => i.defaultChecked).map((i) => i.id)));
}

describe('computeErSync', () => {
  it('finds nothing to do for a diagram generated from the tables', () => {
    const doc = base();
    expect(sync(doc, generated(doc)).items).toEqual([]);
  });

  it('adds a new table with its columns, keys and the relation to it', () => {
    const doc = base();
    const d = generated(doc);
    d.code += `
  refunds["退款"] {
    bigint id PK
    bigint order_id FK
    numeric(10,2) amount "金额"
    varchar(64) refund_no UK
  }
  orders ||--o{ refunds : "退款记录"`;
    const { items, problems } = sync(doc, d);
    expect(problems).toEqual([]);
    expect(items.map((i) => i.id)).toEqual(['table.add:refunds', 'relation.add:refunds->orders(order_id)']);
    expect(items[1].requires).toEqual(['table.add:refunds']);

    const after = applyChecked(doc, d);
    const refunds = normalize(after.schema, { source: 'design', ext: after.ext }).tables.find((t) => t.key === 'refunds')!;
    expect(refunds.comment).toBe('退款');
    expect(refunds.columns.map((c) => [c.name, c.rawType, c.nullable, c.primaryKey, c.unique])).toEqual([
      ['id', 'bigint', false, true, true],
      ['order_id', 'bigint', true, false, false],
      ['amount', 'numeric(10,2)', true, false, false],
      ['refund_no', 'varchar(64)', true, false, true],
    ]);
    expect(after.schema.relations).toContainEqual(
      expect.objectContaining({ table: 'refunds', columns: ['order_id'], parent_table: 'orders', parent_columns: ['id'], virtual: false }),
    );
  });

  it('keeps what Mermaid cannot express: defaults, relation notes, column order', () => {
    const doc = base();
    const d = generated(doc);
    d.code = d.code.replace('varchar(255) email UK "邮箱"', 'varchar(320) email UK "邮箱地址"');
    const after = applyChecked(doc, d);
    const email = after.schema.tables.find((t) => t.name === 'users')!.columns.find((c) => c.name === 'email')!;
    expect(email).toMatchObject({ type: 'varchar(320)', comment: '邮箱地址', default: "''", nullable: false });
    expect(after.ext.relations).toEqual([{ key: 'orders(user_id)->users(id)', kind: 'fk', note: '下单人' }]);
  });

  it('leaves deletions unchecked and scopes table deletion to refs', () => {
    const doc = base();
    const d = diagram('erDiagram\n  users {\n    bigint id PK\n  }', ['users', 'orders']);
    const { items } = sync(doc, d);
    const byId = Object.fromEntries(items.map((i) => [i.id, i.defaultChecked]));
    expect(byId).toEqual({ 'column.delete:users.email': false, 'table.delete:orders': false });

    const notReferenced = sync(doc, diagram('erDiagram\n  users {\n    bigint id PK\n    varchar(255) email UK "邮箱"\n  }', ['users']));
    expect(notReferenced.items).toEqual([]);
  });

  it('does not treat an entity without a body as dropping its columns', () => {
    const doc = base();
    expect(sync(doc, diagram('erDiagram\n  users ||--o{ orders : "user_id"', ['users', 'orders'])).items).toEqual([]);
  });

  it('matches an unlabelled relation to the single existing one', () => {
    const doc = base();
    expect(sync(doc, diagram('erDiagram\n  users ||--o{ orders : places')).items).toEqual([]);
  });

  it('maps kind keywords and dotted lines to relation kinds', () => {
    const doc = base();
    const toLogical = sync(doc, diagram('erDiagram\n  users ||..o{ orders : "user_id"'));
    expect(toLogical.items.map((i) => [i.id, i.ops])).toEqual([
      ['relation.kind:orders(user_id)->users(id)', [{ op: 'relation.update', key: 'orders(user_id)->users(id)', patch: { kind: 'logical' } }]],
    ]);
    const dict = sync(doc, diagram('erDiagram\n  users ||..o{ orders : "user_id dictionary"'));
    expect(dict.items[0].message).toContain('fk → dictionary');
  });

  it('reports cardinality changes', () => {
    const doc = base();
    const { items } = sync(doc, diagram('erDiagram\n  users ||--|| orders : "user_id"'));
    expect(items.map((i) => i.id)).toEqual(['relation.card:orders(user_id)->users(id)']);
    expect(items[0].ops).toEqual([
      { op: 'relation.update', key: 'orders(user_id)->users(id)', patch: { cardinality: 'exactly_one', parentCardinality: 'exactly_one' } },
    ]);
  });

  it('asks which column when it cannot infer the foreign key', () => {
    const doc = applyDesignOps(base(), [
      { op: 'table.add', table: 'teams' },
      { op: 'column.add', table: 'orders', column: { name: 'owner', type: 'bigint', nullable: true } },
    ]);
    const d = diagram('erDiagram\n  teams ||--o{ orders : "负责团队"');
    const open = sync(doc, d).items[0];
    expect(open.choice).toMatchObject({ options: ['user_id', 'owner'] });
    expect(open.ops).toBeUndefined();
    expect(() => collectSyncOps([open], [open.id])).toThrow(SyncError);

    const after = applyChecked(doc, d, { [open.id]: 'owner' });
    expect(after.schema.relations).toContainEqual(expect.objectContaining({ table: 'orders', columns: ['owner'], parent_table: 'teams' }));
  });

  it('infers <parent singular>_id', () => {
    const doc = applyDesignOps(base(), [
      { op: 'table.add', table: 'categories' },
      { op: 'column.add', table: 'orders', column: { name: 'category_id', type: 'bigint', nullable: true } },
    ]);
    const { items } = sync(doc, diagram('erDiagram\n  categories ||--o{ orders : "分类"'));
    expect(items.map((i) => i.id)).toEqual(['relation.add:orders->categories(category_id)']);
  });

  it('rejects many-to-many without a json_array column', () => {
    const { problems, items } = sync(base(), diagram('erDiagram\n  users }o--o{ orders : "x"'));
    expect(items).toEqual([]);
    expect(problems[0].message).toContain('多对多');
  });

  it('hides ignored items and counts them', () => {
    const doc = base();
    const d = diagram('erDiagram\n  users {\n    bigint id PK\n  }', ['users'], ['column.delete:users.email']);
    expect(sync(doc, d)).toMatchObject({ items: [], ignored: 1 });
  });

  it('refuses a selection that misses a required item', () => {
    const doc = base();
    const d = diagram('erDiagram\n  tags {\n    bigint id PK\n  }\n  tags ||..o{ orders : "user_id"');
    const { items } = sync(doc, d);
    const rel = items.find((i) => i.target === 'relation')!;
    expect(() => collectSyncOps(items, [rel.id])).toThrow('需要同时勾选');
  });
});

describe('viewpoints', () => {
  it('follows table renames and deletions', () => {
    let doc = base();
    doc.schema.viewpoints = [{ name: '订单', desc: '', tables: ['orders', 'users'], groups: [{ name: 'g', desc: '', tables: ['users'] }] }];
    doc = applyDesignOps(doc, [{ op: 'table.rename', from: 'users', to: 'accounts' }]);
    expect(doc.schema.viewpoints![0]).toMatchObject({ tables: ['orders', 'accounts'], groups: [{ tables: ['accounts'] }] });
    doc = applyDesignOps(doc, [{ op: 'table.delete', table: 'orders' }]);
    expect(doc.schema.viewpoints![0].tables).toEqual(['accounts']);
  });
});

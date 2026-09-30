import { describe, expect, it } from 'vitest';
import { applyCanvasEdit, DESIGN_SOURCE, emptyCanvas, type CanvasFile } from '../src/shared/canvas';
import { ClipboardError, planCopy, planCut, topLevelItems } from '../src/shared/clipboard';
import type { DesignOp } from '../src/shared/designOps';
import type { NColumn, NormalizedSchema, NRelation, NTable } from '../src/shared/model';
import { copyNamespace, defaultNamespaceKind, effectiveNamespace, landingName, normalizeNamespace, qualify, shortName } from '../src/shared/namespace';

function col(name: string, extra: Partial<NColumn> = {}): NColumn {
  return { name, rawType: 'bigint', logicalType: 'integer', nullable: false, primaryKey: false, unique: false, autoIncrement: false, ...extra };
}

function table(key: string, columns: NColumn[]): NTable {
  return { key, rawName: key, type: 'BASE TABLE', columns, indexes: [] };
}

function rel(from: string, fromCol: string, to: string): NRelation {
  return { key: `${from}(${fromCol})->${to}(id)`, from: { table: from, columns: [fromCol] }, to: { table: to, columns: ['id'] }, cardinality: 'zero_or_more', parentCardinality: 'exactly_one', kind: 'fk', def: '' };
}

const schema: NormalizedSchema = {
  source: 'design',
  name: 'shop',
  tables: [
    table('users', [col('id', { primaryKey: true })]),
    table('orders', [col('id', { primaryKey: true }), col('user_id'), col('no', { unique: true, rawType: 'varchar(32)' })]),
    table('payment.bills', [col('id', { primaryKey: true }), col('order_id')]),
    table('audit', [col('id', { primaryKey: true }), col('order_id')]),
  ],
  relations: [rel('orders', 'user_id', 'users'), rel('payment.bills', 'order_id', 'orders'), rel('audit', 'order_id', 'orders')],
  enums: [],
};

function layout(): CanvasFile {
  return {
    ...emptyCanvas(),
    partitions: [
      { id: 'part1', name: '订单', x: 600, y: 0 },
      { id: 'part2', name: '支付', parent: 'part1', x: 40, y: 320, namespace: { kind: 'schema', value: 'payment' } },
      { id: 'part3', name: '空', x: 0, y: 800 },
    ],
    nodes: [
      { source: DESIGN_SOURCE, table: 'orders', x: 20, y: 40, partition: 'part1' },
      { source: DESIGN_SOURCE, table: 'payment.bills', x: 20, y: 40, partition: 'part2' },
      { source: 'db1', table: 'orders', x: 300, y: 40, partition: 'part1' },
    ],
    diagrams: [{ id: 'diagram1', x: 0, y: 200, width: 360, height: 240, partition: 'part2' }],
    notes: [{ id: 'n1', text: 'x', x: 0, y: 0, width: 200, partition: 'part2' }],
  };
}

const tablesAdded = (ops: DesignOp[]) => ops.filter((o) => o.op === 'table.add').map((o) => (o as { table: string }).table);
const relationsAdded = (ops: DesignOp[]) =>
  ops.filter((o): o is Extract<DesignOp, { op: 'relation.add' }> => o.op === 'relation.add').map((o) => `${o.from.table}->${o.to.table}`);

describe('namespaces', () => {
  it('picks defaults per driver and normalizes prefixes', () => {
    expect(defaultNamespaceKind('postgres')).toBe('schema');
    expect(defaultNamespaceKind('mysql')).toBe('prefix');
    expect(normalizeNamespace('prefix', 'pay')).toEqual({ kind: 'prefix', value: 'pay_' });
    expect(typeof normalizeNamespace('schema', '1bad')).toBe('string');
  });

  it('qualifies, strips and inherits', () => {
    const ns = { kind: 'prefix' as const, value: 'pay_' };
    expect(qualify(ns, 'orders')).toBe('pay_orders');
    expect(shortName(ns, 'pay_orders')).toBe('orders');
    expect(shortName(ns, 'orders')).toBe('orders');
    const c = applyCanvasEdit(layout(), [{ op: 'partition.put', partition: { id: 'part4', name: '子', parent: 'part2', x: 0, y: 0 } }]);
    expect(effectiveNamespace(c, 'part4')).toEqual({ kind: 'schema', value: 'payment' });
    expect(effectiveNamespace(c, 'part1')).toBeUndefined();
  });

  it('adds _copy only on clashes', () => {
    expect(landingName('orders', undefined, new Set(['orders']), new Set())).toBe('orders_copy');
    expect(landingName('orders', undefined, new Set(['orders', 'orders_copy']), new Set())).toBe('orders_copy2');
    expect(landingName('orders', { kind: 'schema', value: 'payment' }, new Set(['orders']), new Set())).toBe('payment.orders');
    expect(copyNamespace({ kind: 'prefix', value: 'pay_' }, new Set(['pay_copy_']))).toEqual({ kind: 'prefix', value: 'pay_copy2_' });
  });
});

describe('copy', () => {
  it('copies a table at the same level with _copy and keeps the FK it references', () => {
    const plan = planCopy({ canvas: layout(), schema, target: 'part1' }, [{ kind: 'table', id: 'design/orders' }]);
    expect(tablesAdded(plan.ops)).toEqual(['orders_copy']);
    // Keeps orders -> users, does not copy bills -> orders or audit -> orders.
    expect(relationsAdded(plan.ops)).toEqual(['orders_copy->users']);
    expect(plan.ops).toContainEqual({ op: 'column.update', table: 'orders_copy', column: 'no', patch: { unique: true } });
    const put = plan.edit.find((o) => o.op === 'nodes.put') as Extract<(typeof plan.edit)[number], { op: 'nodes.put' }>;
    expect(put.nodes[0]).toMatchObject({ table: 'orders_copy', partition: 'part1', x: 60, y: 80 });
  });

  it('keeps the short name when pasting into a namespaced level', () => {
    const plan = planCopy({ canvas: layout(), schema, target: 'part2', at: { x: 0, y: 0 } }, [{ kind: 'table', id: 'design/orders' }]);
    expect(tablesAdded(plan.ops)).toEqual(['payment.orders']);
  });

  it('points FKs among tables copied together to the copies', () => {
    const plan = planCopy({ canvas: layout(), schema, target: undefined }, [
      { kind: 'table', id: 'design/orders' },
      { kind: 'table', id: 'design/users' },
    ]);
    expect(tablesAdded(plan.ops).sort()).toEqual(['orders_copy', 'users_copy']);
    expect(relationsAdded(plan.ops)).toEqual(['orders_copy->users_copy']);
  });

  it('deep-copies a partition with a new namespace, remapped FKs and 副本 names', () => {
    const plan = planCopy({ canvas: layout(), schema, target: undefined, at: { x: 0, y: 1200 } }, [{ kind: 'partition', id: 'part1' }]);
    expect(plan.partitions).toEqual(['part4', 'part5']);
    const parts = plan.edit.filter((o) => o.op === 'partition.put').map((o) => (o as Extract<typeof o, { op: 'partition.put' }>).partition);
    expect(parts[0]).toMatchObject({ id: 'part4', name: '订单 副本', x: 0, y: 1200 });
    expect(parts[0]).not.toHaveProperty('parent');
    expect(parts[1]).toMatchObject({ id: 'part5', name: '支付', parent: 'part4', namespace: { kind: 'schema', value: 'payment_copy' } });
    expect(tablesAdded(plan.ops).sort()).toEqual(['orders_copy', 'payment_copy.bills']);
    expect(relationsAdded(plan.ops).sort()).toEqual(['orders_copy->users', 'payment_copy.bills->orders_copy']);
    expect(plan.skippedDb).toEqual(['db1/orders']);
    expect(plan.diagrams).toEqual([{ from: 'diagram1', renamed: false, placement: { x: 0, y: 200, width: 360, height: 240, partition: 'part5' } }]);
    const note = plan.edit.find((o) => o.op === 'note.put') as Extract<(typeof plan.edit)[number], { op: 'note.put' }>;
    expect(note.note.partition).toBe('part5');
  });

  it('refuses to paste a partition into its own subtree', () => {
    expect(() => planCopy({ canvas: layout(), schema, target: 'part2' }, [{ kind: 'partition', id: 'part1' }])).toThrow(ClipboardError);
  });

  it('ignores items already covered by a selected partition', () => {
    expect(topLevelItems(layout(), [{ kind: 'partition', id: 'part1' }, { kind: 'table', id: 'design/payment.bills' }, { kind: 'partition', id: 'part2' }])).toEqual([
      { kind: 'partition', id: 'part1' },
    ]);
  });
});

describe('cut', () => {
  it('moves without renaming by default and reports namespace renames', () => {
    const plan = planCut({ canvas: layout(), schema, target: 'part2', at: { x: 0, y: 0 } }, [{ kind: 'table', id: 'design/orders' }], false);
    expect(plan.renames).toEqual([{ from: 'orders', to: 'payment.orders' }]);
    const moved = applyCanvasEdit(layout(), plan.edit);
    expect(moved.nodes.find((n) => n.source === DESIGN_SOURCE && n.table === 'orders')!.partition).toBe('part2');
  });

  it('uses the new names in the edit when renaming', () => {
    const plan = planCut({ canvas: layout(), schema, target: undefined, at: { x: 0, y: 0 } }, [{ kind: 'partition', id: 'part2' }], true);
    // The partition keeps its own namespace when moved, so nothing needs renaming.
    expect(plan.renames).toEqual([]);
    const table = planCut({ canvas: layout(), schema, target: undefined, at: { x: 0, y: 0 } }, [{ kind: 'table', id: 'design/payment.bills' }], true);
    expect(table.renames).toEqual([{ from: 'payment.bills', to: 'bills' }]);
    const move = table.edit[0] as Extract<(typeof table.edit)[number], { op: 'move' }>;
    expect(move.items[0].id).toBe('design/bills');
  });

  it('refuses to move a partition into its own child', () => {
    expect(() => planCut({ canvas: layout(), schema, target: 'part2' }, [{ kind: 'partition', id: 'part1' }], false)).toThrow(ClipboardError);
  });
});

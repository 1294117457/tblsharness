import { applyDesignOps, emptyDesignSchema, emptyExt, type DesignDoc } from '@shared/designOps';
import type { TblsSchema } from '@shared/tbls';

/** Hand-written example model for browser development; not taken from any real database. */
export function exampleDesign(): DesignDoc {
  return applyDesignOps({ schema: emptyDesignSchema('shop', 'postgres'), ext: emptyExt() }, [
    { op: 'table.add', table: 'users', comment: '用户' },
    { op: 'column.add', table: 'users', column: { name: 'email', type: 'varchar(255)', nullable: false, comment: '登录邮箱' } },
    { op: 'column.add', table: 'users', column: { name: 'nickname', type: 'varchar(64)', nullable: true } },
    { op: 'column.add', table: 'users', column: { name: 'created_at', type: 'timestamptz', nullable: false, default: 'now()' } },
    { op: 'table.add', table: 'products', comment: '商品' },
    { op: 'column.add', table: 'products', column: { name: 'title', type: 'varchar(128)', nullable: false } },
    { op: 'column.add', table: 'products', column: { name: 'price', type: 'numeric(10,2)', nullable: false } },
    { op: 'column.add', table: 'products', column: { name: 'tag_ids', type: 'jsonb', nullable: true, comment: '标签 id 数组' } },
    { op: 'table.add', table: 'tags', comment: '标签' },
    { op: 'column.add', table: 'tags', column: { name: 'label', type: 'varchar(32)', nullable: false } },
    { op: 'table.add', table: 'orders', comment: '订单' },
    { op: 'column.add', table: 'orders', column: { name: 'user_id', type: 'bigint', nullable: false } },
    { op: 'column.add', table: 'orders', column: { name: 'status', type: 'varchar(16)', nullable: false, default: "'draft'" } },
    { op: 'column.add', table: 'orders', column: { name: 'total', type: 'numeric(12,2)', nullable: false, default: '0' } },
    { op: 'table.add', table: 'order_items', comment: '订单明细' },
    { op: 'column.add', table: 'order_items', column: { name: 'order_id', type: 'bigint', nullable: false } },
    { op: 'column.add', table: 'order_items', column: { name: 'product_id', type: 'bigint', nullable: false } },
    { op: 'column.add', table: 'order_items', column: { name: 'quantity', type: 'integer', nullable: false, default: '1' } },
    { op: 'relation.add', from: { table: 'orders', columns: ['user_id'] }, to: { table: 'users', columns: ['id'] }, kind: 'fk' },
    { op: 'relation.add', from: { table: 'order_items', columns: ['order_id'] }, to: { table: 'orders', columns: ['id'] }, kind: 'fk' },
    { op: 'relation.add', from: { table: 'order_items', columns: ['product_id'] }, to: { table: 'products', columns: ['id'] }, kind: 'fk' },
    { op: 'relation.add', from: { table: 'products', columns: ['tag_ids'] }, to: { table: 'tags', columns: ['id'] }, kind: 'json_array' },
  ]);
}

/** The "database" drifted from the design: a renamed type, a missing column, an extra table and a missing FK. */
export function exampleDb(): TblsSchema {
  const base = exampleDesign();
  const drifted = applyDesignOps(base, [
    { op: 'column.update', table: 'users', column: 'nickname', patch: { type: 'varchar(128)' } },
    { op: 'column.delete', table: 'products', column: 'tag_ids' },
    { op: 'relation.delete', key: 'order_items(product_id)->products(id)' },
    { op: 'table.add', table: 'audit_logs', comment: '操作日志' },
    { op: 'column.add', table: 'audit_logs', column: { name: 'actor_id', type: 'bigint', nullable: true } },
    { op: 'column.add', table: 'audit_logs', column: { name: 'action', type: 'varchar(64)', nullable: false } },
  ]);
  return { ...drifted.schema, name: 'shop_db', driver: { name: 'postgres', meta: { current_schema: 'public' } } };
}

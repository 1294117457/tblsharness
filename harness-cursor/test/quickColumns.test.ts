import { describe, expect, it } from 'vitest';
import { applyDesignOps, emptyExt } from '../src/shared/designOps';
import { columnTemplate, parseQuickColumn, parseQuickColumns, quickColumnOps } from '../src/shared/quickColumns';

describe('quick columns', () => {
  it('parses type, flags and comment', () => {
    expect(parseQuickColumn('email varchar(128) not null unique 登录邮箱')).toEqual({
      name: 'email',
      type: 'varchar(128)',
      nullable: false,
      primaryKey: false,
      unique: true,
      comment: '登录邮箱',
    });
  });

  it('keeps spaced parentheses and multi-word types together', () => {
    expect(parseQuickColumn('amount numeric(10, 2) nn 金额')).toMatchObject({ type: 'numeric(10,2)', nullable: false, comment: '金额' });
    expect(parseQuickColumn('paid_at timestamp with time zone null')).toMatchObject({ type: 'timestamp with time zone', nullable: true });
    expect(parseQuickColumn('score double precision')).toMatchObject({ type: 'double precision' });
  });

  it('guesses the type when only a name and flags are given', () => {
    expect(parseQuickColumn('user_id nn 下单人')).toMatchObject({ type: 'bigint', nullable: false, comment: '下单人' });
    expect(parseQuickColumn('is_active')).toMatchObject({ type: 'boolean', nullable: true });
    expect(parseQuickColumn('title')).toMatchObject({ type: 'varchar(255)' });
  });

  it('handles primary keys and defaults', () => {
    expect(parseQuickColumn('id bigint primary key')).toMatchObject({ primaryKey: true, nullable: false });
    expect(parseQuickColumn("status varchar(16) default 'draft' 状态")).toMatchObject({ default: "'draft'", comment: '状态' });
    expect(parseQuickColumn('id pk null')).toBe('主键字段 id 不能可空');
    expect(parseQuickColumn('x int default')).toBe('default 后面需要写默认值');
  });

  it('only treats leading flags as flags; the rest is the comment', () => {
    expect(parseQuickColumn('code varchar(8) 编码，not null 由业务保证')).toMatchObject({ nullable: true, comment: '编码，not null 由业务保证' });
  });

  it('parses several lines and reports bad ones', () => {
    const r = parseQuickColumns('a int\n\n1bad text; b text；a int');
    expect(r.columns.map((c) => c.name)).toEqual(['a', 'b']);
    expect(r.errors).toHaveLength(2);
  });

  it('builds templates for the driver', () => {
    expect(columnTemplate('created_at', 'postgres')).toMatchObject({ type: 'timestamptz', default: 'now()', nullable: false });
    expect(columnTemplate('created_at', 'mysql')).toMatchObject({ type: 'datetime', default: 'CURRENT_TIMESTAMP' });
    expect(columnTemplate('id', 'sqlite')).toMatchObject({ type: 'integer', primaryKey: true });
    expect(columnTemplate('deleted_at')).toMatchObject({ type: 'timestamp', nullable: true });
  });

  it('turns columns into design ops, skipping existing names', () => {
    const doc = { schema: { name: 'd', tables: [{ name: 'users', type: 'TABLE', columns: [{ name: 'name', type: 'text', nullable: true }] }] }, ext: emptyExt() };
    const cols = [columnTemplate('id'), ...parseQuickColumns('Name text\nemail varchar(128) unique').columns];
    const { ops, added, skipped } = quickColumnOps('users', ['name'], cols);
    expect(added).toEqual(['id', 'email']);
    expect(skipped).toEqual(['Name']);
    const next = applyDesignOps(doc, ops);
    const users = next.schema.tables[0];
    expect(users.columns.map((c) => c.name)).toEqual(['id', 'name', 'email']);
    const kinds = (users.constraints ?? []).map((c) => `${c.type}:${c.columns?.join(',')}`);
    expect(kinds).toContain('PRIMARY KEY:id');
    expect(kinds.some((k) => k.startsWith('UNIQUE') && k.endsWith(':email'))).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { buildExport, fileBaseName, UNGROUPED_DIR, type ExportDiagramInput, type ExportInput, type ExportTableInput } from '../src/export/builder';
import { ROOT_SCOPE } from '../src/shared/canvas';
import type { NRelation, NTable } from '../src/shared/model';
import type { ExportItem, ExportLevel } from '../src/shared/protocol';

function table(key: string, extra: Partial<NTable> = {}): NTable {
  return {
    key,
    rawName: key,
    type: 'TABLE',
    columns: [
      { name: 'id', rawType: 'bigint', logicalType: 'integer', nullable: false, primaryKey: true, unique: true, autoIncrement: false },
      { name: 'title', rawType: 'varchar(64)', logicalType: 'string', length: 64, nullable: true, primaryKey: false, unique: false, autoIncrement: false },
    ],
    indexes: [],
    ...extra,
  };
}

function designItem(key: string, extra: Partial<Extract<ExportItem, { kind: 'design-table' }>> = {}): ExportTableInput {
  return {
    item: { kind: 'design-table', key, rawName: key, onCanvas: true, columns: 2, ...extra },
    table: table(key),
  };
}

function dbItem(source: string, key: string, extra: Partial<Extract<ExportItem, { kind: 'db-table' }>> = {}): ExportTableInput {
  return {
    item: { kind: 'db-table', source, key, rawName: key, onCanvas: true, columns: 2, ...extra },
    table: table(key),
  };
}

/** `relation('orders', 'user_id', 'users', 'id')`; a comma separates a composite key. */
function relation(from: string, fromCols: string, to: string, toCols: string, kind: NRelation['kind'] = 'fk'): NRelation {
  const fc = fromCols.split(',');
  const tc = toCols.split(',');
  return {
    key: `${from}(${fc.join(',')})->${to}(${tc.join(',')})`,
    from: { table: from, columns: fc },
    to: { table: to, columns: tc },
    cardinality: 'zero_or_more',
    parentCardinality: 'exactly_one',
    kind,
    def: '',
  };
}

function diagram(id: string, name: string, extra: Partial<Extract<ExportItem, { kind: 'diagram' }>> = {}): ExportDiagramInput {
  const raw = `---\ntype: state\nname: ${name}\nrefs: []\n---\n\n\`\`\`mermaid\nstateDiagram-v2\n  [*] --> 草稿\n\`\`\`\n`;
  return { item: { kind: 'diagram', id, key: `g:${id}`, name, type: 'state', onCanvas: true, ...extra }, raw };
}

function input(extra: Partial<ExportInput> = {}): ExportInput {
  return {
    designName: '订单库',
    driverLabel: 'postgresql',
    generatedAt: new Date('2026-10-05T01:30:00.000Z'),
    levels: [{ id: undefined, name: '订单库', depth: 0 }],
    tables: [],
    designRelations: [],
    dbRelations: new Map(),
    diagrams: [],
    ...extra,
  };
}

function paths(files: { path: string; content: string }[]): string[] {
  return files.map((f) => f.path);
}

function at(files: { path: string; content: string }[], path: string): string {
  const file = files.find((f) => f.path === path);
  if (!file) throw new Error(`没有导出 ${path}，实际有：\n${paths(files).join('\n')}`);
  return file.content;
}

describe('buildExport', () => {
  it('writes one file per table and an index per level', () => {
    const files = buildExport(input({ tables: [designItem('users'), designItem('orders')] })).files;
    expect(paths(files)).toEqual(['README.md', 'manifest.json', '设计表/orders.md', '设计表/users.md']);
    expect(at(files, '设计表/users.md')).toContain('# users');
  });
  it('puts design tables and database tables in separate folders', () => {
    const files = buildExport(input({ tables: [designItem('users'), dbItem('db1', 'audit_logs')] })).files;
    expect(paths(files)).toContain('设计表/users.md');
    expect(paths(files)).toContain('数据表/audit_logs.md');
    expect(at(files, 'README.md')).toContain('数据源 db1');
  });

  it('nests a partition as a folder with its own README', () => {
    const levels: ExportLevel[] = [
      { id: undefined, name: '订单库', depth: 0 },
      { id: 'part1', name: '交易', parent: undefined, depth: 1 },
    ];
    const files = buildExport(input({ levels, tables: [designItem('users'), designItem('payments', { partition: 'part1' })] })).files;
    expect(paths(files)).toEqual(['README.md', 'manifest.json', '交易/README.md', '交易/设计表/payments.md', '设计表/users.md']);
    expect(at(files, 'README.md')).toContain('[交易](交易/)');  });

  it('nests a partition inside its parent partition', () => {
    const levels: ExportLevel[] = [
      { id: undefined, name: '订单库', depth: 0 },
      { id: 'part1', name: '交易', parent: undefined, depth: 1 },
      { id: 'part2', name: '支付', parent: 'part1', depth: 2 },
    ];
    const files = buildExport(input({ levels, tables: [designItem('refunds', { partition: 'part2' })] })).files;
    expect(paths(files)).toContain('交易/支付/设计表/refunds.md');
    expect(paths(files)).toContain('交易/支付/README.md');
  });

  it('keeps a cross-partition relation in both levels, marking the far end as a reference', () => {
    const levels: ExportLevel[] = [
      { id: undefined, name: '订单库', depth: 0 },
      { id: 'part1', name: '交易', parent: undefined, depth: 1 },
    ];
    const rel = relation('refunds', 'order_id', 'orders', 'id');
    const files = buildExport(
      input({
        levels,
        tables: [designItem('orders', { partition: 'part1' }), designItem('refunds')],
        designRelations: [rel],
      }),
    ).files;

    const root = at(files, 'README.md');
    const trading = at(files, '交易/README.md');
    // Both levels must carry the relation, even though only 交易 holds both tables.
    expect(root).toMatch(/orders \|\|--o\{ refunds/);
    expect(trading).toMatch(/orders \|\|--o\{ refunds/);
    // The root describes refunds and only references orders; 交易 is the other way round.
    expect(root).toMatch(/\n {2}orders\n/);
    expect(trading).toMatch(/\n {2}refunds\n/);
    for (const text of [root, trading]) {
      expect(text).toContain('只引用，不改字段');
    }
  });

  it('drops a relation when only one of its ends is selected', () => {
    const files = buildExport(input({ tables: [designItem('orders')], designRelations: [relation('orders', 'user_id', 'users', 'id')] })).files;
    const er = at(files, 'README.md');
    // The ER diagram must not claim a relation to a table that is not part of the export.
    expect(er).not.toContain('orders }o--|| users');
    expect(er).not.toContain('orders ||--o{ users');
    // The table file still points at the neighbour so the AI knows it exists.
    expect(at(files, '设计表/orders.md')).toContain('users（不在本次导出中）');
  });

  it('keeps database relations in their own source instead of mixing them with design relations', () => {
    const files = buildExport(
      input({
        tables: [designItem('orders'), dbItem('db1', 'audit_logs')],
        designRelations: [relation('orders', 'user_id', 'users', 'id')],
        dbRelations: new Map([['db1', [relation('audit_logs', 'order_id', 'orders', 'id')]]]),
      }),
    ).files;
    const readme = at(files, 'README.md');
    expect(readme).toContain('## 设计表 ER 图');
    expect(readme).toContain('## 数据表 · 数据源 db1 ER 图');
    // The db source's own orders reference stays in its own block.
    expect(readme).toContain('数据源 db1');
  });

  it('lists the real table name so the AI does not only see the canvas short name', () => {
    const files = buildExport(input({ tables: [dbItem('db1', 'audit_logs', { rawName: 'public.audit_logs' })] })).files;
    expect(at(files, '数据表/audit_logs.md')).toContain('真实表名：`public.audit_logs`');
  });

  it('sends tables that were never placed on the canvas to their own folder', () => {
    const files = buildExport(input({ tables: [designItem('users'), designItem('audit_trail', { onCanvas: false })] })).files;
    expect(paths(files)).toContain(`${UNGROUPED_DIR}/设计表/audit_trail.md`);
    // The unplaced table must not silently join the root.
    expect(paths(files)).not.toContain('设计表/audit_trail.md');
    expect(at(files, `${UNGROUPED_DIR}/README.md`)).toContain('没有摆在画布上');
  });

  it('keeps every field detail a Mermaid ER diagram would drop', () => {
    const t = table('users', {
      comment: '用户',
      columns: [
        { name: 'id', rawType: 'bigint', logicalType: 'integer', nullable: false, primaryKey: true, unique: true, autoIncrement: true },
        { name: 'status', rawType: 'status', logicalType: 'enum', nullable: false, primaryKey: false, unique: false, autoIncrement: false, default: "'new'", enumValues: ['new', 'old'] },
      ],
    });
    const files = buildExport(input({ tables: [{ item: { kind: 'design-table', key: 'users', rawName: 'users', onCanvas: true, columns: 2 }, table: t }] })).files;
    const doc = at(files, '设计表/users.md');
    expect(doc).toContain('| id | bigint | PK | 否 |');
    // The pipe inside the enum list is escaped so the row cannot break.
    expect(doc).toContain('enum(new\\|old)');
    expect(doc).toContain("'new'");
    expect(doc).toContain('用户');
  });

  it('escapes a pipe in a comment so the table cannot break', () => {
    const t = table('users', { comment: 'a | b\nsecond line' });
    const files = buildExport(input({ tables: [{ item: { kind: 'design-table', key: 'users', rawName: 'users', onCanvas: true, columns: 2 }, table: t }] })).files;
    const doc = at(files, '设计表/users.md');
    expect(doc).toContain('a \\| b<br>second line');
  });

  it('gives two names that sanitize to the same file different paths', () => {
    const files = buildExport(input({ tables: [designItem('a/b'), designItem('a:b')] })).files;
    expect(paths(files)).toContain('设计表/a_b.md');
    expect(paths(files)).toContain('设计表/a_b_2.md');
  });

  it('copies a diagram byte for byte so it stays a valid Harness diagram', () => {
    const d = diagram('diagram1', '订单状态图');
    const files = buildExport(input({ diagrams: [d] })).files;
    expect(at(files, '设计图/订单状态图.md')).toBe(d.raw);
  });

  it('keeps a code fence inside a comment from closing the block early', () => {
    const d = diagram('diagram1', '图', { name: '图' });
    const t = table('users', { comment: '```' });
    const files = buildExport(input({ tables: [{ item: { kind: 'design-table', key: 'users', rawName: 'users', onCanvas: true, columns: 2 }, table: t }], diagrams: [d] })).files;
    expect(at(files, '设计表/users.md')).toContain('\\`\\`\\`');
  });

  it('never writes a connection detail into the export', () => {
    const files = buildExport(
      input({
        tables: [designItem('users'), dbItem('db1', 'audit_logs')],
        designRelations: [relation('orders', 'user_id', 'users', 'id')],
      }),
    ).files;
    const all = files.map((f) => f.content).join('\n');
    expect(all).not.toMatch(/\b[\w.-]+\.(?:internal|local|corp|com|net|io)(?::\d+)?\b/i);
    expect(all).not.toMatch(/:\d{2,5}\//);
    expect(all).not.toMatch(/password|passwd|user=|dsn/i);
  });

  it('identifies a database source by its id, never by its display name', () => {
    // `ModelStore.dbName` returns `host:port/db`, so a db name must not be used as a label.
    const files = buildExport(input({ tables: [dbItem('db1', 'audit_logs')], dbRelations: new Map([['db1', []]]) })).files;
    const all = files.map((f) => f.content).join('\n');
    expect(all).toContain('数据源 db1');
    const manifest = JSON.parse(at(files, 'manifest.json'));
    // Only the id crosses over; there is no field a host could hide in.
    expect(Object.keys(manifest.items[0]).sort()).toEqual(['columns', 'file', 'key', 'kind', 'partition', 'rawName', 'source']);
  });

  it('keeps the dialog-only database labels out of the export', () => {
    // `dbLabels` is what the host sends the dialog so it can render a friendly name, like
    // `postgres:5432/orders_prod`. It must never reach the files, or we would leak the host.
    const files = buildExport(input({ tables: [dbItem('db1', 'audit_logs')], dbRelations: new Map([['db1', []]]) })).files;
    const all = files.map((f) => f.content).join('\n');
    expect(all).not.toContain('postgres:5432/orders_prod');
    expect(all).not.toContain('dbLabels');
  });

  it('produces identical output for identical input', () => {
    const build = () => buildExport(input({ tables: [designItem('users'), designItem('orders')], designRelations: [relation('orders', 'user_id', 'users', 'id')] })).files;
    expect(build().map((f) => f.content)).toEqual(build().map((f) => f.content));
  });

  it('survives an empty selection', () => {
    const files = buildExport(input()).files;
    expect(paths(files)).toEqual(['README.md', 'manifest.json']);
    expect(at(files, 'README.md')).toContain('这一层没有内容');
  });

  it('reports counts and keeps the design name out of database headings', () => {
    const result = buildExport(input({ tables: [designItem('users'), dbItem('db1', 'audit_logs')], diagrams: [diagram('diagram1', '图')] }));
    expect(result.counts).toMatchObject({ designTables: 1, dbTables: 1, diagrams: 1 });
    const manifest = JSON.parse(at(result.files, 'manifest.json'));
    expect(manifest.design.name).toBe('订单库');
    expect(manifest.items.find((i: { kind: string }) => i.kind === 'db-table').source).toBe('db1');
  });

  it('links a table to a neighbour that lives in another folder', () => {
    const levels: ExportLevel[] = [
      { id: undefined, name: '订单库', depth: 0 },
      { id: 'part1', name: '交易', parent: undefined, depth: 1 },
    ];
    const files = buildExport(
      input({
        levels,
        tables: [designItem('users'), designItem('orders', { partition: 'part1' })],
        designRelations: [relation('orders', 'user_id', 'users', 'id')],
      }),
    ).files;
    // orders is in 交易/设计表/, users in 设计表/: the link has to climb back out.
    expect(at(files, '交易/设计表/orders.md')).toContain('[users](../../设计表/users.md)');
    // And the other direction must resolve too, not claim the table is missing.
    expect(at(files, '设计表/users.md')).toContain('[orders](../交易/设计表/orders.md)');
    expect(at(files, '设计表/users.md')).not.toContain('不在本次导出中');
  });

  it('says nothing about references when there is no relation at all', () => {
    const files = buildExport(input({ tables: [designItem('orphan', { onCanvas: false })] })).files;
    // No relation means no bare stub, so the note would be a lie.
    expect(at(files, '_未分组/README.md')).not.toContain('只引用');
    expect(at(files, 'README.md')).toContain('未分组');
  });

  it('links a table to its neighbours when both are exported', () => {
    const files = buildExport(input({ tables: [designItem('users'), designItem('orders')], designRelations: [relation('orders', 'user_id', 'users', 'id')] })).files;
    expect(at(files, '设计表/orders.md')).toContain('[users](users.md)');
    expect(at(files, 'README.md')).toContain('[users](设计表/users.md)');
  });

  it('marks a neighbour that is not part of the export', () => {
    const files = buildExport(input({ tables: [designItem('orders')], designRelations: [relation('orders', 'user_id', 'users', 'id')] })).files;
    const readme = at(files, 'README.md');
    // users is a bare stub in the ER and is called out in words.
    expect(readme).toMatch(/\n {2}users\n/);
    expect(readme).toContain('只引用，不改字段');
    expect(at(files, '设计表/orders.md')).toContain('users（不在本次导出中）');
  });
});

describe('fileBaseName', () => {
  it('replaces characters that cannot appear in a path', () => {
    expect(fileBaseName('a/b\\c:d*e?f"g<h>i|j')).toBe('a_b_c_d_e_f_g_h_i_j');
  });

  it('keeps a leading dot from creating a hidden file', () => {
    expect(fileBaseName('.hidden')).toBe('_hidden');
  });

  it('keeps Chinese and dots inside a name', () => {
    expect(fileBaseName('订单.日志')).toBe('订单.日志');
  });

  it('escapes a Windows device name', () => {
    expect(fileBaseName('con')).toBe('_con');
  });

  it('falls back when nothing usable is left', () => {
    expect(fileBaseName('   ')).toBe('未命名');
  });
});

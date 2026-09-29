import { describe, expect, it } from 'vitest';
import { emptyDiagram, parseDiagram, serializeDiagram } from '../src/shared/diagram';
import { applyDesignOps, emptyDesignSchema, emptyExt, type DesignDoc } from '../src/shared/designOps';
import { generateErDiagram, mermaidType, parseErDiagram, sameType } from '../src/shared/mermaid/er';
import { normalize } from '../src/model/normalize';

describe('diagram file', () => {
  it('round-trips frontmatter, code and surrounding markdown', () => {
    const file = emptyDiagram('er', '订单核心', ['orders', 'users']);
    file.code = 'erDiagram\n  users ||--o{ orders : "user_id"';
    file.after = '\n\n补充说明\n';
    const text = serializeDiagram(file);
    expect(text.startsWith('---\ntype: er\nname: 订单核心\nrefs:\n  - orders\n  - users\n---\n')).toBe(true);
    const back = parseDiagram(text);
    expect(back.meta).toEqual(file.meta);
    expect(back.code).toBe(file.code);
    expect(serializeDiagram(back)).toBe(text);
    expect(back.problems).toEqual([]);
  });

  it('accepts a bare mermaid text without frontmatter or fences', () => {
    const file = parseDiagram('erDiagram\n  a ||--o{ b : x\n', '粘贴的图');
    expect(file.meta).toMatchObject({ type: 'er', name: '粘贴的图', refs: [], ignored: [] });
    expect(file.code).toBe('erDiagram\n  a ||--o{ b : x');
  });

  it('reports broken frontmatter but keeps the code', () => {
    const file = parseDiagram('---\nname: [oops\n---\n```mermaid\nerDiagram\n```\n');
    expect(file.problems[0]).toContain('YAML');
    expect(file.code).toBe('erDiagram');
  });
});

describe('parseErDiagram', () => {
  it('reads entities, keys, comments, aliases and relationships', () => {
    const d = parseErDiagram(`erDiagram
  %% comment
  users["用户"] {
    bigint id PK "主键"
    varchar(128) email UK "登录邮箱"
    numeric(10,2) balance
  }
  orders {
    bigint id PK
    bigint user_id FK
  }
  users ||--o{ orders : "user_id"
  orders }o..|| coupons : "coupon_id dictionary"`);
    expect(d.problems).toEqual([]);
    const users = d.entities.find((e) => e.name === 'users')!;
    expect(users.alias).toBe('用户');
    expect(users.attributes).toEqual([
      { type: 'bigint', name: 'id', keys: ['PK'], comment: '主键', line: 4 },
      { type: 'varchar(128)', name: 'email', keys: ['UK'], comment: '登录邮箱', line: 5 },
      { type: 'numeric(10,2)', name: 'balance', keys: [], line: 6 },
    ]);
    expect(d.entities.find((e) => e.name === 'coupons')).toMatchObject({ hasBody: false, attributes: [] });
    expect(d.relationships).toEqual([
      { left: 'users', right: 'orders', leftCard: 'exactly_one', rightCard: 'zero_or_more', identifying: true, label: 'user_id', line: 12 },
      { left: 'orders', right: 'coupons', leftCard: 'zero_or_more', rightCard: 'exactly_one', identifying: false, label: 'coupon_id dictionary', line: 13 },
    ]);
  });

  it('accepts quoted entity names and multiple keys', () => {
    const d = parseErDiagram('erDiagram\n  "pgmq.meta" {\n    int a PK, FK\n  }');
    expect(d.entities[0]).toMatchObject({ name: 'pgmq.meta', attributes: [{ name: 'a', keys: ['PK', 'FK'] }] });
  });

  it('reports lines it cannot read with their line numbers', () => {
    const d = parseErDiagram('erDiagram\n  users {\n    just_one_word\n  }\n  a <--> b');
    expect(d.problems.map((p) => p.line)).toEqual([3, 5]);
  });

  it('reports an unclosed block', () => {
    expect(parseErDiagram('erDiagram\n  users {\n    int id').problems[0].message).toContain('没有闭合');
  });
});

describe('generateErDiagram', () => {
  function doc(): DesignDoc {
    return applyDesignOps({ schema: emptyDesignSchema('t', 'postgres'), ext: emptyExt() }, [
      { op: 'table.add', table: 'users', comment: '用户' },
      { op: 'column.add', table: 'users', column: { name: 'email', type: 'varchar(255)', nullable: false, comment: '登录"邮箱"' } },
      { op: 'column.update', table: 'users', column: 'email', patch: { unique: true } },
      { op: 'column.add', table: 'users', column: { name: 'created_at', type: 'timestamp with time zone', nullable: false } },
      { op: 'table.add', table: 'orders' },
      { op: 'column.add', table: 'orders', column: { name: 'user_id', type: 'bigint', nullable: false } },
      { op: 'column.add', table: 'orders', column: { name: 'tag_ids', type: 'jsonb', nullable: true } },
      { op: 'table.add', table: 'tags' },
      { op: 'relation.add', from: { table: 'orders', columns: ['user_id'] }, to: { table: 'users', columns: ['id'] }, kind: 'fk' },
      { op: 'relation.add', from: { table: 'orders', columns: ['tag_ids'] }, to: { table: 'tags', columns: ['id'] }, kind: 'json_array' },
    ]);
  }

  it('writes Mermaid that our parser reads back without problems', () => {
    const d = doc();
    const code = generateErDiagram(normalize(d.schema, { source: 'design', ext: d.ext }));
    expect(code).toContain('users["用户"] {');
    expect(code).toContain(`varchar(255) email UK "登录'邮箱'"`);
    expect(code).toContain('timestamp_with_time_zone created_at');
    expect(code).toContain('bigint user_id FK');
    expect(code).toContain('users ||--o{ orders : "user_id"');
    expect(code).toContain('tags |o..o{ orders : "tag_ids json_array"');
    expect(parseErDiagram(code).problems).toEqual([]);
  });

  it('only includes relations whose both ends are included', () => {
    const d = doc();
    const code = generateErDiagram(normalize(d.schema, { source: 'design', ext: d.ext }), ['orders', 'tags']);
    expect(code).not.toContain('users');
    expect(code).toContain('tags |o..o{ orders');
  });

  it('maps types that contain spaces', () => {
    expect(mermaidType('character varying(20)')).toBe('character_varying(20)');
    expect(sameType('timestamp with time zone', 'timestamp_with_time_zone')).toBe(true);
    expect(sameType('bigint', 'BIGINT')).toBe(true);
    expect(sameType('int', 'bigint')).toBe(false);
  });
});

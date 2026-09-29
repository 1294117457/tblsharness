import type { ColumnInput, DesignOp } from './designOps';

/**
 * One-line column entry in the inspector: `name [type] [flags…] [comment]`, e.g.
 * `email varchar(128) not null unique 登录邮箱`. Several columns can be separated by new lines or `;`.
 */
export interface QuickColumn extends ColumnInput {
  primaryKey: boolean;
  unique: boolean;
}

export interface QuickParseResult {
  columns: QuickColumn[];
  errors: string[];
}

const MULTI_WORD_TYPES = [
  'timestamp with time zone',
  'timestamp without time zone',
  'time with time zone',
  'time without time zone',
  'double precision',
  'character varying',
  'bit varying',
];

const NAME = /^[A-Za-z_][A-Za-z0-9_$]*$/;

function tokenize(line: string): string[] {
  const tokens: string[] = [];
  const re = /'(?:[^']|'')*'|"[^"]*"|\S+/g;
  for (const m of line.matchAll(re)) tokens.push(m[0]);
  return tokens;
}

/** `numeric(10, 2)` is split by whitespace; glue tokens back together until the parentheses balance. */
function takeType(tokens: string[], start: number): { type: string; next: number } | undefined {
  const rest = tokens.slice(start).join(' ').toLowerCase();
  for (const phrase of MULTI_WORD_TYPES) {
    if (rest === phrase || rest.startsWith(`${phrase} `) || rest.startsWith(`${phrase}(`)) {
      const words = phrase.split(' ').length;
      let type = tokens.slice(start, start + words).join(' ');
      let next = start + words;
      if (tokens[next]?.startsWith('(')) type += tokens[next++];
      return balance(tokens, type, next);
    }
  }
  const first = tokens[start];
  if (!first || isFlagStart(tokens, start) || !/^[A-Za-z_]/.test(first)) return undefined;
  return balance(tokens, first, start + 1);
}

function balance(tokens: string[], type: string, next: number): { type: string; next: number } {
  const depth = (s: string) => [...s].reduce((d, ch) => d + (ch === '(' ? 1 : ch === ')' ? -1 : 0), 0);
  while (depth(type) > 0 && next < tokens.length) type += ` ${tokens[next++]}`;
  return { type: type.replace(/\s*,\s*/g, ',').replace(/\s*\(\s*/g, '(').replace(/\s*\)/g, ')'), next };
}

function lower(tokens: string[], i: number): string {
  return tokens[i]?.toLowerCase() ?? '';
}

function isFlagStart(tokens: string[], i: number): boolean {
  const t = lower(tokens, i);
  if (['nn', 'notnull', 'null', 'nullable', 'pk', 'uk', 'unique', 'default'].includes(t)) return true;
  if (t === 'not' && lower(tokens, i + 1) === 'null') return true;
  if (t === 'primary' && lower(tokens, i + 1) === 'key') return true;
  return false;
}

function unquote(s: string): string {
  return s.length >= 2 && s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s;
}

/** Type used when the user only types a name: follows the usual naming conventions. */
export function guessType(name: string): string {
  const n = name.toLowerCase();
  if (n === 'id' || n.endsWith('_id')) return 'bigint';
  if (n.endsWith('_at') || n.endsWith('_time')) return 'timestamp';
  if (n.endsWith('_date')) return 'date';
  if (n.startsWith('is_') || n.startsWith('has_')) return 'boolean';
  if (n.endsWith('_count') || n.endsWith('_num')) return 'integer';
  return 'varchar(255)';
}

export function parseQuickColumn(line: string): QuickColumn | string {
  const tokens = tokenize(line.trim());
  if (!tokens.length) return '没有内容';
  const name = tokens[0];
  if (!NAME.test(name)) return `“${name}”不是合法的字段名（字母、数字、下划线，不能以数字开头）`;
  let i = 1;
  const typed = takeType(tokens, i);
  const column: QuickColumn = { name, type: typed?.type ?? guessType(name), nullable: true, primaryKey: false, unique: false };
  if (typed) i = typed.next;
  let explicitNull = false;
  while (i < tokens.length && isFlagStart(tokens, i)) {
    const t = lower(tokens, i);
    if (t === 'not' || t === 'primary') {
      if (t === 'primary') column.primaryKey = true;
      column.nullable = false;
      i += 2;
    } else if (t === 'nn' || t === 'notnull') {
      column.nullable = false;
      i++;
    } else if (t === 'null' || t === 'nullable') {
      explicitNull = true;
      i++;
    } else if (t === 'pk') {
      column.primaryKey = true;
      column.nullable = false;
      i++;
    } else if (t === 'uk' || t === 'unique') {
      column.unique = true;
      i++;
    } else {
      const value = tokens[i + 1];
      if (value === undefined) return 'default 后面需要写默认值';
      column.default = value;
      i += 2;
    }
  }
  if (explicitNull && column.primaryKey) return `主键字段 ${name} 不能可空`;
  const comment = tokens.slice(i).map(unquote).join(' ').trim();
  if (comment) column.comment = comment;
  return column;
}

export function parseQuickColumns(text: string): QuickParseResult {
  const result: QuickParseResult = { columns: [], errors: [] };
  const seen = new Set<string>();
  for (const line of text.split(/[\r\n;；]+/)) {
    if (!line.trim()) continue;
    const parsed = parseQuickColumn(line);
    if (typeof parsed === 'string') result.errors.push(parsed);
    else if (seen.has(parsed.name)) result.errors.push(`字段 ${parsed.name} 写了两次`);
    else {
      seen.add(parsed.name);
      result.columns.push(parsed);
    }
  }
  return result;
}

export type ColumnTemplate = 'id' | 'created_at' | 'updated_at' | 'deleted_at';

export const COLUMN_TEMPLATES: { key: ColumnTemplate; label: string }[] = [
  { key: 'id', label: 'id 主键' },
  { key: 'created_at', label: 'created_at' },
  { key: 'updated_at', label: 'updated_at' },
  { key: 'deleted_at', label: 'deleted_at' },
];

type Dialect = 'postgres' | 'mysql' | 'sqlite' | 'mssql' | 'oracle' | 'generic';

function dialect(driver: string | undefined): Dialect {
  const d = (driver ?? '').toLowerCase();
  if (d.includes('postgres') || d.includes('redshift')) return 'postgres';
  if (d.includes('mysql') || d.includes('maria')) return 'mysql';
  if (d.includes('sqlite')) return 'sqlite';
  if (d.includes('mssql') || d.includes('sqlserver')) return 'mssql';
  if (d.includes('oracle')) return 'oracle';
  return 'generic';
}

const TIME: Record<Dialect, { type: string; now: string }> = {
  postgres: { type: 'timestamptz', now: 'now()' },
  mysql: { type: 'datetime', now: 'CURRENT_TIMESTAMP' },
  sqlite: { type: 'datetime', now: 'CURRENT_TIMESTAMP' },
  mssql: { type: 'datetime2', now: 'sysdatetime()' },
  oracle: { type: 'timestamp', now: 'systimestamp' },
  generic: { type: 'timestamp', now: 'CURRENT_TIMESTAMP' },
};

export function columnTemplate(key: ColumnTemplate, driver?: string): QuickColumn {
  const d = dialect(driver);
  const time = TIME[d];
  switch (key) {
    case 'id':
      return { name: 'id', type: d === 'sqlite' ? 'integer' : d === 'oracle' ? 'number(19)' : 'bigint', nullable: false, primaryKey: true, unique: false, comment: '主键' };
    case 'created_at':
      return { name: 'created_at', type: time.type, nullable: false, default: time.now, primaryKey: false, unique: false, comment: '创建时间' };
    case 'updated_at':
      return { name: 'updated_at', type: time.type, nullable: false, default: time.now, primaryKey: false, unique: false, comment: '更新时间' };
    case 'deleted_at':
      return { name: 'deleted_at', type: time.type, nullable: true, primaryKey: false, unique: false, comment: '删除时间（软删除）' };
  }
}

/** Ops that add the columns to `table`; columns whose names already exist are skipped and reported. */
export function quickColumnOps(table: string, existing: string[], columns: QuickColumn[]): { ops: DesignOp[]; added: string[]; skipped: string[] } {
  const taken = new Set(existing.map((n) => n.toLowerCase()));
  const ops: DesignOp[] = [];
  const added: string[] = [];
  const skipped: string[] = [];
  for (const c of columns) {
    if (taken.has(c.name.toLowerCase())) {
      skipped.push(c.name);
      continue;
    }
    taken.add(c.name.toLowerCase());
    const { primaryKey, unique, ...input } = c;
    const index = primaryKey ? 0 : undefined;
    ops.push({ op: 'column.add', table, column: input, ...(index === undefined ? {} : { index }) });
    if (primaryKey || unique) ops.push({ op: 'column.update', table, column: c.name, patch: { ...(primaryKey ? { primaryKey } : {}), ...(unique ? { unique } : {}) } });
    added.push(c.name);
  }
  return { ops, added, skipped };
}

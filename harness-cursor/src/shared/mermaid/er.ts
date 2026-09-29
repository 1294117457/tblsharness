import type { NormalizedSchema, NRelation, NTable, RelationKind } from '../model';
import type { TblsCardinality } from '../tbls';

export type ErKey = 'PK' | 'FK' | 'UK';

export interface ErAttribute {
  type: string;
  name: string;
  keys: ErKey[];
  comment?: string;
  line: number;
}

export interface ErEntity {
  name: string;
  /** `name["alias"]`; used as the table comment. */
  alias?: string;
  attributes: ErAttribute[];
  /** false when the entity only appears in relationships, i.e. its columns are not described. */
  hasBody: boolean;
  line: number;
}

export interface ErRelationship {
  left: string;
  right: string;
  leftCard: TblsCardinality;
  rightCard: TblsCardinality;
  /** `--` (identifying) vs `..` (non-identifying). */
  identifying: boolean;
  label: string;
  line: number;
}

export interface ErProblem {
  line: number;
  message: string;
}

export interface ErDiagram {
  entities: ErEntity[];
  relationships: ErRelationship[];
  problems: ErProblem[];
}

/** Relation labels that pick a relation kind; any other words in the label are column names or free text. */
export const KIND_KEYWORDS: Partial<Record<string, RelationKind>> = {
  fk: 'fk',
  logical: 'logical',
  virtual: 'virtual',
  json_array: 'json_array',
  polymorphic: 'polymorphic',
  dictionary: 'dictionary',
};

const LEFT_CARDS: Record<string, TblsCardinality> = {
  '|o': 'zero_or_one',
  '||': 'exactly_one',
  '}o': 'zero_or_more',
  '}|': 'one_or_more',
};

const RIGHT_CARDS: Record<string, TblsCardinality> = {
  'o|': 'zero_or_one',
  '||': 'exactly_one',
  'o{': 'zero_or_more',
  '|{': 'one_or_more',
};

const ENTITY = String.raw`("[^"\r\n]+"|[^\s"{}\[\]:|]+?)`;
const RELATIONSHIP = new RegExp(
  String.raw`^${ENTITY}\s*(\|o|\|\||\}o|\}\|)(--|\.\.)(o\||\|\||o\{|\|\{)\s*${ENTITY}\s*(?::\s*(.*))?$`,
);
const ENTITY_HEAD = new RegExp(String.raw`^${ENTITY}(?:\s*\[\s*("[^"]*"|[^\]]*)\s*\])?(?::::[\w-]+)?\s*(\{.*)?$`);
const ATTRIBUTE = /^(\S+)\s+(\S+?)(?:\s+((?:PK|FK|UK)(?:\s*,\s*(?:PK|FK|UK))*))?(?:\s+"([^"]*)")?\s*$/i;
const SKIPPED = /^(direction\s|title\s|accTitle\s*:|accDescr\s*:|classDef\s|class\s|style\s)/;

export function isMany(card: TblsCardinality): boolean {
  return card === 'zero_or_more' || card === 'one_or_more';
}

function unquote(s: string): string {
  s = s.trim();
  return s.length >= 2 && s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s;
}

export function parseErDiagram(code: string): ErDiagram {
  const entities = new Map<string, ErEntity>();
  const relationships: ErRelationship[] = [];
  const problems: ErProblem[] = [];
  const lines = code.split(/\r?\n/);

  const entity = (name: string, line: number): ErEntity => {
    let e = entities.get(name);
    if (!e) {
      e = { name, attributes: [], hasBody: false, line };
      entities.set(name, e);
    }
    return e;
  };

  let headerSeen = false;
  let block: ErEntity | undefined;
  let accDescrBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const no = i + 1;
    let text = lines[i].trim();
    if (!text || text.startsWith('%%')) continue;
    if (accDescrBlock) {
      if (text.includes('}')) accDescrBlock = false;
      continue;
    }

    if (block) {
      const close = text.indexOf('}');
      const inner = close >= 0 ? text.slice(0, close).trim() : text;
      if (inner) parseAttribute(inner, no, block, problems);
      if (close >= 0) {
        block = undefined;
        const rest = text.slice(close + 1).trim();
        if (rest) problems.push({ line: no, message: `} 后面的内容被忽略：${rest}` });
      }
      continue;
    }

    if (!headerSeen) {
      if (/^erDiagram\b/.test(text)) {
        headerSeen = true;
        text = text.slice('erDiagram'.length).trim();
        if (!text) continue;
      } else {
        problems.push({ line: no, message: '第一行应该是 erDiagram' });
        headerSeen = true;
      }
    }

    if (/^accDescr\s*\{/.test(text)) {
      accDescrBlock = !text.includes('}');
      continue;
    }
    if (SKIPPED.test(text)) continue;

    const rel = RELATIONSHIP.exec(text);
    if (rel) {
      const left = unquote(rel[1]);
      const right = unquote(rel[5]);
      entity(left, no);
      entity(right, no);
      relationships.push({
        left,
        right,
        leftCard: LEFT_CARDS[rel[2]],
        identifying: rel[3] === '--',
        rightCard: RIGHT_CARDS[rel[4]],
        label: unquote(rel[6] ?? ''),
        line: no,
      });
      continue;
    }

    const head = ENTITY_HEAD.exec(text);
    if (head) {
      const e = entity(unquote(head[1]), no);
      if (head[2] !== undefined) {
        const alias = unquote(head[2]);
        if (alias) e.alias = alias;
      }
      const body = head[3];
      if (body !== undefined) {
        e.hasBody = true;
        const inner = body.slice(1);
        const close = inner.indexOf('}');
        if (close >= 0) {
          for (const part of inner.slice(0, close).split(';')) {
            if (part.trim()) parseAttribute(part.trim(), no, e, problems);
          }
        } else {
          if (inner.trim()) parseAttribute(inner.trim(), no, e, problems);
          block = e;
        }
      }
      continue;
    }

    if (/[|}o]\s*[.-]{2}|[.-]{2}\s*[|o{]/.test(text)) {
      problems.push({ line: no, message: `看不懂的关系写法：${text}。支持 ||、|o、}o、}| 和 --、.. 的组合` });
    } else {
      problems.push({ line: no, message: `看不懂这一行：${text}` });
    }
  }
  if (block) problems.push({ line: block.line, message: `${block.name} 的 { 没有闭合` });
  if (!headerSeen && code.trim()) problems.push({ line: 1, message: '第一行应该是 erDiagram' });

  return { entities: [...entities.values()], relationships, problems };
}

function parseAttribute(text: string, line: number, entity: ErEntity, problems: ErProblem[]): void {
  const m = ATTRIBUTE.exec(text);
  if (!m) {
    problems.push({ line, message: `${entity.name} 的字段写法不对：${text}。格式是 “类型 字段名 PK/FK/UK "注释"”` });
    return;
  }
  const keys = (m[3] ?? '')
    .split(',')
    .map((k) => k.trim().toUpperCase())
    .filter((k): k is ErKey => k === 'PK' || k === 'FK' || k === 'UK');
  const attr: ErAttribute = { type: m[1], name: m[2], keys: [...new Set(keys)], line };
  if (m[4] !== undefined && m[4] !== '') attr.comment = m[4];
  if (entity.attributes.some((a) => a.name === attr.name)) {
    problems.push({ line, message: `${entity.name}.${attr.name} 重复定义，以后面的为准` });
    entity.attributes = entity.attributes.filter((a) => a.name !== attr.name);
  }
  entity.attributes.push(attr);
}

// ---- generation ----

/** Mermaid types cannot contain spaces: `timestamp with time zone` becomes `timestamp_with_time_zone`. */
export function mermaidType(type: string): string {
  const t = type.trim().replace(/"/g, '').replace(/\s+/g, '_');
  return /^[*A-Za-z_\u00C0-\uFFFF]/.test(t) ? t : `t_${t}`;
}

export function sameType(dbType: string, mermaid: string): boolean {
  const a = dbType.trim().toLowerCase();
  const b = mermaid.trim().toLowerCase();
  return a === b || mermaidType(a) === b;
}

function entityName(name: string): string {
  return /^([^\x00-\x7F]|[\w-])+$/.test(name) ? name : `"${name.replace(/"/g, "'")}"`;
}

function text(s: string): string {
  return s.replace(/"/g, "'").replace(/\s*\r?\n\s*/g, ' ').trim();
}

function aliasOf(t: NTable): string | undefined {
  const c = t.comment?.trim();
  if (!c || c.includes('\n') || c.length > 40 || /[\[\]"]/.test(c)) return undefined;
  return c;
}

const LEFT_MARK: Record<string, string> = { zero_or_one: '|o', exactly_one: '||', zero_or_more: '}o', one_or_more: '}|' };
const RIGHT_MARK: Record<string, string> = { zero_or_one: 'o|', exactly_one: '||', zero_or_more: 'o{', one_or_more: '|{' };

export const DEFAULT_PARENT_CARD: TblsCardinality = 'exactly_one';
export const DEFAULT_CHILD_CARD: TblsCardinality = 'zero_or_more';

/** Label that round-trips: child columns, plus the kind when a dotted line alone would be ambiguous. */
export function relationLabel(r: Pick<NRelation, 'kind' | 'from'>): string {
  const words = [...r.from.columns];
  if (r.kind !== 'fk' && r.kind !== 'logical') words.push(r.kind);
  return words.join(' ');
}

/** Tables are emitted in the given order; relations only when both ends are included. */
export function generateErDiagram(schema: NormalizedSchema, tables?: string[]): string {
  const keys = tables ?? schema.tables.map((t) => t.key);
  const byKey = new Map(schema.tables.map((t) => [t.key, t]));
  const included = keys.map((k) => byKey.get(k)).filter((t): t is NTable => !!t);
  const set = new Set(included.map((t) => t.key));
  const relations = schema.relations.filter((r) => set.has(r.from.table) && set.has(r.to.table));
  const fkColumns = new Set(relations.flatMap((r) => r.from.columns.map((c) => `${r.from.table}.${c}`)));

  const out = ['erDiagram'];
  for (const t of included) {
    const alias = aliasOf(t);
    out.push(`  ${entityName(t.key)}${alias ? `["${alias}"]` : ''} {`);
    for (const c of t.columns) {
      const k: ErKey[] = [];
      if (c.primaryKey) k.push('PK');
      if (fkColumns.has(`${t.key}.${c.name}`)) k.push('FK');
      if (c.unique && !c.primaryKey) k.push('UK');
      const comment = c.comment ? text(c.comment) : '';
      out.push(`    ${mermaidType(c.rawType)} ${c.name}${k.length ? ` ${k.join(', ')}` : ''}${comment ? ` "${comment}"` : ''}`);
    }
    out.push('  }');
  }
  for (const r of relations) {
    const line = r.kind === 'fk' ? '--' : '..';
    const pm = LEFT_MARK[r.parentCardinality || DEFAULT_PARENT_CARD];
    const cm = RIGHT_MARK[r.cardinality || DEFAULT_CHILD_CARD];
    out.push(`  ${entityName(r.to.table)} ${pm}${line}${cm} ${entityName(r.from.table)} : "${text(relationLabel(r))}"`);
  }
  return out.join('\n');
}

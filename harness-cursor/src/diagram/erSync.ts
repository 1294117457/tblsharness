import { normalize } from '../model/normalize';
import type { DiagramFile } from '../shared/diagram';
import type { ColumnInput, DesignDoc, DesignOp } from '../shared/designOps';
import {
  DEFAULT_CHILD_CARD,
  DEFAULT_PARENT_CARD,
  isMany,
  KIND_KEYWORDS,
  parseErDiagram,
  sameType,
  type ErAttribute,
  type ErEntity,
  type ErRelationship,
} from '../shared/mermaid/er';
import type { NColumn, NormalizedSchema, NRelation, NTable, RelationKind } from '../shared/model';
import type { SyncItem, SyncResult } from '../shared/sync';
import type { TblsCardinality } from '../shared/tbls';

const ORDER = { tableAdd: 0, tableChange: 1, columnAdd: 2, columnChange: 3, relation: 4, relationDelete: 5, columnDelete: 6, tableDelete: 7 };

const CARD_LABEL: Record<string, string> = { zero_or_one: '0..1', exactly_one: '1', zero_or_more: '0..n', one_or_more: '1..n', '': '未指定' };

/** A dotted line without a kind keyword: matches any relation that is not a real foreign key. */
type ParsedKind = RelationKind | 'soft';

interface Resolved {
  child: string;
  parent: string;
  childCard: TblsCardinality;
  parentCard: TblsCardinality;
  kind: ParsedKind;
  childColumns?: string[];
  parentColumns?: string[];
  options: string[];
  rel: ErRelationship;
}

/**
 * Compares an ER diagram with the design it belongs to.
 *
 * Scope: tables in `refs` plus every entity in the diagram. Anything Mermaid cannot express
 * (defaults, indexes, enums, notes, column order) is never touched.
 */
export function computeErSync(doc: DesignDoc, diagram: DiagramFile, choices: Record<string, string> = {}): SyncResult {
  const parsed = parseErDiagram(diagram.code);
  const schema = normalize(doc.schema, { source: 'design', ext: doc.ext });
  const ctx = new Context(schema, parsed.entities, choices);

  for (const e of parsed.entities) {
    if (ctx.table(e.name)) ctx.compareTable(e);
    else ctx.addTable(e);
  }
  const drawn = new Set(parsed.entities.map((e) => e.name));
  for (const ref of diagram.meta.refs) {
    const t = ctx.table(ref);
    if (t && !drawn.has(ref)) {
      ctx.push({
        id: `table.delete:${ref}`,
        action: 'delete',
        target: 'table',
        table: ref,
        message: `删除表 ${ref}`,
        detail: '设计图引用了这张表，但图里已经没有它。如果只是不想在图里画出来，请忽略这一项。',
        defaultChecked: false,
        ops: [{ op: 'table.delete', table: ref }],
        order: ORDER.tableDelete,
      });
    }
  }
  const problems = [...parsed.problems];
  const matched = new Set<string>();
  // A drawn relationship we could not read still says "these two are related": never propose deleting theirs.
  const unreadPairs = new Set<string>();
  for (const rel of parsed.relationships) {
    const r = ctx.resolve(rel);
    if (typeof r === 'string') {
      problems.push({ line: rel.line, message: r });
      unreadPairs.add(`${rel.left}\n${rel.right}`).add(`${rel.right}\n${rel.left}`);
      continue;
    }
    ctx.compareRelation(r, matched);
  }
  for (const r of schema.relations) {
    if (matched.has(r.key) || !drawn.has(r.from.table) || !drawn.has(r.to.table)) continue;
    if (unreadPairs.has(`${r.from.table}\n${r.to.table}`)) continue;
    ctx.push({
      id: `relation.delete:${r.key}`,
      action: 'delete',
      target: 'relation',
      table: r.from.table,
      message: `删除关系 ${r.from.table}.${r.from.columns.join(',')} → ${r.to.table}`,
      detail: '两张表都在图里，但图里没有画这条关系。',
      defaultChecked: false,
      ops: [{ op: 'relation.delete', key: r.key }],
      order: ORDER.relationDelete,
    });
  }

  const ignoredIds = new Set(diagram.meta.ignored);
  const items = ctx.items.filter((i) => !ignoredIds.has(i.id));
  return { items, problems, ignored: ctx.items.length - items.length };
}

function singular(name: string): string[] {
  const out = [name];
  if (name.endsWith('ies')) out.push(`${name.slice(0, -3)}y`);
  if (name.endsWith('ses') || name.endsWith('xes')) out.push(name.slice(0, -2));
  if (name.endsWith('s')) out.push(name.slice(0, -1));
  return out;
}

function sameCols(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function flatText(s: string | undefined): string {
  return (s ?? '').replace(/"/g, "'").replace(/\s*\r?\n\s*/g, ' ').trim();
}

class Context {
  readonly items: SyncItem[] = [];
  private readonly tables: Map<string, NTable>;
  private readonly entities: Map<string, ErEntity>;

  constructor(
    private readonly schema: NormalizedSchema,
    entities: ErEntity[],
    private readonly choices: Record<string, string>,
  ) {
    this.tables = new Map(schema.tables.map((t) => [t.key, t]));
    this.entities = new Map(entities.map((e) => [e.name, e]));
  }

  table(key: string): NTable | undefined {
    return this.tables.get(key);
  }

  push(item: SyncItem): void {
    this.items.push(item);
  }

  private columnInput(a: ErAttribute): ColumnInput {
    const input: ColumnInput = { name: a.name, type: a.type, nullable: !a.keys.includes('PK') };
    if (a.comment) input.comment = a.comment;
    return input;
  }

  private keyOps(table: string, a: ErAttribute): DesignOp[] {
    const ops: DesignOp[] = [];
    if (a.keys.includes('PK')) ops.push({ op: 'column.update', table, column: a.name, patch: { primaryKey: true } });
    if (a.keys.includes('UK') && !a.keys.includes('PK')) ops.push({ op: 'column.update', table, column: a.name, patch: { unique: true } });
    return ops;
  }

  addTable(e: ErEntity): void {
    const ops: DesignOp[] = [{ op: 'table.add', table: e.name, comment: e.alias, withId: !e.attributes.length }];
    for (const a of e.attributes) ops.push({ op: 'column.add', table: e.name, column: this.columnInput(a) });
    for (const a of e.attributes) ops.push(...this.keyOps(e.name, a));
    const cols = e.attributes.length ? e.attributes.map((a) => a.name).join(', ') : '只有 id 字段（图里没有写字段）';
    this.push({
      id: `table.add:${e.name}`,
      action: 'add',
      target: 'table',
      table: e.name,
      message: `新建表 ${e.name}${e.alias ? `（${e.alias}）` : ''}`,
      detail: `字段：${cols}`,
      defaultChecked: true,
      ops,
      order: ORDER.tableAdd,
    });
  }

  compareTable(e: ErEntity): void {
    const t = this.tables.get(e.name)!;
    if (e.alias !== undefined && flatText(e.alias) !== flatText(t.comment)) {
      this.push({
        id: `table.comment:${t.key}`,
        action: 'change',
        target: 'table',
        table: t.key,
        message: `表 ${t.key} 的注释改为“${e.alias}”`,
        detail: t.comment ? `原来是“${t.comment}”` : undefined,
        defaultChecked: true,
        ops: [{ op: 'table.update', table: t.key, comment: e.alias }],
        order: ORDER.tableChange,
      });
    }
    // An entity drawn without a body only shows the table; its columns are not being described.
    if (!e.hasBody || !e.attributes.length) return;

    const byName = new Map(t.columns.map((c) => [c.name, c]));
    for (const a of e.attributes) {
      const c = byName.get(a.name);
      if (!c) {
        this.push({
          id: `column.add:${t.key}.${a.name}`,
          action: 'add',
          target: 'column',
          table: t.key,
          column: a.name,
          message: `新增字段 ${t.key}.${a.name} ${a.type}`,
          detail: a.comment,
          defaultChecked: true,
          ops: [{ op: 'column.add', table: t.key, column: this.columnInput(a) }, ...this.keyOps(t.key, a)],
          order: ORDER.columnAdd,
        });
        continue;
      }
      this.compareColumn(t, c, a);
    }
    const drawn = new Set(e.attributes.map((a) => a.name));
    for (const c of t.columns) {
      if (drawn.has(c.name)) continue;
      this.push({
        id: `column.delete:${t.key}.${c.name}`,
        action: 'delete',
        target: 'column',
        table: t.key,
        column: c.name,
        message: `删除字段 ${t.key}.${c.name}`,
        detail: '图里这张表没有写这个字段。如果只是省略没画，请忽略这一项。',
        defaultChecked: false,
        ops: [{ op: 'column.delete', table: t.key, column: c.name }],
        order: ORDER.columnDelete,
      });
    }
  }

  private compareColumn(t: NTable, c: NColumn, a: ErAttribute): void {
    const at = `${t.key}.${c.name}`;
    const change = (id: string, message: string, patch: Extract<DesignOp, { op: 'column.update' }>['patch'], checked = true, detail?: string) =>
      this.push({
        id: `${id}:${at}`,
        action: 'change',
        target: 'column',
        table: t.key,
        column: c.name,
        message,
        detail,
        defaultChecked: checked,
        ops: [{ op: 'column.update', table: t.key, column: c.name, patch }],
        order: ORDER.columnChange,
      });
    if (!sameType(c.rawType, a.type)) change('column.type', `字段 ${at} 类型 ${c.rawType} → ${a.type}`, { type: a.type });
    if (a.comment !== undefined && a.comment !== flatText(c.comment)) {
      change('column.comment', `字段 ${at} 注释改为“${a.comment}”`, { comment: a.comment }, true, c.comment ? `原来是“${c.comment}”` : undefined);
    }
    const pk = a.keys.includes('PK');
    if (pk && !c.primaryKey) change('column.pk', `字段 ${at} 设为主键`, { primaryKey: true });
    if (!pk && c.primaryKey) change('column.unpk', `字段 ${at} 取消主键`, { primaryKey: false }, false, '图里这个字段没有标 PK。');
    const uk = a.keys.includes('UK');
    if (!c.primaryKey && !pk) {
      if (uk && !c.unique) change('column.uk', `字段 ${at} 设为唯一`, { unique: true });
      if (!uk && c.unique) change('column.unuk', `字段 ${at} 取消唯一`, { unique: false }, false, '图里这个字段没有标 UK。');
    }
  }

  /** Column names of a table as they will be after sync: existing ones plus the ones drawn. */
  private columnsOf(table: string): string[] {
    const names = new Set((this.tables.get(table)?.columns ?? []).map((c) => c.name));
    for (const a of this.entities.get(table)?.attributes ?? []) names.add(a.name);
    return [...names];
  }

  private pkOf(table: string): string[] {
    const drawn = (this.entities.get(table)?.attributes ?? []).filter((a) => a.keys.includes('PK')).map((a) => a.name);
    if (drawn.length) return drawn;
    const existing = (this.tables.get(table)?.columns ?? []).filter((c) => c.primaryKey).map((c) => c.name);
    if (existing.length) return existing;
    return this.columnsOf(table).includes('id') || !this.tables.has(table) ? ['id'] : [];
  }

  private fkMarked(table: string): Set<string> {
    return new Set((this.entities.get(table)?.attributes ?? []).filter((a) => a.keys.includes('FK')).map((a) => a.name));
  }

  /** Label words that are columns of `child`; the child columns stated explicitly. */
  private labelColumns(child: string, words: string[]): string[] {
    const cols = new Set(this.columnsOf(child));
    return words.filter((w) => cols.has(w));
  }

  private inferColumn(child: string, parent: string): string | undefined {
    const cols = this.columnsOf(child);
    const marked = this.fkMarked(child);
    const bare = parent.includes('.') ? parent.slice(parent.lastIndexOf('.') + 1) : parent;
    const names = singular(bare).flatMap((s) => [`${s}_id`, `${s}Id`]);
    const hits = cols.filter((c) => names.includes(c));
    const preferred = hits.filter((c) => marked.has(c));
    if (preferred.length === 1) return preferred[0];
    if (hits.length === 1) return hits[0];
    return undefined;
  }

  resolve(rel: ErRelationship): Resolved | string {
    const words = rel.label.split(/[\s,，、]+/).filter(Boolean);
    const keyword = words.map((w) => KIND_KEYWORDS[w.toLowerCase()]).find(Boolean);
    const kind: ParsedKind = keyword ?? (rel.identifying ? 'fk' : 'soft');
    const leftMany = isMany(rel.leftCard);
    const rightMany = isMany(rel.rightCard);

    const orient = (childLeft: boolean) => {
      const child = childLeft ? rel.left : rel.right;
      const parent = childLeft ? rel.right : rel.left;
      return { child, parent, childCard: childLeft ? rel.leftCard : rel.rightCard, parentCard: childLeft ? rel.rightCard : rel.leftCard };
    };
    let o = orient(leftMany && !rightMany);
    if (leftMany === rightMany) {
      // 1:1 or n:m: whichever side carries the named or inferable column is the child.
      const rightHas = this.labelColumns(rel.right, words).length > 0 || !!this.inferColumn(rel.right, rel.left);
      const leftHas = this.labelColumns(rel.left, words).length > 0 || !!this.inferColumn(rel.left, rel.right);
      o = orient(leftHas && !rightHas);
    }
    for (const t of [o.child, o.parent]) {
      if (!this.tables.has(t) && !this.entities.get(t)) return `关系里的表 ${t} 不存在`;
    }
    if (leftMany && rightMany && kind !== 'json_array') {
      const cols = this.labelColumns(o.child, words);
      if (!cols.length) return `${rel.left} 和 ${rel.right} 是多对多关系：请加一张中间表，或者在关系文字里写出存 id 数组的字段并标注 json_array`;
    }

    const parentColumns = this.pkOf(o.parent);
    const base: Resolved = { ...o, kind, rel, parentColumns: parentColumns.length ? parentColumns : undefined, options: [] };
    const named = this.labelColumns(o.child, words);
    if (named.length) return { ...base, childColumns: named };
    const inferred = this.inferColumn(o.child, o.parent);
    if (inferred) return { ...base, childColumns: [inferred] };
    const marked = [...this.fkMarked(o.child)];
    const rest = this.columnsOf(o.child).filter((c) => !marked.includes(c) && !parentColumns.includes(c));
    return { ...base, options: [...marked, ...rest] };
  }

  private requirementsFor(r: Resolved, childColumns?: string[]): string[] {
    const req: string[] = [];
    for (const t of [r.child, r.parent]) if (!this.tables.has(t)) req.push(`table.add:${t}`);
    if (this.tables.has(r.child)) {
      const existing = new Set(this.tables.get(r.child)!.columns.map((c) => c.name));
      for (const c of childColumns ?? []) if (!existing.has(c)) req.push(`column.add:${r.child}.${c}`);
    }
    return req;
  }

  compareRelation(r: Resolved, matched: Set<string>): void {
    const between = this.schema.relations.filter((x) => x.from.table === r.child && x.to.table === r.parent && !matched.has(x.key));
    let existing: NRelation | undefined;
    if (r.childColumns) existing = between.find((x) => sameCols(x.from.columns, r.childColumns!));
    else if (between.length === 1) existing = between[0];
    const title = `${r.child}${r.childColumns ? `.${r.childColumns.join(',')}` : ''} → ${r.parent}`;

    if (existing) {
      matched.add(existing.key);
      const kindSame = r.kind === 'soft' ? existing.kind !== 'fk' : r.kind === existing.kind;
      const cardSame =
        r.childCard === (existing.cardinality || DEFAULT_CHILD_CARD) && r.parentCard === (existing.parentCardinality || DEFAULT_PARENT_CARD);
      if (!kindSame) {
        const kind = r.kind === 'soft' ? 'logical' : r.kind;
        this.push({
          id: `relation.kind:${existing.key}`,
          action: 'change',
          target: 'relation',
          table: r.child,
          message: `关系 ${title} 类型 ${existing.kind} → ${kind}`,
          defaultChecked: true,
          ops: [{ op: 'relation.update', key: existing.key, patch: { kind } }],
          order: ORDER.relation,
        });
      }
      if (!cardSame) {
        this.push({
          id: `relation.card:${existing.key}`,
          action: 'change',
          target: 'relation',
          table: r.child,
          message: `关系 ${title} 基数改为 ${CARD_LABEL[r.parentCard]} : ${CARD_LABEL[r.childCard]}`,
          detail: `原来是 ${CARD_LABEL[existing.parentCardinality]} : ${CARD_LABEL[existing.cardinality]}`,
          defaultChecked: true,
          ops: [{ op: 'relation.update', key: existing.key, patch: { cardinality: r.childCard, parentCardinality: r.parentCard } }],
          order: ORDER.relation,
        });
      }
      return;
    }

    const id = `relation.add:${r.child}->${r.parent}${r.childColumns ? `(${r.childColumns.join(',')})` : ''}`;
    const picked = r.childColumns ?? (this.choices[id] ? [this.choices[id]] : undefined);
    const kind: RelationKind = r.kind === 'soft' ? 'logical' : r.kind;
    const item: SyncItem = {
      id,
      action: 'add',
      target: 'relation',
      table: r.child,
      message: `新增关系 ${title}（${kind}）`,
      detail: `${CARD_LABEL[r.parentCard]} : ${CARD_LABEL[r.childCard]}，第 ${r.rel.line} 行`,
      defaultChecked: true,
      requires: this.requirementsFor(r, picked),
      order: ORDER.relation,
    };
    if (!r.childColumns) {
      item.choice = { label: `${r.child} 里哪个字段指向 ${r.parent}？`, options: r.options, value: picked?.[0] };
    }
    if (!r.parentColumns) {
      item.detail = `${r.parent} 没有主键，无法确定关系指向哪个字段`;
    } else if (picked) {
      if (picked.length !== r.parentColumns.length) {
        item.detail = `${r.child} 的字段数（${picked.length}）和 ${r.parent} 的主键字段数（${r.parentColumns.length}）不一致`;
      } else {
        item.ops = [
          {
            op: 'relation.add',
            from: { table: r.child, columns: picked },
            to: { table: r.parent, columns: r.parentColumns },
            kind,
            cardinality: r.childCard,
            parentCardinality: r.parentCard,
          },
        ];
      }
    }
    if (!item.requires?.length) delete item.requires;
    this.push(item);
  }
}

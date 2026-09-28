import { relationKey, type DesignExt, type GroupExt, type RelationExt, type RelationKind } from './model';
import type { TblsCardinality, TblsColumn, TblsConstraint, TblsRelation, TblsSchema, TblsTable } from './tbls';

export interface DesignDoc {
  schema: TblsSchema;
  ext: DesignExt;
}

export interface ColumnInput {
  name: string;
  type: string;
  nullable: boolean;
  default?: string | null;
  comment?: string;
}

export interface ColumnPatch extends Partial<ColumnInput> {
  primaryKey?: boolean;
  unique?: boolean;
}

export interface RelationEndInput {
  table: string;
  columns: string[];
}

export interface RelationPatch {
  kind?: RelationKind;
  cardinality?: TblsCardinality;
  parentCardinality?: TblsCardinality;
  discriminator?: string;
  note?: string;
}

/** Tables are addressed by their normalized key (default schema stripped), the same key the canvas uses. */
export type DesignOp =
  | { op: 'table.add'; table: string; comment?: string; withId?: boolean }
  | { op: 'table.rename'; from: string; to: string }
  | { op: 'table.update'; table: string; comment?: string }
  | { op: 'table.delete'; table: string }
  | { op: 'column.add'; table: string; column: ColumnInput; index?: number }
  | { op: 'column.update'; table: string; column: string; patch: ColumnPatch }
  | { op: 'column.move'; table: string; column: string; toIndex: number }
  | { op: 'column.delete'; table: string; column: string }
  | ({ op: 'relation.add'; from: RelationEndInput; to: RelationEndInput; kind: RelationKind } & Omit<RelationPatch, 'kind'>)
  | { op: 'relation.update'; key: string; patch: RelationPatch }
  | { op: 'relation.delete'; key: string };

export class DesignOpError extends Error {}

export function emptyExt(): DesignExt {
  return { version: 2, relations: [], modules: [] };
}

/** Accepts the stage-1 layout (`groups`, version 1) as well. */
export function parseExt(raw: unknown): DesignExt {
  const r = (raw ?? {}) as Partial<DesignExt> & { groups?: GroupExt[] };
  return {
    version: 2,
    relations: Array.isArray(r.relations) ? r.relations : [],
    modules: Array.isArray(r.modules) ? r.modules : Array.isArray(r.groups) ? r.groups : [],
  };
}

export function emptyDesignSchema(name: string, driver: string): TblsSchema {
  return { name, tables: [], relations: [], driver: { name: driver } };
}

/** Keeps only what describes the model; functions, triggers and view definitions stay in the db snapshot. */
export function designFromSnapshot(schema: TblsSchema, name?: string): TblsSchema {
  return {
    name: name ?? schema.name,
    desc: schema.desc,
    tables: schema.tables.map((t) => {
      const table: TblsTable = { name: t.name, type: t.type, columns: t.columns, indexes: t.indexes ?? [], constraints: t.constraints ?? [] };
      if (t.comment) table.comment = t.comment;
      return table;
    }),
    relations: schema.relations ?? [],
    enums: schema.enums,
    driver: schema.driver && { name: schema.driver.name, meta: { current_schema: schema.driver.meta?.current_schema } },
  };
}

export function applyDesignOps(doc: DesignDoc, ops: DesignOp[]): DesignDoc {
  const editor = new Editor(structuredClone(doc));
  for (const op of ops) {
    editor.apply(op);
  }
  return editor.doc;
}

/** Deterministic output: tables by name, relations by key, two-space indent. */
export function serializeDesign(doc: DesignDoc): { schema: string; ext: string } {
  const strip = stripper(doc.schema);
  const keyOf = (r: TblsRelation) => relationKey(strip(r.table), r.columns, strip(r.parent_table), r.parent_columns);
  const schema: TblsSchema = {
    ...doc.schema,
    tables: [...doc.schema.tables].sort((a, b) => a.name.localeCompare(b.name)),
    relations: [...(doc.schema.relations ?? [])].sort((a, b) => keyOf(a).localeCompare(keyOf(b))),
  };
  const ext: DesignExt = { ...doc.ext, relations: [...doc.ext.relations].sort((a, b) => a.key.localeCompare(b.key)) };
  return { schema: `${JSON.stringify(schema, null, 2)}\n`, ext: `${JSON.stringify(ext, null, 2)}\n` };
}

function stripper(schema: TblsSchema): (name: string) => string {
  const def = schema.driver?.meta?.current_schema;
  return (name) => (def && name.startsWith(`${def}.`) ? name.slice(def.length + 1) : name);
}

function fkDef(columns: string[], parentRaw: string, parentColumns: string[]): string {
  return `FOREIGN KEY (${columns.join(', ')}) REFERENCES ${parentRaw}(${parentColumns.join(', ')})`;
}

function idTypeFor(driver?: string): string {
  switch (driver) {
    case 'sqlite':
      return 'integer';
    case 'oracle':
      return 'number(19)';
    default:
      return 'bigint';
  }
}

function isPrimary(c: TblsConstraint): boolean {
  return c.type.toUpperCase().includes('PRIMARY');
}

function isForeign(c: TblsConstraint): boolean {
  return c.type.toUpperCase().includes('FOREIGN');
}

function isUnique(c: TblsConstraint): boolean {
  return c.type.toUpperCase().includes('UNIQUE');
}

function sameColumns(a: string[] | undefined, b: string[] | undefined): boolean {
  return !!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]);
}

class Editor {
  private readonly strip: (name: string) => string;

  constructor(readonly doc: DesignDoc) {
    doc.schema.relations ??= [];
    this.strip = stripper(doc.schema);
  }

  private get schema(): TblsSchema {
    return this.doc.schema;
  }

  private get relations(): TblsRelation[] {
    return this.doc.schema.relations!;
  }

  private get ext(): DesignExt {
    return this.doc.ext;
  }

  apply(op: DesignOp): void {
    switch (op.op) {
      case 'table.add':
        return this.addTable(op.table, op.comment, op.withId ?? true);
      case 'table.rename':
        return this.renameTable(op.from, op.to);
      case 'table.update': {
        const t = this.table(op.table);
        setOptional(t, 'comment', op.comment);
        return;
      }
      case 'table.delete':
        return this.deleteTable(op.table);
      case 'column.add':
        return this.addColumn(op.table, op.column, op.index);
      case 'column.update':
        return this.updateColumn(op.table, op.column, op.patch);
      case 'column.move': {
        const t = this.table(op.table);
        const from = t.columns.findIndex((c) => c.name === op.column);
        if (from < 0) throw new DesignOpError(`字段 ${op.table}.${op.column} 不存在`);
        const [col] = t.columns.splice(from, 1);
        t.columns.splice(Math.max(0, Math.min(op.toIndex, t.columns.length)), 0, col);
        return;
      }
      case 'column.delete':
        return this.deleteColumn(op.table, op.column);
      case 'relation.add':
        return this.addRelation(op);
      case 'relation.update':
        return this.updateRelation(op.key, op.patch);
      case 'relation.delete':
        return this.deleteRelation(op.key);
    }
  }

  // ---- lookup ----

  private findTable(key: string): TblsTable | undefined {
    return this.schema.tables.find((t) => this.strip(t.name) === key);
  }

  private table(key: string): TblsTable {
    const t = this.findTable(key);
    if (!t) throw new DesignOpError(`表 ${key} 不存在`);
    return t;
  }

  private column(t: TblsTable, name: string): TblsColumn {
    const c = t.columns.find((x) => x.name === name);
    if (!c) throw new DesignOpError(`字段 ${this.strip(t.name)}.${name} 不存在`);
    return c;
  }

  private keyOf(r: TblsRelation): string {
    return relationKey(this.strip(r.table), r.columns, this.strip(r.parent_table), r.parent_columns);
  }

  private relationIndex(key: string): number {
    const i = this.relations.findIndex((r) => this.keyOf(r) === key);
    if (i < 0) throw new DesignOpError(`关系 ${key} 不存在`);
    return i;
  }

  private rawNameFor(key: string): string {
    const def = this.schema.driver?.meta?.current_schema;
    return def && !key.includes('.') && this.schema.tables.some((t) => t.name.startsWith(`${def}.`)) ? `${def}.${key}` : key;
  }

  private uniqueConstraintName(t: TblsTable, base: string): string {
    const taken = new Set([...(t.constraints ?? []).map((c) => c.name), ...(t.indexes ?? []).map((i) => i.name)]);
    if (!taken.has(base)) return base;
    for (let i = 2; ; i++) {
      if (!taken.has(`${base}${i}`)) return `${base}${i}`;
    }
  }

  /** Runs `mutate`, then carries ext.relations over to the relations' new keys. */
  private rekey(mutate: () => void): void {
    const before = new Map(this.relations.map((r) => [r, this.keyOf(r)]));
    mutate();
    const renamed = new Map<string, string>();
    for (const r of this.relations) {
      const old = before.get(r);
      const now = this.keyOf(r);
      if (old && old !== now) renamed.set(old, now);
    }
    if (renamed.size) {
      this.ext.relations = this.ext.relations.map((e) => (renamed.has(e.key) ? { ...e, key: renamed.get(e.key)! } : e));
    }
  }

  private dropExtRelations(keys: Iterable<string>): void {
    const drop = new Set(keys);
    this.ext.relations = this.ext.relations.filter((e) => !drop.has(e.key));
  }

  private regenerateDefs(): void {
    for (const t of this.schema.tables) {
      for (const c of t.constraints ?? []) {
        if (isForeign(c) && c.referenced_table && c.columns && c.referenced_columns) {
          c.def = fkDef(c.columns, c.referenced_table, c.referenced_columns);
        } else if (isPrimary(c) && c.columns) {
          c.def = `PRIMARY KEY (${c.columns.join(', ')})`;
        } else if (isUnique(c) && c.columns) {
          c.def = `UNIQUE (${c.columns.join(', ')})`;
        }
      }
    }
    for (const r of this.relations) {
      r.def = fkDef(r.columns, r.parent_table, r.parent_columns);
    }
  }

  // ---- tables ----

  private validateName(name: string, what: string): string {
    const trimmed = name.trim();
    if (!trimmed) throw new DesignOpError(`${what}不能为空`);
    if (/\s/.test(trimmed)) throw new DesignOpError(`${what}不能包含空白字符`);
    return trimmed;
  }

  private addTable(key: string, comment: string | undefined, withId: boolean): void {
    const name = this.validateName(key, '表名');
    if (this.findTable(name)) throw new DesignOpError(`表 ${name} 已存在`);
    const raw = this.rawNameFor(name);
    const table: TblsTable = { name: raw, type: 'BASE TABLE', columns: [], indexes: [], constraints: [] };
    setOptional(table, 'comment', comment);
    if (withId) {
      table.columns.push({ name: 'id', type: idTypeFor(this.schema.driver?.name), nullable: false });
      table.constraints!.push({ name: `${name}_pkey`, type: 'PRIMARY KEY', def: 'PRIMARY KEY (id)', table: raw, columns: ['id'] });
    }
    this.schema.tables.push(table);
  }

  private renameTable(fromKey: string, toKey: string): void {
    const t = this.table(fromKey);
    const to = this.validateName(toKey, '表名');
    if (to === fromKey) return;
    if (this.findTable(to)) throw new DesignOpError(`表 ${to} 已存在`);
    const oldRaw = t.name;
    const def = this.schema.driver?.meta?.current_schema;
    const newRaw = def && oldRaw.startsWith(`${def}.`) && !to.includes('.') ? `${def}.${to}` : to;

    this.rekey(() => {
      t.name = newRaw;
      const renamePrefix = (n: string) => (n.startsWith(`${fromKey}_`) ? `${to}_${n.slice(fromKey.length + 1)}` : n);
      for (const c of t.constraints ?? []) c.name = renamePrefix(c.name);
      for (const i of t.indexes ?? []) {
        i.name = renamePrefix(i.name);
        i.def = i.def.replace(new RegExp(`(?<![\\w.])${escapeRegExp(oldRaw)}(?![\\w])`, 'g'), newRaw);
      }
      for (const other of this.schema.tables) {
        for (const c of other.constraints ?? []) {
          if (c.table === oldRaw) c.table = newRaw;
          if (c.referenced_table === oldRaw) c.referenced_table = newRaw;
        }
        for (const i of other.indexes ?? []) {
          if (i.table === oldRaw) i.table = newRaw;
        }
      }
      for (const r of this.relations) {
        if (r.table === oldRaw) r.table = newRaw;
        if (r.parent_table === oldRaw) r.parent_table = newRaw;
      }
      this.regenerateDefs();
    });
    this.ext.modules = this.ext.modules.map((m) => ({ ...m, tables: m.tables.map((x) => (x === fromKey ? to : x)) }));
  }

  private deleteTable(key: string): void {
    const t = this.table(key);
    const raw = t.name;
    const removed = this.relations.filter((r) => r.table === raw || r.parent_table === raw);
    this.dropExtRelations(removed.map((r) => this.keyOf(r)));
    this.schema.relations = this.relations.filter((r) => !removed.includes(r));
    this.schema.tables = this.schema.tables.filter((x) => x !== t);
    for (const other of this.schema.tables) {
      if (other.constraints) other.constraints = other.constraints.filter((c) => c.referenced_table !== raw);
    }
    this.ext.modules = this.ext.modules.map((m) => ({ ...m, tables: m.tables.filter((x) => x !== key) }));
  }

  // ---- columns ----

  private addColumn(key: string, input: ColumnInput, index?: number): void {
    const t = this.table(key);
    const name = this.validateName(input.name, '字段名');
    if (t.columns.some((c) => c.name === name)) throw new DesignOpError(`字段 ${key}.${name} 已存在`);
    const type = input.type.trim();
    if (!type) throw new DesignOpError('字段类型不能为空');
    const column: TblsColumn = { name, type, nullable: input.nullable };
    if (input.default !== undefined && input.default !== '') column.default = input.default;
    setOptional(column, 'comment', input.comment);
    const at = index === undefined ? t.columns.length : Math.max(0, Math.min(index, t.columns.length));
    t.columns.splice(at, 0, column);
  }

  private updateColumn(key: string, name: string, patch: ColumnPatch): void {
    const t = this.table(key);
    const col = this.column(t, name);

    if (patch.name !== undefined && patch.name.trim() !== col.name) {
      const newName = this.validateName(patch.name, '字段名');
      if (t.columns.some((c) => c.name === newName)) throw new DesignOpError(`字段 ${key}.${newName} 已存在`);
      this.renameColumn(t, col, newName);
    }
    if (patch.type !== undefined) {
      const type = patch.type.trim();
      if (!type) throw new DesignOpError('字段类型不能为空');
      col.type = type;
    }
    if (patch.nullable !== undefined) col.nullable = patch.nullable;
    if (patch.default !== undefined) {
      if (patch.default === null || patch.default === '') delete col.default;
      else col.default = patch.default;
    }
    if (patch.comment !== undefined) setOptional(col, 'comment', patch.comment);
    if (patch.primaryKey !== undefined) this.setPrimary(t, col.name, patch.primaryKey);
    if (patch.unique !== undefined) this.setUnique(t, col.name, patch.unique);

    const pk = (t.constraints ?? []).find(isPrimary);
    if (pk?.columns?.includes(col.name)) {
      if (patch.nullable === true) throw new DesignOpError('主键字段不能允许为空');
      col.nullable = false;
    }
  }

  private renameColumn(t: TblsTable, col: TblsColumn, to: string): void {
    const from = col.name;
    const raw = t.name;
    const swap = (list?: string[]) => list?.map((c) => (c === from ? to : c));
    const word = new RegExp(`\\b${escapeRegExp(from)}\\b`, 'g');
    this.rekey(() => {
      col.name = to;
      for (const c of t.constraints ?? []) c.columns = swap(c.columns);
      for (const i of t.indexes ?? []) {
        i.columns = swap(i.columns)!;
        i.def = i.def.replace(/\(([^)]*)\)/g, (m) => m.replace(word, to));
      }
      for (const other of this.schema.tables) {
        for (const c of other.constraints ?? []) {
          if (c.referenced_table === raw) c.referenced_columns = swap(c.referenced_columns);
        }
      }
      for (const r of this.relations) {
        if (r.table === raw) r.columns = swap(r.columns)!;
        if (r.parent_table === raw) r.parent_columns = swap(r.parent_columns)!;
      }
      this.regenerateDefs();
    });
  }

  private setPrimary(t: TblsTable, column: string, on: boolean): void {
    t.constraints ??= [];
    let pk = t.constraints.find(isPrimary);
    if (on) {
      if (!pk) {
        pk = { name: this.uniqueConstraintName(t, `${this.strip(t.name)}_pkey`), type: 'PRIMARY KEY', def: '', table: t.name, columns: [] };
        t.constraints.push(pk);
      }
      if (!pk.columns!.includes(column)) pk.columns = [...pk.columns!, column];
      pk.def = `PRIMARY KEY (${pk.columns!.join(', ')})`;
      return;
    }
    if (!pk?.columns?.includes(column)) return;
    pk.columns = pk.columns.filter((c) => c !== column);
    if (pk.columns.length) {
      pk.def = `PRIMARY KEY (${pk.columns.join(', ')})`;
    } else {
      const pkName = pk.name;
      t.constraints = t.constraints.filter((c) => c !== pk);
      if (t.indexes) t.indexes = t.indexes.filter((i) => i.name !== pkName);
    }
  }

  private setUnique(t: TblsTable, column: string, on: boolean): void {
    t.constraints ??= [];
    const single = (cols?: string[]) => sameColumns(cols, [column]);
    const hasUnique =
      t.constraints.some((c) => isUnique(c) && single(c.columns)) || (t.indexes ?? []).some((i) => /\bUNIQUE\b/i.test(i.def) && single(i.columns));
    if (on) {
      if (hasUnique) return;
      t.constraints.push({
        name: this.uniqueConstraintName(t, `${this.strip(t.name)}_${column}_key`),
        type: 'UNIQUE',
        def: `UNIQUE (${column})`,
        table: t.name,
        columns: [column],
      });
      return;
    }
    const dropped = new Set(t.constraints.filter((c) => isUnique(c) && single(c.columns)).map((c) => c.name));
    t.constraints = t.constraints.filter((c) => !dropped.has(c.name));
    if (t.indexes) t.indexes = t.indexes.filter((i) => !(single(i.columns) && (/\bUNIQUE\b/i.test(i.def) || dropped.has(i.name))));
  }

  private deleteColumn(key: string, name: string): void {
    const t = this.table(key);
    this.column(t, name);
    const raw = t.name;
    t.columns = t.columns.filter((c) => c.name !== name);
    if (t.constraints) t.constraints = t.constraints.filter((c) => !c.columns?.includes(name));
    if (t.indexes) t.indexes = t.indexes.filter((i) => !i.columns.includes(name));
    const removed = this.relations.filter(
      (r) => (r.table === raw && r.columns.includes(name)) || (r.parent_table === raw && r.parent_columns.includes(name)),
    );
    this.dropExtRelations(removed.map((r) => this.keyOf(r)));
    this.schema.relations = this.relations.filter((r) => !removed.includes(r));
    for (const other of this.schema.tables) {
      if (other.constraints) {
        other.constraints = other.constraints.filter((c) => !(c.referenced_table === raw && c.referenced_columns?.includes(name)));
      }
    }
  }

  // ---- relations ----

  private addRelation(op: Extract<DesignOp, { op: 'relation.add' }>): void {
    const child = this.table(op.from.table);
    const parent = this.table(op.to.table);
    if (!op.from.columns.length || op.from.columns.length !== op.to.columns.length) {
      throw new DesignOpError('关系两端的字段数量必须一致');
    }
    const childCols = op.from.columns.map((c) => this.column(child, c));
    op.to.columns.forEach((c) => this.column(parent, c));
    const key = relationKey(op.from.table, op.from.columns, op.to.table, op.to.columns);
    if (this.relations.some((r) => this.keyOf(r) === key)) throw new DesignOpError(`关系 ${key} 已存在`);

    const def = fkDef(op.from.columns, parent.name, op.to.columns);
    const relation: TblsRelation = {
      table: child.name,
      columns: [...op.from.columns],
      cardinality: op.cardinality ?? 'zero_or_more',
      parent_table: parent.name,
      parent_columns: [...op.to.columns],
      parent_cardinality: op.parentCardinality ?? (childCols.some((c) => c.nullable) ? 'zero_or_one' : 'exactly_one'),
      def,
      virtual: op.kind !== 'fk',
    };
    if (op.kind === 'fk') this.addForeignKey(child, parent, op.from.columns, op.to.columns);
    this.relations.push(relation);
    this.putExt(key, op.kind, op);
  }

  private addForeignKey(child: TblsTable, parent: TblsTable, columns: string[], parentColumns: string[]): void {
    child.constraints ??= [];
    child.constraints.push({
      name: this.uniqueConstraintName(child, `${this.strip(child.name)}_${columns.join('_')}_fkey`),
      type: 'FOREIGN KEY',
      def: fkDef(columns, parent.name, parentColumns),
      table: child.name,
      referenced_table: parent.name,
      columns: [...columns],
      referenced_columns: [...parentColumns],
    });
  }

  private removeForeignKey(r: TblsRelation): void {
    const child = this.schema.tables.find((t) => t.name === r.table);
    if (child?.constraints) {
      child.constraints = child.constraints.filter(
        (c) => !(isForeign(c) && c.referenced_table === r.parent_table && sameColumns(c.columns, r.columns) && sameColumns(c.referenced_columns, r.parent_columns)),
      );
    }
  }

  private kindOf(r: TblsRelation, key: string): RelationKind {
    return this.ext.relations.find((e) => e.key === key)?.kind ?? (r.virtual ? 'logical' : 'fk');
  }

  private putExt(key: string, kind: RelationKind, info: Omit<RelationPatch, 'kind'>): void {
    const prev = this.ext.relations.find((e) => e.key === key);
    const entry: RelationExt = { key, kind };
    const discriminator = info.discriminator !== undefined ? info.discriminator : prev?.discriminator;
    const note = info.note !== undefined ? info.note : prev?.note;
    if (kind === 'polymorphic' && discriminator) entry.discriminator = discriminator;
    if (note) entry.note = note;
    this.dropExtRelations([key]);
    // A plain foreign key needs no extension entry unless it carries a note.
    if (kind !== 'fk' || entry.note) this.ext.relations.push(entry);
  }

  private updateRelation(key: string, patch: RelationPatch): void {
    const r = this.relations[this.relationIndex(key)];
    if (patch.cardinality !== undefined) r.cardinality = patch.cardinality;
    if (patch.parentCardinality !== undefined) r.parent_cardinality = patch.parentCardinality;
    const oldKind = this.kindOf(r, key);
    const kind = patch.kind ?? oldKind;
    if (kind === 'fk' && oldKind !== 'fk') {
      const child = this.schema.tables.find((t) => t.name === r.table)!;
      const parent = this.schema.tables.find((t) => t.name === r.parent_table)!;
      this.addForeignKey(child, parent, r.columns, r.parent_columns);
      r.virtual = false;
    } else if (kind !== 'fk' && oldKind === 'fk') {
      this.removeForeignKey(r);
      r.virtual = true;
    }
    this.putExt(key, kind, patch);
  }

  private deleteRelation(key: string): void {
    const i = this.relationIndex(key);
    const r = this.relations[i];
    if (!r.virtual) this.removeForeignKey(r);
    this.relations.splice(i, 1);
    this.dropExtRelations([key]);
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function setOptional<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
    delete target[key];
  } else {
    target[key] = (typeof value === 'string' ? value.trim() : value) as T[K];
  }
}

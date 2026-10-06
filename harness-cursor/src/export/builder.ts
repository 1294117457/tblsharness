/**
 * Assembles the export tree: the design's current tables, diagrams and relations as a
 * directory an AI can read.
 *
 * Pure function: no vscode, no IO. Everything it needs is passed in, which is what makes
 * the output format testable (see `test/exportBuilder.test.ts`).
 *
 * Layout mirrors the canvas, so what the AI reads is what the user sees:
 *
 *   <root>/README.md                     entry point: overview + ER + index
 *   <root>/manifest.json                 machine-readable inventory
 *   <root>/设计表/<table>.md              one file per table
 *   <root>/设计图/<diagram>.md            one file per diagram, copied verbatim
 *   <root>/数据表/<table>.md              database tables, grouped per source
 *   <root>/<partition>/…                  the same three folders, nested
 */
import { generateErDiagram } from '../shared/mermaid/er';
import type { NRelation, NTable } from '../shared/model';
import { ROOT_SCOPE } from '../shared/canvas';
import type { DiagramType } from '../shared/diagram';
import type { ExportItem, ExportLevel } from '../shared/protocol';

/** Where the design's own tables go; database tables are split by source. */
export const DESIGN_TABLE_DIR = '设计表';
export const DIAGRAM_DIR = '设计图';
export const DB_TABLE_DIR = '数据表';
/** Items that exist in the design but were never placed on the canvas. */
export const UNGROUPED_DIR = '_未分组';

export interface ExportFile {
  /** Path relative to the export root, always with `/` separators. */
  path: string;
  content: string;
}

export interface ExportTableInput {
  item: Extract<ExportItem, { kind: 'design-table' | 'db-table' }>;
  table: NTable;
}

export interface ExportDiagramInput {
  item: Extract<ExportItem, { kind: 'diagram' }>;
  /** Raw source file text, frontmatter included; copied verbatim so it stays a valid Harness diagram. */
  raw: string;
}

export interface ExportInput {
  designName: string;
  driverLabel?: string;
  generatedAt: Date;
  levels: ExportLevel[];
  tables: ExportTableInput[];
  designRelations: NRelation[];
  /** Relations per database source id. */
  dbRelations: Map<string, NRelation[]>;
  diagrams: ExportDiagramInput[];
}

export interface ExportResult {
  files: ExportFile[];
  counts: { designTables: number; dbTables: number; diagrams: number; partitions: number };
}

/** Prefix for the unplaced bucket, kept out of the partition tree so it never collides with a partition. */
const UNGROUPED = '\u0000ungrouped';

const RELATION_KIND_LABEL: Record<NRelation['kind'], string> = {
  fk: '真实外键',
  virtual: '虚拟关系',
  logical: '逻辑关系',
  json_array: 'JSON 数组',
  polymorphic: '多态',
  dictionary: '字典',
};

/** `users` / `pgmq.meta` → `users` / `pgmq.meta.md`; illegal path characters become `_`. */
export function fileBaseName(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/^\.+/, '_')
    .replace(/[. ]+$/g, '')
    .trim();
  const safe = cleaned || '未命名';
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(safe) ? `_${safe}` : safe;
}

/** Appends `_2`, `_3`… until the name is free, so two tables never overwrite each other. */
function uniquePath(dir: string, base: string, taken: Set<string>): string {
  for (let i = 1; ; i++) {
    const name = `${dir}${base}${i === 1 ? '' : `_${i}`}.md`;
    if (!taken.has(name)) {
      taken.add(name);
      return name;
    }
  }
}

/**
 * Table cell text: a raw `|`, newline or backtick would break the row or open a code block,
 * so all three are neutralised.
 */
function cell(text: string | undefined): string {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([\\|`])/g, '\\$1')
    .replace(/\r?\n/g, '<br>');
}

function columnKeys(c: NTable['columns'][number], fk: boolean): string {
  const keys: string[] = [];
  if (c.primaryKey) keys.push('PK');
  if (fk) keys.push('FK');
  if (c.unique && !c.primaryKey) keys.push('UK');
  return keys.join(' ');
}

function columnType(c: NTable['columns'][number]): string {
  const bits = [c.rawType.trim()];
  if (c.enumValues?.length) bits.push(`enum(${c.enumValues.join('|')})`);
  return bits.join(' ');
}

/** A design table input, narrowed so `item.source` is known to exist. */
type DesignTableInput = ExportTableInput & { item: Extract<ExportItem, { kind: 'design-table' }> };
/** A database table input, narrowed so `item.source` is known to exist. */
type DbTableInput = ExportTableInput & { item: Extract<ExportItem, { kind: 'db-table' }> };

/** Tables that end up in one level, in the order they should be listed. */
interface LevelGroup {
  /** Partition id, or {@link UNGROUPED}. */
  partition: string;
  designTables: DesignTableInput[];
  dbTables: DbTableInput[];
  diagrams: ExportDiagramInput[];
}

export function buildExport(input: ExportInput): ExportResult {
  const files: ExportFile[] = [];
  const taken = new Set<string>();
  const levelOf = new Map<string, ExportLevel>();
  for (const level of input.levels) if (level.id) levelOf.set(level.id, level);

  // Levels in tree order, so parents are written before their children and the index reads top-down.
  const ordered = orderLevels(input.levels);
  const groups = new Map<string, LevelGroup>();
  const group = (partition: string): LevelGroup => {
    let g = groups.get(partition);
    if (!g) {
      g = { partition, designTables: [], dbTables: [], diagrams: [] };
      groups.set(partition, g);
    }
    return g;
  };

  // Anything the user never placed on the canvas goes to its own bucket instead of the root.
  for (const t of input.tables) {
    if (t.item.kind === 'design-table') group(bucket(t.item)).designTables.push(t as DesignTableInput);
    else group(bucket(t.item)).dbTables.push(t as DbTableInput);
  }
  for (const d of input.diagrams) group(bucket(d.item)).diagrams.push(d);

  const designKeys = new Set(input.tables.filter((t) => t.item.kind === 'design-table').map((t) => t.item.key));

  // ── Per-table files ───────────────────────────────────────────────
  // Paths are assigned in one pass and rendered in another: a table links to its neighbours
  // wherever they ended up, so every path has to be known before the first file is written.
  const fileOf = new Map<string, string>();
  for (const g of groups.values()) {
    const dir = dirPrefix(g.partition, levelOf);
    for (const t of g.designTables) fileOf.set(t.item.key, uniquePath(`${dir}${DESIGN_TABLE_DIR}/`, fileBaseName(t.item.key), taken));
    for (const t of g.dbTables) fileOf.set(`${t.item.source}/${t.item.key}`, uniquePath(`${dir}${DB_TABLE_DIR}/`, fileBaseName(t.item.key), taken));
    for (const d of g.diagrams) fileOf.set(d.item.id, uniquePath(`${dir}${DIAGRAM_DIR}/`, fileBaseName(d.item.name), taken));
  }

  for (const g of groups.values()) {
    for (const t of g.designTables) {
      files.push({ path: fileOf.get(t.item.key)!, content: tableDoc(input, t, relationsOf(input.designRelations, t.item.key), fileOf) });
    }
    for (const t of g.dbTables) {
      const rels = relationsOf(input.dbRelations.get(t.item.source) ?? [], t.item.key);
      files.push({ path: fileOf.get(`${t.item.source}/${t.item.key}`)!, content: tableDoc(input, t, rels, fileOf) });
    }
    for (const d of g.diagrams) {
      // Verbatim: the exported file is still a valid Harness diagram, so it can be pasted back.
      files.push({ path: fileOf.get(d.item.id)!, content: d.raw.endsWith('\n') ? d.raw : `${d.raw}\n` });
    }
  }

  // ── One README per level ──────────────────────────────────────────
  const readmes: ExportFile[] = [];
  for (const level of ordered) {
    const id = levelKey(level);
    const g = groups.get(id);
    // The root always gets one, even when empty: it is the entry point of the export.
    const isEntry = !level.id;
    if (!g && !isEntry && !input.levels.some((l) => l.id && l.parent === level.id)) continue;
    const prefix = dirPrefix(id, levelOf);
    readmes.push({ path: `${prefix}README.md`, content: levelDoc(input, level, g, prefix, fileOf, levelOf) });
  }
  // The unplaced bucket is not a canvas level, but it still needs an entry point.
  if (groups.has(UNGROUPED)) {
    readmes.push({
      path: `${UNGROUPED_DIR}/README.md`,
      content: levelDoc(input, { id: UNGROUPED, name: '未分组', description: '没有摆在画布上的内容', depth: 1 }, groups.get(UNGROUPED), `${UNGROUPED_DIR}/`, fileOf, levelOf),
    });
  }
  files.push(...readmes);

  files.push({ path: 'manifest.json', content: manifest(input, fileOf) });

  return {
    // Sorted per path segment so the order is stable across machines and easy to scan:
    // the entry README first, then a level's own folder before its subfolders.
    files: files.sort((a, b) => comparePaths(a.path, b.path)),
    counts: {
      designTables: designKeys.size,
      dbTables: input.tables.length - designKeys.size,
      diagrams: input.diagrams.length,
      partitions: input.levels.filter((l) => l.id).length,
    },
  };

  function bucket(item: { partition?: string; onCanvas: boolean }): string {
    return item.onCanvas ? (item.partition ?? ROOT_SCOPE) : UNGROUPED;
  }

  function dirPrefix(partition: string, levels: Map<string, ExportLevel>): string {
    if (partition === UNGROUPED) return `${UNGROUPED_DIR}/`;
    if (partition === ROOT_SCOPE) return '';
    const chain: string[] = [];
    const seen = new Set<string>();
    for (let id: string | undefined = partition; id; id = levels.get(id)?.parent) {
      if (seen.has(id)) break;
      seen.add(id);
      chain.unshift(id);
    }
    // Nested partitions that vanished from the layout still need a home for their contents.
    if (!chain.length) chain.push(partition);
    return `${chain.map((id) => `${fileBaseName(levels.get(id)?.name ?? id)}/`).join('')}`;
  }
}

/** The root level is the one without an id; inside the builder it is keyed by {@link ROOT_SCOPE}. */
function levelKey(level: ExportLevel): string {
  return level.id ?? ROOT_SCOPE;
}

/** Markdown link target. `encodeURI` would percent-encode Chinese, which reads badly in a file. */
function linkName(name: string): string {
  return name.replace(/([ ()<>])/g, (m) => `%${m.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Compares path segment by segment, so a directory always precedes what is inside it. */
function comparePaths(a: string, b: string): number {
  const as = a.split('/');
  const bs = b.split('/');
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    const x = as[i];
    const y = bs[i];
    // A path that ends here is a file/dir itself, so it comes before the longer one.
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** Every level, parents first; the root first of all. */
function orderLevels(levels: ExportLevel[]): ExportLevel[] {
  const byParent = new Map<string | undefined, ExportLevel[]>();
  for (const l of levels) {
    const key = l.id ? l.parent : undefined;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(l);
  }
  const out: ExportLevel[] = [];
  const seen = new Set<ExportLevel>();
  const walk = (parent: string | undefined, depth: number): void => {
    for (const l of byParent.get(parent) ?? []) {
      if (seen.has(l)) continue;
      seen.add(l);
      out.push({ ...l, depth });
      // The root has no id, so recursing on it would find the root again.
      if (l.id) walk(l.id, depth + 1);
    }
  };
  walk(undefined, 0);
  // A partition whose parent is missing (hand-edited layout) still needs a README.
  for (const l of levels) {
    if (!seen.has(l)) out.push({ ...l, depth: 0 });
  }
  return out;
}

function relationsOf(relations: NRelation[], key: string): NRelation[] {
  return relations.filter((r) => r.from.table === key || r.to.table === key);
}

/** One table as Markdown. Tables, not Mermaid: Mermaid drops nullable, defaults, indexes and enum values. */
function tableDoc(input: ExportInput, t: ExportTableInput, relations: NRelation[], fileOf: Map<string, string>): string {
  const { item, table } = t;
  const isDb = item.kind === 'db-table';
  const out: string[] = [`# ${item.key}`, ''];

  if (item.rawName && item.rawName !== item.key) out.push(`真实表名：\`${item.rawName}\``, '');
  if (table.comment?.trim()) out.push(cell(table.comment.trim()), '');
  out.push(`来源：${isDb ? `数据表 · 数据源 ${item.source}` : `设计表 · ${input.designName}`}`, '');

  const fkColumns = new Set(relations.filter((r) => r.kind === 'fk').flatMap((r) => r.from.columns.map((c) => `${r.from.table}.${c}`)));
  out.push('| 字段 | 类型 | 键 | 可空 | 默认值 | 说明 |', '| --- | --- | --- | --- | --- | --- |');
  for (const c of table.columns) {
    const keys = columnKeys(c, fkColumns.has(`${item.key}.${c.name}`));
    out.push(`| ${cell(c.name)} | ${cell(columnType(c))} | ${keys} | ${c.nullable ? '是' : '否'} | ${cell(c.default ?? '')} | ${cell(c.comment)} |`);
  }
  out.push('');

  if (relations.length) {
    out.push('## 关系', '');
    for (const r of relations) {
      const mine = r.from.table === item.key;
      const other = mine ? r.to.table : r.from.table;
      const cols = (mine ? r.from.columns : r.to.columns).join(', ');
      const otherCols = (mine ? r.to.columns : r.from.columns).join(', ');
      out.push(`- \`${item.key}.${cols}\` → \`${other}.${otherCols}\`（${RELATION_KIND_LABEL[r.kind]}）`);
    }
    out.push('');
  }

  const related = relations
    .map((r) => (r.from.table === item.key ? r.to.table : r.from.table))
    .filter((k) => k !== item.key)
    .filter((k, i, a) => a.indexOf(k) === i);
  const links = related
    .map((k) => {
      const path = fileOf.get(k);
      return path ? `- [${k}](${relativeTo(path, tablePath(fileOf, t))})` : `- ${k}（不在本次导出中）`;
    })
    .filter(Boolean);
  if (links.length) {
    out.push('## 相关表', '', ...links, '');
  }
  return `${out.join('\n')}\n`;
}

/** The table's own path, needed to make links relative. */
function tablePath(fileOf: Map<string, string>, t: ExportTableInput): string {
  const id = t.item.kind === 'db-table' ? `${t.item.source}/${t.item.key}` : t.item.key;
  return fileOf.get(id) ?? '';
}

/** Markdown link from one exported file to another; falls back to the bare name across levels. */
function relativeTo(target: string, from: string): string {
  const a = target.split('/').slice(0, -1);
  const b = from.split('/').slice(0, -1);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return `${'../'.repeat(b.length - i)}${target.split('/').slice(i).join('/')}`;
}

/**
 * A level's README: the entry point for an AI reading this level.
 *
 * The ER diagram keeps every relation that touches this level, even when the other end lives
 * elsewhere: `generateErDiagram` drops relations whose ends are both required to be present,
 * which would silently lose a cross-partition relation. The other end is added as a bare
 * table name, which the Mermaid ER grammar reads as "referenced, columns not described".
 */
function levelDoc(
  input: ExportInput,
  level: ExportLevel,
  g: LevelGroup | undefined,
  prefix: string,
  fileOf: Map<string, string>,
  levels: Map<string, ExportLevel>,
): string {
  const isRoot = !level.id || level.id === ROOT_SCOPE;
  const ungrouped = input.tables.filter((t) => !t.item.onCanvas).length + input.diagrams.filter((d) => !d.item.onCanvas).length;
  const out: string[] = [`# ${level.name}`, ''];
  if (level.description?.trim()) out.push(level.description.trim().replace(/\r?\n/g, ' '), '');
  out.push(
    isRoot
      ? `${input.designName} 的根画布。目标数据库：${input.driverLabel ?? '未指定'}。`
      : `${input.designName} 的一个分区画布。`,
    '',
  );
  out.push('本文件由 Harness 导出，只包含数据模型，不含任何数据库连接信息。', '');

  const designTables = g?.designTables ?? [];
  const dbTables = g?.dbTables ?? [];
  const diagrams = g?.diagrams ?? [];
  // Compare on the key: the root's `id` is undefined and would otherwise match itself.
  const children = input.levels.filter((l) => !!l.id && l.parent === level.id);
  const ungroupedHere = g?.partition === UNGROUPED;

  const erSections: { title: string; er: string }[] = [];
  if (designTables.length) {
    const er = levelEr(
      designTables.map((t) => t.table),
      input.designRelations,
      designTables.map((t) => t.item.key),
    );
    if (er) erSections.push({ title: '设计表', er });
  }
  // Relations of database tables stay in their own source: mixing them would draw foreign
  // keys that do not exist between a database and the design.
  for (const source of [...new Set(dbTables.map((t) => (t.item.kind === 'db-table' ? t.item.source : '')))]) {
    const tables = dbTables.filter((t) => t.item.kind === 'db-table' && t.item.source === source);
    const er = levelEr(
      tables.map((t) => t.table),
      input.dbRelations.get(source) ?? [],
      tables.map((t) => t.item.key),
    );
    if (er) erSections.push({ title: `数据表 · 数据源 ${source}`, er });
  }
  for (const { title, er } of erSections) {
    out.push(`## ${title} ER 图`, '', '```mermaid', er, '```', '');
  }
  // Say it once, and only when a stub was actually emitted.
  if (erSections.some(({ er }) => BARE_STUB.test(er))) {
    out.push('> ER 图里只写表名、不写 `{ }` 的表表示「只引用，不改字段」：它在别的画布里，不在本次范围内。', '');
  }

  const link = (path: string | undefined, label: string, hint?: string): string =>
    path ? `- [${label}](${relativeTo(path, `${prefix}README.md`)})${hint ? ` — ${hint}` : ''}` : `- ${label}`;

  if (designTables.length) {
    out.push(`**设计表（${designTables.length}）**`, '');
    for (const t of designTables) {
      out.push(link(fileOf.get(t.item.key), t.item.key, t.table.comment?.trim().split(/\r?\n/)[0] || `${t.table.columns.length} 字段`));
    }
    out.push('');
  }
  if (dbTables.length) {
    out.push(`**数据表（${dbTables.length}）**`, '');
    for (const t of dbTables) {
      const source = t.item.kind === 'db-table' ? t.item.source : '';
      out.push(link(fileOf.get(`${source}/${t.item.key}`), t.item.key, `${source} · ${t.table.comment?.trim().split(/\r?\n/)[0] || `${t.table.columns.length} 字段`}`));
    }
    out.push('');
  }
  if (diagrams.length) {
    out.push(`**设计图（${diagrams.length}）**`, '');
    for (const d of diagrams) out.push(link(fileOf.get(d.item.id), d.item.name, typeLabel(d.item.type)));
    out.push('');
  }
  if (ungroupedHere) out.push('> 这些内容存在于设计中，但没有摆在画布上，所以单独放一个目录。', '');
  if (!designTables.length && !dbTables.length && !diagrams.length && !children.length) {
    out.push('_这一层没有内容。_', '');
  }
  if (children.length) {
    out.push(`**子分区（${children.length}）**`, '');
    for (const c of children) {
      const name = fileBaseName(levels.get(c.id ?? '')?.name ?? c.id ?? '');
      out.push(`- [${c.name}](${linkName(name)}/) — ${c.description?.trim() || '子分区画布'}`);
    }
    out.push('');
  }
  // The root is where a reader starts, so it points at the unplaced bucket when there is one.
  if (isRoot && ungrouped) {
    out.push(`**未分组（${ungrouped}）**`, '', `- [${UNGROUPED_DIR}/](${linkName(UNGROUPED_DIR)}/) — 存在于设计中但没有摆在画布上`, '');
  }
  return `${out.join('\n')}\n`;
}

/**
 * ER for one group of tables, keeping the relations that reach outside the group.
 *
 * `generateErDiagram` only emits a relation when both ends are in the table list, so the far
 * end of every relation is added as a placeholder table. `generateErDiagram` writes a `{ }`
 * block even for a table with no columns, and that block would read as "this table has no
 * fields" — the opposite of the intent — so empty blocks are turned back into a bare name.
 * A bare name is the Mermaid ER form for "referenced, columns not described"
 * (`ErEntity.hasBody` is false), which is what the spec tells the AI it means.
 */
/** A bare entity line in a generated ER block: a table referenced but not described. `}` must not match. */
const BARE_STUB = /^ {2}(?:"[^"]+"|[^\s{}[\]|"]+?)(?:\["[^"]*"\])?$/m;

function levelEr(tables: NTable[], relations: NRelation[], keys: string[]): string | undefined {
  const included = new Set(keys);
  const known = new Map(tables.map((t) => [t.key, t]));
  const extra: string[] = [];
  for (const r of relations) {
    if (!included.has(r.from.table) && !included.has(r.to.table)) continue;
    for (const end of [r.from.table, r.to.table]) {
      if (included.has(end) || known.has(end) || extra.includes(end)) continue;
      extra.push(end);
    }
  }
  const all = [...tables, ...extra.map((key) => ({ key, rawName: key, type: '', columns: [], indexes: [] }) satisfies NTable)];
  const er = generateErDiagram({ source: 'design', name: '', tables: all, relations, enums: [] }, all.map((t) => t.key));
  if (er === 'erDiagram') return undefined;
  // `  orders {` on one line and `  }` on the next is the empty block; both go, leaving the name.
  return er.replace(/^(\s*)("[^"]+"|\S+?)(?:\["[^"]*"\])? \{[ \t]*\r?\n\1\}[ \t]*\r?\n/gm, '$1$2\n');
}

function typeLabel(type: DiagramType): string {
  return { er: 'ER 图', state: '状态图', sequence: '时序图', flow: '流程图', dataflow: '数据流图' }[type];
}

function manifest(input: ExportInput, fileOf: Map<string, string>): string {
  const items = [
    ...input.tables.map((t) => ({
      kind: t.item.kind,
      key: t.item.key,
      rawName: t.item.rawName,
      ...(t.item.kind === 'db-table' ? { source: t.item.source } : {}),
      partition: t.item.onCanvas ? (t.item.partition ?? null) : UNGROUPED_DIR,
      file: fileOf.get(t.item.kind === 'db-table' ? `${t.item.source}/${t.item.key}` : t.item.key),
      columns: t.table.columns.length,
    })),
    ...input.diagrams.map((d) => ({
      kind: d.item.kind,
      id: d.item.id,
      name: d.item.name,
      type: d.item.type,
      partition: d.item.onCanvas ? (d.item.partition ?? null) : UNGROUPED_DIR,
      file: fileOf.get(d.item.id),
    })),
  ];
  const value = {
    version: 1,
    generatedAt: input.generatedAt.toISOString(),
    design: { name: input.designName, driver: input.driverLabel },
    counts: {
      designTables: items.filter((i) => i.kind === 'design-table').length,
      dbTables: items.filter((i) => i.kind === 'db-table').length,
      diagrams: items.filter((i) => i.kind === 'diagram').length,
      partitions: input.levels.filter((l) => l.id).length,
    },
    levels: input.levels.map((l) => ({ id: l.id ?? null, name: l.name, parent: l.parent ?? null, depth: l.depth })),
    // Only source ids here, never a database name: the export must not carry connection details.
    items,
  };
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Copy / cut / paste inside one design, like files in Windows Explorer:
 * cut moves items between levels, copy creates independent tables, diagrams and partitions.
 * Pure planning only; the host writes files and records undo.
 */
import {
  applyCanvasEdit,
  DESIGN_SOURCE,
  nextPartitionId,
  nodeId,
  parseNodeId,
  partitionOf,
  partitionSubtree,
  type CanvasDiagram,
  type CanvasEdit,
  type CanvasFile,
  type CanvasPartition,
  type ItemRef,
  type MoveItem,
} from './canvas';
import type { DesignOp } from './designOps';
import type { NormalizedSchema, NTable } from './model';
import { copyNamespace, effectiveNamespace, landingName, qualify, shortName } from './namespace';

export type ClipboardMode = 'copy' | 'cut';

export interface ClipboardData {
  workspace: string;
  design: string;
  mode: ClipboardMode;
  items: ItemRef[];
}

export interface Position {
  x: number;
  y: number;
}

export interface PasteContext {
  canvas: CanvasFile;
  schema: NormalizedSchema;
  /** Target partition; `undefined` for the root canvas. */
  target: string | undefined;
  /** Where the top-left of the pasted block should land, relative to the target frame. */
  at?: Position;
  /** Positions of items without a layout entry (design tables and diagrams shown implicitly). */
  positions?: Record<string, Position>;
  /** Snapshots of the databases whose tables are being copied; those tables become design tables. */
  dbSchemas?: Record<string, NormalizedSchema>;
}

export class ClipboardError extends Error {}

export const itemKey = (ref: ItemRef) => `${ref.kind}:${ref.id}`;

/** Drops items that are already covered because a partition containing them is selected too. */
export function topLevelItems(canvas: CanvasFile, items: ItemRef[]): ItemRef[] {
  const selectedParts = items.filter((i) => i.kind === 'partition').map((i) => i.id);
  const covered = new Set<string>();
  for (const id of selectedParts) for (const p of partitionSubtree(canvas, id)) if (p !== id) covered.add(p);
  const seen = new Set<string>();
  return items.filter((i) => {
    const key = itemKey(i);
    if (seen.has(key)) return false;
    seen.add(key);
    if (i.kind === 'partition' && covered.has(i.id)) return false;
    const home = partitionOf(canvas, i);
    if (home && (covered.has(home) || selectedParts.includes(home))) return false;
    return exists(canvas, i);
  });
}

function exists(canvas: CanvasFile, ref: ItemRef): boolean {
  if (ref.kind === 'partition') return canvas.partitions.some((p) => p.id === ref.id);
  if (ref.kind === 'note') return canvas.notes.some((n) => n.id === ref.id);
  return true;
}

function positionOf(ctx: PasteContext, ref: ItemRef): Position {
  const c = ctx.canvas;
  const found =
    ref.kind === 'table'
      ? c.nodes.find((n) => nodeId(n.source, n.table) === ref.id)
      : ref.kind === 'diagram'
        ? c.diagrams.find((d) => d.id === ref.id)
        : ref.kind === 'note'
          ? c.notes.find((n) => n.id === ref.id)
          : c.partitions.find((p) => p.id === ref.id);
  return found ? { x: found.x, y: found.y } : (ctx.positions?.[itemKey(ref)] ?? { x: 0, y: 0 });
}

function shiftFor(ctx: PasteContext, top: ItemRef[], sameLevel: boolean): Position {
  const points = top.map((r) => positionOf(ctx, r));
  if (!points.length) return { x: 0, y: 0 };
  const minX = Math.min(...points.map((p) => p.x));
  const minY = Math.min(...points.map((p) => p.y));
  if (ctx.at) return { x: ctx.at.x - minX, y: ctx.at.y - minY };
  return sameLevel ? { x: 40, y: 40 } : { x: 0, y: 0 };
}

function assertTarget(ctx: PasteContext, top: ItemRef[], verb: string): void {
  if (ctx.target && !ctx.canvas.partitions.some((p) => p.id === ctx.target)) throw new ClipboardError('目标分区画布不存在');
  for (const r of top) {
    if (r.kind === 'partition' && ctx.target && partitionSubtree(ctx.canvas, r.id).has(ctx.target)) {
      throw new ClipboardError(`不能把分区画布${verb}到它自己或它的子分区里`);
    }
  }
}

export interface DiagramCopy {
  from: string;
  /** Top-level copies get "副本" appended to their name. */
  renamed: boolean;
  placement: Omit<CanvasDiagram, 'id'>;
}

export interface CopyPlan {
  ops: DesignOp[];
  /** Layout changes; the host appends `diagrams.put` once the copied diagram files have IDs. */
  edit: CanvasEdit;
  /** Original design table -> its copy. */
  tables: Map<string, string>;
  /** Selected database table (node ID) -> the design table created from it. */
  fromDb: Map<string, string>;
  diagrams: DiagramCopy[];
  /** Database tables inside copied partitions (or without a snapshot) are not copied. */
  skippedDb: string[];
  partitions: string[];
}

export function planCopy(ctx: PasteContext, items: ItemRef[]): CopyPlan {
  const { canvas, schema } = ctx;
  const top = topLevelItems(canvas, items);
  assertTarget(ctx, top, '复制');
  const shift = shiftFor(ctx, top, top.every((r) => partitionOf(canvas, r) === ctx.target));
  const topKeys = new Set(top.map(itemKey));

  // 1. Partitions, parents first so namespaces resolve on the partially built layout.
  const partMap = new Map<string, string>();
  const newPartitions: CanvasPartition[] = [];
  const usedNamespaces = new Set(canvas.partitions.map((p) => p.namespace?.value).filter((v): v is string => !!v));
  let seqCanvas = canvas;
  const queue = top.filter((r) => r.kind === 'partition').map((r) => r.id);
  while (queue.length) {
    const id = queue.shift()!;
    const src = canvas.partitions.find((p) => p.id === id)!;
    const isTop = topKeys.has(itemKey({ kind: 'partition', id }));
    const newId = nextPartitionId(seqCanvas);
    partMap.set(id, newId);
    const copy: CanvasPartition = {
      ...src,
      id: newId,
      name: isTop ? `${src.name} 副本` : src.name,
      parent: isTop ? ctx.target : partMap.get(src.parent!),
      x: isTop ? src.x + shift.x : src.x,
      y: isTop ? src.y + shift.y : src.y,
    };
    if (src.namespace) {
      copy.namespace = copyNamespace(src.namespace, usedNamespaces);
      usedNamespaces.add(copy.namespace.value);
    }
    if (!copy.parent) delete copy.parent;
    newPartitions.push(copy);
    seqCanvas = { ...seqCanvas, seq: Number(newId.slice(4)), partitions: [...seqCanvas.partitions, copy] };
    for (const child of canvas.partitions) if (child.parent === id) queue.push(child.id);
  }
  const edit: CanvasEdit = newPartitions.map((p) => ({ op: 'partition.put', partition: p }));
  const withParts = applyCanvasEdit(canvas, edit);

  const destOf = (ref: ItemRef): string | undefined => {
    if (topKeys.has(itemKey(ref))) return ctx.target;
    const home = partitionOf(canvas, ref);
    return home ? partMap.get(home) : undefined;
  };
  const inCopied = (home: string | undefined) => !!home && partMap.has(home);

  // 2. Tables: top-level ones plus everything inside copied partitions.
  const tableRefs: ItemRef[] = top.filter((r) => r.kind === 'table');
  for (const n of canvas.nodes) {
    if (inCopied(n.partition)) tableRefs.push({ kind: 'table', id: nodeId(n.source, n.table) });
  }
  const byKey = new Map(schema.tables.map((t) => [t.key, t]));
  const takenReal = new Set(schema.tables.map((t) => t.key));
  const takenShortAt = new Map<string, Set<string>>();
  const shortsAt = (level: string | undefined) => {
    const key = level ?? '';
    let set = takenShortAt.get(key);
    if (!set) {
      const ns = effectiveNamespace(withParts, level);
      set = new Set(levelTables(withParts, schema, level).map((t) => shortName(ns, t)));
      takenShortAt.set(key, set);
    }
    return set;
  };

  const tables = new Map<string, string>();
  const fromDb = new Map<string, string>();
  const skippedDb: string[] = [];
  const nodes: CanvasFile['nodes'] = [];
  const copiedTables: { table: NTable; to: string }[] = [];
  for (const ref of tableRefs) {
    const { source, table } = parseNodeId(ref.id);
    if (source !== DESIGN_SOURCE) {
      const t = topKeys.has(itemKey(ref)) ? ctx.dbSchemas?.[source]?.tables.find((x) => x.key === table) : undefined;
      if (!t) {
        skippedDb.push(ref.id);
        continue;
      }
      if (fromDb.has(ref.id)) continue;
      const dstNs = effectiveNamespace(withParts, ctx.target);
      const shorts = shortsAt(ctx.target);
      const to = landingName(table, dstNs, takenReal, shorts);
      takenReal.add(to);
      shorts.add(shortName(dstNs, to));
      fromDb.set(ref.id, to);
      copiedTables.push({ table: t, to });
      const p = positionOf(ctx, ref);
      nodes.push({ source: DESIGN_SOURCE, table: to, x: p.x + shift.x, y: p.y + shift.y, partition: ctx.target });
      continue;
    }
    const t = byKey.get(table);
    if (!t || tables.has(table)) continue;
    const dest = destOf(ref);
    const srcNs = effectiveNamespace(canvas, partitionOf(canvas, ref));
    const dstNs = effectiveNamespace(withParts, dest);
    const shorts = shortsAt(dest);
    const to = landingName(shortName(srcNs, table), dstNs, takenReal, shorts);
    takenReal.add(to);
    shorts.add(shortName(dstNs, to));
    tables.set(table, to);
    copiedTables.push({ table: t, to });
    const entry = canvas.nodes.find((n) => nodeId(n.source, n.table) === ref.id);
    const p = positionOf(ctx, ref);
    const isTop = topKeys.has(itemKey(ref));
    nodes.push({ source: DESIGN_SOURCE, table: to, x: isTop ? p.x + shift.x : p.x, y: isTop ? p.y + shift.y : p.y, display: entry?.display, partition: dest });
  }

  const ops: DesignOp[] = [];
  for (const { table, to } of copiedTables) ops.push(...tableOps(table, to));
  for (const r of schema.relations) {
    const from = tables.get(r.from.table);
    if (from) ops.push(relationOp(r, from, tables.get(r.to.table) ?? r.to.table));
  }
  // Relations between database tables copied together; links to tables left behind in the database are dropped.
  for (const [source, db] of Object.entries(ctx.dbSchemas ?? {})) {
    for (const r of db.relations) {
      const from = fromDb.get(nodeId(source, r.from.table));
      const to = fromDb.get(nodeId(source, r.to.table));
      if (from && to) ops.push(relationOp(r, from, to));
    }
  }
  if (nodes.length) edit.push({ op: 'nodes.put', nodes });

  // 3. Diagrams and notes.
  const diagramRefs: ItemRef[] = top.filter((r) => r.kind === 'diagram');
  for (const d of canvas.diagrams) if (inCopied(d.partition)) diagramRefs.push({ kind: 'diagram', id: d.id });
  const diagrams: DiagramCopy[] = diagramRefs.map((ref) => {
    const entry = canvas.diagrams.find((d) => d.id === ref.id);
    const p = positionOf(ctx, ref);
    const isTop = topKeys.has(itemKey(ref));
    return {
      from: ref.id,
      renamed: isTop,
      placement: {
        x: isTop ? p.x + shift.x : p.x,
        y: isTop ? p.y + shift.y : p.y,
        width: entry?.width ?? 360,
        height: entry?.height ?? 240,
        partition: destOf(ref),
      },
    };
  });

  let noteSeq = 0;
  const stamp = Date.now().toString(36);
  for (const n of canvas.notes) {
    const ref: ItemRef = { kind: 'note', id: n.id };
    const isTop = topKeys.has(itemKey(ref));
    if (!isTop && !inCopied(n.partition)) continue;
    edit.push({
      op: 'note.put',
      note: { ...n, id: `n${stamp}${noteSeq++}`, x: isTop ? n.x + shift.x : n.x, y: isTop ? n.y + shift.y : n.y, partition: destOf(ref) },
    });
  }

  return { ops, edit, tables, fromDb, diagrams, skippedDb, partitions: newPartitions.map((p) => p.id) };
}

function relationOp(r: NormalizedSchema['relations'][number], from: string, to: string): DesignOp {
  const op: DesignOp = { op: 'relation.add', from: { table: from, columns: r.from.columns }, to: { table: to, columns: r.to.columns }, kind: r.kind };
  if (r.cardinality) op.cardinality = r.cardinality;
  if (r.parentCardinality) op.parentCardinality = r.parentCardinality;
  if (r.discriminator) op.discriminator = r.discriminator;
  if (r.note) op.note = r.note;
  return op;
}

/** Design tables shown at a level (implicit tables without a layout entry sit at the root). */
export function levelTables(canvas: CanvasFile, schema: NormalizedSchema, level: string | undefined): string[] {
  const placed = new Map(canvas.nodes.filter((n) => n.source === DESIGN_SOURCE).map((n) => [n.table, n.partition]));
  return schema.tables.map((t) => t.key).filter((k) => placed.get(k) === level);
}

function tableOps(t: NTable, name: string): DesignOp[] {
  const ops: DesignOp[] = [{ op: 'table.add', table: name, comment: t.comment, withId: false }];
  for (const c of t.columns) {
    const column: Extract<DesignOp, { op: 'column.add' }>['column'] = { name: c.name, type: c.rawType, nullable: c.nullable };
    if (c.default !== undefined && c.default !== null) column.default = c.default;
    if (c.comment) column.comment = c.comment;
    ops.push({ op: 'column.add', table: name, column });
  }
  const pks = t.columns.filter((c) => c.primaryKey);
  for (const c of pks) ops.push({ op: 'column.update', table: name, column: c.name, patch: { primaryKey: true } });
  for (const c of t.columns) {
    if (c.unique && !(pks.length === 1 && pks[0].name === c.name)) ops.push({ op: 'column.update', table: name, column: c.name, patch: { unique: true } });
  }
  return ops;
}

export interface CutPlan {
  edit: CanvasEdit;
  /** Design tables whose namespace changes with the move; renamed only when the user agrees. */
  renames: { from: string; to: string }[];
}

/** Moves items to the target level. With `rename`, tables adopt the target namespace and the edit uses the new names. */
export function planCut(ctx: PasteContext, items: ItemRef[], rename: boolean): CutPlan {
  const { canvas, schema } = ctx;
  if (items.some((r) => r.kind === 'table' && parseNodeId(r.id).source !== DESIGN_SOURCE)) {
    throw new ClipboardError('数据库表只能复制（粘贴后成为设计表），不能剪切');
  }
  const top = topLevelItems(canvas, items).filter((r) => partitionOf(canvas, r) !== ctx.target || !!ctx.at);
  assertTarget(ctx, top, '移动');
  const shift = shiftFor(ctx, top, false);
  const moves: MoveItem[] = top.map((r) => {
    const p = positionOf(ctx, r);
    return { ...r, partition: ctx.target ?? null, x: p.x + shift.x, y: p.y + shift.y };
  });
  const moved = applyCanvasEdit(canvas, [{ op: 'move', items: moves }]);

  const affected = new Set<string>();
  for (const r of top) {
    if (r.kind === 'table' && parseNodeId(r.id).source === DESIGN_SOURCE) affected.add(parseNodeId(r.id).table);
    if (r.kind === 'partition') {
      const sub = partitionSubtree(canvas, r.id);
      for (const n of canvas.nodes) if (n.source === DESIGN_SOURCE && n.partition && sub.has(n.partition)) affected.add(n.table);
    }
  }
  const known = new Set(schema.tables.map((t) => t.key));
  const takenReal = new Set(known);
  const renames: { from: string; to: string }[] = [];
  for (const table of affected) {
    if (!known.has(table)) continue;
    const ref: ItemRef = { kind: 'table', id: nodeId(DESIGN_SOURCE, table) };
    const before = effectiveNamespace(canvas, partitionOf(canvas, ref));
    const after = effectiveNamespace(moved, partitionOf(moved, ref));
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    const short = shortName(before, table);
    if (qualify(after, short) === table) continue;
    takenReal.delete(table);
    const to = landingName(short, after, takenReal, new Set());
    takenReal.add(to);
    if (to !== table) renames.push({ from: table, to });
  }

  if (!rename || !renames.length) return { edit: [{ op: 'move', items: moves }], renames };
  const map = new Map(renames.map((r) => [nodeId(DESIGN_SOURCE, r.from), nodeId(DESIGN_SOURCE, r.to)]));
  return { edit: [{ op: 'move', items: moves.map((m) => (m.kind === 'table' && map.has(m.id) ? { ...m, id: map.get(m.id)! } : m)) }], renames };
}

/**
 * Stand-in for the extension host when the webview runs in a normal browser (`npm run dev:webview`).
 * Only loaded in dev builds outside VS Code; it keeps everything in memory.
 */
import {
  applyCanvasEdit,
  DESIGN_SOURCE,
  DIAGRAM_CARD_SIZE,
  emptyCanvas,
  partitionContents,
  removeDiagramFromCanvas,
  renameTableInCanvas,
  type CanvasEdit,
  type CanvasFile,
} from '@shared/canvas';
import { applyDesignOps, DesignOpError, type DesignDoc, type DesignOp } from '@shared/designOps';
import { DIAGRAM_TYPES } from '@shared/diagram';
import type { ComparisonData, DesignContext, DiagramData, HostMessage, SourceData, WebviewMessage, WorkspaceCatalog } from '@shared/protocol';
import type { TblsSchema } from '@shared/tbls';
import { diffSchemas } from '../../../src/diff/diff';
import { normalize } from '../../../src/model/normalize';
import { exampleDb, exampleDesign } from './fixtures';

const designDoc: DesignDoc = exampleDesign();
const designName = '商城设计';
const dbs: Record<string, { name: string; schema?: TblsSchema }> = {
  db1: { name: 'db.example.test:5432/shop', schema: exampleDb() },
  db2: { name: 'localhost:5432/staging' },
};
const accepted = new Set<string>();

const diagrams: DiagramData[] = [
  { id: 'diagram1', name: '订单状态', type: 'state', code: 'stateDiagram-v2\n  [*] --> 待支付\n  待支付 --> 已支付\n  已支付 --> 已完成\n  待支付 --> 已取消' },
];

let canvas: CanvasFile = {
  ...emptyCanvas(),
  seq: 1,
  partitions: [{ id: 'part1', name: '支付', x: 700, y: 0, namespace: { kind: 'prefix', value: 'pay_' } }],
  nodes: [
    { source: 'db1', table: 'users', x: 0, y: 420 },
    { source: 'db1', table: 'audit_logs', x: 320, y: 420 },
  ],
};

function send(msg: HostMessage) {
  setTimeout(() => window.postMessage(msg, '*'), 30);
}

function reply(requestId: string, error?: string) {
  send({ type: 'reply', requestId, ok: !error, error });
}

function designSourceData(): SourceData {
  return {
    source: DESIGN_SOURCE,
    name: designName,
    schema: normalize(designDoc.schema, { source: 'design', ext: designDoc.ext }),
  };
}

function dbSourceData(dbId: string): SourceData | undefined {
  const db = dbs[dbId];
  if (!db) return undefined;
  return {
    source: dbId,
    name: db.name,
    schema: db.schema && normalize(db.schema, { source: 'db' }),
    snapshot: db.schema ? { file: '2026-01-01T00-00-00-000Z.json', takenAt: '2026-01-01T00:00:00.000Z' } : undefined,
  };
}

function allSources(): SourceData[] {
  const result: SourceData[] = [designSourceData()];
  const dbIds = new Set(canvas.nodes.map((n) => n.source).filter((s) => s !== DESIGN_SOURCE));
  for (const id of dbIds) {
    const d = dbSourceData(id);
    if (d) result.push(d);
  }
  return result;
}

function comparison(): ComparisonData | undefined {
  const c = canvas.comparison;
  if (!c) return undefined;
  const design = designSourceData().schema;
  const db = dbSourceData(c.db)?.schema;
  if (!design || !db) return undefined;
  return { diff: diffSchemas(design, db, { acceptedDiffs: [...accepted] }), tableMappings: {} };
}

function designContext(): DesignContext {
  return { workspace: 'demo', design: 'design1', name: designName, driver: designDoc.schema.driver?.name };
}

function catalog(): WorkspaceCatalog {
  return {
    workspace: { id: 'demo', name: '演示工作区' },
    db: Object.entries(dbs).map(([id, d]) => ({ id, name: d.name, tableCount: d.schema?.tables.length, hasSnapshot: !!d.schema })),
  };
}

function setCanvas(next: CanvasFile) {
  if (next === canvas) return;
  canvas = next;
  send({ type: 'canvas', canvas });
}

function applyDesign(requestId: string, ops: DesignOp[], canvasEdit?: CanvasEdit) {
  const deletes = ops.filter((o) => o.op === 'table.delete').map((o) => (o as { table: string }).table);
  if (deletes.length && !window.confirm(`确定从设计中删除表 ${deletes.join('、')} 吗？`)) return reply(requestId, '已取消');
  try {
    Object.assign(designDoc, applyDesignOps(designDoc, ops));
  } catch (err) {
    return reply(requestId, err instanceof DesignOpError ? err.message : String(err));
  }
  let next = canvas;
  for (const op of ops) if (op.op === 'table.rename') next = renameTableInCanvas(next, op.from, op.to);
  if (canvasEdit) next = applyCanvasEdit(next, canvasEdit);
  setCanvas(next);
  send({ type: 'source', source: designSourceData() });
  send({ type: 'comparison', comparison: comparison() });
  reply(requestId);
}

function deletePartition(requestId: string, id: string) {
  const contents = partitionContents(canvas, id);
  if (!window.confirm(`确定删除分区画布及其中 ${contents.designTables.length} 张设计表、${contents.diagrams.length} 张设计图吗？`)) return reply(requestId, '已取消');
  const ops: DesignOp[] = contents.designTables.map((table) => ({ op: 'table.delete', table }));
  let next = canvas;
  for (const d of contents.diagrams) {
    next = removeDiagramFromCanvas(next, d);
    diagrams.splice(diagrams.findIndex((x) => x.id === d), 1);
  }
  setCanvas(applyCanvasEdit(next, [{ op: 'partition.remove', id }]));
  if (ops.length) Object.assign(designDoc, applyDesignOps(designDoc, ops));
  send({ type: 'source', source: designSourceData() });
  send({ type: 'diagrams', diagrams: [...diagrams] });
  reply(requestId);
}

function createDiagram(msg: Extract<WebviewMessage, { type: 'diagram/create' }>) {
  const info = DIAGRAM_TYPES.find((t) => t.type === msg.diagramType) ?? DIAGRAM_TYPES[0];
  const type = info.type;
  let n = 1;
  while (diagrams.some((d) => d.id === `diagram${n}`)) n++;
  const id = `diagram${n}`;
  diagrams.push({ id, name: `${info.label}${n}`, type, code: `${info.header}\n` });
  send({ type: 'diagrams', diagrams: [...diagrams] });
  const at = msg.at ?? { x: 0, y: 0 };
  setCanvas(applyCanvasEdit(canvas, [{ op: 'diagrams.put', diagrams: [{ id, ...at, ...DIAGRAM_CARD_SIZE, partition: msg.partition }] }]));
  send({ type: 'reveal', target: { item: { kind: 'diagram', id }, edit: true } });
}

function updateDiagram(id: string, patch: Partial<DiagramData>) {
  const i = diagrams.findIndex((d) => d.id === id);
  if (i < 0) return;
  diagrams[i] = { ...diagrams[i], ...patch };
  send({ type: 'diagrams', diagrams: [...diagrams] });
}

function handle(msg: WebviewMessage) {
  switch (msg.type) {
    case 'ready':
      send({ type: 'init', canvas, design: designContext(), sources: allSources(), diagrams: [...diagrams], catalog: catalog(), comparison: comparison() });
      return;
    case 'level':
    case 'viewport':
      return;
    case 'diagram/code':
      updateDiagram(msg.diagram, { code: msg.code });
      return;
    case 'diagram/meta':
      updateDiagram(msg.diagram, {
        ...(msg.name?.trim() ? { name: msg.name.trim() } : {}),
        ...(msg.description !== undefined ? { description: msg.description.trim() || undefined } : {}),
      });
      return;
    case 'canvas/edit':
      canvas = applyCanvasEdit(canvas, msg.edit);
      send({ type: 'comparison', comparison: comparison() });
      console.info(`[mock host] ${msg.label}`, msg.edit);
      return;
    case 'design/op':
      applyDesign(msg.requestId, msg.ops, msg.canvasEdit);
      console.info(`[mock host] ${msg.label}`, msg.ops);
      return;
    case 'diff/accept':
      if (msg.accepted) accepted.add(msg.id);
      else accepted.delete(msg.id);
      send({ type: 'comparison', comparison: comparison() });
      reply(msg.requestId);
      return;
    case 'design/rename':
      Object.assign(designDoc.schema, { name: msg.name });
      send({ type: 'design', design: designContext() });
      reply(msg.requestId);
      return;
    case 'source/add': {
      const db = dbSourceData(msg.dbId);
      if (db) send({ type: 'source', source: db });
      reply(msg.requestId);
      return;
    }
    case 'source/remove':
      reply(msg.requestId);
      return;
    case 'items/move':
      setCanvas(applyCanvasEdit(canvas, [{ op: 'move', items: msg.items }]));
      reply(msg.requestId);
      return;
    case 'partition/delete':
      deletePartition(msg.requestId, msg.id);
      return;
    case 'diagram/create':
      createDiagram(msg);
      return;
    case 'diagram/delete': {
      const i = diagrams.findIndex((d) => d.id === msg.diagram);
      if (i >= 0) diagrams.splice(i, 1);
      setCanvas(removeDiagramFromCanvas(canvas, msg.diagram));
      send({ type: 'diagrams', diagrams: [...diagrams] });
      reply(msg.requestId);
      return;
    }
    case 'clipboard/set':
      send({ type: 'clipboard', clipboard: { mode: msg.mode, count: msg.items.length } });
      return;
    case 'clipboard/paste':
      reply(msg.requestId, '浏览器模拟模式下不支持粘贴');
      return;
    default:
      console.info('[mock host] 浏览器模式下不支持：', msg);
  }
}

export function installMockHost(): void {
  window.addEventListener('harness:to-host', (e) => handle((e as CustomEvent<WebviewMessage>).detail));
  console.info('[mock host] 已启用浏览器模拟宿主');
}

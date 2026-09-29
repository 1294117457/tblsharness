/**
 * Stand-in for the extension host when the webview runs in a normal browser (`npm run dev:webview`).
 * Only loaded in dev builds outside VS Code; it keeps everything in memory.
 */
import { applyCanvasEdit, DESIGN_SOURCE, emptyCanvas, renameTableInCanvas, type CanvasFile } from '@shared/canvas';
import { applyDesignOps, DesignOpError, emptyDesignSchema, emptyExt, type DesignDoc, type DesignOp } from '@shared/designOps';
import type { ComparisonData, DesignContext, HostMessage, SourceData, WebviewMessage, WorkspaceCatalog } from '@shared/protocol';
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

let canvas: CanvasFile = {
  ...emptyCanvas('示例画布（浏览器模拟）'),
  designTables: 'all',
  nodes: [
    { source: 'db1', table: 'users', x: 0, y: 420 },
    { source: 'db1', table: 'audit_logs', x: 320, y: 420 },
  ],
};

function send(msg: HostMessage) {
  setTimeout(() => window.postMessage(msg, '*'), 30);
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
  return {
    workspace: 'demo',
    design: 'design1',
    name: designName,
    driver: designDoc.schema.driver?.name,
    canvases: [{ id: 'canvas1', name: canvas.name }],
  };
}

function catalog(): WorkspaceCatalog {
  return {
    workspace: { id: 'demo', name: '演示工作区' },
    db: Object.entries(dbs).map(([id, d]) => ({ id, name: d.name, tableCount: d.schema?.tables.length, hasSnapshot: !!d.schema })),
  };
}

function applyDesign(requestId: string, ops: DesignOp[], canvasEdit?: Parameters<typeof applyCanvasEdit>[1]) {
  const reply = (error?: string) => send({ type: 'reply', requestId, ok: !error, error });
  const deletes = ops.filter((o) => o.op === 'table.delete').map((o) => (o as { table: string }).table);
  if (deletes.length && !window.confirm(`确定从设计画布中删除表 ${deletes.join('、')} 吗？`)) return reply('已取消');
  try {
    Object.assign(designDoc, applyDesignOps(designDoc, ops));
  } catch (err) {
    return reply(err instanceof DesignOpError ? err.message : String(err));
  }
  let next = canvas;
  for (const op of ops) if (op.op === 'table.rename') next = renameTableInCanvas(next, op.from, op.to);
  if (canvasEdit) next = applyCanvasEdit(next, canvasEdit);
  if (next !== canvas) {
    canvas = next;
    send({ type: 'canvas', canvas });
  }
  send({ type: 'source', source: designSourceData() });
  send({ type: 'comparison', comparison: comparison() });
  reply();
}

function handle(msg: WebviewMessage) {
  switch (msg.type) {
    case 'ready':
      send({ type: 'init', canvas, design: designContext(), sources: allSources(), catalog: catalog(), comparison: comparison() });
      return;
    case 'canvas/edit': {
      canvas = applyCanvasEdit(canvas, msg.edit);
      send({ type: 'comparison', comparison: comparison() });
      console.info(`[mock host] ${msg.label}`, msg.edit);
      return;
    }
    case 'design/op':
      applyDesign(msg.requestId, msg.ops, msg.canvasEdit);
      console.info(`[mock host] ${msg.label}`, msg.ops);
      return;
    case 'diff/accept':
      if (msg.accepted) accepted.add(msg.id);
      else accepted.delete(msg.id);
      send({ type: 'comparison', comparison: comparison() });
      send({ type: 'reply', requestId: msg.requestId, ok: true });
      return;
    case 'design/rename':
      Object.assign(designDoc.schema, { name: msg.name });
      send({ type: 'design', design: designContext() });
      send({ type: 'reply', requestId: msg.requestId, ok: true });
      return;
    case 'source/add': {
      const db = dbSourceData(msg.dbId);
      if (db) send({ type: 'source', source: db });
      send({ type: 'reply', requestId: msg.requestId, ok: true });
      return;
    }
    case 'source/remove':
      send({ type: 'reply', requestId: msg.requestId, ok: true });
      return;
    default:
      console.info('[mock host] 浏览器模式下不支持：', msg);
  }
}

export function installMockHost(): void {
  window.addEventListener('harness:to-host', (e) => handle((e as CustomEvent<WebviewMessage>).detail));
  console.info('[mock host] 已启用浏览器模拟宿主');
}

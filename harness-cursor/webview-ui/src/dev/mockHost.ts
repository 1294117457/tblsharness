/**
 * Stand-in for the extension host when the webview runs in a normal browser (`npm run dev:webview`).
 * Only loaded in dev builds outside VS Code; it keeps everything in memory.
 */
import { applyCanvasEdit, emptyCanvas, renameTableInCanvas, type CanvasFile } from '@shared/canvas';
import { applyDesignOps, DesignOpError, emptyDesignSchema, emptyExt, type DesignDoc, type DesignOp } from '@shared/designOps';
import type { ComparisonData, HostMessage, SourceData, WebviewMessage, WorkspaceCatalog } from '@shared/protocol';
import type { TblsSchema } from '@shared/tbls';
import type { SourceKind } from '@shared/workspace';
import { diffSchemas } from '../../../src/diff/diff';
import { normalize } from '../../../src/model/normalize';
import { exampleDb, exampleDesign } from './fixtures';

const designs: Record<string, { name: string; doc: DesignDoc }> = {
  shop: { name: '商城设计', doc: exampleDesign() },
  blank: { name: '空白设计', doc: { schema: emptyDesignSchema('blank', 'postgres'), ext: emptyExt() } },
};
const dbs: Record<string, { name: string; schema?: TblsSchema }> = {
  prod: { name: 'db.example.test:5432/shop', schema: exampleDb() },
  empty: { name: 'localhost:5432/staging' },
};
const accepted = new Set<string>();

let canvas: CanvasFile = {
  ...emptyCanvas('示例画布（浏览器模拟）'),
  sources: [
    { alias: 'd1', kind: 'design', ref: 'shop', tables: 'all' },
    { alias: 'b1', kind: 'db', ref: 'prod', tables: 'picked' },
  ],
  nodes: [
    { source: 'b1', table: 'users', x: 0, y: 420 },
    { source: 'b1', table: 'audit_logs', x: 320, y: 420 },
  ],
};

function send(msg: HostMessage) {
  // Asynchronous like the real host, so ordering bugs show up here too.
  setTimeout(() => window.postMessage(msg, '*'), 30);
}

function sourceData(alias: string): SourceData | undefined {
  const s = canvas.sources.find((x) => x.alias === alias);
  if (!s) return undefined;
  if (s.kind === 'design') {
    const d = designs[s.ref];
    if (!d) return { alias, kind: s.kind, ref: s.ref, name: s.ref, error: '设计库不存在' };
    return { alias, kind: s.kind, ref: s.ref, name: d.name, schema: normalize(d.doc.schema, { source: 'design', ext: d.doc.ext }) };
  }
  const db = dbs[s.ref];
  if (!db) return { alias, kind: s.kind, ref: s.ref, name: s.ref, error: '数据库不存在' };
  return {
    alias,
    kind: s.kind,
    ref: s.ref,
    name: db.name,
    schema: db.schema && normalize(db.schema, { source: 'db' }),
    snapshot: db.schema && { file: '2026-01-01T00-00-00-000Z.json', takenAt: '2026-01-01T00:00:00.000Z' },
  };
}

function comparison(): ComparisonData | undefined {
  const c = canvas.comparison;
  if (!c) return undefined;
  const design = sourceData(c.design)?.schema;
  const db = sourceData(c.db)?.schema;
  if (!design || !db) return undefined;
  return { diff: diffSchemas(design, db, { acceptedDiffs: [...accepted] }), tableMappings: {} };
}

function catalog(): WorkspaceCatalog {
  return {
    workspace: { id: 'demo', name: '演示工作区' },
    design: Object.entries(designs).map(([id, d]) => ({ id, name: d.name, tableCount: d.doc.schema.tables.length })),
    db: Object.entries(dbs).map(([id, d]) => ({ id, name: d.name, tableCount: d.schema?.tables.length, hasSnapshot: !!d.schema })),
  };
}

function pushSources(kind?: SourceKind, ref?: string) {
  for (const s of canvas.sources) {
    if (kind && (s.kind !== kind || s.ref !== ref)) continue;
    const data = sourceData(s.alias);
    if (data) send({ type: 'source', source: data });
  }
}

function applyDesign(requestId: string, alias: string, ops: DesignOp[], canvasEdit?: Parameters<typeof applyCanvasEdit>[1]) {
  const reply = (error?: string) => send({ type: 'reply', requestId, ok: !error, error });
  const s = canvas.sources.find((x) => x.alias === alias);
  const d = s?.kind === 'design' ? designs[s.ref] : undefined;
  if (!s || !d) return reply('只能编辑设计数据源中的表');
  const deletes = ops.filter((o) => o.op === 'table.delete').map((o) => (o as { table: string }).table);
  if (deletes.length && !window.confirm(`确定从设计库“${d.name}”中删除表 ${deletes.join('、')} 吗？`)) return reply('已取消');
  try {
    d.doc = applyDesignOps(d.doc, ops);
  } catch (err) {
    return reply(err instanceof DesignOpError ? err.message : String(err));
  }
  let next = canvas;
  for (const op of ops) if (op.op === 'table.rename') next = renameTableInCanvas(next, 'design', s.ref, op.from, op.to);
  if (canvasEdit) next = applyCanvasEdit(next, canvasEdit);
  if (next !== canvas) {
    canvas = next;
    send({ type: 'canvas', canvas });
  }
  pushSources('design', s.ref);
  send({ type: 'comparison', comparison: comparison() });
  send({ type: 'catalog', catalog: catalog() });
  reply();
}

function handle(msg: WebviewMessage) {
  switch (msg.type) {
    case 'ready':
      send({ type: 'init', canvas, sources: canvas.sources.map((s) => sourceData(s.alias)!), catalog: catalog(), comparison: comparison() });
      return;
    case 'canvas/edit': {
      const before = canvas;
      canvas = applyCanvasEdit(canvas, msg.edit);
      const added = canvas.sources.filter((s) => !before.sources.some((b) => b.alias === s.alias));
      for (const s of added) send({ type: 'source', source: sourceData(s.alias)! });
      if (JSON.stringify(before.comparison) !== JSON.stringify(canvas.comparison) || added.length) {
        send({ type: 'comparison', comparison: comparison() });
      }
      console.info(`[mock host] ${msg.label}`, msg.edit);
      return;
    }
    case 'design/op':
      applyDesign(msg.requestId, msg.alias, msg.ops, msg.canvasEdit);
      console.info(`[mock host] ${msg.label}`, msg.ops);
      return;
    case 'diff/accept':
      if (msg.accepted) accepted.add(msg.id);
      else accepted.delete(msg.id);
      send({ type: 'comparison', comparison: comparison() });
      send({ type: 'reply', requestId: msg.requestId, ok: true });
      return;
    case 'source/rename': {
      const s = canvas.sources.find((x) => x.alias === msg.alias);
      const target = s?.kind === 'design' ? designs[s.ref] : undefined;
      if (!s || !target) return;
      target.name = msg.name;
      pushSources(s.kind, s.ref);
      send({ type: 'catalog', catalog: catalog() });
      return;
    }
    case 'source/create': {
      if (msg.kind !== 'design') {
        console.info('[mock host] 连接页面请用 ?view=connection 打开');
        return;
      }
      let n = 1;
      while (Object.values(designs).some((d) => d.name === `设计库 ${n}`)) n++;
      designs[`design${Date.now()}`] = { name: `设计库 ${n}`, doc: { schema: emptyDesignSchema(`设计库 ${n}`, 'postgres'), ext: emptyExt() } };
      send({ type: 'catalog', catalog: catalog() });
      return;
    }
    default:
      console.info('[mock host] 浏览器模式下不支持：', msg);
  }
}

export function installMockHost(): void {
  window.addEventListener('harness:to-host', (e) => handle((e as CustomEvent<WebviewMessage>).detail));
  console.info('[mock host] 已启用浏览器模拟宿主');
}

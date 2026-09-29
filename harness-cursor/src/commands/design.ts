import * as vscode from 'vscode';
import { designFromSnapshot, emptyDesignSchema, emptyExt, type DesignDoc } from '../shared/designOps';
import { DESIGN_DRIVERS, driverLabel, nextDefaultName, type DesignMeta } from '../shared/workspace';
import { parseTblsJson } from '../tbls/runner';
import { readText } from '../workspace/fsUtil';
import type { HarnessWorkspace } from '../workspace/storage';
import { closeTabsUnder, confirm, designNames, pickSourceId, pickWorkspace, promptName, register, required, revealInTree, type Harness } from './common';

const DEFAULT_DESIGN_NAME = '设计画布';

export const LAST_DESIGN_DRIVER_KEY = 'harness.lastDesignDriver';

export function registerDesignCommands(h: Harness): void {
  const finish = async (ws: HarnessWorkspace, name: string, createdFrom: DesignMeta['createdFrom'], doc: DesignDoc) => {
    const id = await ws.createDesign({ version: 1, name, createdFrom }, doc);
    h.store.invalidate({ workspace: ws.id, kind: 'design', id });
    void revealInTree(h, { kind: 'design', workspace: ws.id, id });
    const driver = driverLabel(doc.schema.driver?.name) ?? '未指定类型';
    const tables = doc.schema.tables.length ? `，${doc.schema.tables.length} 张表` : '';
    void vscode.window.showInformationMessage(`已创建"${name}"（${driver}${tables}）。按 F2 重命名，右键可以更改数据库类型。`);
  };

  register(h, 'harness.design.create', async (arg) => {
    const ws = await pickWorkspace(h, arg);
    const name = nextDefaultName(DEFAULT_DESIGN_NAME, await designNames(ws));
    const driver = await inferDesignDriver(h, ws);
    await finish(ws, name, { kind: 'empty' }, { schema: emptyDesignSchema(name, driver), ext: emptyExt() });
  });

  register(h, 'harness.design.createBlank', (arg) => vscode.commands.executeCommand('harness.design.create', arg));

  register(h, 'harness.design.createFromDb', async (arg) => {
    const ws = await pickWorkspace(h, arg);
    const candidates: { id: string; name: string; snapshot: string }[] = [];
    for (const dbId of await ws.dbIds()) {
      const db = ws.db(dbId);
      const snapshot = await db.latestSnapshot();
      if (snapshot) candidates.push({ id: dbId, name: await h.store.dbName(ws.id, dbId), snapshot });
    }
    if (!candidates.length) throw new Error('这个工作区还没有带快照的数据库，请先添加数据库并同步结构');
    const pick =
      candidates.length === 1
        ? candidates[0]
        : required(await vscode.window.showQuickPick(candidates.map((d) => ({ label: d.name, description: d.snapshot, ...d })), { title: '从哪个数据库复制？' }));
    const snapshot = await ws.db(pick.id).readSnapshot(pick.snapshot);
    const name = nextDefaultName(DEFAULT_DESIGN_NAME, await designNames(ws));
    await finish(ws, name, { kind: 'db', source: pick.id, snapshot: pick.snapshot }, { schema: designFromSnapshot(snapshot, name), ext: emptyExt() });
  });

  register(h, 'harness.design.createFromFile', async (arg) => {
    const ws = await pickWorkspace(h, arg);
    const [file] = required(
      await vscode.window.showOpenDialog({ title: '选择 tbls 导出的 JSON 文件', filters: { 'tbls JSON': ['json'] }, canSelectMany: false }),
    );
    const schema = parseTblsJson(await readText(file));
    const name = schema.name?.trim() || nextDefaultName(DEFAULT_DESIGN_NAME, await designNames(ws));
    await finish(ws, name, { kind: 'file', path: file.fsPath }, { schema: designFromSnapshot(schema, name), ext: emptyExt() });
  });

  register(h, 'harness.design.setDriver', async (arg) => {
    const ws = await pickWorkspace(h, arg);
    const id = await pickSourceId(h, ws, 'design', arg);
    const doc = await h.store.designDoc(ws.id, id);
    const current = doc.schema.driver?.name;
    const pick = required(
      await vscode.window.showQuickPick(
        DESIGN_DRIVERS.map((d) => ({ label: d.label, description: d.name === current ? '当前' : undefined, name: d.name })),
        { title: '目标数据库类型', placeHolder: '决定字段类型的解析方式。已有字段的类型不会自动转换' },
      ),
    );
    await h.context.globalState.update(LAST_DESIGN_DRIVER_KEY, pick.name);
    if (pick.name === current) return;
    await h.store.writeDesignDoc(ws.id, id, { ...doc, schema: { ...doc.schema, driver: { ...doc.schema.driver, name: pick.name } } });
    void vscode.window.showInformationMessage(`已改为 ${pick.label}。已有字段的类型没有转换，请按需检查。`);
  });

  register(h, 'harness.design.openRaw', async (arg) => {
    const ws = await pickWorkspace(h, arg);
    const id = await pickSourceId(h, ws, 'design', arg);
    await vscode.window.showTextDocument(ws.design(id).schemaFile);
  });

  register(h, 'harness.design.openExt', async (arg) => {
    const ws = await pickWorkspace(h, arg);
    const id = await pickSourceId(h, ws, 'design', arg);
    await vscode.window.showTextDocument(ws.design(id).extFile);
  });

  register(h, 'harness.design.rename', async (arg) => {
    const ws = await pickWorkspace(h, arg);
    const id = await pickSourceId(h, ws, 'design', arg);
    const source = ws.design(id);
    const meta = await source.readMeta();
    await source.writeMeta({ ...meta, name: await promptName('重命名设计画布', meta.name) });
    h.store.invalidate({ workspace: ws.id, kind: 'design', id });
  });

  register(h, 'harness.design.delete', async (arg) => {
    const ws = await pickWorkspace(h, arg);
    const id = await pickSourceId(h, ws, 'design', arg);
    const source = ws.design(id);
    const meta = await source.readMeta();
    const canvasCount = (await source.canvasIds()).length;
    const diagramCount = (await source.diagramIds()).length;
    const parts: string[] = [];
    if (canvasCount) parts.push(`${canvasCount} 张画布`);
    if (diagramCount) parts.push(`${diagramCount} 张设计图`);
    await confirm(
      `确定删除设计画布"${meta.name}"吗？`,
      `表结构${parts.length ? `、${parts.join('、')}` : ''}会被删除，此操作不能撤销。`,
      '删除',
    );
    await closeTabsUnder(source.dir);
    await source.remove();
    h.store.invalidate({ workspace: ws.id, kind: 'design', id });
  });
}

/** The type of the most recently synced db in the workspace, else the last one used, else PostgreSQL. */
async function inferDesignDriver(h: Harness, ws: HarnessWorkspace): Promise<string> {
  let latest: { file: string; driver?: string } | undefined;
  for (const dbId of await ws.dbIds()) {
    const db = ws.db(dbId);
    const file = await db.latestSnapshot();
    if (!file || (latest && latest.file >= file)) continue;
    try {
      latest = { file, driver: (await db.readSnapshot(file)).driver?.name };
    } catch {
      // unreadable snapshot: ignore for inference
    }
  }
  if (latest?.driver) return latest.driver;
  return h.context.globalState.get<string>(LAST_DESIGN_DRIVER_KEY) ?? 'postgres';
}

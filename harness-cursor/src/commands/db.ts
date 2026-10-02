import * as vscode from 'vscode';
import { friendlyMissingTblsError, friendlyTblsError } from '../connection/errors';
import { buildDsn, describeProfile, parseStoredConnection, secretsOf, serializeConnection } from '../shared/connection';
import { maskSecret, parseTblsJson, stripDsnFromTblsConfig, TblsError, tblsOutJson } from '../tbls/runner';
import { resolveTblsPath, TblsResolveError } from '../tbls/resolver';
import { readText, writeText } from '../workspace/fsUtil';
import { deleteDbFromDesigns, designNamesReferencingDb } from '../workspace/refactor';
import type { DbSource } from '../workspace/storage';
import { closeTabsUnder, confirm, pickSourceId, pickWorkspace, register, required, type Harness, type NodeArg } from './common';

export function registerDbCommands(h: Harness): void {
  const nameOf = (db: DbSource) => h.store.dbName(db.workspace.id, db.id);

  register(h, 'harness.db.create', async (arg) => {
    h.connections.openCreate(await pickWorkspace(h, arg));
  });

  register(h, 'harness.db.editConnection', async (arg) => {
    h.connections.openEdit(await pickDb(h, arg));
  });

  register(h, 'harness.db.sync', async (arg) => {
    const db = await pickDb(h, arg);
    const [meta, name] = await Promise.all([db.readMeta(), nameOf(db)]);
    const stored = await h.context.secrets.get(db.secretKey);
    if (!stored) {
      const pick = await vscode.window.showInformationMessage(`“${name}”还没有设置连接。`, '设置连接…', '导入快照文件…');
      if (pick === '设置连接…') h.connections.openEdit(db);
      if (pick === '导入快照文件…') await vscode.commands.executeCommand('harness.db.importSnapshot', { workspace: db.workspace.id, kind: 'db', id: db.id });
      return;
    }
    const profile = parseStoredConnection(stored);
    const dsn = buildDsn(profile);
    const secrets = secretsOf(profile);
    const errorKey = `${db.workspace.id}/${db.id}`;
    const config = vscode.workspace.getConfiguration('harness');
    const tblsPath = await resolveTblsPath(
      h.context,
      config.get<string>('tblsPath', 'tbls') || 'tbls',
      { extensionVersion: h.context.extension.packageJSON.version as string },
    );
    const timeoutMs = Math.max(5, config.get<number>('tblsTimeoutSeconds', 120)) * 1000;
    const configPath = (await db.hasTblsConfig()) ? db.tblsConfigFile.fsPath : undefined;
    await vscode.workspace.fs.createDirectory(db.snapshotsDir);
    try {
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Harness：正在读取 ${maskSecret(describeProfile(profile), dsn, secrets)}`, cancellable: true },
        (_progress, token) => {
          const abort = new AbortController();
          token.onCancellationRequested(() => abort.abort());
          return tblsOutJson({ tblsPath, dsn, configPath, exclude: meta.exclude, include: meta.include, cwd: db.dir.fsPath, timeoutMs, signal: abort.signal, secrets });
        },
      );
      const file = await db.writeSnapshot(result.raw, meta.snapshotRetention);
      h.tree.syncErrors.delete(errorKey);
      h.store.invalidate({ workspace: db.workspace.id, kind: 'db', id: db.id });
      vscode.window.showInformationMessage(`已同步“${name}”：${result.schema.tables.length} 张表、${result.schema.relations?.length ?? 0} 条关系（${file}）`);
    } catch (err) {
      if (err instanceof TblsError && err.reason === 'cancelled') return;
      const raw = maskSecret((err as Error).message, dsn, secrets);
      const friendly =
        err instanceof TblsResolveError
          ? friendlyMissingTblsError(err)
          : err instanceof TblsError
          ? friendlyTblsError(raw, err.reason)
          : { message: raw };
      h.tree.syncErrors.set(errorKey, friendly.detail ? `${friendly.message}\n${friendly.detail}` : friendly.message);
      h.tree.refresh();
      const actions =
        friendly.action === 'setTblsPath'
          ? ['设置 tbls 路径']
          : friendly.action === 'downloadTbls'
          ? ['下载 tbls', '设置 tbls 路径', '查看 Releases…']
          : ['编辑连接…'];
      const pick = await vscode.window.showErrorMessage(`Harness：同步“${name}”失败：${friendly.message}`, { detail: friendly.detail }, ...actions);
      if (pick === '设置 tbls 路径') await vscode.commands.executeCommand('workbench.action.openSettings', 'harness.tblsPath');
      if (pick === '下载 tbls') await vscode.commands.executeCommand('harness.tbls.repair');
      if (pick === '查看 Releases…') await vscode.env.openExternal(vscode.Uri.parse('https://github.com/k1LoW/tbls/releases'));
      if (pick === '编辑连接…') h.connections.openEdit(db);
    }
  });

  register(h, 'harness.db.clearConnection', async (arg) => {
    const db = await pickDb(h, arg);
    const name = await nameOf(db);
    await h.context.secrets.delete(db.secretKey);
    h.store.invalidate({ workspace: db.workspace.id, kind: 'db', id: db.id });
    vscode.window.showInformationMessage(`已清除“${name}”保存的连接。`);
  });

  register(h, 'harness.db.importSnapshot', async (arg) => {
    const db = await pickDb(h, arg);
    const meta = await db.readMeta();
    const file = await db.writeSnapshot(await pickTblsJsonFile(), meta.snapshotRetention);
    h.store.invalidate({ workspace: db.workspace.id, kind: 'db', id: db.id });
    vscode.window.showInformationMessage(`已导入快照 ${file}`);
  });

  register(h, 'harness.db.importTblsConfig', async (arg) => {
    const db = await pickDb(h, arg);
    const [file] = required(
      await vscode.window.showOpenDialog({ title: '选择 tbls 配置文件', filters: { YAML: ['yml', 'yaml'] }, canSelectMany: false }),
    );
    const { text, dsn } = stripDsnFromTblsConfig(await readText(file));
    if (dsn) {
      const save = await vscode.window.showWarningMessage(
        '这个配置文件里有明文的数据库连接串（包含密码）。Harness 不会把它写入任何文件。',
        {
          modal: true,
          detail: `原文件 ${file.fsPath} 中仍然保留着明文密码，请不要把它提交到 Git。\n是否把这个连接串保存到系统凭据，作为“${await nameOf(db)}”的连接？`,
        },
        '保存到系统凭据',
        '不保存',
      );
      if (save === undefined) return;
      if (save === '保存到系统凭据') {
        await h.context.secrets.store(db.secretKey, serializeConnection({ version: 1, driver: 'custom', dsn }));
        const meta = await db.readMeta();
        await db.writeMeta({ ...meta, connection: { kind: 'secret', driver: 'custom' } });
      }
    }
    await writeText(db.tblsConfigFile, text);
    h.store.invalidate({ workspace: db.workspace.id, kind: 'db', id: db.id });
    vscode.window.showInformationMessage('已导入 tbls 配置，下次同步时生效。');
  });

  register(h, 'harness.db.openConfig', async (arg) => {
    const db = await pickDb(h, arg);
    await vscode.window.showTextDocument(db.metaFile);
  });

  register(h, 'harness.db.openSnapshot', async (arg) => {
    const db = await pickDb(h, arg);
    const latest = await db.latestSnapshot();
    if (!latest) throw new Error('还没有快照，请先同步或导入');
    await vscode.window.showTextDocument(db.snapshotUri(latest), { preview: true });
  });

  register(h, 'harness.db.delete', async (arg) => {
    const db = await pickDb(h, arg);
    const name = await nameOf(db);
    const designs = await designNamesReferencingDb(db.workspace, db.id);
    await confirm(
      `确定删除数据库“${name}”吗？`,
      `会删除它的所有快照和已保存的连接，不会影响真实数据库。${designs.length ? `\n以下设计画布会移除这个数据源：${designs.join('、')}` : ''}`,
      '删除',
    );
    await deleteDbFromDesigns(db.workspace, h.canvases, db.id);
    await closeTabsUnder(db.dir);
    await h.context.secrets.delete(db.secretKey);
    await db.remove();
    h.store.invalidate({ workspace: db.workspace.id, kind: 'db', id: db.id });
  });
}

async function pickDb(h: Harness, arg?: NodeArg): Promise<DbSource> {
  const ws = await pickWorkspace(h, arg);
  return ws.db(await pickSourceId(h, ws, 'db', arg));
}

async function pickTblsJsonFile(): Promise<string> {
  const [file] = required(
    await vscode.window.showOpenDialog({ title: '选择 tbls 导出的 JSON 文件', filters: { 'tbls JSON': ['json'] }, canSelectMany: false }),
  );
  const text = await readText(file);
  parseTblsJson(text);
  return text;
}

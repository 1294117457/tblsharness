import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import type { Harness } from '../commands/common';
import { revealInTree } from '../commands/common';
import {
  buildDsn,
  defaultConnectionName,
  driverInfo,
  parseStoredConnection,
  secretsOf,
  serializeConnection,
  validateProfile,
  type ConnectionDriver,
  type ConnectionProfile,
} from '../shared/connection';
import type { ConnectionFilters, ConnectionHostMessage, ConnectionResult, ConnectionWebviewMessage, TblsStatus } from '../shared/connectionProtocol';
import type { TblsSchema } from '../shared/tbls';
import { DEFAULT_DB_EXCLUDE, DEFAULT_SNAPSHOT_RETENTION, type DbSourceMeta } from '../shared/workspace';
import { maskSecret, parseTblsJson, TblsError, tblsOutJson } from '../tbls/runner';
import { readText } from '../workspace/fsUtil';
import type { DbSource, HarnessWorkspace } from '../workspace/storage';
import { renderWebviewHtml, webviewOptions } from '../webview/html';
import { friendlyMissingTblsError, friendlyTblsError } from './errors';
import { resolveTblsPath, TblsResolveError } from '../tbls/resolver';
import { install, probe, TblsInstallError } from '../tbls/manager';
import { readTblsConfig } from '../tbls/config';
import { probeTblsVersion } from '../tbls/probeVersion';

const LAST_DRIVER_KEY = 'harness.lastConnectionDriver';
const CACHE_TTL_MS = 5 * 60 * 1000;

interface TblsRun {
  raw: string;
  schema: TblsSchema;
  elapsedMs: number;
}

/** One page per workspace (create) or per db source (edit); opening it again just focuses it. */
export class ConnectionPanels implements vscode.Disposable {
  private readonly panels = new Map<string, ConnectionPanel>();
  /** Test results keyed by a hash of the connection + filters, so "连接" right after "测试连接" doesn't read twice. */
  readonly cache = new Map<string, TblsRun & { at: number }>();

  constructor(readonly h: Harness) {}

  openCreate(ws: HarnessWorkspace): void {
    this.open(`create:${ws.id}`, () => new ConnectionPanel(this, ws));
  }

  openEdit(db: DbSource): void {
    this.open(`edit:${db.workspace.id}:${db.id}`, () => new ConnectionPanel(this, db.workspace, db));
  }

  private open(key: string, create: () => ConnectionPanel): void {
    const existing = this.panels.get(key);
    if (existing) {
      existing.panel.reveal();
      return;
    }
    const panel = create();
    this.panels.set(key, panel);
    panel.panel.onDidDispose(() => {
      this.panels.delete(key);
      panel.dispose();
    });
  }

  cached(key: string): TblsRun | undefined {
    const now = Date.now();
    for (const [k, v] of this.cache) if (now - v.at > CACHE_TTL_MS) this.cache.delete(k);
    return this.cache.get(key);
  }

  dispose(): void {
    for (const p of this.panels.values()) p.panel.dispose();
    this.cache.clear();
  }
}

class ConnectionPanel implements vscode.Disposable {
  readonly panel: vscode.WebviewPanel;
  private abort: AbortController | undefined;
  private pickedJson: { path: string; text: string } | undefined;
  private lastSecrets: string[] = [];
  private disposed = false;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly owner: ConnectionPanels,
    private readonly ws: HarnessWorkspace,
    private readonly db?: DbSource,
  ) {
    const context = owner.h.context;
    this.panel = vscode.window.createWebviewPanel('harness.connection', db ? '编辑连接' : '添加数据库', vscode.ViewColumn.Active, {
      ...webviewOptions(context),
      retainContextWhenHidden: true,
    });
    this.panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'harness.svg');
    this.panel.webview.html = renderWebviewHtml({ webview: this.panel.webview, context, title: this.panel.title, view: 'connection' });
    this.disposables.push(this.panel.webview.onDidReceiveMessage((msg: ConnectionWebviewMessage) => void this.onMessage(msg)));
    void this.updateTitle();
  }

  private get h(): Harness {
    return this.owner.h;
  }

  private async updateTitle(): Promise<void> {
    this.panel.title = this.db ? `编辑连接 · ${await this.h.store.dbName(this.ws.id, this.db.id)}` : `添加数据库 · ${(await this.ws.readMeta()).name}`;
  }

  private post(msg: ConnectionHostMessage): void {
    if (!this.disposed) void this.panel.webview.postMessage(msg);
  }

  private async onMessage(msg: ConnectionWebviewMessage): Promise<void> {
    switch (msg.type) {
      case 'ready':
        return this.sendInit();
      case 'test':
        return this.reply(msg.requestId, async () => {
          const run = await this.runTbls(await this.resolveProfile(msg.profile), msg.filters);
          return { ok: true, tables: run.schema.tables.length, relations: run.schema.relations?.length ?? 0, elapsedMs: run.elapsedMs };
        });
      case 'connect':
        return this.reply(msg.requestId, () => (this.db ? this.save(this.db, msg) : this.create(msg)));
      case 'importFile':
        return this.reply(msg.requestId, () => this.importFile());
      case 'pickFile':
        return this.pickFile(msg.requestId, msg.purpose);
      case 'pickTblsPath':
        return this.handlePickTblsPath(msg.requestId);
      case 'testTbls':
        return this.handleTestTbls(msg.requestId);
      case 'installTbls':
        return this.handleInstallTbls(msg.requestId);
      case 'openTblsReleases':
        if (/^https:\/\//.test(msg.url)) await vscode.env.openExternal(vscode.Uri.parse(msg.url));
        return;
      case 'openUrl':
        if (/^https:\/\//.test(msg.url)) await vscode.env.openExternal(vscode.Uri.parse(msg.url));
        return;
      case 'openTblsSettings':
        await vscode.commands.executeCommand('workbench.action.openSettings', 'harness.tblsPath');
        return;
      case 'cancel':
        this.abort?.abort();
        return;
      case 'close':
        this.panel.dispose();
        return;
    }
  }

  private async sendInit(): Promise<void> {
    const wsMeta = await this.ws.readMeta();
    const tblsStatus = await this.buildTblsStatus();
    if (!this.db) {
      const last = this.h.context.globalState.get<ConnectionDriver>(LAST_DRIVER_KEY);
      this.post({
        type: 'init',
        mode: 'create',
        workspaceName: wsMeta.name,
        driver: last && driverInfo(last).id === last ? last : 'postgres',
        hasSavedPassword: false,
        filters: { exclude: [...DEFAULT_DB_EXCLUDE], include: [] },
        tblsStatus,
      });
      return;
    }
    const meta = await this.db.readMeta();
    const stored = await this.h.context.secrets.get(this.db.secretKey);
    const saved = stored ? parseStoredConnection(stored) : undefined;
    let profile: Omit<ConnectionProfile, 'password'> | undefined;
    if (saved) {
      const { password: _password, ...rest } = saved;
      profile = saved.driver === 'custom' ? { ...rest, dsn: undefined } : rest;
    }
    const hasSecret = saved ? (saved.driver === 'custom' ? !!saved.dsn : !!saved.password) : false;
    this.post({
      type: 'init',
      mode: 'edit',
      workspaceName: wsMeta.name,
      driver: saved?.driver ?? (meta.connection.kind === 'secret' ? meta.connection.driver : undefined) ?? 'postgres',
      profile,
      hasSavedPassword: hasSecret,
      defaultSchema: meta.defaultSchema,
      filters: { exclude: meta.exclude, include: meta.include },
      tblsStatus,
    });
  }

  /**
   * Describes the tbls Harness would use, and — importantly — whether it actually runs.
   *
   * The `user-configured` branch probes the *user's* path. It must not report the bundled
   * version there: the two are unrelated, and showing "内置已安装 vX" next to a local path is
   * misleading.
   */
  private async buildTblsStatus(): Promise<TblsStatus> {
    const config = readTblsConfig();

    if (config.tblsPath) {
      const info = await probeTblsVersion(config.tblsPath);
      return {
        source: 'user-configured',
        bundledVersion: config.version,
        resolvedPath: info.resolvedPath ?? config.tblsPath,
        verified: info.ok,
        verifiedVersion: info.version,
        error: info.ok ? undefined : info.error,
      };
    }

    const installed = await probe(this.h.context, config.version);
    if (installed) {
      const info = await probeTblsVersion(installed.fsPath);
      return {
        source: 'bundled',
        bundledVersion: config.version,
        installedVersion: config.version,
        resolvedPath: installed.fsPath,
        verified: info.ok,
        verifiedVersion: info.version,
        error: info.ok ? undefined : info.error,
      };
    }
    return { source: 'missing', bundledVersion: config.version, verified: false };
  }

  /** In edit mode an empty password (or DSN) means "keep the saved one"; the page never receives it. */
  private async resolveProfile(profile: ConnectionProfile): Promise<ConnectionProfile> {
    const errors = validateProfile(profile, { passwordOptional: !!this.db });
    const first = Object.values(errors)[0];
    if (first) throw new UserError(first);
    const resolved = await this.fillSaved(profile);
    this.lastSecrets = secretsOf(resolved);
    return resolved;
  }

  private async fillSaved(profile: ConnectionProfile): Promise<ConnectionProfile> {
    if (!this.db) return profile;
    const stored = await this.h.context.secrets.get(this.db.secretKey);
    if (!stored) {
      if (profile.driver === 'custom' && !profile.dsn?.trim()) throw new UserError('请填写连接串');
      return profile;
    }
    const saved = parseStoredConnection(stored);
    if (profile.driver === 'custom') {
      if (profile.dsn?.trim()) return profile;
      if (saved.driver === 'custom' && saved.dsn) return { ...profile, dsn: saved.dsn };
      throw new UserError('请填写连接串');
    }
    if (!profile.password && saved.driver !== 'custom' && saved.password) return { ...profile, password: saved.password };
    return profile;
  }

  private configPath = async (): Promise<string | undefined> => (this.db && (await this.db.hasTblsConfig()) ? this.db.tblsConfigFile.fsPath : undefined);

  private async cacheKey(profile: ConnectionProfile, filters: ConnectionFilters): Promise<string> {
    return createHash('sha256')
      .update(JSON.stringify([profile, filters.exclude, filters.include, await this.configPath()]))
      .digest('hex');
  }

  private async runTbls(profile: ConnectionProfile, filters: ConnectionFilters): Promise<TblsRun> {
    const key = await this.cacheKey(profile, filters);
    const cached = this.owner.cached(key);
    if (cached) return cached;

    this.abort?.abort();
    const abort = new AbortController();
    this.abort = abort;
    const config = readTblsConfig();
    const started = Date.now();
    try {
      const result = await tblsOutJson({
        tblsPath: await resolveTblsPath(this.h.context),
        dsn: buildDsn(profile),
        configPath: await this.configPath(),
        exclude: filters.exclude,
        include: filters.include,
        cwd: (this.db?.dir ?? this.ws.dir).fsPath,
        timeoutMs: config.timeoutSeconds * 1000,
        signal: abort.signal,
        secrets: secretsOf(profile),
      });
      const run = { ...result, elapsedMs: Date.now() - started };
      this.owner.cache.set(key, { ...run, at: Date.now() });
      return run;
    } finally {
      if (this.abort === abort) this.abort = undefined;
    }
  }

  private async create(msg: Extract<ConnectionWebviewMessage, { type: 'connect' }>): Promise<ConnectionResult> {
    const profile = await this.resolveProfile(msg.profile);
    const run = await this.runTbls(profile, msg.filters);
    const meta: DbSourceMeta = {
      version: 1,
      name: defaultConnectionName(profile),
      connection: { kind: 'secret', driver: profile.driver },
      defaultSchema: msg.defaultSchema?.trim() || undefined,
      exclude: msg.filters.exclude,
      include: msg.filters.include,
      snapshotRetention: DEFAULT_SNAPSHOT_RETENTION,
    };
    const db = await this.ws.claimDb();
    try {
      await db.create(meta);
      await this.h.context.secrets.store(db.secretKey, serializeConnection(profile));
      await db.writeSnapshot(run.raw, meta.snapshotRetention);
    } catch (err) {
      await this.h.context.secrets.delete(db.secretKey).then(undefined, () => undefined);
      await db.remove().then(undefined, () => undefined);
      throw err;
    }
    await this.h.context.globalState.update(LAST_DRIVER_KEY, profile.driver);
    this.h.store.invalidate({ workspace: this.ws.id, kind: 'db', id: db.id });
    this.panel.dispose();
    void revealInTree(this.h, { kind: 'db', workspace: this.ws.id, id: db.id });
    const name = await this.h.store.dbName(this.ws.id, db.id);
    void vscode.window.showInformationMessage(`已连接 ${name}：${run.schema.tables.length} 张表。右键可以添加到画布。`);
    return { ok: true, tables: run.schema.tables.length, relations: run.schema.relations?.length ?? 0, elapsedMs: run.elapsedMs };
  }

  private async save(db: DbSource, msg: Extract<ConnectionWebviewMessage, { type: 'connect' }>): Promise<ConnectionResult> {
    const profile = await this.resolveProfile(msg.profile);
    const before = await db.readMeta();
    const driverChanged = before.connection.kind === 'secret' && !!before.connection.driver && before.connection.driver !== profile.driver;
    const meta: DbSourceMeta = {
      ...before,
      name: defaultConnectionName(profile),
      connection: { kind: 'secret', driver: profile.driver },
      defaultSchema: msg.defaultSchema?.trim() || undefined,
      exclude: msg.filters.exclude,
      include: msg.filters.include,
    };
    await this.h.context.secrets.store(db.secretKey, serializeConnection(profile));
    await db.writeMeta(meta);
    const tested = this.owner.cached(await this.cacheKey(profile, msg.filters));
    if (tested) await db.writeSnapshot(tested.raw, meta.snapshotRetention);
    this.h.tree.syncErrors.delete(`${db.workspace.id}/${db.id}`);
    this.h.store.invalidate({ workspace: db.workspace.id, kind: 'db', id: db.id });
    await this.h.context.globalState.update(LAST_DRIVER_KEY, profile.driver);
    this.panel.dispose();

    const name = await this.h.store.dbName(db.workspace.id, db.id);
    if (tested) {
      void vscode.window.showInformationMessage(`已保存“${name}”的连接，并用测试时读取的结构更新了快照（${tested.schema.tables.length} 张表）。`);
    } else {
      const hint = driverChanged ? '数据库类型已修改，已有快照来自原来的数据库，建议重新同步。' : '现在同步吗？';
      void vscode.window.showInformationMessage(`已保存“${name}”的连接。${hint}`, '立即同步').then((pick) => {
        if (pick) void vscode.commands.executeCommand('harness.db.sync', { workspace: db.workspace.id, kind: 'db', id: db.id });
      });
    }
    return tested
      ? { ok: true, tables: tested.schema.tables.length, relations: tested.schema.relations?.length ?? 0, elapsedMs: 0, cached: true }
      : { ok: true, tables: 0, relations: 0, elapsedMs: 0 };
  }

  private async importFile(): Promise<ConnectionResult> {
    const picked = this.pickedJson;
    if (!picked) throw new UserError('请先选择 tbls 导出的 JSON 文件');
    const schema = parseTblsJson(picked.text);
    const meta: DbSourceMeta = {
      version: 1,
      name: importedName(schema, picked.path),
      connection: { kind: 'none' },
      exclude: [...DEFAULT_DB_EXCLUDE],
      include: [],
      snapshotRetention: DEFAULT_SNAPSHOT_RETENTION,
    };
    const db = await this.ws.claimDb();
    try {
      await db.create(meta);
      await db.writeSnapshot(picked.text, meta.snapshotRetention);
    } catch (err) {
      await db.remove().then(undefined, () => undefined);
      throw err;
    }
    this.h.store.invalidate({ workspace: this.ws.id, kind: 'db', id: db.id });
    this.panel.dispose();
    void revealInTree(this.h, { kind: 'db', workspace: this.ws.id, id: db.id });
    const name = await this.h.store.dbName(this.ws.id, db.id);
    void vscode.window.showInformationMessage(`已导入 ${name}：${schema.tables.length} 张表。右键可以添加到画布。`);
    return { ok: true, tables: schema.tables.length, relations: schema.relations?.length ?? 0, elapsedMs: 0 };
  }

  private async pickFile(requestId: string, purpose: 'sqlite' | 'json'): Promise<void> {
    const [file] =
      (await vscode.window.showOpenDialog(
        purpose === 'sqlite'
          ? { title: '选择 SQLite 数据库文件', canSelectMany: false, filters: { SQLite: ['db', 'sqlite', 'sqlite3', 'db3'], 所有文件: ['*'] } }
          : { title: '选择 tbls 导出的 JSON 文件', canSelectMany: false, filters: { 'tbls JSON': ['json'] } },
      )) ?? [];
    if (!file) {
      this.post({ type: 'filePicked', requestId });
      return;
    }
    if (purpose === 'sqlite') {
      this.post({ type: 'filePicked', requestId, path: file.fsPath });
      return;
    }
    try {
      const text = await readText(file);
      const schema = parseTblsJson(text);
      this.pickedJson = { path: file.fsPath, text };
      this.post({ type: 'filePicked', requestId, path: file.fsPath, name: importedName(schema, file.fsPath), tables: schema.tables.length });
    } catch (err) {
      this.pickedJson = undefined;
      this.post({ type: 'filePicked', requestId, path: file.fsPath, error: (err as Error).message });
    }
  }

  private async reply(requestId: string, run: () => Promise<ConnectionResult>): Promise<void> {
    let result: ConnectionResult;
    try {
      result = await run();
    } catch (err) {
      if (err instanceof TblsResolveError) {
        result = { ok: false, ...friendlyMissingTblsError(err) };
      } else if (err instanceof TblsError) {
        result = { ok: false, ...friendlyTblsError(err.message, err.reason) };
      } else if (err instanceof UserError) {
        result = { ok: false, message: err.message };
      } else {
        result = { ok: false, message: maskSecret((err as Error).message, undefined, this.lastSecrets) };
      }
    }
    this.post({ type: 'result', requestId, ...result });
  }

  /**
   * Picks a local tbls and validates it *before* persisting the setting.
   *
   * Writing the setting unconditionally is what produced the silent "selected but broken" state:
   * any file (even a .txt) looked like a success. Now the file must run `--version` first, and a
   * failure leaves the previous setting untouched.
   */
  private async handlePickTblsPath(requestId: string): Promise<void> {
    const [file] = (await vscode.window.showOpenDialog({
      title: '选择 tbls 可执行文件',
      canSelectMany: false,
      filters: process.platform === 'win32'
        ? { 'tbls 可执行文件': ['exe', 'cmd', 'bat'], 所有文件: ['*'] }
        : { 所有文件: ['*'] },
    })) ?? [];
    if (!file) {
      this.post({ type: 'tblsPathPicked', requestId });
      return;
    }

    const info = await probeTblsVersion(file.fsPath);
    if (!info.ok) {
      this.post({ type: 'tblsPathPicked', requestId, path: file.fsPath, ok: false, error: info.error });
      return;
    }

    await vscode.workspace.getConfiguration('harness').update('tblsPath', file.fsPath, vscode.ConfigurationTarget.Global);
    this.post({ type: 'tblsPathPicked', requestId, path: file.fsPath, ok: true, version: info.version });
  }

  /** The "测试" button: run the same resolution the real run uses, then report the version. */
  private async handleTestTbls(requestId: string): Promise<void> {
    try {
      const resolved = await resolveTblsPath(this.h.context);
      const info = await probeTblsVersion(resolved);
      if (!info.ok) {
        this.post({ type: 'tblsTested', requestId, ok: false, error: info.error });
        return;
      }
      this.post({ type: 'tblsTested', requestId, ok: true, version: info.version ?? info.raw });
    } catch (err) {
      const friendly = err instanceof TblsResolveError ? friendlyMissingTblsError(err) : undefined;
      this.post({ type: 'tblsTested', requestId, ok: false, error: friendly?.message ?? (err as Error).message });
    }
  }

  private async handleInstallTbls(requestId: string): Promise<void> {
    const config = readTblsConfig();
    try {
      const installed = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Harness：正在下载 tbls v${config.version}…`, cancellable: true },
        (progress, token) => install(this.h.context, config.version, config.baseUrl, {
          token,
          onProgress: (message, increment) => (increment !== undefined ? progress.report({ increment }) : progress.report({ message })),
        }),
      );
      const info = await probeTblsVersion(installed.fsPath);
      this.post({ type: 'tblsInstalled', requestId, ok: true, path: installed.fsPath, version: info.version });
    } catch (err) {
      const detail = err instanceof TblsInstallError ? err.detail : undefined;
      this.post({ type: 'tblsInstalled', requestId, ok: false, error: (err as Error).message, detail });
    }
  }

  dispose(): void {
    this.disposed = true;
    this.abort?.abort();
    this.pickedJson = undefined;
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }
}

class UserError extends Error {}

/** Name of an offline db source: the schema name inside the file, else the file name. */
function importedName(schema: TblsSchema, path: string): string {
  return schema.name?.trim() || path.split(/[\\/]/).pop()?.replace(/\.json$/i, '') || '数据库';
}

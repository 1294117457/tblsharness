import { promises as nodeFs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { emptyCanvas, serializeCanvas, type CanvasFile } from '../shared/canvas';
import { CONNECTION_DRIVERS } from '../shared/connection';
import type { ComparisonPair, DesignExt } from '../shared/model';
import type { TblsSchema } from '../shared/tbls';
import {
  DEFAULT_DB_EXCLUDE,
  DEFAULT_SNAPSHOT_RETENTION,
  ID_PREFIX,
  nextSeq,
  type ComparisonsFile,
  type DbSourceMeta,
  type DesignSourceMeta,
  type HarnessRootMeta,
  type SeqKind,
  type SourceKind,
  type WorkspaceMeta,
} from '../shared/workspace';
import { parseExt, serializeDesign, type DesignDoc } from '../shared/designOps';
import {
  exists,
  listDirectories,
  listFiles,
  mkdirp,
  readJson,
  readTextIfExists,
  readYaml,
  removeRecursive,
  writeJson,
  writeText,
  writeYaml,
} from './fsUtil';

export const CANVAS_SUFFIX = '.canvas.json';

/**
 * Everything lives outside the user's projects:
 *
 * <root>/workspaces/<ws>/
 *   workspace.yml
 *   comparisons.json
 *   design/<id>/{source.yml, schema.json, ext.json}
 *   db/<id>/{source.yml, .tbls.yml?, snapshots/*.json}
 *   canvas/<id>.canvas.json
 */
export class HarnessStorage {
  constructor(private readonly context: vscode.ExtensionContext) {}

  get root(): vscode.Uri {
    const custom = vscode.workspace.getConfiguration('harness').get<string>('storageDir', '').trim();
    return custom ? vscode.Uri.file(custom) : this.context.globalStorageUri;
  }

  get workspacesDir(): vscode.Uri {
    return vscode.Uri.joinPath(this.root, 'workspaces');
  }

  workspace(id: string): HarnessWorkspace {
    return new HarnessWorkspace(id, vscode.Uri.joinPath(this.workspacesDir, id));
  }

  async listWorkspaces(): Promise<HarnessWorkspace[]> {
    const ids = await listDirectories(this.workspacesDir);
    return ids.map((id) => this.workspace(id));
  }

  async workspaceIds(): Promise<string[]> {
    return listDirectories(this.workspacesDir);
  }

  get rootMetaFile(): vscode.Uri {
    return vscode.Uri.joinPath(this.root, 'harness.json');
  }

  private async readRootMeta(): Promise<HarnessRootMeta> {
    try {
      const raw = await readJson<Partial<HarnessRootMeta>>(this.rootMetaFile);
      return { version: 1, seq: { workspace: Number(raw.seq?.workspace) || undefined } };
    } catch {
      return { version: 1, seq: {} };
    }
  }

  /** Creates `workspace<N>` with an empty first canvas. */
  async createWorkspace(name: string, firstCanvasName: string): Promise<HarnessWorkspace> {
    await mkdirp(this.workspacesDir);
    const root = await this.readRootMeta();
    const { id, n } = await claim(ID_PREFIX.workspace, await this.workspaceIds(), root.seq.workspace, (candidate) =>
      tryMkdir(this.workspace(candidate).dir),
    );
    const latest = await this.readRootMeta();
    await writeJson(this.rootMetaFile, { ...latest, seq: { ...latest.seq, workspace: Math.max(n, latest.seq.workspace ?? 0) } });

    const ws = this.workspace(id);
    await mkdirp(ws.designDir);
    await mkdirp(ws.dbDir);
    await mkdirp(ws.canvasDir);
    await ws.writeMeta({ version: 1, name, seq: {} });
    await ws.writeComparisons({ version: 1, pairs: [] });
    await ws.createCanvas(emptyCanvas(firstCanvasName));
    return ws;
  }

  /** Maps a file under the storage root back to what it belongs to. */
  locate(uri: vscode.Uri): Located | undefined {
    const rel = path.relative(this.workspacesDir.fsPath, uri.fsPath);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
    const parts = rel.split(/[\\/]/);
    const [workspace, area, id] = parts;
    if (!workspace) return undefined;
    if (area === 'design' || area === 'db') {
      return id ? { workspace, kind: area, id } : { workspace };
    }
    if (area === 'canvas' && id?.endsWith(CANVAS_SUFFIX)) {
      return { workspace, kind: 'canvas', id: id.slice(0, -CANVAS_SUFFIX.length) };
    }
    if (area === 'comparisons.json') {
      return { workspace, kind: 'comparisons' };
    }
    return { workspace };
  }
}

export type Located =
  | { workspace: string; kind?: undefined; id?: undefined }
  | { workspace: string; kind: SourceKind; id: string }
  | { workspace: string; kind: 'canvas'; id: string }
  | { workspace: string; kind: 'comparisons'; id?: undefined };

export class HarnessWorkspace {
  readonly metaFile: vscode.Uri;
  readonly comparisonsFile: vscode.Uri;
  readonly designDir: vscode.Uri;
  readonly dbDir: vscode.Uri;
  readonly canvasDir: vscode.Uri;

  constructor(
    readonly id: string,
    readonly dir: vscode.Uri,
  ) {
    this.metaFile = vscode.Uri.joinPath(dir, 'workspace.yml');
    this.comparisonsFile = vscode.Uri.joinPath(dir, 'comparisons.json');
    this.designDir = vscode.Uri.joinPath(dir, 'design');
    this.dbDir = vscode.Uri.joinPath(dir, 'db');
    this.canvasDir = vscode.Uri.joinPath(dir, 'canvas');
  }

  async readMeta(): Promise<WorkspaceMeta> {
    const raw = await readYaml<WorkspaceMeta>(this.metaFile);
    const seq: WorkspaceMeta['seq'] = {};
    for (const kind of ['design', 'db', 'canvas'] as SeqKind[]) {
      const n = Number(raw.seq?.[kind]);
      if (n > 0) seq[kind] = n;
    }
    return { version: 1, name: raw.name ? String(raw.name) : this.id, description: raw.description || undefined, seq };
  }

  /** Rewrites name/description while keeping the counters that may have moved since `meta` was read. */
  async writeMeta(meta: WorkspaceMeta): Promise<void> {
    const current = (await exists(this.metaFile)) ? (await this.readMeta()).seq : {};
    const seq = { ...meta.seq };
    for (const [k, v] of Object.entries(current ?? {}) as [SeqKind, number][]) seq[k] = Math.max(v, seq[k] ?? 0);
    const out: WorkspaceMeta = { version: 1, name: meta.name };
    if (meta.description) out.description = meta.description;
    out.seq = seq;
    await writeYaml(this.metaFile, out);
  }

  /**
   * Hands out the next `<kind><N>` id. `create` must fail (return false) when the target already exists,
   * which makes two windows creating at the same time pick different numbers.
   */
  private async allocate(kind: SeqKind, existing: string[], create: (id: string) => Promise<boolean>): Promise<string> {
    const meta = await this.readMeta();
    const { id, n } = await claim(ID_PREFIX[kind], existing, meta.seq?.[kind], create);
    const latest = await this.readMeta();
    await this.writeMeta({ ...latest, seq: { ...latest.seq, [kind]: Math.max(n, latest.seq?.[kind] ?? 0) } });
    return id;
  }

  async createDesign(meta: DesignSourceMeta, doc: DesignDoc): Promise<string> {
    await mkdirp(this.designDir);
    const id = await this.allocate('design', await this.designIds(), (c) => tryMkdir(this.design(c).dir));
    await this.design(id).create(meta, doc);
    return id;
  }

  /** Only claims the directory; the caller writes source.yml and removes the directory again on failure. */
  async claimDb(): Promise<DbSource> {
    await mkdirp(this.dbDir);
    const id = await this.allocate('db', await this.dbIds(), (c) => tryMkdir(this.db(c).dir));
    return this.db(id);
  }

  async createCanvas(canvas: CanvasFile): Promise<string> {
    await mkdirp(this.canvasDir);
    const text = serializeCanvas(canvas);
    return this.allocate('canvas', await this.canvasIds(), (c) => tryWriteNew(this.canvasUri(c), text));
  }

  design(id: string): DesignSource {
    return new DesignSource(this, id);
  }

  db(id: string): DbSource {
    return new DbSource(this, id);
  }

  source(kind: SourceKind, id: string): DesignSource | DbSource {
    return kind === 'design' ? this.design(id) : this.db(id);
  }

  async designIds(): Promise<string[]> {
    return listDirectories(this.designDir);
  }

  async dbIds(): Promise<string[]> {
    return listDirectories(this.dbDir);
  }

  async canvasIds(): Promise<string[]> {
    return (await listFiles(this.canvasDir, CANVAS_SUFFIX)).map((f) => f.slice(0, -CANVAS_SUFFIX.length));
  }

  canvasUri(id: string): vscode.Uri {
    return vscode.Uri.joinPath(this.canvasDir, `${id}${CANVAS_SUFFIX}`);
  }

  async readComparisons(): Promise<ComparisonsFile> {
    if (!(await exists(this.comparisonsFile))) return { version: 1, pairs: [] };
    const raw = await readJson<Partial<ComparisonsFile>>(this.comparisonsFile);
    return {
      version: 1,
      pairs: (raw.pairs ?? []).map((p) => ({
        design: p.design,
        db: p.db,
        tableMappings: p.tableMappings ?? {},
        acceptedDiffs: p.acceptedDiffs ?? [],
      })),
    };
  }

  writeComparisons(file: ComparisonsFile): Promise<void> {
    return writeJson(this.comparisonsFile, file);
  }

  async pair(design: string, db: string): Promise<ComparisonPair> {
    const file = await this.readComparisons();
    return file.pairs.find((p) => p.design === design && p.db === db) ?? { design, db, tableMappings: {}, acceptedDiffs: [] };
  }

  async updatePair(design: string, db: string, update: (pair: ComparisonPair) => ComparisonPair): Promise<void> {
    const file = await this.readComparisons();
    const i = file.pairs.findIndex((p) => p.design === design && p.db === db);
    const current = i >= 0 ? file.pairs[i] : { design, db, tableMappings: {}, acceptedDiffs: [] };
    const next = update(current);
    const pairs = i >= 0 ? file.pairs.map((p, j) => (j === i ? next : p)) : [...file.pairs, next];
    await this.writeComparisons({ version: 1, pairs });
  }
}

export class DesignSource {
  readonly kind = 'design' as const;
  readonly dir: vscode.Uri;
  readonly metaFile: vscode.Uri;
  readonly schemaFile: vscode.Uri;
  readonly extFile: vscode.Uri;

  constructor(
    readonly workspace: HarnessWorkspace,
    readonly id: string,
  ) {
    this.dir = vscode.Uri.joinPath(workspace.designDir, id);
    this.metaFile = vscode.Uri.joinPath(this.dir, 'source.yml');
    this.schemaFile = vscode.Uri.joinPath(this.dir, 'schema.json');
    this.extFile = vscode.Uri.joinPath(this.dir, 'ext.json');
  }

  async readMeta(): Promise<DesignSourceMeta> {
    const raw = await readYaml<DesignSourceMeta>(this.metaFile);
    return { version: 1, name: raw.name ? String(raw.name) : this.id, description: raw.description || undefined, createdFrom: raw.createdFrom };
  }

  writeMeta(meta: DesignSourceMeta): Promise<void> {
    return writeYaml(this.metaFile, meta);
  }

  async readDoc(): Promise<DesignDoc> {
    const schema = (await exists(this.schemaFile)) ? await readJson<TblsSchema>(this.schemaFile) : { tables: [], relations: [] };
    if (!Array.isArray(schema.tables)) throw new Error(`${this.schemaFile.fsPath} 缺少 tables 数组，不是 tbls 格式`);
    const extText = await readTextIfExists(this.extFile);
    const ext: DesignExt = parseExt(extText ? JSON.parse(extText) : undefined);
    return { schema, ext };
  }

  /** Returns the written texts so callers can recognise their own writes in file events. */
  async writeDoc(doc: DesignDoc): Promise<{ schema: string; ext: string }> {
    const text = serializeDesign(doc);
    await mkdirp(this.dir);
    await writeText(this.schemaFile, text.schema);
    await writeText(this.extFile, text.ext);
    return text;
  }

  async create(meta: DesignSourceMeta, doc: DesignDoc): Promise<void> {
    await mkdirp(this.dir);
    await this.writeMeta(meta);
    await this.writeDoc(doc);
  }

  remove(): Promise<void> {
    return removeRecursive(this.dir);
  }
}

export class DbSource {
  readonly kind = 'db' as const;
  readonly dir: vscode.Uri;
  readonly metaFile: vscode.Uri;
  readonly tblsConfigFile: vscode.Uri;
  readonly snapshotsDir: vscode.Uri;

  constructor(
    readonly workspace: HarnessWorkspace,
    readonly id: string,
  ) {
    this.dir = vscode.Uri.joinPath(workspace.dbDir, id);
    this.metaFile = vscode.Uri.joinPath(this.dir, 'source.yml');
    this.tblsConfigFile = vscode.Uri.joinPath(this.dir, '.tbls.yml');
    this.snapshotsDir = vscode.Uri.joinPath(this.dir, 'snapshots');
  }

  get secretKey(): string {
    return `harness.dsn:v2:${this.workspace.id}:${this.id}`;
  }

  async readMeta(): Promise<DbSourceMeta> {
    const raw = await readYaml<DbSourceMeta>(this.metaFile);
    const list = (v: unknown, fallback: string[]) => (Array.isArray(v) ? v.map(String) : fallback);
    return {
      version: 1,
      name: raw.name ? String(raw.name) : this.id,
      description: raw.description || undefined,
      connection:
        raw.connection?.kind === 'none'
          ? { kind: 'none' }
          : { kind: 'secret', driver: CONNECTION_DRIVERS.find((d) => d.id === (raw.connection as { driver?: string } | undefined)?.driver)?.id },
      defaultSchema: raw.defaultSchema || undefined,
      exclude: list(raw.exclude, DEFAULT_DB_EXCLUDE),
      include: list(raw.include, []),
      snapshotRetention: Number(raw.snapshotRetention) > 0 ? Number(raw.snapshotRetention) : DEFAULT_SNAPSHOT_RETENTION,
    };
  }

  writeMeta(meta: DbSourceMeta): Promise<void> {
    const connection = meta.connection.kind === 'secret' && meta.connection.driver ? meta.connection : { kind: meta.connection.kind };
    return writeYaml(this.metaFile, { ...meta, connection });
  }

  async create(meta: DbSourceMeta): Promise<void> {
    await mkdirp(this.snapshotsDir);
    await this.writeMeta(meta);
  }

  hasTblsConfig(): Promise<boolean> {
    return exists(this.tblsConfigFile);
  }

  async snapshots(): Promise<string[]> {
    return listFiles(this.snapshotsDir, '.json');
  }

  async latestSnapshot(): Promise<string | undefined> {
    return (await this.snapshots()).pop();
  }

  snapshotUri(name: string): vscode.Uri {
    return vscode.Uri.joinPath(this.snapshotsDir, name);
  }

  async readSnapshot(name: string): Promise<TblsSchema> {
    const schema = await readJson<TblsSchema>(this.snapshotUri(name));
    if (!Array.isArray(schema.tables)) throw new Error(`快照 ${name} 缺少 tables 数组，不是 tbls 格式`);
    return schema;
  }

  /** ISO timestamps sort lexicographically, so the newest snapshot is always last. */
  async writeSnapshot(raw: string, retention: number): Promise<string> {
    await mkdirp(this.snapshotsDir);
    const name = `${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    await writeText(this.snapshotUri(name), raw.endsWith('\n') ? raw : `${raw}\n`);
    const all = await this.snapshots();
    for (const old of all.slice(0, Math.max(0, all.length - retention))) {
      await vscode.workspace.fs.delete(this.snapshotUri(old));
    }
    return name;
  }

  remove(): Promise<void> {
    return removeRecursive(this.dir);
  }
}

const MAX_CLAIM_ATTEMPTS = 20;

async function claim(
  prefix: string,
  existing: string[],
  recorded: number | undefined,
  create: (id: string) => Promise<boolean>,
): Promise<{ id: string; n: number }> {
  let n = nextSeq(prefix, existing, recorded);
  for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt++, n++) {
    const id = `${prefix}${n}`;
    if (await create(id)) return { id, n };
  }
  throw new Error(`无法分配新的 ID（${prefix}${n - MAX_CLAIM_ATTEMPTS} 之后连续 ${MAX_CLAIM_ATTEMPTS} 个都已被占用）`);
}

/** Non-recursive on purpose: vscode.workspace.fs.createDirectory succeeds on existing directories. */
async function tryMkdir(uri: vscode.Uri): Promise<boolean> {
  try {
    await nodeFs.mkdir(uri.fsPath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}

async function tryWriteNew(uri: vscode.Uri, text: string): Promise<boolean> {
  try {
    await nodeFs.writeFile(uri.fsPath, text, { flag: 'wx' });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}

export function snapshotTakenAt(name: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.json$/.exec(name);
  return m ? `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z` : name.replace(/\.json$/, '');
}

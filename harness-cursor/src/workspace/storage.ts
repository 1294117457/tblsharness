import { promises as nodeFs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { CanvasFile } from '../shared/canvas';
import { CONNECTION_DRIVERS } from '../shared/connection';
import type { DesignExt } from '../shared/model';
import type { TblsSchema } from '../shared/tbls';
import {
  DEFAULT_DB_EXCLUDE,
  DEFAULT_SNAPSHOT_RETENTION,
  ID_PREFIX,
  nextSeq,
  type ComparisonsFile,
  type ComparisonEntry,
  type DbSourceMeta,
  type DesignMeta,
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

export const CANVAS_SUFFIX = '.json';
export const DIAGRAM_SUFFIX = '.md';
const CANVAS_ID = /^canvas\d+$/;
const DIAGRAM_ID = /^diagram\d+$/;

/**
 * Everything lives outside the user's projects:
 *
 * <root>/workspaces/<ws>/
 *   workspace.yml
 *   design/<id>/{design.yml, schema.json, ext.json, comparisons.json, diagrams/<diagramN>.md, canvases/<canvasN>.json}
 *   db/<id>/{source.yml, .tbls.yml?, snapshots/*.json}
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

  async createWorkspace(name: string): Promise<HarnessWorkspace> {
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
    await ws.writeMeta({ version: 1, name, seq: {} });
    return ws;
  }

  /** Maps a file under the storage root back to what it belongs to. */
  locate(uri: vscode.Uri): Located | undefined {
    const rel = path.relative(this.workspacesDir.fsPath, uri.fsPath);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
    const parts = rel.split(/[\\/]/);
    const [workspace, area, id, sub, file] = parts;
    if (!workspace) return undefined;
    if (area === 'design' && id && sub === 'diagrams') {
      const diagram = file?.endsWith(DIAGRAM_SUFFIX) ? file.slice(0, -DIAGRAM_SUFFIX.length) : undefined;
      return { workspace, kind: 'diagram', id, diagram: diagram && DIAGRAM_ID.test(diagram) ? diagram : undefined };
    }
    if (area === 'design' && id && sub === 'canvases') {
      const canvas = file?.endsWith(CANVAS_SUFFIX) ? file.slice(0, -CANVAS_SUFFIX.length) : undefined;
      return { workspace, kind: 'canvas', id, design: id, canvas: canvas && CANVAS_ID.test(canvas) ? canvas : undefined };
    }
    if (area === 'design' && id && sub === 'comparisons.json') {
      return { workspace, kind: 'comparisons', id };
    }
    if (area === 'design' || area === 'db') {
      return id ? { workspace, kind: area, id } : { workspace };
    }
    return { workspace };
  }
}

export type Located =
  | { workspace: string; kind?: undefined; id?: undefined }
  | { workspace: string; kind: SourceKind; id: string }
  /** Canvas inside a design: `design/<designN>/canvases/<canvasN>.json`. */
  | { workspace: string; kind: 'canvas'; id: string; design: string; canvas?: string }
  /** `id` is the design ID; `diagram` is missing for the directory itself or unrelated files in it. */
  | { workspace: string; kind: 'diagram'; id: string; diagram?: string }
  | { workspace: string; kind: 'comparisons'; id: string };

export class HarnessWorkspace {
  readonly metaFile: vscode.Uri;
  readonly designDir: vscode.Uri;
  readonly dbDir: vscode.Uri;

  constructor(
    readonly id: string,
    readonly dir: vscode.Uri,
  ) {
    this.metaFile = vscode.Uri.joinPath(dir, 'workspace.yml');
    this.designDir = vscode.Uri.joinPath(dir, 'design');
    this.dbDir = vscode.Uri.joinPath(dir, 'db');
  }

  async readMeta(): Promise<WorkspaceMeta> {
    const raw = await readYaml<WorkspaceMeta>(this.metaFile);
    const seq: WorkspaceMeta['seq'] = {};
    for (const kind of ['design', 'db'] as SeqKind[]) {
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

  async createDesign(meta: DesignMeta, doc: DesignDoc): Promise<string> {
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

  design(id: string): Design {
    return new Design(this, id);
  }

  db(id: string): DbSource {
    return new DbSource(this, id);
  }

  source(kind: SourceKind, id: string): Design | DbSource {
    return kind === 'design' ? this.design(id) : this.db(id);
  }

  async designIds(): Promise<string[]> {
    return listDirectories(this.designDir);
  }

  async dbIds(): Promise<string[]> {
    return listDirectories(this.dbDir);
  }
}

export class Design {
  readonly kind = 'design' as const;
  readonly dir: vscode.Uri;
  readonly metaFile: vscode.Uri;
  readonly schemaFile: vscode.Uri;
  readonly extFile: vscode.Uri;
  readonly comparisonsFile: vscode.Uri;

  constructor(
    readonly workspace: HarnessWorkspace,
    readonly id: string,
  ) {
    this.dir = vscode.Uri.joinPath(workspace.designDir, id);
    this.metaFile = vscode.Uri.joinPath(this.dir, 'design.yml');
    this.schemaFile = vscode.Uri.joinPath(this.dir, 'schema.json');
    this.extFile = vscode.Uri.joinPath(this.dir, 'ext.json');
    this.comparisonsFile = vscode.Uri.joinPath(this.dir, 'comparisons.json');
  }

  async readMeta(): Promise<DesignMeta> {
    const raw = await readYaml<DesignMeta>(this.metaFile);
    const meta: DesignMeta = {
      version: 1,
      name: raw.name ? String(raw.name) : this.id,
      description: raw.description || undefined,
      createdFrom: raw.createdFrom,
    };
    if (Array.isArray(raw.sources) && raw.sources.length > 0) {
      meta.sources = raw.sources.map(String);
    }
    const diagram = Number(raw.seq?.diagram);
    const canvas = Number(raw.seq?.canvas);
    if (diagram > 0 || canvas > 0) {
      meta.seq = {};
      if (diagram > 0) meta.seq.diagram = diagram;
      if (canvas > 0) meta.seq.canvas = canvas;
    }
    if (raw.lastCanvas) meta.lastCanvas = String(raw.lastCanvas);
    return meta;
  }

  /** Keeps the diagram/canvas counters when they moved on disk since `meta` was read. */
  async writeMeta(meta: DesignMeta): Promise<void> {
    const current = (await exists(this.metaFile)) ? await this.readMeta() : undefined;
    const diagram = Math.max(current?.seq?.diagram ?? 0, meta.seq?.diagram ?? 0);
    const canvas = Math.max(current?.seq?.canvas ?? 0, meta.seq?.canvas ?? 0);
    const out: DesignMeta = { version: 1, name: meta.name };
    if (meta.description) out.description = meta.description;
    if (meta.createdFrom) out.createdFrom = meta.createdFrom;
    if (meta.sources && meta.sources.length > 0) out.sources = meta.sources;
    const seq: NonNullable<DesignMeta['seq']> = {};
    if (canvas > 0) seq.canvas = canvas;
    if (diagram > 0) seq.diagram = diagram;
    if (Object.keys(seq).length > 0) out.seq = seq;
    if (meta.lastCanvas) out.lastCanvas = meta.lastCanvas;
    await writeYaml(this.metaFile, out);
  }

  // ── Diagrams ──────────────────────────────────────────────────────

  get diagramsDir(): vscode.Uri {
    return vscode.Uri.joinPath(this.dir, 'diagrams');
  }

  diagramUri(id: string): vscode.Uri {
    return vscode.Uri.joinPath(this.diagramsDir, `${id}${DIAGRAM_SUFFIX}`);
  }

  async diagramIds(): Promise<string[]> {
    const ids = (await listFiles(this.diagramsDir, DIAGRAM_SUFFIX)).map((f) => f.slice(0, -DIAGRAM_SUFFIX.length));
    return ids.filter((id) => DIAGRAM_ID.test(id)).sort((a, b) => Number(a.slice(7)) - Number(b.slice(7)));
  }

  async readDiagramText(id: string): Promise<string> {
    return (await readTextIfExists(this.diagramUri(id))) ?? '';
  }

  async createDiagram(text: string): Promise<string> {
    await mkdirp(this.diagramsDir);
    const meta = await this.readMeta();
    const { id, n } = await claim(ID_PREFIX.diagram, await this.diagramIds(), meta.seq?.diagram, (c) => tryWriteNew(this.diagramUri(c), text));
    const latest = await this.readMeta();
    await this.writeMeta({ ...latest, seq: { ...latest.seq, diagram: Math.max(n, latest.seq?.diagram ?? 0) } });
    return id;
  }

  async removeDiagram(id: string): Promise<void> {
    await vscode.workspace.fs.delete(this.diagramUri(id), { useTrash: false });
  }

  // ── Canvases ──────────────────────────────────────────────────────

  get canvasesDir(): vscode.Uri {
    return vscode.Uri.joinPath(this.dir, 'canvases');
  }

  canvasUri(id: string): vscode.Uri {
    return vscode.Uri.joinPath(this.canvasesDir, `${id}${CANVAS_SUFFIX}`);
  }

  async canvasIds(): Promise<string[]> {
    const ids = (await listFiles(this.canvasesDir, CANVAS_SUFFIX)).map((f) => f.slice(0, -CANVAS_SUFFIX.length));
    return ids.filter((id) => CANVAS_ID.test(id)).sort((a, b) => Number(a.slice(6)) - Number(b.slice(6)));
  }

  async readCanvas(id: string): Promise<CanvasFile> {
    return readJson<CanvasFile>(this.canvasUri(id));
  }

  async createCanvas(text: string): Promise<string> {
    await mkdirp(this.canvasesDir);
    const meta = await this.readMeta();
    const { id, n } = await claim(ID_PREFIX.canvas, await this.canvasIds(), meta.seq?.canvas, (c) => tryWriteNew(this.canvasUri(c), text));
    const latest = await this.readMeta();
    await this.writeMeta({ ...latest, seq: { ...latest.seq, canvas: Math.max(n, latest.seq?.canvas ?? 0) } });
    return id;
  }

  async removeCanvas(id: string): Promise<void> {
    await vscode.workspace.fs.delete(this.canvasUri(id), { useTrash: false });
  }

  // ── Comparisons ───────────────────────────────────────────────────

  async readComparisons(): Promise<ComparisonsFile> {
    if (!(await exists(this.comparisonsFile))) return { version: 1, dbs: {} };
    const raw = await readJson<Partial<ComparisonsFile>>(this.comparisonsFile);
    const dbs: Record<string, ComparisonEntry> = {};
    if (raw.dbs && typeof raw.dbs === 'object') {
      for (const [key, val] of Object.entries(raw.dbs)) {
        dbs[key] = {
          tableMappings: val?.tableMappings ?? undefined,
          acceptedDiffs: val?.acceptedDiffs ?? undefined,
        };
      }
    }
    return { version: 1, dbs };
  }

  writeComparisons(file: ComparisonsFile): Promise<void> {
    return writeJson(this.comparisonsFile, file);
  }

  async comparisonEntry(dbId: string): Promise<ComparisonEntry> {
    const file = await this.readComparisons();
    return file.dbs[dbId] ?? {};
  }

  async writeComparisonEntry(dbId: string, entry: ComparisonEntry): Promise<void> {
    const file = await this.readComparisons();
    file.dbs[dbId] = entry;
    return this.writeComparisons(file);
  }

  // ── Design doc (schema + ext) ─────────────────────────────────────

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

  async create(meta: DesignMeta, doc: DesignDoc): Promise<void> {
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

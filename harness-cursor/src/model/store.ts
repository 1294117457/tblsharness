import * as vscode from 'vscode';
import { diffSchemas } from '../diff/diff';
import { connectionLabel, parseStoredConnection } from '../shared/connection';
import type { DesignDoc } from '../shared/designOps';
import type { NormalizedSchema } from '../shared/model';
import type { ComparisonData } from '../shared/protocol';
import { uniqueName, type SourceKind } from '../shared/workspace';
import { readTextIfExists } from '../workspace/fsUtil';
import { snapshotTakenAt, type HarnessStorage, type Located } from '../workspace/storage';
import { normalize } from './normalize';

export interface LoadedSource {
  kind: SourceKind;
  id: string;
  name: string;
  schema?: NormalizedSchema;
  snapshot?: { file: string; takenAt: string };
  error?: string;
}

export interface StoreChange {
  workspace?: string;
  kind?: SourceKind | 'canvas' | 'comparisons' | 'workspace';
  id?: string;
}

/** Caches normalized models per source; everything else reads through here so all views stay consistent. */
export class ModelStore implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<StoreChange>();
  readonly onDidChange = this.emitter.event;

  private readonly sources = new Map<string, Promise<LoadedSource>>();
  private readonly designDocs = new Map<string, Promise<DesignDoc>>();
  /** uri -> text we wrote last; lets the file watcher skip our own writes. */
  private readonly ownWrites = new Map<string, string>();
  /** workspace -> db id -> display name. */
  private readonly dbNames = new Map<string, Promise<Map<string, string>>>();

  private readonly secretSubscription: vscode.Disposable;

  constructor(
    readonly storage: HarnessStorage,
    private readonly secrets: vscode.SecretStorage,
  ) {
    // Connections can also change in another window; names derive from them.
    this.secretSubscription = secrets.onDidChange((e) => {
      const m = /^harness\.dsn:v2:([^:]+):(.+)$/.exec(e.key);
      if (m) this.invalidate({ workspace: m[1], kind: 'db', id: m[2] });
    });
  }

  /**
   * UI name of a db source: `host:port/db` from the saved connection, else the name in source.yml.
   * Contains the host, so it is for the UI only; anything facing the AI must use the id.
   */
  async dbName(workspace: string, id: string): Promise<string> {
    let entry = this.dbNames.get(workspace);
    if (!entry) {
      entry = this.loadDbNames(workspace);
      entry.catch(() => this.dbNames.delete(workspace));
      this.dbNames.set(workspace, entry);
    }
    return (await entry).get(id) ?? id;
  }

  /** All db names of a workspace at once, so two sources pointing at the same database get " (2)". */
  private async loadDbNames(workspace: string): Promise<Map<string, string>> {
    const ws = this.storage.workspace(workspace);
    const ids = (await ws.dbIds()).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const base = await Promise.all(
      ids.map(async (id) => {
        const db = ws.db(id);
        const meta = await db.readMeta().catch(() => undefined);
        if (meta?.connection.kind === 'secret') {
          const stored = await Promise.resolve(this.secrets.get(db.secretKey)).catch(() => undefined);
          const label = stored ? connectionLabel(parseStoredConnection(stored)) : undefined;
          if (label) return label;
        }
        return meta?.name || id;
      }),
    );
    const names = new Map<string, string>();
    const taken: string[] = [];
    ids.forEach((id, i) => {
      const name = uniqueName(base[i], taken);
      taken.push(name);
      names.set(id, name);
    });
    return names;
  }

  source(workspace: string, kind: SourceKind, id: string, snapshot?: string | null): Promise<LoadedSource> {
    const key = cacheKey(workspace, kind, id, snapshot);
    let entry = this.sources.get(key);
    if (!entry) {
      entry = this.load(workspace, kind, id, snapshot ?? undefined);
      this.sources.set(key, entry);
    }
    return entry;
  }

  designDoc(workspace: string, id: string): Promise<DesignDoc> {
    const key = cacheKey(workspace, 'design', id);
    let entry = this.designDocs.get(key);
    if (!entry) {
      entry = this.storage.workspace(workspace).design(id).readDoc();
      entry.catch(() => this.designDocs.delete(key));
      this.designDocs.set(key, entry);
    }
    return entry.then((doc) => structuredClone(doc));
  }

  async writeDesignDoc(workspace: string, id: string, doc: DesignDoc): Promise<void> {
    const source = this.storage.workspace(workspace).design(id);
    const text = await source.writeDoc(doc);
    this.ownWrites.set(source.schemaFile.toString(), text.schema);
    this.ownWrites.set(source.extFile.toString(), text.ext);
    this.invalidate({ workspace, kind: 'design', id });
  }

  noteOwnWrite(uri: vscode.Uri, text: string): void {
    this.ownWrites.set(uri.toString(), text);
  }

  async comparison(workspace: string, designId: string, dbId: string, snapshot?: string | null): Promise<ComparisonData | undefined> {
    const [design, db, pair] = await Promise.all([
      this.source(workspace, 'design', designId),
      this.source(workspace, 'db', dbId, snapshot),
      this.storage.workspace(workspace).pair(designId, dbId),
    ]);
    if (!design.schema || !db.schema) return undefined;
    return { diff: diffSchemas(design.schema, db.schema, pair), tableMappings: pair.tableMappings };
  }

  invalidate(change: StoreChange): void {
    const prefix = [change.workspace, change.kind === 'design' || change.kind === 'db' ? change.kind : undefined, change.id]
      .filter((p) => p !== undefined)
      .join('/');
    const affectsModels = change.kind === undefined || change.kind === 'design' || change.kind === 'db' || change.kind === 'workspace';
    if (affectsModels) {
      if (change.workspace) this.dbNames.delete(change.workspace);
      else this.dbNames.clear();
      for (const map of [this.sources, this.designDocs] as Map<string, unknown>[]) {
        for (const key of [...map.keys()]) {
          if (!prefix || key === prefix || key.startsWith(`${prefix}/`) || key.startsWith(`${prefix}@`)) map.delete(key);
        }
      }
    }
    this.emitter.fire(change);
  }

  /** Called by the storage file watcher. */
  async onFileEvent(uri: vscode.Uri): Promise<void> {
    const own = this.ownWrites.get(uri.toString());
    if (own !== undefined) {
      const text = await readTextIfExists(uri);
      if (text === own) return;
      this.ownWrites.delete(uri.toString());
    }
    const located = this.storage.locate(uri);
    if (!located) return;
    this.invalidate(toChange(located));
  }

  private async load(workspace: string, kind: SourceKind, id: string, snapshot?: string): Promise<LoadedSource> {
    const ws = this.storage.workspace(workspace);
    try {
      if (kind === 'design') {
        const source = ws.design(id);
        const [meta, doc] = await Promise.all([source.readMeta(), this.designDoc(workspace, id)]);
        return { kind, id, name: meta.name, schema: normalize(doc.schema, { source: 'design', ext: doc.ext }) };
      }
      const source = ws.db(id);
      const [meta, name] = await Promise.all([source.readMeta(), this.dbName(workspace, id)]);
      const file = snapshot ?? (await source.latestSnapshot());
      if (!file) return { kind, id, name };
      const raw = await source.readSnapshot(file);
      return {
        kind,
        id,
        name,
        schema: normalize(raw, { source: 'db', defaultSchema: meta.defaultSchema }),
        snapshot: { file, takenAt: snapshotTakenAt(file) },
      };
    } catch (err) {
      return { kind, id, name: id, error: (err as Error).message };
    }
  }

  dispose(): void {
    this.secretSubscription.dispose();
    this.emitter.dispose();
  }
}

function cacheKey(workspace: string, kind: SourceKind, id: string, snapshot?: string | null): string {
  return snapshot ? `${workspace}/${kind}/${id}@${snapshot}` : `${workspace}/${kind}/${id}`;
}

function toChange(located: Located): StoreChange {
  if (!located.kind) return { workspace: located.workspace, kind: 'workspace' };
  return { workspace: located.workspace, kind: located.kind, id: located.id };
}

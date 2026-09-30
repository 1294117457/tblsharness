import type * as vscode from 'vscode';
import { parseCanvas, removeDbFromCanvas, renameTableInCanvas, serializeCanvas, type CanvasFile } from '../shared/canvas';
import type { ComparisonEntry, ComparisonsFile, DesignMeta } from '../shared/workspace';
import { readTextIfExists, writeText } from './fsUtil';

/** Implemented by the canvas editor so an open (possibly dirty) layout is rewritten in memory instead of on disk. */
export interface OpenCanvasRegistry {
  transformIfOpen(uri: vscode.Uri, transform: (canvas: CanvasFile) => CanvasFile): boolean;
}

/** Subset of the Design class from storage.ts that refactoring operations need. */
export interface DesignHandle {
  readonly layoutUri: vscode.Uri;
  readMeta(): Promise<DesignMeta>;
  writeMeta(meta: DesignMeta): Promise<void>;
  readComparisons(): Promise<ComparisonsFile>;
  writeComparisons(file: ComparisonsFile): Promise<void>;
}

/** Subset of the HarnessWorkspace class from storage.ts. */
export interface WorkspaceHandle {
  designIds(): Promise<string[]>;
  design(id: string): DesignHandle;
}

export async function transformLayout(design: DesignHandle, registry: OpenCanvasRegistry, transform: (canvas: CanvasFile) => CanvasFile): Promise<void> {
  const uri = design.layoutUri;
  if (registry.transformIfOpen(uri, transform)) return;
  const text = await readTextIfExists(uri);
  if (text === undefined) return;
  const before = parseCanvas(text);
  const after = transform(before);
  if (after !== before) await writeText(uri, serializeCanvas(after));
}

/** Renames a design table in the layout and in the comparisons of the design. */
export async function renameDesignTable(design: DesignHandle, registry: OpenCanvasRegistry, from: string, to: string): Promise<void> {
  await transformLayout(design, registry, (c) => renameTableInCanvas(c, from, to));

  const file = await design.readComparisons();
  let changed = false;
  const dbs: Record<string, ComparisonEntry> = {};
  for (const [dbId, entry] of Object.entries(file.dbs)) {
    let updated = entry;
    if (entry.tableMappings) {
      const renamed = Object.fromEntries(Object.entries(entry.tableMappings).map(([k, v]) => [k === from ? to : k, v]));
      if (Object.keys(renamed).join('\0') !== Object.keys(entry.tableMappings).join('\0')) {
        updated = { ...updated, tableMappings: renamed };
        changed = true;
      }
    }
    if (entry.acceptedDiffs) {
      const renamed = entry.acceptedDiffs.map((id) => {
        const parts = id.split(':');
        return parts[0] !== 'table_missing_in_design' && parts[1] === from ? [parts[0], to, ...parts.slice(2)].join(':') : id;
      });
      if (renamed.some((d, i) => d !== entry.acceptedDiffs![i])) {
        updated = { ...updated, acceptedDiffs: renamed };
        changed = true;
      }
    }
    dbs[dbId] = updated;
  }
  if (changed) await design.writeComparisons({ ...file, dbs });
}

/** Removes a database from every design in the workspace: their sources list, layouts, and comparisons. */
export async function deleteDbFromDesigns(workspace: WorkspaceHandle, registry: OpenCanvasRegistry, dbId: string): Promise<void> {
  for (const designId of await workspace.designIds()) {
    const design = workspace.design(designId);
    await transformLayout(design, registry, (c) => removeDbFromCanvas(c, dbId));

    const meta = await design.readMeta();
    if (meta.sources?.includes(dbId)) await design.writeMeta({ ...meta, sources: meta.sources.filter((s) => s !== dbId) });

    const file = await design.readComparisons();
    if (dbId in file.dbs) {
      const { [dbId]: _removed, ...rest } = file.dbs;
      await design.writeComparisons({ ...file, dbs: rest });
    }
  }
}

/** Names of designs whose canvas shows tables of the given db. Used in delete confirmations. */
export async function designNamesReferencingDb(workspace: WorkspaceHandle, dbId: string): Promise<string[]> {
  const names: string[] = [];
  for (const designId of await workspace.designIds()) {
    const design = workspace.design(designId);
    try {
      const canvas = parseCanvas((await readTextIfExists(design.layoutUri)) ?? '');
      const meta = await design.readMeta();
      if (canvas.nodes.some((n) => n.source === dbId) || meta.sources?.includes(dbId)) names.push(meta.name);
    } catch {
      // skip unreadable layouts
    }
  }
  return names;
}

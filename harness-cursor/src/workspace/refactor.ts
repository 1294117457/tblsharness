import type * as vscode from 'vscode';
import { parseCanvas, removeSourceFromCanvas, renameTableInCanvas, serializeCanvas, type CanvasFile } from '../shared/canvas';
import type { SourceKind } from '../shared/workspace';
import { readText, writeText } from './fsUtil';
import type { HarnessStorage } from './storage';

/** Implemented by the canvas editor so open (possibly dirty) canvases are rewritten in memory instead of on disk. */
export interface OpenCanvasRegistry {
  transformIfOpen(uri: vscode.Uri, transform: (canvas: CanvasFile) => CanvasFile): boolean;
}

export async function transformCanvases(
  storage: HarnessStorage,
  registry: OpenCanvasRegistry,
  workspaceId: string,
  transform: (canvas: CanvasFile) => CanvasFile,
): Promise<void> {
  const ws = storage.workspace(workspaceId);
  for (const id of await ws.canvasIds()) {
    const uri = ws.canvasUri(id);
    if (registry.transformIfOpen(uri, transform)) continue;
    const before = parseCanvas(await readText(uri));
    const after = transform(before);
    if (after !== before) {
      await writeText(uri, serializeCanvas(after));
    }
  }
}

export async function renameDesignTable(
  storage: HarnessStorage,
  registry: OpenCanvasRegistry,
  workspaceId: string,
  designId: string,
  from: string,
  to: string,
): Promise<void> {
  await transformCanvases(storage, registry, workspaceId, (c) => renameTableInCanvas(c, 'design', designId, from, to));
  const ws = storage.workspace(workspaceId);
  const file = await ws.readComparisons();
  if (!file.pairs.some((p) => p.design === designId)) return;
  await ws.writeComparisons({
    ...file,
    pairs: file.pairs.map((p) => {
      if (p.design !== designId) return p;
      const tableMappings = Object.fromEntries(Object.entries(p.tableMappings).map(([k, v]) => [k === from ? to : k, v]));
      const acceptedDiffs = p.acceptedDiffs.map((id) => {
        const parts = id.split(':');
        return parts[0] !== 'table_missing_in_design' && parts[1] === from ? [parts[0], to, ...parts.slice(2)].join(':') : id;
      });
      return { ...p, tableMappings, acceptedDiffs };
    }),
  });
}

export async function removeSourceReferences(
  storage: HarnessStorage,
  registry: OpenCanvasRegistry,
  workspaceId: string,
  kind: SourceKind,
  id: string,
): Promise<void> {
  await transformCanvases(storage, registry, workspaceId, (c) => removeSourceFromCanvas(c, kind, id));
  const ws = storage.workspace(workspaceId);
  const file = await ws.readComparisons();
  const pairs = file.pairs.filter((p) => (kind === 'design' ? p.design !== id : p.db !== id));
  if (pairs.length !== file.pairs.length) {
    await ws.writeComparisons({ ...file, pairs });
  }
}

/** Names of canvases in the workspace that reference the source; shown before deleting it. */
export async function canvasesReferencing(storage: HarnessStorage, workspaceId: string, kind: SourceKind, id: string): Promise<string[]> {
  const ws = storage.workspace(workspaceId);
  const names: string[] = [];
  for (const canvasId of await ws.canvasIds()) {
    try {
      const canvas = parseCanvas(await readText(ws.canvasUri(canvasId)));
      if (canvas.sources.some((s) => s.kind === kind && s.ref === id)) names.push(canvas.name);
    } catch {
      // An unreadable canvas cannot reference anything we could update.
    }
  }
  return names;
}

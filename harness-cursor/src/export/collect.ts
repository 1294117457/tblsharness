/**
 * Gathers what can be exported from a design: its tables, its diagrams and the partition
 * tree they sit in.
 *
 * Everything here goes through `ModelStore`, so the export lists exactly what the canvas
 * shows. The heavy lifting (rendering the files) is `buildExport`, which takes no vscode.
 */
import * as vscode from 'vscode';
import type { Harness } from '../commands/common';
import { DESIGN_SOURCE, nodeId, partitionPath, type CanvasFile } from '../shared/canvas';
import type { NRelation } from '../shared/model';
import { exportKey, type ExportItem, type ExportLevel, type ExportRequest } from '../shared/protocol';
import type { ExportDiagramInput, ExportTableInput } from './builder';

/** Everything needed to build the export, gathered up front so `buildExport` stays pure. */
export interface CollectedExport {
  request: ExportRequest;
  tables: ExportTableInput[];
  designRelations: NRelation[];
  dbRelations: Map<string, NRelation[]>;
  diagrams: ExportDiagramInput[];
  /** Resolves the webview's chosen keys back to real items; the webview cannot invent names. */
  byKey: Map<string, ExportItem>;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** `订单库-20261005-0930`; sortable and legal on every filesystem. */
export function stamp(date: Date): string {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

/** Where an export goes when the user does not pick a folder: outside every workspace, so nothing rescans. */
export function defaultExportDir(context: vscode.ExtensionContext): vscode.Uri {
  return vscode.Uri.joinPath(context.globalStorageUri, 'exports');
}

/** Partitions, outermost first, plus the root canvas as the first entry. */
export function collectLevels(canvas: CanvasFile, designName: string): ExportLevel[] {
  const levels: ExportLevel[] = [{ id: undefined, name: designName, depth: 0 }];
  for (const p of canvas.partitions) {
    // depth comes from the real ancestry, so nesting matches what the canvas shows.
    levels.push({ id: p.id, name: p.name, description: p.description, parent: p.parent, depth: partitionPath(canvas, p.id).length });
  }
  return levels;
}

export async function collectExport(h: Harness, workspace: string, design: string): Promise<CollectedExport> {
  const designStore = h.storage.workspace(workspace).design(design);
  const [meta, canvas, designData] = await Promise.all([designStore.readMeta(), h.canvases.layout(workspace, design), h.store.source(workspace, 'design', design)]);
  const designSchema = designData.schema;

  const items: ExportItem[] = [];
  const tables: ExportTableInput[] = [];

  // Which tables have a node on the canvas, and in which partition.
  const nodeOf = new Map<string, { partition?: string }>();
  for (const n of canvas.nodes) nodeOf.set(nodeId(n.source, n.table), { partition: n.partition });

  if (designSchema) {
    for (const table of designSchema.tables) {
      const node = nodeOf.get(nodeId(DESIGN_SOURCE, table.key));
      const item: ExportItem = {
        kind: 'design-table',
        key: table.key,
        rawName: table.rawName,
        comment: table.comment,
        partition: node?.partition,
        onCanvas: !!node,
        columns: table.columns.length,
      };
      items.push(item);
      tables.push({ item: item as Extract<ExportItem, { kind: 'design-table' }>, table });
    }
  }

  // Database tables, grouped per source. Only the id ever leaves this file: a db name can
  // carry a host (`dbName` returns `host:port/db`), which must not reach the export.
  const dbRelations = new Map<string, NRelation[]>();
  /** Display name of every db source this canvas uses, so the dialog can render it without another round-trip. */
  const dbLabels: Record<string, string> = {};
  for (const dbId of meta.sources ?? []) {
    dbLabels[dbId] = await h.store.dbName(workspace, dbId);
    const data = await h.store.source(workspace, 'db', dbId);
    if (!data.schema) continue;
    dbRelations.set(dbId, data.schema.relations);
    for (const table of data.schema.tables) {
      const node = nodeOf.get(nodeId(dbId, table.key));
      const item: ExportItem = {
        kind: 'db-table',
        source: dbId,
        key: table.key,
        rawName: table.rawName,
        comment: table.comment,
        partition: node?.partition,
        onCanvas: !!node,
        columns: table.columns.length,
      };
      items.push(item);
      tables.push({ item: item as Extract<ExportItem, { kind: 'db-table' }>, table });
    }
  }

  const diagramItems = await h.diagrams.list(workspace, design);
  const diagrams: ExportDiagramInput[] = [];
  for (const { id, file } of diagramItems) {
    const node = canvas.diagrams.find((d) => d.id === id);
    const item: ExportItem = {
      kind: 'diagram',
      id,
      key: exportKey({ kind: 'diagram', id, key: '', name: file.meta.name, type: file.meta.type, onCanvas: !!node }),
      name: file.meta.name,
      type: file.meta.type,
      partition: node?.partition,
      onCanvas: !!node,
    };
    // `text()` reads the open editor first, so unsaved edits are exported too.
    const raw = await h.diagrams.text({ workspace, design, diagram: id });
    items.push(item);
    diagrams.push({ item: item as Extract<ExportItem, { kind: 'diagram' }>, raw });
  }

  const levels = collectLevels(canvas, meta.name);
  const request: ExportRequest = {
    requestId: '',
    dbLabels,
    items,
    levels,
    suggestedPath: defaultExportDir(h.context).fsPath,
    designName: meta.name,
    driverLabel: designSchema?.driver?.name,
  };
  return {
    request,
    tables,
    designRelations: designSchema?.relations ?? [],
    dbRelations,
    diagrams,
    byKey: new Map(items.map((i) => [exportKey(i), i])),
  };
}

/** Rough byte size of an export, so the dialog can warn before the user picks 300 tables. */
export function estimateSize(counts: { designTables: number; dbTables: number; diagrams: number }): number {
  // A table file is a heading plus one Markdown row per column; a diagram is whatever it is.
  return counts.designTables * 900 + counts.dbTables * 900 + counts.diagrams * 1200;
}

export function formatSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

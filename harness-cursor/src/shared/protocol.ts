import type { CanvasEdit, CanvasFile, ItemRef, MoveItem, Viewport } from './canvas';
import type { ClipboardMode, Position } from './clipboard';
import type { DesignOp } from './designOps';
import type { DiagramType } from './diagram';
import type { DiffResult, NormalizedSchema } from './model';
import type { SyncGroup } from './sync';

/** A data source visible on the canvas. The design itself is always present; databases are optional. */
export interface SourceData {
  /** `"design"` for the design's own tables, or a database ID like `"db1"`. */
  source: string;
  name: string;
  /** Missing when a db source has no snapshot yet, or the source failed to load (see `error`). */
  schema?: NormalizedSchema;
  snapshot?: { file: string; takenAt: string };
  error?: string;
}

/** Context about the design this canvas belongs to. */
export interface DesignContext {
  workspace: string;
  design: string;
  name: string;
  driver?: string;
}

/** A diagram of the design, shown as a Mermaid card on the canvas. */
export interface DiagramData {
  id: string;
  name: string;
  type: DiagramType;
  code: string;
  description?: string;
  /** ER diagrams: number of changes waiting to be synced into the tables. */
  pending?: number;
}

export interface WorkspaceCatalog {
  workspace: { id: string; name: string };
  /** Databases in this workspace that could be added as data sources. */
  db: { id: string; name: string; tableCount?: number; hasSnapshot: boolean }[];
}

export interface ComparisonData {
  diff: DiffResult;
  tableMappings: Record<string, string>;
}

export interface RevealTarget {
  item?: ItemRef;
  column?: string;
  /** Diagrams: focus the Mermaid text in the side panel. */
  edit?: boolean;
}

export interface ClipboardInfo {
  mode: ClipboardMode;
  count: number;
}

// ── Export ─────────────────────────────────────────────────────────

/** One thing that can be exported. The webview only ever sends back the `key` of these. */
export type ExportItem =
  | { kind: 'design-table'; key: string; rawName: string; comment?: string; partition?: string; onCanvas: boolean; columns: number }
  | { kind: 'db-table'; source: string; key: string; rawName: string; comment?: string; partition?: string; onCanvas: boolean; columns: number }
  | { kind: 'diagram'; id: string; key: string; name: string; type: DiagramType; partition?: string; onCanvas: boolean };

/** One level of the canvas; `id` missing is the root canvas. */
export interface ExportLevel {
  id?: string;
  name: string;
  description?: string;
  parent?: string;
  depth: number;
}

/** Host→Web. Pushed when the export dialog opens. */
export interface ExportRequest {
  /**
   * Identifies this dialog session. The host keeps the collected inventory under it, so the
   * webview must echo it back verbatim — it must never invent its own id, or the host cannot
   * match the selection to the snapshot it collected.
   */
  requestId: string;
  /**
   * Human-readable name of a database source for the UI only. Contains the host, so anything
   * that the AI will see has to go through the id instead — this field is for display.
   */
  dbLabels?: Record<string, string>;
  items: ExportItem[];
  levels: ExportLevel[];
  suggestedPath: string;
  designName: string;
  driverLabel?: string;
}

/** Stable identity of an item, used so the webview cannot rewrite names or sources. */
export function exportKey(item: ExportItem): string {
  return item.kind === 'diagram' ? `g:${item.id}` : item.kind === 'design-table' ? `d:${item.key}` : `b:${item.source}:${item.key}`;
}

export type HostMessage =
  | {
      type: 'init';
      canvas: CanvasFile;
      design: DesignContext;
      sources: SourceData[];
      diagrams: DiagramData[];
      catalog?: WorkspaceCatalog;
      comparison?: ComparisonData;
      clipboard?: ClipboardInfo;
      error?: string;
    }
  | { type: 'canvas'; canvas: CanvasFile }
  | { type: 'source'; source: SourceData }
  | { type: 'design'; design: DesignContext }
  | { type: 'diagrams'; diagrams: DiagramData[] }
  | { type: 'comparison'; comparison?: ComparisonData }
  | { type: 'catalog'; catalog: WorkspaceCatalog }
  | { type: 'reply'; requestId: string; ok: boolean; error?: string; message?: string }
  /** Select an item and zoom the canvas to it; without `item`, fit the whole canvas. `edit` puts the cursor in its editor. */
  | { type: 'reveal'; target: RevealTarget }
  | { type: 'clipboard'; clipboard?: ClipboardInfo }
  | { type: 'pendingSync'; groups: SyncGroup[] }
  /** The export dialog opens; the host answers a path pick and an export run this way. */
  | { type: 'export/items'; request: ExportRequest }
  | { type: 'export/result'; path?: string; message?: string; error?: string };

export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'canvas/edit'; label: string; edit: CanvasEdit }
  | { type: 'design/op'; requestId: string; ops: DesignOp[]; label: string; canvasEdit?: CanvasEdit }
  | { type: 'diff/accept'; requestId: string; id: string; accepted: boolean }
  | { type: 'viewport'; viewport: Viewport }
  | { type: 'db/sync'; source: string }
  | { type: 'openRaw'; source: string }
  /** Add a database from the workspace to this design's sources. */
  | { type: 'source/add'; requestId: string; dbId: string }
  /** Remove a database from this design's sources. */
  | { type: 'source/remove'; requestId: string; dbId: string }
  /** Rename this design. */
  | { type: 'design/rename'; requestId: string; name: string }
  | { type: 'table/copyToDesign'; requestId: string; source: string; tables: string[]; partition?: string; at?: Position }
  | { type: 'sync/apply'; requestId: string; diagram: string; ids: string[]; choices: Record<string, string> }
  | { type: 'sync/ignore'; requestId: string; diagram: string; ids: string[]; clear?: boolean }
  /** Opens the diagram in its own editor tab. */
  | { type: 'diagram/openInTab'; diagram: string }
  | { type: 'diagram/create'; partition?: string; at?: Position; diagramType?: DiagramType }
  /** Mermaid text typed in the side panel; written straight to the diagram file (not the canvas undo stack). */
  | { type: 'diagram/code'; diagram: string; code: string }
  | { type: 'diagram/meta'; diagram: string; name?: string; description?: string }
  | { type: 'diagram/copyForAI'; diagram: string }
  | { type: 'diagram/delete'; requestId: string; diagram: string }
  | { type: 'clipboard/set'; mode: ClipboardMode; items: ItemRef[] }
  | { type: 'clipboard/paste'; requestId: string; partition?: string; at?: Position; positions?: Record<string, Position> }
  | { type: 'partition/delete'; requestId: string; id: string }
  | { type: 'partition/namespace'; id: string }
  /** Dragging items into or out of a partition frame; coordinates are relative to the target frame. */
  | { type: 'items/move'; requestId: string; items: MoveItem[] }
  /** The current level (from selection / focus); the tree follows it. */
  | { type: 'level'; level?: string }
  /** Open the export dialog for this design. The host answers with `export/items`, which carries the id to use. */
  | { type: 'export/open' }
  /** Let the user pick the export directory natively. */
  | { type: 'export/pickPath'; requestId: string }
  /** Write the export. `keys` are {@link exportKey} values, never whole items. */
  | { type: 'export/run'; requestId: string; keys: string[]; path: string };

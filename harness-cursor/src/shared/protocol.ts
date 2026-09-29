import type { CanvasEdit, CanvasFile, Viewport } from './canvas';
import type { DesignOp } from './designOps';
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
  canvases: { id: string; name: string }[];
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

export type HostMessage =
  | { type: 'init'; canvas: CanvasFile; design: DesignContext; sources: SourceData[]; catalog?: WorkspaceCatalog; comparison?: ComparisonData; error?: string }
  | { type: 'canvas'; canvas: CanvasFile }
  | { type: 'source'; source: SourceData }
  | { type: 'design'; design: DesignContext }
  | { type: 'comparison'; comparison?: ComparisonData }
  | { type: 'catalog'; catalog: WorkspaceCatalog }
  | { type: 'reply'; requestId: string; ok: boolean; error?: string; message?: string }
  | { type: 'focus'; source: string; table: string; column?: string }
  | { type: 'pendingSync'; groups: SyncGroup[] };

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
  | { type: 'table/copyToDesign'; requestId: string; source: string; tables: string[] }
  | { type: 'sync/apply'; requestId: string; diagram: string; ids: string[]; choices: Record<string, string> }
  | { type: 'sync/ignore'; requestId: string; diagram: string; ids: string[]; clear?: boolean }
  | { type: 'diagram/open'; diagram: string }
  | { type: 'diagram/create' }
  | { type: 'canvas/switch'; canvasId: string }
  | { type: 'canvas/new'; name?: string }
  | { type: 'canvas/copy' };

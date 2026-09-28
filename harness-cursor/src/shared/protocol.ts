import type { CanvasEdit, CanvasFile, Viewport } from './canvas';
import type { DesignOp } from './designOps';
import type { DiffResult, NormalizedSchema } from './model';
import type { SourceKind } from './workspace';

export interface SourceData {
  alias: string;
  kind: SourceKind;
  ref: string;
  name: string;
  /** Missing when a db source has no snapshot yet, or the source failed to load (see `error`). */
  schema?: NormalizedSchema;
  snapshot?: { file: string; takenAt: string };
  error?: string;
}

export interface WorkspaceCatalog {
  workspace: { id: string; name: string };
  design: { id: string; name: string; tableCount: number }[];
  db: { id: string; name: string; tableCount?: number; hasSnapshot: boolean }[];
}

export interface ComparisonData {
  diff: DiffResult;
  tableMappings: Record<string, string>;
}

export type HostMessage =
  | { type: 'init'; canvas: CanvasFile; sources: SourceData[]; catalog?: WorkspaceCatalog; comparison?: ComparisonData; error?: string }
  /** Full canvas after undo/redo/revert or an external rewrite (e.g. a table rename). */
  | { type: 'canvas'; canvas: CanvasFile }
  | { type: 'source'; source: SourceData }
  | { type: 'comparison'; comparison?: ComparisonData }
  | { type: 'catalog'; catalog: WorkspaceCatalog }
  | { type: 'reply'; requestId: string; ok: boolean; error?: string }
  | { type: 'focus'; alias: string; table: string; column?: string };

export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'canvas/edit'; label: string; edit: CanvasEdit }
  | { type: 'design/op'; requestId: string; alias: string; ops: DesignOp[]; label: string; canvasEdit?: CanvasEdit }
  | { type: 'diff/accept'; requestId: string; id: string; accepted: boolean }
  | { type: 'viewport'; viewport: Viewport }
  | { type: 'db/sync'; alias: string }
  | { type: 'openRaw'; alias: string }
  /** Only creates the source in the workspace; it is not added to this canvas. */
  | { type: 'source/create'; kind: SourceKind }
  /** Design sources only; a db source is named after its connection. */
  | { type: 'source/rename'; alias: string; name: string };

export type EditKind = 'workspace' | 'design' | 'canvas';

export interface EditInit {
  kind: EditKind;
  /** Parent workspace name; for a workspace it is its own current name. */
  workspaceName: string;
  name: string;
  description?: string;
  /** Design only: current target database type (tbls driver name). */
  driver?: string;
  drivers?: { name: string; label: string }[];
  /** Design only: changing the type does not convert column types, so the page warns when there are tables. */
  tableCount?: number;
}

export interface EditValues {
  name: string;
  description: string;
  driver?: string;
}

export type EditWebviewMessage =
  | { type: 'ready' }
  | ({ type: 'save'; requestId: string } & EditValues)
  | { type: 'close' };

export type EditHostMessage =
  | ({ type: 'init' } & EditInit)
  | { type: 'result'; requestId: string; ok: boolean; message?: string };

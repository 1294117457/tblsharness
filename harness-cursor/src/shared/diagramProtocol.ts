import type { DiagramMeta } from './diagram';
import type { SyncGroup } from './sync';

export interface DiagramDocState {
  meta: DiagramMeta;
  code: string;
  problems: string[];
}

export interface DiagramContext {
  designName: string;
  driver?: string;
  tableCount: number;
}

export type DiagramHostMessage =
  | { type: 'init'; doc: DiagramDocState; context?: DiagramContext; error?: string }
  /** The document changed outside the webview (agent, text editor, undo). */
  | { type: 'doc'; doc: DiagramDocState }
  | { type: 'context'; context: DiagramContext }
  /** `undo`: label of the last sync from this editor that can still be undone. */
  | { type: 'sync'; group?: SyncGroup; undo?: string }
  | { type: 'reply'; requestId: string; ok: boolean; error?: string; message?: string };

export type DiagramWebviewMessage =
  | { type: 'ready' }
  | { type: 'code'; code: string }
  | { type: 'meta'; name?: string; description?: string }
  | { type: 'sync/apply'; requestId: string; ids: string[]; choices: Record<string, string> }
  | { type: 'sync/ignore'; requestId: string; ids: string[]; clear?: boolean }
  | { type: 'sync/undo'; requestId: string }
  | { type: 'regenerate'; requestId: string }
  | { type: 'command'; command: 'copyForAI' | 'openText' | 'openCanvas' };

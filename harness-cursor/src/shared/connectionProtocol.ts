import type { ConnectionDriver, ConnectionProfile } from './connection';

export interface ConnectionFilters {
  exclude: string[];
  include: string[];
}

export interface ConnectionInit {
  mode: 'create' | 'edit';
  workspaceName: string;
  /** Pre-selected type: the saved one when editing, otherwise the last one used. */
  driver: ConnectionDriver;
  /** Edit mode only; never contains the password (nor the DSN of a custom connection). */
  profile?: Omit<ConnectionProfile, 'password'>;
  hasSavedPassword: boolean;
  defaultSchema?: string;
  filters: ConnectionFilters;
}

export type ConnectionWebviewMessage =
  | { type: 'ready' }
  | { type: 'test'; requestId: string; profile: ConnectionProfile; filters: ConnectionFilters }
  | { type: 'connect'; requestId: string; profile: ConnectionProfile; filters: ConnectionFilters; defaultSchema?: string }
  | { type: 'importFile'; requestId: string }
  | { type: 'pickFile'; requestId: string; purpose: 'sqlite' | 'json' }
  | { type: 'openUrl'; url: string }
  | { type: 'openTblsSettings' }
  | { type: 'cancel' }
  | { type: 'close' };

export type ConnectionResult =
  | { ok: true; tables: number; relations: number; elapsedMs: number; cached?: boolean }
  | { ok: false; message: string; detail?: string; action?: 'setTblsPath' };

export type ConnectionHostMessage =
  | ({ type: 'init' } & ConnectionInit)
  | ({ type: 'result'; requestId: string } & ConnectionResult)
  | { type: 'filePicked'; requestId: string; path?: string; name?: string; tables?: number; error?: string };

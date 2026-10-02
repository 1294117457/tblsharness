import type { ConnectionDriver, ConnectionProfile } from './connection';

export interface ConnectionFilters {
  exclude: string[];
  include: string[];
}

/** Where the tbls binary Harness would use comes from, for the connection page's status row. */
export interface TblsStatus {
  /** Where the binary lives, in human terms. */
  source: 'bundled' | 'user-configured' | 'missing';
  /** The version Harness wants to use (bundled version). */
  bundledVersion: string;
  /** What's currently installed under `<globalStorage>/bin/`, if any. */
  installedVersion?: string;
  /** Absolute path to the binary (only when source is not 'missing'). */
  resolvedPath?: string;
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
  /** Status of the bundled tbls binary, surfaced as a status row in the form. */
  tblsStatus: TblsStatus;
}

export type ConnectionWebviewMessage =
  | { type: 'ready' }
  | { type: 'test'; requestId: string; profile: ConnectionProfile; filters: ConnectionFilters }
  | { type: 'connect'; requestId: string; profile: ConnectionProfile; filters: ConnectionFilters; defaultSchema?: string }
  | { type: 'importFile'; requestId: string }
  | { type: 'pickFile'; requestId: string; purpose: 'sqlite' | 'json' }
  | { type: 'pickTblsPath'; requestId: string }
  | { type: 'testTbls'; requestId: string }
  | { type: 'installTbls'; requestId: string }
  | { type: 'openTblsSettings' }
  | { type: 'openTblsReleases'; url: string }
  | { type: 'openUrl'; url: string }
  | { type: 'cancel' }
  | { type: 'close' };

export type ConnectionResult =
  | { ok: true; tables: number; relations: number; elapsedMs: number; cached?: boolean }
  | { ok: false; message: string; detail?: string; action?: 'setTblsPath' | 'downloadTbls' };

export type ConnectionHostMessage =
  | ({ type: 'init' } & ConnectionInit)
  | ({ type: 'result'; requestId: string } & ConnectionResult)
  | { type: 'filePicked'; requestId: string; path?: string; name?: string; tables?: number; error?: string }
  | { type: 'tblsPathPicked'; requestId: string; path?: string; error?: string }
  | { type: 'tblsTested'; requestId: string; ok: boolean; version?: string; error?: string }
  | { type: 'tblsInstalled'; requestId: string; ok: boolean; path?: string; error?: string };
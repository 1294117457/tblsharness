import * as vscode from 'vscode';
import { BUNDLED_TBLS_VERSION, normalizeBaseUrl, normalizeVersion } from '../shared/tblsConfig';

export interface TblsConfig {
  /** User-supplied local tbls path. `""` means "use the bundled/downloaded version". */
  tblsPath: string;
  /** The tbls version to download when the bundled one is used. Never the extension's version. */
  version: string;
  /** Base URL for release downloads (always ends in `/releases/download`). */
  baseUrl: string;
  /** Whether to download the bundled tbls automatically. */
  autoDownload: boolean;
  /** Per-run timeout for `tbls out`, in seconds. */
  timeoutSeconds: number;
  /** True when the user pinned an explicit `harness.tblsVersion` (worth an API existence check). */
  versionPinned: boolean;
}

/**
 * The single place where `harness.*` settings are read.
 *
 * Every reader must go through here. The two mistakes this exists to prevent:
 *  - reading a `harness.`-prefixed key off `getConfiguration('harness')` (it always misses), and
 *  - defaulting the path to `'tbls'`, which silently bypasses the bundled download.
 */
export function readTblsConfig(): TblsConfig {
  const c = vscode.workspace.getConfiguration('harness');
  const rawVersion = c.get<string>('tblsVersion', '');
  const version = normalizeVersion(rawVersion) ?? BUNDLED_TBLS_VERSION;
  return {
    tblsPath: (c.get<string>('tblsPath', '') || '').trim(),
    version,
    baseUrl: normalizeBaseUrl(c.get<string>('tblsDownloadBaseUrl', '')),
    autoDownload: c.get<boolean>('tblsAutoDownload', true) !== false,
    timeoutSeconds: Math.max(5, c.get<number>('tblsTimeoutSeconds', 120)),
    versionPinned: normalizeVersion(rawVersion) !== undefined,
  };
}

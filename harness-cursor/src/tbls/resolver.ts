import * as fs from 'node:fs/promises';
import * as vscode from 'vscode';
import { probe } from './manager';

const CONFIG_KEY = 'harness.tblsPath';
const DOWNLOAD_BASE_URL_KEY = 'harness.tblsDownloadBaseUrl';
const VERSION_KEY = 'harness.tblsVersion';
const AUTO_DOWNLOAD_KEY = 'harness.tblsAutoDownload';

/** Reads the raw user-configured path; `""` means "use bundled/downloaded version". */
export function getConfiguredTblsPath(config: vscode.WorkspaceConfiguration): string {
  return config.get<string>(CONFIG_KEY, 'tbls');
}

export interface ResolveOptions {
  /** Skip the bundled/download path check (used while installing). */
  skipBundled?: boolean;
  /** Bypass auto-download; just resolve what's there. */
  skipDownload?: boolean;
  /** Extension version used as fallback target version. */
  extensionVersion: string;
}

/**
 * Resolves the tbls binary path to use.
 *
 *   1. If `harness.tblsPath` is set (non-empty) AND it points to an existing file → use it.
 *      - If it doesn't exist (and looks like a name, not a path) → return as-is so the
 *        runner can surface a clear "找不到 tbls" error.
 *   2. Otherwise → use bundled/downloaded version from `<globalStorage>/bin/`.
 *   3. If nothing is installed and `harness.tblsAutoDownload !== false` → kick off a download
 *      and wait. If download fails, throw — the caller decides what to show.
 */
export async function resolveTblsPath(
  context: vscode.ExtensionContext,
  configured: string | undefined,
  options: ResolveOptions,
): Promise<string> {
  const config = vscode.workspace.getConfiguration('harness');
  const configuredPath = (configured ?? getConfiguredTblsPath(config)).trim();

  if (configuredPath) {
    if (await looksLikeFile(configuredPath)) return configuredPath;
    // Looks like a PATH-style name; trust it and let the runner surface errors.
    return configuredPath;
  }

  if (options.skipBundled) return configuredPath || 'tbls';

  // Bundled/downloaded version
  const version = (config.get<string>(VERSION_KEY, options.extensionVersion) || options.extensionVersion).replace(/^v/, '');
  const baseUrl = config.get<string>(DOWNLOAD_BASE_URL_KEY, 'https://github.com/k1LoW/tbls/releases');

  // Try the existing binary first.
  const existing = await probe(context, version);
  if (existing) return existing.fsPath;

  if (options.skipDownload) throw new TblsResolveError('missing-bundled');

  const autoDownload = config.get<boolean>(AUTO_DOWNLOAD_KEY, true);
  if (!autoDownload) throw new TblsResolveError('missing-bundled');

  const { install } = await import('./manager');
  const installed = await install(context, version, baseUrl);
  return installed.fsPath;
}

async function looksLikeFile(path: string): Promise<boolean> {
  // Absolute / relative paths with separators are files; names without separators are PATH entries.
  if (!path.includes('/') && !path.includes('\\')) return false;
  try {
    const stat = await fs.stat(path);
    return stat.isFile();
  } catch {
    return false;
  }
}

/** Error thrown by resolveTblsPath when the bundled binary is needed but unavailable. */
export class TblsResolveError extends Error {
  constructor(public readonly reason: 'missing-bundled' | 'download-failed', message?: string) {
    super(message ?? reason);
    this.name = 'TblsResolveError';
  }
}
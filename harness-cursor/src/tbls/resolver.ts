import * as vscode from 'vscode';
import { install, probe } from './manager';
import { readTblsConfig } from './config';
import { whichTbls, probeTblsVersion, type TblsVersionInfo } from './probeVersion';

export type TblsResolveReason =
  /** The bundled binary is needed but not installed yet. */
  | 'missing-bundled'
  /** Downloading the bundled binary failed. */
  | 'download-failed'
  /** `harness.tblsPath` points at a path that doesn't exist. */
  | 'bad-path'
  /** `harness.tblsPath` is a bare name that isn't on PATH. */
  | 'not-on-path'
  /** The path exists but running it failed. */
  | 'not-executable';

export class TblsResolveError extends Error {
  constructor(
    public readonly reason: TblsResolveReason,
    message?: string,
  ) {
    super(message ?? reason);
    this.name = 'TblsResolveError';
  }
}

export interface ResolveOptions {
  /** Skip the bundled/download path check (used while installing). */
  skipBundled?: boolean;
  /** Bypass auto-download; just report what's there. */
  skipDownload?: boolean;
}

export interface ResolvedTbls {
  /** The path to hand to `execFile`. */
  path: string;
  /** Where it came from. */
  source: 'user-configured' | 'bundled';
  /** Version reported by `--version`, when we probed it. */
  version?: string;
  /** The binary can actually run. */
  verified: boolean;
}

/**
 * Resolves which tbls to run.
 *
 *  1. `harness.tblsPath` set:
 *     - looks like a path → must exist, be a file, and run; otherwise a `TblsResolveError`
 *       explaining exactly what is wrong (no more "trust it and fail later at execFile").
 *     - looks like a bare name → resolved through PATH, with a clear error when absent.
 *  2. Otherwise the bundled copy under `<globalStorage>/bin/`, downloading it if allowed.
 */
export async function resolveTbls(context: vscode.ExtensionContext, options: ResolveOptions = {}): Promise<ResolvedTbls> {
  const config = readTblsConfig();

  if (config.tblsPath) {
    if (looksLikePath(config.tblsPath)) {
      const info = await probeTblsVersion(config.tblsPath);
      if (!info.ok) {
        const reason = info.reason === 'notFound' || info.reason === 'notAFile' ? 'bad-path' : 'not-executable';
        throw new TblsResolveError(reason, info.error);
      }
      return { path: info.resolvedPath ?? config.tblsPath, source: 'user-configured', version: info.version, verified: true };
    }
    const onPath = await whichTbls(config.tblsPath);
    if (!onPath) {
      throw new TblsResolveError('not-on-path', `系统的 PATH 里找不到 “${config.tblsPath}”。请在连接页面点“选择本地文件…”指定完整路径。`);
    }
    const info = await probeTblsVersion(onPath);
    if (!info.ok) throw new TblsResolveError('not-executable', info.error);
    return { path: info.resolvedPath ?? onPath, source: 'user-configured', version: info.version, verified: true };
  }

  if (options.skipBundled) throw new TblsResolveError('missing-bundled', '内置 tbls 不可用（已跳过）');

  const existing = await probe(context, config.version);
  if (existing) {
    const info = await probeTblsVersion(existing.fsPath);
    if (info.ok) return { path: existing.fsPath, source: 'bundled', version: info.version, verified: true };
  }

  if (options.skipDownload) throw new TblsResolveError('missing-bundled');
  if (!config.autoDownload) throw new TblsResolveError('missing-bundled');

  try {
    const installed = await install(context, config.version, config.baseUrl);
    const info = await probeTblsVersion(installed.fsPath);
    return { path: installed.fsPath, source: 'bundled', version: info.version, verified: info.ok };
  } catch (err) {
    throw new TblsResolveError('download-failed', (err as Error).message);
  }
}

/**
 * Resolves to a plain path string.
 *
 * Kept for callers that only need the path; prefer {@link resolveTbls} when the version or the
 * verification state is useful.
 */
export async function resolveTblsPath(context: vscode.ExtensionContext, options: ResolveOptions = {}): Promise<string> {
  return (await resolveTbls(context, options)).path;
}

/** Probes whatever is currently configured without downloading or throwing. */
export async function inspectConfiguredTbls(): Promise<TblsVersionInfo | undefined> {
  const { tblsPath } = readTblsConfig();
  if (!tblsPath) return undefined;
  return probeTblsVersion(tblsPath);
}

function looksLikePath(p: string): boolean {
  return p.includes('/') || p.includes('\\');
}

import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import * as path from 'node:path';

export type TblsProbeFailure = 'notFound' | 'notAFile' | 'notOnPath' | 'notExecutable' | 'timeout';

export interface TblsVersionInfo {
  ok: boolean;
  /** Semantic version parsed out of tbls' output, e.g. `1.96.1`. */
  version?: string;
  /** The raw first line tbls printed, e.g. `tbls version 1.96.1`. */
  raw?: string;
  /** The absolute path that was probed (resolved through PATH when a bare name was given). */
  resolvedPath?: string;
  reason?: TblsProbeFailure;
  /** Already safe to show to the user (contains no secrets; tbls `--version` prints nothing private). */
  error?: string;
}

/** Matches the version in `tbls version 1.96.1` / `tbls version v1.96.1`. */
const VERSION_RE = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/;

function isPathLike(p: string): boolean {
  return p.includes('/') || p.includes('\\');
}

/** Resolves a bare command name to an absolute path via PATH; returns undefined when absent. */
export async function whichTbls(name: string): Promise<string | undefined> {
  if (isPathLike(name)) return (await isFile(name)) ? path.resolve(name) : undefined;
  const finder = process.platform === 'win32' ? 'where' : 'which';
  const found = await new Promise<string | undefined>((resolve) => {
    execFile(finder, [name], { timeout: 10_000, windowsHide: true }, (err, stdout) => {
      if (err) {
        resolve(undefined);
        return;
      }
      // `where` may print several matches; prefer one that is actually a file.
      const first = String(stdout)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.length > 0);
      resolve(first || undefined);
    });
  });
  if (found && isPathLike(found) && (await isFile(found))) return found;
  return undefined;
}

/** Existence + regular-file check. */
async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

/** On non-Windows, a non-executable file exists but cannot be run — report that distinctly. */
async function hasExecBit(file: string): Promise<boolean> {
  if (process.platform === 'win32') return true;
  try {
    return ((await stat(file)).mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/**
 * Runs `<tbls> --version` and normalizes the result.
 *
 * This is the only implementation of "can Harness actually run this tbls?" — the connection page's
 * test button, the file picker, and `harness.tbls.checkUpdate` all go through here.
 */
export async function probeTblsVersion(tblsPath: string, options: { timeoutMs?: number } = {}): Promise<TblsVersionInfo> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const input = (tblsPath ?? '').trim();
  if (!input) return { ok: false, reason: 'notFound', error: '没有指定 tbls 路径' };

  let target = input;
  if (!isPathLike(input)) {
    const onPath = await whichTbls(input);
    if (!onPath) {
      return {
        ok: false,
        reason: 'notOnPath',
        error: `系统的 PATH 里找不到 “${input}”。请用“选择本地文件…”指定它的完整路径。`,
      };
    }
    target = onPath;
  } else {
    let s;
    try {
      s = await stat(input);
    } catch {
      return { ok: false, reason: 'notFound', error: `找不到文件：${input}` };
    }
    if (!s.isFile()) return { ok: false, reason: 'notAFile', error: `这不是一个文件：${input}` };
    if (!(await hasExecBit(input))) {
      return { ok: false, reason: 'notExecutable', error: `文件不可执行（缺少执行权限）：${input}` };
    }
    target = path.resolve(input);
  }

  return new Promise<TblsVersionInfo>((resolve) => {
    execFile(
      target,
      ['--version'],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        const raw = String(stdout ?? '').trim().split(/\r?\n/)[0]?.trim() ?? '';
        if (err) {
          const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: string };
          if (e.code === 'ENOENT') {
            resolve({ ok: false, reason: 'notFound', resolvedPath: target, error: `找不到可执行文件：${target}` });
            return;
          }
          if (e.code === 'EACCES') {
            resolve({ ok: false, reason: 'notExecutable', resolvedPath: target, error: `没有权限执行：${target}` });
            return;
          }
          if (e.killed) {
            resolve({ ok: false, reason: 'timeout', resolvedPath: target, error: `运行 ${target} --version 超时` });
            return;
          }
          const detail = String(stderr ?? '').trim() || e.message;
          resolve({ ok: false, reason: 'notExecutable', resolvedPath: target, error: `无法运行 ${target}：${detail}` });
          return;
        }
        resolve({
          ok: true,
          raw: raw || String(stdout ?? '').trim(),
          version: VERSION_RE.exec(raw)?.[1],
          resolvedPath: target,
        });
      },
    );
  });
}

import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as tar from 'tar';
import * as vscode from 'vscode';
import { exists, mkdirp, readText, removeRecursive, writeJson } from '../workspace/fsUtil';
import { binaryFilename, binDirName, pickAsset, type TblsAsset } from '../shared/tblsPlatform';
import { assetFor, checksumsUrl, downloadUrl, parseChecksums, releaseTagApiUrl, sameDigest } from '../shared/tblsConfig';
import { probeTblsVersion } from './probeVersion';

const CURRENT_FILE = 'tbls.current.json';

export interface CurrentRecord {
  version: string;
  platform: NodeJS.Platform;
  arch: NodeJS.Architecture;
  filename: string;
  /** sha256 of the downloaded *archive*, when checksums could be fetched. */
  sha256: string;
  /** sha256 of the installed *binary*, recorded after extraction. */
  binarySha256?: string;
  /** False when the archive could not be checksum-verified (checksums file unavailable). */
  verified: boolean;
  installedAt: string;
  source: 'downloaded' | 'user-supplied';
}

/** Progress/cancellation hooks so callers can drive a `withProgress` UI. */
export interface InstallHooks {
  onProgress?: (message: string, increment?: number) => void;
  token?: vscode.CancellationToken;
  /** Overridable for tests. */
  fetchImpl?: typeof fetch;
}

/** Thrown for problems the user can act on (bad URL, bad checksum, cancelled, …). */
export class TblsInstallError extends Error {
  constructor(
    message: string,
    readonly reason: 'version-not-found' | 'http-error' | 'checksum-mismatch' | 'cancelled' | 'extract-failed' | 'smoke-test-failed',
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'TblsInstallError';
  }
}

/** Path to `<globalStorage>/bin`. */
export function binDir(context: vscode.ExtensionContext): vscode.Uri {
  return vscode.Uri.joinPath(context.globalStorageUri, 'bin');
}

function currentFile(context: vscode.ExtensionContext): vscode.Uri {
  return vscode.Uri.joinPath(context.globalStorageUri, CURRENT_FILE);
}

/** Path to the binary itself under a given bin directory. */
export function binaryPathIn(dir: vscode.Uri, asset: TblsAsset): vscode.Uri {
  return vscode.Uri.joinPath(dir, binDirName(asset), binaryFilename(asset.key.platform));
}

/** Reads the currently installed record; returns `undefined` if missing or invalid. */
export async function readCurrent(context: vscode.ExtensionContext): Promise<CurrentRecord | undefined> {
  if (!(await exists(currentFile(context)))) return undefined;
  try {
    const text = await readText(currentFile(context));
    const parsed = JSON.parse(text) as CurrentRecord;
    if (!parsed.version || !parsed.platform || !parsed.arch || !parsed.filename) return undefined;
    // Records written before `verified` existed are treated as unverified, not as "fine".
    if (typeof parsed.verified !== 'boolean') parsed.verified = !!parsed.sha256;
    return parsed;
  } catch {
    return undefined;
  }
}

async function writeCurrent(context: vscode.ExtensionContext, record: CurrentRecord): Promise<void> {
  await writeJson(currentFile(context), record);
}

/**
 * Returns the binary path inside `<globalStorage>/bin/` if a matching binary is already installed.
 *
 * The directory is derived from the *current* machine, not from the record: a globalStorage folder
 * copied from another machine would otherwise point at a directory that can't exist here.
 */
export async function probe(context: vscode.ExtensionContext, version?: string): Promise<vscode.Uri | undefined> {
  const record = await readCurrent(context);
  if (!record) return undefined;
  if (version && record.version !== version) return undefined;
  const asset = pickAsset(process.platform as NodeJS.Platform, process.arch as NodeJS.Architecture, record.version);
  if (!asset) return undefined;
  const bin = binaryPathIn(binDir(context), asset);
  return (await exists(bin)) ? bin : undefined;
}

/**
 * Ensures a tbls binary matching `version` exists in `<globalStorage>/bin/`, downloading it if needed.
 *
 * Steps: check tag exists → download archive → fetch `checksums-<platform>.txt` → verify sha256 →
 * extract → chmod → smoke-test `--version` → record. Any failure cleans up the half-written
 * directory so a retry starts from scratch.
 */
export async function install(
  context: vscode.ExtensionContext,
  version: string,
  baseUrl: string,
  hooks: InstallHooks = {},
): Promise<vscode.Uri> {
  const asset = assetFor(process.platform, process.arch, version);
  if (!asset) throw new TblsInstallError(`tbls 没有适用于 ${process.platform}/${process.arch} 的二进制文件`, 'extract-failed');
  const fetchImpl = hooks.fetchImpl ?? globalThis.fetch;
  const report = hooks.onProgress ?? (() => undefined);
  const cancelled = (): boolean => hooks.token?.isCancellationRequested === true;

  // Already installed? Trust the file only if it can still report a version.
  const existing = await probe(context, version);
  if (existing) {
    const info = await probeTblsVersion(existing.fsPath);
    if (info.ok) return existing;
    report(`已安装的 tbls 无法运行（${info.error ?? '未知原因'}），准备重新下载…`);
  }

  report(`检查 tbls v${version} 是否存在…`);
  await assertTagExists(fetchImpl, version);

  const url = downloadUrl(baseUrl, asset);
  const dir = vscode.Uri.joinPath(binDir(context), binDirName(asset));
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'harness-tbls-'));
  const archivePath = path.join(tmpDir, asset.filename);
  let createdDir = false;

  try {
    report(`正在下载 ${asset.filename}…`);
    await downloadToFile(fetchImpl, url, archivePath, report, cancelled);

    report('正在校验下载文件…');
    const expected = await fetchExpectedSha(fetchImpl, baseUrl, asset);
    if (expected) {
      const actual = await sha256OfFile(archivePath);
      if (!sameDigest(actual, expected)) {
        throw new TblsInstallError(
          'tbls 下载校验失败（sha256 不匹配）。文件可能已损坏或被篡改，请重试。',
          'checksum-mismatch',
          `期望 ${expected}\n下载 ${actual}\n地址 ${url}`,
        );
      }
    }

    if (cancelled()) throw new TblsInstallError('已取消', 'cancelled');
    report('正在解压…');
    await mkdirp(dir);
    createdDir = true;
    await extractArchive(archivePath, dir.fsPath, asset);

    const installed = binaryPathIn(dir, asset);
    if (asset.key.platform !== 'win32') {
      await fsp.chmod(path.join(dir.fsPath, binaryFilename(asset.key.platform)), 0o755);
    }
    if (!(await exists(installed))) {
      throw new TblsInstallError('下载完成，但压缩包里没有找到 tbls 可执行文件', 'extract-failed', `地址 ${url}`);
    }

    report('正在验证 tbls…');
    const smoke = await probeTblsVersion(installed.fsPath);
    if (!smoke.ok) {
      throw new TblsInstallError('下载完成，但下载下来的 tbls 无法运行', 'smoke-test-failed', smoke.error);
    }

    const record: CurrentRecord = {
      version: asset.key.version,
      platform: asset.key.platform,
      arch: asset.key.arch,
      filename: asset.filename,
      sha256: expected ?? '',
      binarySha256: await sha256OfFile(installed.fsPath),
      verified: !!expected,
      installedAt: new Date().toISOString(),
      source: 'downloaded',
    };
    await writeCurrent(context, record);
    report(`已安装 tbls ${smoke.version ?? asset.key.version}`);
    return installed;
  } catch (err) {
    // Leave no half-installed directory behind: the next attempt would find it via `probe`.
    if (createdDir) await removeRecursive(dir).then(undefined, () => undefined);
    throw err;
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true }).then(undefined, () => undefined);
  }
}

/** Deletes any installed tbls and clears the current record. */
export async function uninstall(context: vscode.ExtensionContext): Promise<void> {
  await removeRecursive(binDir(context));
  try {
    await vscode.workspace.fs.delete(currentFile(context));
  } catch {
    // ignore
  }
}

/**
 * Re-checks the installed binary.
 *
 * `ok` is only true for a binary that is both present and runnable. `verified` is reported
 * separately: a binary installed before checksums were available is usable but unverified.
 */
export async function verify(
  context: vscode.ExtensionContext,
): Promise<{ ok: boolean; record?: CurrentRecord; reason?: string; verified: boolean }> {
  const record = await readCurrent(context);
  if (!record) return { ok: false, reason: '没有已安装的 tbls', verified: false };
  const asset = pickAsset(process.platform as NodeJS.Platform, process.arch as NodeJS.Architecture, record.version);
  if (!asset) return { ok: false, record, reason: '当前平台的二进制不受支持', verified: false };
  const bin = binaryPathIn(binDir(context), asset);
  if (!(await exists(bin))) return { ok: false, record, reason: '找不到已安装的 tbls 二进制', verified: false };

  const smoke = await probeTblsVersion(bin.fsPath);
  if (!smoke.ok) return { ok: false, record, reason: smoke.error ?? '无法运行', verified: record.verified };

  if (record.binarySha256) {
    const actual = await sha256OfFile(bin.fsPath);
    if (!sameDigest(actual, record.binarySha256)) {
      return { ok: false, record, reason: 'sha256 校验失败，二进制已被修改', verified: false };
    }
  }
  return { ok: true, record, verified: record.verified };
}

/** Confirms the git tag exists, so a 404 surfaces as a clear message instead of a raw download error. */
async function assertTagExists(fetchImpl: typeof fetch, version: string): Promise<void> {
  const api = releaseTagApiUrl(version);
  let res: Response;
  try {
    res = await fetchImpl(api, { headers: { accept: 'application/vnd.github+json' } });
  } catch {
    return; // Offline or API blocked: let the actual download produce the real error.
  }
  if (res.status === 404) {
    throw new TblsInstallError(`tbls v${version} 这个版本不存在`, 'version-not-found', `检查地址：${api}`);
  }
  // Rate limits and other transient failures shouldn't block the download.
}

async function downloadToFile(
  fetchImpl: typeof fetch,
  url: string,
  dest: string,
  report: (message: string, increment?: number) => void,
  cancelled: () => boolean,
): Promise<void> {
  const res = await fetchImpl(url, { redirect: 'follow' });
  if (!res.ok) {
    throw new TblsInstallError(`下载失败：${url} 返回 ${res.status}`, 'http-error', describeHttp(res.status, url));
  }
  const total = Number(res.headers.get('content-length') ?? 0);
  const body = res.body;
  // Stream to disk when possible so a large archive doesn't sit in memory, and so we can report progress.
  if (!body) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (cancelled()) throw new TblsInstallError('已取消', 'cancelled');
    await fsp.writeFile(dest, buf);
    report('下载完成', 1);
    return;
  }
  const handle = await fsp.open(dest, 'w');
  try {
    const reader = body.getReader();
    let received = 0;
    let lastReported = 0;
    for (;;) {
      if (cancelled()) {
        await reader.cancel().catch(() => undefined);
        throw new TblsInstallError('已取消', 'cancelled');
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        await handle.write(value);
        received += value.length;
        const ratio = total > 0 ? received / total : 0;
        if (ratio - lastReported >= 0.05 || received === total) {
          lastReported = ratio;
          report(total > 0 ? `正在下载… ${Math.round(ratio * 100)}%` : '正在下载…');
        }
      }
    }
    report('下载完成', 1);
  } finally {
    await handle.close();
  }
}

function describeHttp(status: number, url: string): string {
  if (status === 404) {
    return [
      `地址不存在：${url}`,
      '如果这是自建的下载源，请确认 base 地址指向 <仓库>/releases/download（少了 /download 段会 404），',
      '并且该版本确实有对应平台的发布文件。',
    ].join('\n');
  }
  if (status === 403 || status === 429) return `GitHub 限流（${status}），请稍后重试。`;
  return `HTTP ${status}`;
}

async function sha256OfFile(file: string): Promise<string> {
  const hash = createHash('sha256');
  const handle = await fsp.open(file, 'r');
  try {
    const stream = handle.createReadStream();
    for await (const chunk of stream) hash.update(chunk as Buffer);
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

/**
 * Looks up the expected sha256 in the release's `checksums-<platform>.txt`.
 *
 * tbls publishes one checksums file per platform listing every asset — not a sibling `.sha256`
 * per archive — so a missing file means "unverified", never "skip the check silently".
 */
async function fetchExpectedSha(fetchImpl: typeof fetch, baseUrl: string, asset: TblsAsset): Promise<string | undefined> {
  const url = checksumsUrl(baseUrl, asset.key.version, asset.key.platform);
  try {
    const res = await fetchImpl(url);
    if (!res.ok) return undefined;
    return parseChecksums(await res.text())[asset.filename];
  } catch {
    return undefined;
  }
}

async function extractArchive(archivePath: string, destDir: string, asset: TblsAsset): Promise<void> {
  if (asset.format === 'tar.gz') {
    await tar.x({ file: archivePath, cwd: destDir });
    return;
  }
  await extractZip(archivePath, destDir, asset);
}

/**
 * Minimal ZIP reader that extracts just the tbls binary.
 *
 * tbls archives are produced by Go's `zip.Writer`, which writes sizes in the local header and
 * does not use data descriptors, so walking entries by `compSize` is safe. ZIP64 archives
 * (>4GB) are not supported.
 */
async function extractZip(archivePath: string, destDir: string, asset: TblsAsset): Promise<void> {
  const buf = await fsp.readFile(archivePath);
  if (buf.length < 4 || buf.readUInt32LE(0) !== 0x04034b50) throw new Error('ZIP 头不合法');

  const target = binaryFilename(asset.key.platform).toLowerCase();
  let offset = 0;
  let wrote = false;
  while (offset + 30 <= buf.length) {
    if (buf.readUInt32LE(offset) !== 0x04034b50) break;
    const flags = buf.readUInt16LE(offset + 6);
    const compMethod = buf.readUInt16LE(offset + 8);
    const compSize = buf.readUInt32LE(offset + 18);
    const nameLen = buf.readUInt16LE(offset + 26);
    const extraLen = buf.readUInt16LE(offset + 28);
    const name = buf.subarray(offset + 30, offset + 30 + nameLen).toString('utf8');
    const start = offset + 30 + nameLen + extraLen;
    if (flags & 0x08) throw new Error('暂不支持带数据描述符的 ZIP 条目');
    const data = buf.subarray(start, start + compSize);

    if (!wrote && (name.toLowerCase().endsWith(target) || name.toLowerCase().endsWith('tbls'))) {
      const out = path.join(destDir, path.basename(name));
      const payload = compMethod === 0 ? data : await inflateRaw(data);
      await fsp.writeFile(out, payload);
      wrote = true;
    }

    offset = start + compSize;
  }
  if (!wrote) throw new Error('ZIP 里没有找到 tbls 可执行文件');
}

function inflateRaw(data: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    import('node:zlib').then(({ inflateRawSync }) => {
      try {
        resolve(inflateRawSync(data));
      } catch (err) {
        reject(err);
      }
    }, reject);
  });
}

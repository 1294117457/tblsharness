import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as tar from 'tar';
import * as vscode from 'vscode';
import { exists, mkdirp, readText, removeRecursive, writeJson } from '../workspace/fsUtil';
import { binaryFilename, binDirName, pickAsset, type TblsAsset } from '../shared/tblsPlatform';

const CURRENT_FILE = 'tbls.current.json';

export interface CurrentRecord {
  version: string;
  platform: NodeJS.Platform;
  arch: NodeJS.Architecture;
  filename: string;
  sha256: string;
  installedAt: string;
  source: 'downloaded' | 'user-supplied';
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
    return parsed;
  } catch {
    return undefined;
  }
}

async function writeCurrent(context: vscode.ExtensionContext, record: CurrentRecord): Promise<void> {
  await writeJson(currentFile(context), record);
}

/**
 * Returns the binary path inside `<globalStorage>/bin/` if a matching binary is already
 * installed for the requested version. `version === undefined` means "any installed version".
 */
export async function probe(context: vscode.ExtensionContext, version?: string): Promise<vscode.Uri | undefined> {
  const record = await readCurrent(context);
  if (!record) return undefined;
  if (version && record.version !== version) return undefined;
  const asset: TblsAsset | undefined = pickAsset(record.platform, record.arch, record.version);
  if (!asset) return undefined;
  const dir = vscode.Uri.joinPath(binDir(context), binDirName(asset));
  const bin = binaryPathIn(dir, asset);
  return (await exists(bin)) ? bin : undefined;
}

/**
 * Ensures a tbls binary matching the given version exists in `<globalStorage>/bin/`.
 * Downloads from `baseUrl` if missing. Returns the resolved binary path.
 */
export async function install(
  context: vscode.ExtensionContext,
  version: string,
  baseUrl: string,
  options: { fetchImpl?: typeof fetch; sha256?: string } = {},
): Promise<vscode.Uri> {
  const platform = process.platform as NodeJS.Platform;
  const arch = process.arch as NodeJS.Architecture;
  const asset = pickAsset(platform, arch, version);
  if (!asset) throw new Error(`tbls 没有适用于 ${platform}/${arch} 的二进制文件`);

  // Already installed?
  const existing = await probe(context, version);
  if (existing) return existing;

  const dir = vscode.Uri.joinPath(binDir(context), binDirName(asset));
  await mkdirp(dir);

  // Download
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const tagVersion = asset.key.version.replace(/^v/, '');
  const url = `${baseUrl.replace(/\/$/, '')}/v${tagVersion}/${asset.filename}`;
  const sha = options.sha256 ?? (await tryFetchSha256(fetchImpl, url, asset.filename));

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'harness-tbls-'));
  try {
    const archivePath = path.join(tmpDir, asset.filename);
    await downloadToFile(fetchImpl, url, archivePath);

    if (sha) {
      const actual = await sha256OfFile(archivePath);
      if (actual.toLowerCase() !== sha.toLowerCase()) {
        throw new Error(`tbls 下载校验失败（sha256 不匹配）。期望 ${sha}，下载 ${actual}`);
      }
    }

    await extractArchive(archivePath, dir.fsPath, asset);

    if (asset.key.platform !== 'win32') {
      await fsp.chmod(path.join(dir.fsPath, binaryFilename(asset.key.platform)), 0o755);
    }

    const installed = binaryPathIn(dir, asset);
    if (!(await exists(installed))) throw new Error('下载完成但找不到解压后的 tbls 二进制文件');

    const record: CurrentRecord = {
      version: tagVersion,
      platform: asset.key.platform,
      arch: asset.key.arch,
      filename: asset.filename,
      sha256: sha ?? '',
      installedAt: new Date().toISOString(),
      source: 'downloaded',
    };
    await writeCurrent(context, record);
    return installed;
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

/** Verifies the recorded sha256 still matches the on-disk file (if sha256 was recorded). */
export async function verify(context: vscode.ExtensionContext): Promise<{ ok: boolean; record?: CurrentRecord; reason?: string }> {
  const record = await readCurrent(context);
  if (!record) return { ok: false, reason: '没有已安装的 tbls' };
  const asset = pickAsset(record.platform, record.arch, record.version);
  if (!asset) return { ok: false, record, reason: '当前平台的二进制不支持' };
  const dir = vscode.Uri.joinPath(binDir(context), binDirName(asset));
  const bin = binaryPathIn(dir, asset);
  if (!(await exists(bin))) return { ok: false, record, reason: '找不到已安装的 tbls 二进制' };
  if (record.sha256) {
    const actual = await sha256OfFile(bin.fsPath);
    if (actual.toLowerCase() !== record.sha256.toLowerCase()) {
      return { ok: false, record, reason: 'sha256 校验失败' };
    }
  }
  return { ok: true, record };
}

async function downloadToFile(fetchImpl: typeof fetch, url: string, dest: string): Promise<void> {
  const res = await fetchImpl(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`下载失败：${url} 返回 ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fsp.writeFile(dest, buf);
}

async function sha256OfFile(file: string): Promise<string> {
  const buf = await fsp.readFile(file);
  return createHash('sha256').update(buf).digest('hex');
}

/** Tries to fetch a sibling sha256 file; returns undefined if not present. */
async function tryFetchSha256(fetchImpl: typeof fetch, archiveUrl: string, filename: string): Promise<string | undefined> {
  try {
    const shaUrl = archiveUrl.replace(/[^/]+$/, `${filename}.sha256`);
    const res = await fetchImpl(shaUrl);
    if (!res.ok) return undefined;
    const text = (await res.text()).trim().split(/\s+/)[0] ?? '';
    return text || undefined;
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

async function extractZip(archivePath: string, destDir: string, asset: TblsAsset): Promise<void> {
  const buf = await fsp.readFile(archivePath);
  if (buf.readUInt32LE(0) !== 0x04034b50) throw new Error('ZIP 头不合法');

  const target = binaryFilename(asset.key.platform).toLowerCase();
  let offset = 0;
  let wrote = false;
  while (offset + 4 <= buf.length) {
    const sig = buf.readUInt32LE(offset);
    if (sig !== 0x04034b50) break;
    const compMethod = buf.readUInt16LE(offset + 8);
    const compSize = buf.readUInt32LE(offset + 18);
    const nameLen = buf.readUInt16LE(offset + 26);
    const extraLen = buf.readUInt16LE(offset + 28);
    const name = buf.slice(offset + 30, offset + 30 + nameLen).toString('utf8');
    const data = buf.subarray(offset + 30 + nameLen + extraLen, offset + 30 + nameLen + extraLen + compSize);

    if (!wrote && (name.toLowerCase().endsWith(target) || name.toLowerCase().endsWith('tbls'))) {
      const out = path.join(destDir, path.basename(name));
      const payload = compMethod === 0 ? data : await inflateRaw(data);
      await fsp.writeFile(out, payload);
      wrote = true;
    }

    offset += 30 + nameLen + extraLen + compSize;
  }
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
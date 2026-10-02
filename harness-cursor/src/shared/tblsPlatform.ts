/** Pure functions for picking the right GitHub release asset for the current OS/arch. No `vscode` dependency. */

export type TblsAssetFormat = 'zip' | 'tar.gz';

/** Platform strings compatible with both Node.js (`process.platform`) and tbls's release naming. */
export type TblsPlatform = 'win32' | 'darwin' | 'linux';
export type TblsArch = 'x64' | 'arm64';

export interface TblsAssetKey {
  readonly platform: TblsPlatform;
  readonly arch: TblsArch;
  readonly version: string;
}

export interface TblsAsset {
  readonly key: TblsAssetKey;
  readonly filename: string;
  readonly format: TblsAssetFormat;
}

/**
 * Mapping table for the platforms/archs we support downloading.
 * tbls ships:
 *   - windows_amd64.zip
 *   - darwin_amd64.zip, darwin_arm64.zip
 *   - linux_amd64.tar.gz, linux_arm64.tar.gz
 * Returns `undefined` for unsupported combos (e.g. windows-arm64, freebsd).
 */
export function pickAsset(platform: string, arch: string, version: string): TblsAsset | undefined {
  const v = version.replace(/^v/, '');
  const vLabel = `v${v}`;
  if (platform === 'win32' && arch === 'x64') {
    return {
      key: { platform: 'win32', arch: 'x64', version: v },
      filename: `tbls_${vLabel}_windows_amd64.zip`,
      format: 'zip',
    };
  }
  if (platform === 'darwin' && (arch === 'x64' || arch === 'arm64')) {
    return {
      key: { platform: 'darwin', arch, version: v },
      filename: `tbls_${vLabel}_darwin_${arch === 'x64' ? 'amd64' : 'arm64'}.zip`,
      format: 'zip',
    };
  }
  if (platform === 'linux' && (arch === 'x64' || arch === 'arm64')) {
    return {
      key: { platform: 'linux', arch, version: v },
      filename: `tbls_${vLabel}_linux_${arch === 'x64' ? 'amd64' : 'arm64'}.tar.gz`,
      format: 'tar.gz',
    };
  }
  return undefined;
}

/** Name of the binary inside the archive. tbls only ships `.exe` on Windows. */
export function binaryFilename(platform: string): string {
  return platform === 'win32' ? 'tbls.exe' : 'tbls';
}

/** Directory name under `<globalStorage>/bin/` for a given asset. */
export function binDirName(asset: TblsAsset): string {
  return `tbls-${asset.key.version.replace(/^v/, '')}-${asset.key.platform}-${asset.key.arch}`;
}
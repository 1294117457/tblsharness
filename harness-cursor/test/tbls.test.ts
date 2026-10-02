import { describe, expect, it } from 'vitest';
import { binaryFilename, binDirName, pickAsset } from '../src/shared/tblsPlatform';

describe('tblsPlatform', () => {
  it('picks the windows zip for win32 x64', () => {
    const asset = pickAsset('win32', 'x64', '1.86.0');
    expect(asset).toBeDefined();
    expect(asset!.filename).toBe('tbls_v1.86.0_windows_amd64.zip');
    expect(asset!.format).toBe('zip');
    expect(asset!.key.version).toBe('1.86.0');
    expect(binaryFilename(asset!.key.platform)).toBe('tbls.exe');
  });

  it('picks the darwin zip for darwin arm64', () => {
    const asset = pickAsset('darwin', 'arm64', '1.86.0');
    expect(asset).toBeDefined();
    expect(asset!.filename).toBe('tbls_v1.86.0_darwin_arm64.zip');
    expect(asset!.format).toBe('zip');
    expect(binaryFilename(asset!.key.platform)).toBe('tbls');
  });

  it('picks the linux tarball for linux amd64', () => {
    const asset = pickAsset('linux', 'x64', 'v2.0.1');
    expect(asset).toBeDefined();
    expect(asset!.filename).toBe('tbls_v2.0.1_linux_amd64.tar.gz');
    expect(asset!.format).toBe('tar.gz');
  });

  it('returns undefined for unsupported platforms/archs', () => {
    expect(pickAsset('freebsd', 'x64', '1.86.0')).toBeUndefined();
    expect(pickAsset('linux', 'ia32', '1.86.0')).toBeUndefined();
    expect(pickAsset('win32', 'arm64', '1.86.0')).toBeUndefined();
  });

  it('builds a stable bin directory name', () => {
    const asset = pickAsset('darwin', 'arm64', '1.86.0')!;
    expect(binDirName(asset)).toBe('tbls-1.86.0-darwin-arm64');
  });

  it('strips a leading v from version', () => {
    const asset = pickAsset('linux', 'arm64', 'v1.86.0')!;
    expect(asset.filename).toBe('tbls_v1.86.0_linux_arm64.tar.gz');
    expect(binDirName(asset)).toBe('tbls-1.86.0-linux-arm64');
  });

  it('produces correct filenames for darwin amd64', () => {
    const asset = pickAsset('darwin', 'x64', '1.96.1')!;
    expect(asset.filename).toBe('tbls_v1.96.1_darwin_amd64.zip');
    expect(asset.format).toBe('zip');
  });
});
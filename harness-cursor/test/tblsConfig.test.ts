import { describe, expect, it } from 'vitest';
import {
  BUNDLED_TBLS_VERSION,
  DEFAULT_TBLS_DOWNLOAD_BASE_URL,
  checksumsFilename,
  checksumsUrl,
  downloadUrl,
  normalizeBaseUrl,
  normalizeVersion,
  parseChecksums,
  releaseTagApiUrl,
  sameDigest,
  tagFor,
} from '../src/shared/tblsConfig';
import { pickAsset } from '../src/shared/tblsPlatform';

describe('normalizeBaseUrl', () => {
  it('keeps a proper download base URL untouched', () => {
    expect(normalizeBaseUrl('https://github.com/k1LoW/tbls/releases/download')).toBe('https://github.com/k1LoW/tbls/releases/download');
  });

  it('upgrades the legacy releases listing page to a download base', () => {
    // Regression: the old default (a listing page) 404s for asset downloads.
    expect(normalizeBaseUrl('https://github.com/k1LoW/tbls/releases')).toBe('https://github.com/k1LoW/tbls/releases/download');
  });

  it('strips trailing slashes before deciding', () => {
    expect(normalizeBaseUrl('https://github.com/k1LoW/tbls/releases/')).toBe('https://github.com/k1LoW/tbls/releases/download');
    expect(normalizeBaseUrl('https://github.com/k1LoW/tbls/releases/download/')).toBe('https://github.com/k1LoW/tbls/releases/download');
  });

  it('falls back to the default for empty values', () => {
    expect(normalizeBaseUrl('')).toBe(DEFAULT_TBLS_DOWNLOAD_BASE_URL);
    expect(normalizeBaseUrl(undefined)).toBe(DEFAULT_TBLS_DOWNLOAD_BASE_URL);
    expect(normalizeBaseUrl(null)).toBe(DEFAULT_TBLS_DOWNLOAD_BASE_URL);
  });

  it('leaves a custom mirror alone', () => {
    expect(normalizeBaseUrl('https://mirror.example.test/tbls')).toBe('https://mirror.example.test/tbls');
  });
});

describe('normalizeVersion', () => {
  it('strips a leading v and whitespace', () => {
    expect(normalizeVersion('v1.96.1')).toBe('1.96.1');
    expect(normalizeVersion('  1.96.1  ')).toBe('1.96.1');
  });

  it('returns undefined for empty values so callers can fall back', () => {
    expect(normalizeVersion('')).toBeUndefined();
    expect(normalizeVersion('   ')).toBeUndefined();
    expect(normalizeVersion(undefined)).toBeUndefined();
  });
});

describe('BUNDLED_TBLS_VERSION', () => {
  it('is independent of the extension version and looks like a tbls release', () => {
    // The extension is 0.x; using its version as the tbls version guarantees a 404.
    expect(BUNDLED_TBLS_VERSION).toMatch(/^1\.\d+\.\d+$/);
    expect(tagFor(BUNDLED_TBLS_VERSION)).toBe(`v${BUNDLED_TBLS_VERSION}`);
  });
});

describe('downloadUrl', () => {
  const asset = pickAsset('win32', 'x64', '1.96.1')!;

  it('includes the /download segment GitHub requires', () => {
    expect(downloadUrl(DEFAULT_TBLS_DOWNLOAD_BASE_URL, asset)).toBe(
      'https://github.com/k1LoW/tbls/releases/download/v1.96.1/tbls_v1.96.1_windows_amd64.zip',
    );
  });

  it('repairs a legacy base URL at build time', () => {
    expect(downloadUrl('https://github.com/k1LoW/tbls/releases', asset)).toBe(
      'https://github.com/k1LoW/tbls/releases/download/v1.96.1/tbls_v1.96.1_windows_amd64.zip',
    );
  });

  it('uses the v-prefixed tag and the real asset name', () => {
    const url = new URL(downloadUrl(DEFAULT_TBLS_DOWNLOAD_BASE_URL, asset));
    expect(url.pathname).toBe('/k1LoW/tbls/releases/download/v1.96.1/tbls_v1.96.1_windows_amd64.zip');
  });
});

describe('checksumsUrl', () => {
  it('targets the per-platform checksums file', () => {
    expect(checksumsFilename('windows')).toBe('checksums-windows.txt');
    expect(checksumsUrl(DEFAULT_TBLS_DOWNLOAD_BASE_URL, '1.96.1', 'windows')).toBe(
      'https://github.com/k1LoW/tbls/releases/download/v1.96.1/checksums-windows.txt',
    );
  });
});

describe('releaseTagApiUrl', () => {
  it('points at the tag endpoint with a v prefix', () => {
    expect(releaseTagApiUrl('1.96.1')).toBe('https://api.github.com/repos/k1LoW/tbls/releases/tags/v1.96.1');
    expect(releaseTagApiUrl('v1.96.1')).toBe('https://api.github.com/repos/k1LoW/tbls/releases/tags/v1.96.1');
  });
});

describe('parseChecksums', () => {
  // Real content shape of tbls' checksums-windows.txt (fetched from the v1.96.1 release).
  const real = 'ecd641e0d1ffde95350b1336cb03603c7f7fd8c7fc20a996323ea80d8594a5c6  tbls_v1.96.1_windows_amd64.zip\n';

  it('parses the real single-line format', () => {
    expect(parseChecksums(real)).toEqual({
      'tbls_v1.96.1_windows_amd64.zip': 'ecd641e0d1ffde95350b1336cb03603c7f7fd8c7fc20a996323ea80d8594a5c6',
    });
  });

  it('handles CRLF, multiple entries, and binary-mode asterisks', () => {
    const text = [
      'a'.repeat(64) + '  tbls_v1.96.1_windows_amd64.zip',
      'b'.repeat(64) + ' *tbls_v1.96.1_windows_amd64.zip',
      'c'.repeat(64) + '  tbls_v1.96.1_linux_amd64.tar.gz',
    ].join('\r\n');
    const map = parseChecksums(text);
    expect(Object.keys(map).sort()).toEqual(['tbls_v1.96.1_linux_amd64.tar.gz', 'tbls_v1.96.1_windows_amd64.zip']);
    // The '*' binary-mode marker is stripped, so both spellings of the same asset collide.
    expect(map['tbls_v1.96.1_windows_amd64.zip']).toBe('b'.repeat(64));
    expect(map['tbls_v1.96.1_linux_amd64.tar.gz']).toBe('c'.repeat(64));
  });

  it('looks entries up by exact file name', () => {
    const text = 'a'.repeat(64) + '  tbls_v1.96.1_linux_amd64.tar.gz';
    // Guards against the old bug: taking only the first line of the checksums file.
    expect(parseChecksums(text)['tbls_v1.96.1_windows_amd64.zip']).toBeUndefined();
  });

  it('lowercases digests so comparisons are case-insensitive', () => {
    expect(parseChecksums('ABCDEF' + '0'.repeat(58) + '  a.zip')['a.zip']).toBe('abcdef' + '0'.repeat(58));
  });

  it('skips blank lines, comments, and malformed entries', () => {
    const map = parseChecksums(['', '# generated by goreleaser', 'not-a-checksum', '  ', `short  a.zip`, 'zz  b.zip'].join('\n'));
    expect(map).toEqual({});
  });

  it('returns an empty map for empty input', () => {
    expect(parseChecksums('')).toEqual({});
  });
});

describe('sameDigest', () => {
  it('compares case-insensitively and rejects empties', () => {
    expect(sameDigest('ABC', 'abc')).toBe(true);
    expect(sameDigest('abc', 'abd')).toBe(false);
    expect(sameDigest(undefined, 'abc')).toBe(false);
    expect(sameDigest('', '')).toBe(false);
  });
});

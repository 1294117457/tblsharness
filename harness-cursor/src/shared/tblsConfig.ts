/** Pure helpers for the bundled tbls download: version constant, URL building, checksum parsing. No `vscode`. */

import { binaryFilename, pickAsset, type TblsAsset } from './tblsPlatform';

/**
 * The tbls version Harness bundles.
 *
 * This MUST NOT fall back to the extension's own version: the extension is versioned `0.x`
 * while tbls is `1.x`, so the two version spaces never line up and every download would 404.
 * Bump this constant (and only this constant) to move Harness to a newer tbls.
 */
export const BUNDLED_TBLS_VERSION = '1.96.1';

/**
 * Base URL for release *downloads*.
 *
 * Note the trailing `/releases/download` — the asset lives at
 * `<repo>/releases/download/<tag>/<file>`, NOT `<repo>/releases/<tag>/<file>` (the latter is 404).
 */
export const DEFAULT_TBLS_DOWNLOAD_BASE_URL = 'https://github.com/k1LoW/tbls/releases/download';

/** GitHub API endpoint used to check that a tag exists before attempting a download. */
export const TBLS_RELEASES_API = 'https://api.github.com/repos/k1LoW/tbls/releases';

/**
 * Normalizes a user-supplied download base URL.
 *
 * Older versions of Harness defaulted to the releases *listing page*
 * (`https://github.com/k1LoW/tbls/releases`), which 404s for asset downloads. Users who still
 * have that value in their settings keep getting the normalized `/releases/download` form so an
 * extension upgrade doesn't leave them stuck.
 */
export function normalizeBaseUrl(raw: string | undefined | null): string {
  const base = (raw ?? '').trim().replace(/\/+$/, '');
  if (!base) return DEFAULT_TBLS_DOWNLOAD_BASE_URL;
  // Already a download base, or some other host entirely: leave it alone.
  if (/\/releases\/download$/.test(base) || !/\/releases$/.test(base)) return base;
  return `${base}/download`;
}

/** Strips a leading `v` and surrounding whitespace from a version string. */
export function normalizeVersion(raw: string | undefined | null): string | undefined {
  const v = (raw ?? '').trim().replace(/^v/, '').trim();
  return v || undefined;
}

/** The `v`-prefixed git tag for a tbls version (e.g. `1.96.1` → `v1.96.1`). */
export function tagFor(version: string): string {
  return `v${normalizeVersion(version) ?? BUNDLED_TBLS_VERSION}`;
}

/** The file name of the `checksums-<platform>.txt` asset published alongside the binaries. */
export function checksumsFilename(platform: string): string {
  return `checksums-${platform}.txt`;
}

/**
 * Builds the full download URL for a release asset.
 *
 * `baseUrl` is normalized first, so both the current default and the legacy listing-page value
 * produce a working URL.
 */
export function downloadUrl(baseUrl: string, asset: TblsAsset): string {
  return `${normalizeBaseUrl(baseUrl)}/${tagFor(asset.key.version)}/${asset.filename}`;
}

/** Builds the URL of the `checksums-<platform>.txt` file for a release. */
export function checksumsUrl(baseUrl: string, version: string, platform: string): string {
  return `${normalizeBaseUrl(baseUrl)}/${tagFor(version)}/${checksumsFilename(platform)}`;
}

/** Builds the GitHub API URL used to confirm a tag exists. */
export function releaseTagApiUrl(version: string): string {
  return `${TBLS_RELEASES_API}/tags/${tagFor(version)}`;
}

/**
 * Picks the release asset for a given platform, or returns `undefined` when unsupported.
 *
 * Takes platform/arch as arguments instead of reading `process` so this module stays usable from
 * the webview bundle and from unit tests (`src/shared/` must not depend on the host environment).
 */
export function assetFor(platform: string, arch: string, version: string): TblsAsset | undefined {
  return pickAsset(platform, arch, version);
}

/**
 * Parses a `checksums-<platform>.txt` file into a `filename → sha256` map.
 *
 * The real file is a list of `<64-hex>  <name>` lines, e.g.
 * `ecd641e0…4a5c6  tbls_v1.96.1_windows_amd64.zip`. Lines that don't match, blank lines, and
 * comments are skipped so a stray header can't break verification.
 */
export function parseChecksums(text: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = /^([0-9a-fA-F]{64})\s+[*\s]?(.+)$/.exec(trimmed);
    if (!match) continue;
    // Strip a leading '*' (binary-mode marker in sha256sum output).
    map[match[2].trim()] = match[1].toLowerCase();
  }
  return map;
}

/** Compares two sha256 hex digests case-insensitively. */
export function sameDigest(a: string | undefined, b: string | undefined): boolean {
  return !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Human-readable label for the binary inside an asset, e.g. `tbls.exe`. */
export function assetBinaryLabel(asset: TblsAsset): string {
  return binaryFilename(asset.key.platform);
}

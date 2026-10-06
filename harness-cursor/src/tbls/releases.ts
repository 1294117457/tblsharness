import { readTblsConfig } from './config';

/**
 * @deprecated Kept as thin re-exports so existing imports keep working.
 * All configuration now flows through {@link readTblsConfig}; nothing reads
 * `vscode.workspace.getConfiguration` for tbls settings directly anymore.
 */

/** The release *download* base URL (always ends in `/releases/download`). */
export function resolveBaseUrl(): string {
  return readTblsConfig().baseUrl;
}

/** The bundled tbls version. Independent of the extension's own version. */
export function resolveVersion(): string {
  return readTblsConfig().version;
}

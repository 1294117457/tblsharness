import * as vscode from 'vscode';

/** Resolves the configured download base URL (e.g. `https://github.com/k1LoW/tbls/releases`). */
export function resolveBaseUrl(config: vscode.WorkspaceConfiguration): string {
  return config.get<string>('harness.tblsDownloadBaseUrl', 'https://github.com/k1LoW/tbls/releases').replace(/\/$/, '');
}

/** Resolves the desired tbls version (e.g. `1.86.0`). Falls back to the extension's bundled version. */
export function resolveVersion(config: vscode.WorkspaceConfiguration, extensionVersion: string): string {
  return config.get<string>('harness.tblsVersion', extensionVersion).replace(/^v/, '');
}
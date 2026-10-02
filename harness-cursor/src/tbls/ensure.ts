import * as vscode from 'vscode';
import { install, probe } from './manager';
import { resolveBaseUrl } from './releases';

/**
 * Returns the bundled tbls binary path if present; otherwise tries a non-blocking install
 * if `harness.tblsAutoDownload` is enabled. Logs but never throws — the user will see a
 * clear "Error" message the next time they try to use tbls.
 */
export async function ensureTbls(context: vscode.ExtensionContext): Promise<void> {
  const config = vscode.workspace.getConfiguration('harness');
  const configuredPath = (config.get<string>('harness.tblsPath', '') || '').trim();
  if (configuredPath) return; // user override; nothing to do.

  const version = (config.get<string>('harness.tblsVersion', '') || context.extension.packageJSON.version).replace(/^v/, '');
  const baseUrl = resolveBaseUrl(config);

  if (await probe(context, version)) return;

  try {
    await install(context, version, baseUrl);
    console.log(`[harness.tbls] 已下载 tbls v${version} 到 ${context.globalStorageUri.fsPath}/bin/`);
  } catch (err) {
    console.error(`[harness.tbls] 自动下载失败：${(err as Error).message}`);
  }
}
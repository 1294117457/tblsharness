import * as vscode from 'vscode';
import { install, probe } from './manager';
import { readTblsConfig } from './config';

/** Whether the auto-download notice for this session was already shown. */
let notified = false;

/**
 * Downloads the bundled tbls in the background if it is missing.
 *
 * Never throws: activation must not be blocked by a slow or failing download. Failures are
 * surfaced once through a notification with a "下载" action, instead of only reaching the console.
 */
export async function ensureTbls(context: vscode.ExtensionContext): Promise<void> {
  const config = readTblsConfig();
  if (config.tblsPath) return; // user override; nothing to do.
  if (!config.autoDownload) return;
  if (await probe(context, config.version)) return;

  try {
    await install(context, config.version, config.baseUrl);
    void vscode.window.setStatusBarMessage(`Harness：已下载内置 tbls v${config.version}`, 8000);
  } catch (err) {
    const message = (err as Error).message;
    console.error(`[harness.tbls] 自动下载失败：${message}`);
    if (notified) return;
    notified = true;
    const pick = await vscode.window.showWarningMessage(
      `Harness 没有内置的 tbls，自动下载失败：${message}`,
      '重新下载',
      '选择本地文件…',
    );
    if (pick === '重新下载') await vscode.commands.executeCommand('harness.tbls.repair');
    if (pick === '选择本地文件…') await vscode.commands.executeCommand('workbench.action.openSettings', 'harness.tblsPath');
  }
}

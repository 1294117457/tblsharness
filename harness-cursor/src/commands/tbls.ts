import { execFile } from 'node:child_process';
import * as vscode from 'vscode';
import type { Harness } from './common';
import { register } from './common';
import { install, probe, readCurrent, verify } from '../tbls/manager';
import { resolveBaseUrl, resolveVersion } from '../tbls/releases';

interface RunTblsResult {
  ok: boolean;
  version: string;
  error?: string;
}

function runTblsVersion(path: string, timeoutMs = 10_000): Promise<RunTblsResult> {
  return new Promise((resolve) => {
    execFile(path, ['--version'], { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      if (err) {
        resolve({ ok: false, version: '', error: (err as Error).message });
        return;
      }
      const firstLine = String(stdout).trim().split(/\r?\n/)[0] ?? '';
      // tbls prints `tbls version 1.86.0`; keep the full line but fall back to whatever came out.
      resolve({ ok: true, version: firstLine || String(stdout).trim() });
    });
  });
}

function pathExists(p: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(process.platform === 'win32' ? 'where' : 'which', [p], { windowsHide: true }, (err) => resolve(!err));
  });
}

export function registerTblsCommands(h: Harness): void {
  const extensionVersion = (): string => resolveVersion(vscode.workspace.getConfiguration('harness'), h.context.extension.packageJSON.version as string);
  const baseUrl = (): string => resolveBaseUrl(vscode.workspace.getConfiguration('harness'));

  register(h, 'harness.tbls.checkUpdate', async () => {
    const configured = (vscode.workspace.getConfiguration('harness').get<string>('harness.tblsPath', '') || '').trim();
    const bundledVersion = extensionVersion();
    const current = await readCurrent(h.context);

    if (configured) {
      if (!(await pathExists(configured))) {
        void vscode.window.showWarningMessage(`当前 “harness.tblsPath” 指向 ${configured}，但在系统上找不到它。请确认路径是否正确。`, '打开设置').then((p) => {
          if (p === '打开设置') void vscode.commands.executeCommand('workbench.action.openSettings', 'harness.tblsPath');
        });
        return;
      }
      const result = await runTblsVersion(configured);
      if (!result.ok) {
        void vscode.window.showWarningMessage(`无法执行 ${configured}：${result.error}`);
        return;
      }
      void vscode.window.showInformationMessage(`当前使用本地的 tbls：${result.version}（Harness 内置版本是 ${bundledVersion}）。`);
      return;
    }

    const installed = await probe(h.context, bundledVersion);
    if (!installed) {
      const pick = await vscode.window.showWarningMessage(
        `Harness 内置的 tbls 还没有下载（v${bundledVersion}）。`,
        '下载内置版本',
        '取消',
      );
      if (pick === '下载内置版本') await vscode.commands.executeCommand('harness.tbls.repair');
      return;
    }

    const result = await runTblsVersion(installed.fsPath);
    if (!result.ok) {
      const repairPick = await vscode.window.showErrorMessage(`已安装的 tbls 看起来坏了：${result.error}`, '重新下载');
      if (repairPick === '重新下载') await vscode.commands.executeCommand('harness.tbls.repair');
      return;
    }

    const installedVersion = current?.version ?? bundledVersion;
    if (installedVersion === bundledVersion) {
      void vscode.window.showInformationMessage(`已是最新版本：tbls v${bundledVersion}（${installed.fsPath}）。`);
      return;
    }

    const updatePick = await vscode.window.showInformationMessage(
      `已安装 v${installedVersion}，当前版本是 v${bundledVersion}。`,
      '下载 v' + bundledVersion,
    );
    if (updatePick) await vscode.commands.executeCommand('harness.tbls.repair');
  });

  register(h, 'harness.tbls.repair', async () => {
    const version = extensionVersion();
    const url = baseUrl();
    const progressTitle = `Harness：正在下载 tbls v${version}…`;
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: progressTitle }, async () => {
        await install(h.context, version, url);
      });
      const verification = await verify(h.context);
      if (!verification.ok) {
        void vscode.window.showErrorMessage(`tbls 下载完成，但自检失败：${verification.reason}`);
        return;
      }
      const picked = await vscode.window.showInformationMessage(
        `已下载 tbls v${version}。`,
        '打开文件夹',
      );
      if (picked === '打开文件夹') void vscode.commands.executeCommand('harness.tbls.openFolder');
    } catch (err) {
      const message = (err as Error).message;
      const pick = await vscode.window.showErrorMessage(`下载 tbls 失败：${message}`, '查看 Releases…');
      if (pick === '查看 Releases…') void vscode.env.openExternal(vscode.Uri.parse('https://github.com/k1LoW/tbls/releases'));
    }
  });

  register(h, 'harness.tbls.openFolder', async () => {
    const binDir = vscode.Uri.joinPath(h.context.globalStorageUri, 'bin');
    try {
      await vscode.workspace.fs.createDirectory(binDir);
    } catch {
      // ignore — already exists or not creatable; revealExternal still works for files.
    }
    await vscode.env.openExternal(vscode.Uri.file(binDir.fsPath));
  });
}
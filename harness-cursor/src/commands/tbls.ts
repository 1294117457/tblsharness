import * as vscode from 'vscode';
import type { Harness } from './common';
import { register } from './common';
import { install, probe, readCurrent, verify, TblsInstallError } from '../tbls/manager';
import { readTblsConfig } from '../tbls/config';
import { probeTblsVersion, whichTbls } from '../tbls/probeVersion';
import { resolveTbls, TblsResolveError } from '../tbls/resolver';
import { friendlyMissingTblsError } from '../connection/errors';

export function registerTblsCommands(h: Harness): void {
  const openTblsSetting = (): Thenable<unknown> =>
    vscode.commands.executeCommand('workbench.action.openSettings', 'harness.tblsPath');
  const openReleases = (): Thenable<boolean> =>
    vscode.env.openExternal(vscode.Uri.parse('https://github.com/k1LoW/tbls/releases'));

  register(h, 'harness.tbls.checkUpdate', async () => {
    const config = readTblsConfig();

    if (config.tblsPath) {
      const info = await probeTblsVersion(config.tblsPath);
      if (!info.ok) {
        const pick = await vscode.window.showWarningMessage(
          `当前 “harness.tblsPath” 指向 ${config.tblsPath}，但它无法运行：${info.error ?? '未知原因'}`,
          '重新选择',
          '改用内置版本',
        );
        if (pick === '重新选择') await openTblsSetting();
        if (pick === '改用内置版本') {
          await vscode.workspace.getConfiguration('harness').update('tblsPath', undefined, vscode.ConfigurationTarget.Global);
          void vscode.window.showInformationMessage('已清空 harness.tblsPath，将使用内置的 tbls。');
        }
        return;
      }
      const pick = await vscode.window.showInformationMessage(
        `当前使用本地的 tbls：${info.version ?? info.raw}（Harness 内置版本是 ${config.version}）。`,
        '查看 Releases…',
      );
      if (pick === '查看 Releases…') await openReleases();
      return;
    }

    const installed = await probe(h.context, config.version);
    if (!installed) {
      const pick = await vscode.window.showWarningMessage(`Harness 内置的 tbls 还没有下载（v${config.version}）。`, '下载内置版本', '取消');
      if (pick === '下载内置版本') await vscode.commands.executeCommand('harness.tbls.repair');
      return;
    }

    const info = await probeTblsVersion(installed.fsPath);
    if (!info.ok) {
      const repairPick = await vscode.window.showErrorMessage(`已安装的 tbls 看起来坏了：${info.error}`, '重新下载');
      if (repairPick === '重新下载') await vscode.commands.executeCommand('harness.tbls.repair');
      return;
    }

    const record = await readCurrent(h.context);
    const installedVersion = record?.version ?? config.version;
    if (installedVersion === config.version) {
      void vscode.window.showInformationMessage(`已是最新版本：tbls v${config.version}（${installed.fsPath}）。`);
      return;
    }

    const updatePick = await vscode.window.showInformationMessage(`已安装 v${installedVersion}，当前版本是 v${config.version}。`, '下载 v' + config.version);
    if (updatePick) await vscode.commands.executeCommand('harness.tbls.repair');
  });

  register(h, 'harness.tbls.repair', async () => {
    const config = readTblsConfig();
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Harness：正在下载 tbls v${config.version}…`, cancellable: true },
        (progress, token) => install(h.context, config.version, config.baseUrl, {
          token,
          onProgress: (message, increment) => (increment !== undefined ? progress.report({ increment }) : progress.report({ message })),
        }),
      );
      const verification = await verify(h.context);
      if (!verification.ok) {
        void vscode.window.showErrorMessage(`tbls 下载完成，但自检失败：${verification.reason}`);
        return;
      }
      const note = verification.verified ? '' : '（这次没有拿到官方校验文件，未做 sha256 校验）';
      const picked = await vscode.window.showInformationMessage(`已下载 tbls v${config.version}${note}。`, '打开文件夹');
      if (picked === '打开文件夹') void vscode.commands.executeCommand('harness.tbls.openFolder');
    } catch (err) {
      const message = (err as Error).message;
      const detail = err instanceof TblsInstallError ? err.detail : undefined;
      const pick = await vscode.window.showErrorMessage(`下载 tbls 失败：${message}`, { detail }, '查看 Releases…', '设置 tbls 路径');
      if (pick === '查看 Releases…') await openReleases();
      if (pick === '设置 tbls 路径') await openTblsSetting();
    }
  });

  register(h, 'harness.tbls.openFolder', async () => {
    const dir = vscode.Uri.joinPath(h.context.globalStorageUri, 'bin');
    try {
      await vscode.workspace.fs.createDirectory(dir);
    } catch {
      // ignore — already exists or not creatable; openExternal still works for files.
    }
    await vscode.env.openExternal(vscode.Uri.file(dir.fsPath));
  });

  /** Reports what Harness would run right now — used by "why isn't this working?" debugging. */
  register(h, 'harness.tbls.status', async () => {
    const config = readTblsConfig();
    try {
      const resolved = await resolveTbls(h.context);
      const info = await probeTblsVersion(resolved.path);
      const onPath = config.tblsPath && !config.tblsPath.includes('/') && !config.tblsPath.includes('\\') ? await whichTbls(config.tblsPath) : undefined;
      void vscode.window.showInformationMessage(
        [
          `来源：${resolved.source === 'bundled' ? '内置下载' : '本地配置'}`,
          `路径：${resolved.path}`,
          `版本：${info.version ?? info.raw ?? '未知'}`,
          `可执行：${info.ok ? '是' : `否（${info.error ?? '未知原因'}）`}`,
          config.tblsPath ? `设置值：${config.tblsPath}${onPath ? `（PATH 解析为 ${onPath}）` : ''}` : '设置值：空（使用内置版本）',
          `内置版本：v${config.version}`,
        ].join('\n'),
        '打开文件夹',
      ).then((p) => {
        if (p === '打开文件夹') void vscode.commands.executeCommand('harness.tbls.openFolder');
      });
    } catch (err) {
      const friendly = err instanceof TblsResolveError ? friendlyMissingTblsError(err) : undefined;
      const message = friendly?.message ?? (err as Error).message;
      const pick = await vscode.window.showWarningMessage(`当前没有可用的 tbls：${message}`, '下载内置版本', '设置 tbls 路径');
      if (pick === '下载内置版本') await vscode.commands.executeCommand('harness.tbls.repair');
      if (pick === '设置 tbls 路径') await openTblsSetting();
    }
  });
}

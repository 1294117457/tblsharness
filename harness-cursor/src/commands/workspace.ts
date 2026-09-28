import * as vscode from 'vscode';
import { nextDefaultName } from '../shared/workspace';
import type { TreeNode } from '../views/workspaceTree';
import { removeRecursive } from '../workspace/fsUtil';
import { closeTabsUnder, confirm, pickWorkspace, promptName, register, required, revealInTree, workspaceNames, type Harness } from './common';

export function registerWorkspaceCommands(h: Harness): void {
  register(h, 'harness.workspace.create', async () => {
    const name = nextDefaultName('工作区', await workspaceNames(h));
    const ws = await h.storage.createWorkspace(name, '画布 1');
    h.store.invalidate({});
    void revealInTree(h, { kind: 'workspace', workspace: ws.id });
    void vscode.window.showInformationMessage(`已创建${name}，按 F2 可以重命名。`);
  });

  register(h, 'harness.workspace.rename', async (arg) => {
    const ws = await pickWorkspace(h, arg);
    const meta = await ws.readMeta();
    const name = await promptName('重命名工作区', meta.name);
    await ws.writeMeta({ ...meta, name });
    h.store.invalidate({ workspace: ws.id, kind: 'workspace' });
  });

  register(h, 'harness.workspace.delete', async (arg) => {
    const ws = await pickWorkspace(h, arg);
    const [meta, designIds, dbIds, canvasIds] = await Promise.all([ws.readMeta(), ws.designIds(), ws.dbIds(), ws.canvasIds()]);
    await confirm(
      `确定删除工作区“${meta.name}”吗？`,
      `将删除 ${designIds.length} 个设计库、${dbIds.length} 个数据库（含快照和已保存的连接）、${canvasIds.length} 个画布。此操作不能撤销。`,
      '删除',
    );
    await closeTabsUnder(ws.dir);
    for (const id of dbIds) await h.context.secrets.delete(ws.db(id).secretKey);
    await removeRecursive(ws.dir);
    h.store.invalidate({});
  });

  register(h, 'harness.workspace.add', async (arg) => {
    const ws = await pickWorkspace(h, arg);
    const pick = required(
      await vscode.window.showQuickPick(
        [
          { label: '$(edit) 设计库', command: 'harness.design.create' },
          { label: '$(database) 数据库', command: 'harness.db.create' },
          { label: '$(type-hierarchy) 画布', command: 'harness.canvas.create' },
        ],
        { title: '新建' },
      ),
    );
    await vscode.commands.executeCommand(pick.command, { workspace: ws.id });
  });

  /** F2 in the tree: forwards to the rename command of whatever is selected. */
  register(h, 'harness.rename', async (arg) => {
    const node = (arg as TreeNode | undefined) ?? h.treeView.selection[0];
    if (!node) return;
    if (node.kind === 'db') {
      const pick = await vscode.window.showInformationMessage('数据库的名称来自连接信息（主机:端口/库名），不能单独修改。', '编辑连接…');
      if (pick) await vscode.commands.executeCommand('harness.db.editConnection', node);
      return;
    }
    const commands: Partial<Record<TreeNode['kind'], string>> = {
      workspace: 'harness.workspace.rename',
      design: 'harness.design.rename',
      canvas: 'harness.canvas.rename',
    };
    const command = commands[node.kind];
    if (command) await vscode.commands.executeCommand(command, node);
  });

  /** Tree "编辑…" button: name and description, plus the target database type for a design. */
  register(h, 'harness.edit', async (arg) => {
    const node = (arg as TreeNode | undefined) ?? h.treeView.selection[0];
    if (!node) return;
    if (node.kind === 'db') return vscode.commands.executeCommand('harness.db.editConnection', node);
    if (node.kind !== 'workspace' && node.kind !== 'design' && node.kind !== 'canvas') return;
    const ws = await pickWorkspace(h, node);
    h.editors.open(node.kind, ws, node.kind === 'workspace' ? undefined : node.id);
  });

  register(h, 'harness.refresh', () => h.store.invalidate({}));

  register(h, 'harness.openStorage', async () => {
    await vscode.workspace.fs.createDirectory(h.storage.workspacesDir);
    await vscode.commands.executeCommand('revealFileInOS', h.storage.workspacesDir);
  });
}

import * as vscode from 'vscode';
import type { CanvasEditorProvider } from '../canvas/canvasEditor';
import type { ItemRef } from '../shared/canvas';
import { itemOf, levelOf, type TreeNode } from './workspaceTree';

const MIME = 'application/vnd.code.tree.harness.workspaces';

interface DragPayload {
  workspace: string;
  design: string;
  items: ItemRef[];
}

/**
 * Dragging design tables, diagrams or partitions onto another level of the same design moves them there.
 * The tree API does not report modifier keys, so copying goes through right-click 复制 / 粘贴.
 */
export class TreeDragAndDrop implements vscode.TreeDragAndDropController<TreeNode> {
  readonly dragMimeTypes = [MIME];
  readonly dropMimeTypes = [MIME];

  constructor(private readonly canvases: CanvasEditorProvider) {}

  handleDrag(source: readonly TreeNode[], data: vscode.DataTransfer): void {
    const items = source.map(itemOf).filter((i): i is NonNullable<typeof i> => !!i);
    if (!items.length) return;
    const { workspace, design } = items[0];
    const same = items.filter((i) => i.workspace === workspace && i.design === design);
    const payload: DragPayload = { workspace, design, items: same.map((i) => i.ref) };
    data.set(MIME, new vscode.DataTransferItem(payload));
  }

  async handleDrop(target: TreeNode | undefined, data: vscode.DataTransfer): Promise<void> {
    const payload = data.get(MIME)?.value as DragPayload | undefined;
    const level = target && levelOf(target);
    if (!payload?.items.length || !level) return;
    if (level.workspace !== payload.workspace || level.design !== payload.design) {
      void vscode.window.showInformationMessage('目前只能在同一个设计画布内拖动。');
      return;
    }
    try {
      const message = await this.canvases.pasteItems(level.workspace, level.design, 'cut', payload.items, level.partition);
      vscode.window.setStatusBarMessage(`Harness：${message}`, 4000);
    } catch (err) {
      const message = (err as Error).message;
      if (message !== '已取消') void vscode.window.showErrorMessage(`Harness：${message}`);
    }
  }
}

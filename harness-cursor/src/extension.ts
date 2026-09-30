import * as vscode from 'vscode';
import { CanvasEditorProvider } from './canvas/canvasEditor';
import { registerCanvasCommands } from './commands/canvas';
import type { Harness } from './commands/common';
import { registerDbCommands } from './commands/db';
import { registerDesignCommands } from './commands/design';
import { registerDiagramCommands } from './commands/diagram';
import { DiagramEditorProvider } from './diagram/diagramEditor';
import { DiagramService } from './diagram/diagramService';
import { registerWorkspaceCommands } from './commands/workspace';
import { ConnectionPanels } from './connection/connectionPanel';
import { EditPanels } from './edit/editPanel';
import { ModelStore } from './model/store';
import { TreeDragAndDrop } from './views/treeDragAndDrop';
import { WorkspaceTreeProvider } from './views/workspaceTree';
import { HarnessStorage } from './workspace/storage';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const storage = new HarnessStorage(context);
  const store = new ModelStore(storage, context.secrets);
  const tree = new WorkspaceTreeProvider(storage, store, context.secrets, context.extensionUri);
  const diagrams = new DiagramService(storage, store);
  tree.diagrams = diagrams;
  const canvases = CanvasEditorProvider.register(context, storage, store, diagrams);
  tree.layoutOf = (workspace, design) => canvases.layout(workspace, design);
  const treeView = vscode.window.createTreeView('harness.workspaces', {
    treeDataProvider: tree,
    showCollapseAll: true,
    canSelectMany: true,
    dragAndDropController: new TreeDragAndDrop(canvases),
  });
  const h = { context, storage, store, tree, treeView, canvases, diagrams } as Harness;
  h.connections = new ConnectionPanels(h);
  h.editors = new EditPanels(h);

  context.subscriptions.push(
    store,
    tree,
    treeView,
    diagrams,
    h.connections,
    h.editors,
    canvases.onDidChangeLayout(() => tree.refresh()),
    DiagramEditorProvider.register(context, diagrams, store),
  );
  registerWorkspaceCommands(h);
  registerDesignCommands(h);
  registerDiagramCommands(h);
  registerDbCommands(h);
  registerCanvasCommands(h);

  const watcher = new StorageWatcher(storage, store);
  context.subscriptions.push(
    watcher,
    vscode.workspace.onDidSaveTextDocument((doc) => void store.onFileEvent(doc.uri)),
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (e.affectsConfiguration('harness.storageDir')) {
        await watcher.start();
        store.invalidate({});
      }
    }),
  );
  await watcher.start();
}

export function deactivate(): void {}

/** The storage root is usually outside every open folder, so it needs its own watcher. */
class StorageWatcher implements vscode.Disposable {
  private watcher: vscode.FileSystemWatcher | undefined;
  private readonly pending = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly storage: HarnessStorage,
    private readonly store: ModelStore,
  ) {}

  async start(): Promise<void> {
    this.watcher?.dispose();
    await vscode.workspace.fs.createDirectory(this.storage.workspacesDir);
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.storage.workspacesDir, '**/*'));
    const schedule = (uri: vscode.Uri) => {
      const key = uri.toString();
      clearTimeout(this.pending.get(key));
      this.pending.set(
        key,
        setTimeout(() => {
          this.pending.delete(key);
          void this.store.onFileEvent(uri);
        }, 200),
      );
    };
    watcher.onDidCreate(schedule);
    watcher.onDidChange(schedule);
    watcher.onDidDelete(schedule);
    this.watcher = watcher;
  }

  dispose(): void {
    this.watcher?.dispose();
    for (const t of this.pending.values()) clearTimeout(t);
  }
}

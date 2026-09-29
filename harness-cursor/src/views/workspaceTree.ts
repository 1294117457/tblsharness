import * as vscode from 'vscode';
import type { DiagramService } from '../diagram/diagramService';
import type { ModelStore } from '../model/store';
import { diagramTypeLabel, type DiagramType } from '../shared/diagram';
import { driverInfo, type ConnectionDriver } from '../shared/connection';
import type { NColumn, NTable } from '../shared/model';
import { driverLabel, type SourceKind } from '../shared/workspace';
import { parseCanvas } from '../shared/canvas';
import { readText } from '../workspace/fsUtil';
import type { HarnessStorage } from '../workspace/storage';

type Group = 'design' | 'db';

/** Drivers with a brand icon under media/db (`<driver>-light.svg` / `<driver>-dark.svg`). */
const DRIVER_ICONS = new Set<ConnectionDriver>(['postgres', 'mysql', 'mariadb', 'sqlserver', 'sqlite', 'clickhouse', 'redshift']);

export type TreeNode =
  | { kind: 'workspace'; workspace: string }
  | { kind: 'group'; workspace: string; group: Group }
  | { kind: 'placeholder'; workspace: string; group: Group }
  | { kind: 'design'; workspace: string; id: string }
  /** "表结构" under a design; `id` is the design ID. */
  | { kind: 'designTables'; workspace: string; id: string }
  /** "设计图" under a design; `id` is the design ID. */
  | { kind: 'diagramGroup'; workspace: string; id: string }
  | { kind: 'diagramPlaceholder'; workspace: string; id: string }
  | { kind: 'diagram'; workspace: string; design: string; id: string }
  /** "画布" group under a design. `id` is the design. */
  | { kind: 'canvasGroup'; workspace: string; id: string }
  | { kind: 'canvas'; workspace: string; design: string; id: string }
  | { kind: 'db'; workspace: string; id: string }
  | { kind: 'table'; workspace: string; source: SourceKind; id: string; table: NTable; fks: Set<string> }
  | { kind: 'column'; workspace: string; source: SourceKind; id: string; table: string; column: NColumn; fk: boolean };

const DIAGRAM_ICONS: Record<DiagramType, string> = {
  er: 'type-hierarchy-sub',
  state: 'debug-step-over',
  sequence: 'arrow-swap',
  flow: 'git-merge',
  dataflow: 'arrow-both',
};

const GROUP_INFO: Record<Group, { label: string; icon: string; empty: string; command: string }> = {
  design: { label: '设计画布', icon: 'edit', empty: '还没有设计画布，点击新建', command: 'harness.design.create' },
  db: { label: '数据库', icon: 'database', empty: '还没有数据库，点击添加', command: 'harness.db.create' },
};

export class WorkspaceTreeProvider implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly subscription: vscode.Disposable;
  private timer: NodeJS.Timeout | undefined;
  /** Last sync failure per db source, already masked. */
  readonly syncErrors = new Map<string, string>();
  /** Name of a canvas that is open (possibly with an unsaved rename); set by the canvas editor. */
  openCanvasName: (uri: vscode.Uri) => string | undefined = () => undefined;
  diagrams: DiagramService | undefined;

  constructor(
    private readonly storage: HarnessStorage,
    private readonly store: ModelStore,
    private readonly secrets: vscode.SecretStorage,
    private readonly extensionUri: vscode.Uri,
  ) {
    this.subscription = store.onDidChange(() => this.refresh());
  }

  private driverIcon(driver: ConnectionDriver | undefined): vscode.TreeItem['iconPath'] {
    if (!driver || !DRIVER_ICONS.has(driver)) return new vscode.ThemeIcon('database');
    const icon = (theme: string) => vscode.Uri.joinPath(this.extensionUri, 'media', 'db', `${driver}-${theme}.svg`);
    return { light: icon('light'), dark: icon('dark') };
  }

  refresh(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.emitter.fire(undefined), 100);
  }

  async getTreeItem(node: TreeNode): Promise<vscode.TreeItem> {
    const ws = this.storage.workspace(node.workspace);
    switch (node.kind) {
      case 'workspace': {
        const meta = await ws.readMeta();
        const item = new vscode.TreeItem(meta.name, vscode.TreeItemCollapsibleState.Expanded);
        item.id = `ws:${node.workspace}`;
        item.description = meta.description?.split('\n')[0];
        item.tooltip = `${meta.name}（ID：${node.workspace}）${meta.description ? `\n${meta.description}` : ''}`;
        item.iconPath = new vscode.ThemeIcon('folder-library');
        item.contextValue = 'workspace';
        return item;
      }
      case 'group': {
        const info = GROUP_INFO[node.group];
        const item = new vscode.TreeItem(info.label, vscode.TreeItemCollapsibleState.Expanded);
        item.id = `ws:${node.workspace}:${node.group}`;
        const count = await this.groupIds(node.workspace, node.group);
        item.description = count.length ? String(count.length) : undefined;
        item.iconPath = new vscode.ThemeIcon(info.icon);
        item.contextValue = `group.${node.group}`;
        return item;
      }
      case 'placeholder': {
        const info = GROUP_INFO[node.group];
        const item = new vscode.TreeItem(info.empty, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon('add');
        item.contextValue = 'placeholder';
        item.command = { command: info.command, title: info.empty, arguments: [{ workspace: node.workspace }] };
        return item;
      }
      case 'design': {
        const loaded = await this.store.source(node.workspace, 'design', node.id);
        const item = new vscode.TreeItem(loaded.name, vscode.TreeItemCollapsibleState.Collapsed);
        item.id = `ws:${node.workspace}:design:${node.id}`;
        if (loaded.error) {
          item.description = '读取失败';
          item.tooltip = loaded.error;
          item.iconPath = new vscode.ThemeIcon('warning');
        } else {
          const driver = driverLabel(loaded.schema?.driver?.name);
          item.description = [driver, `${loaded.schema?.tables.length ?? 0} 张表`].filter(Boolean).join(' · ');
          item.tooltip = `${loaded.name}（ID：${node.id}）`;
          item.iconPath = new vscode.ThemeIcon('symbol-structure');
        }
        item.contextValue = 'design';
        return item;
      }
      case 'designTables': {
        const loaded = await this.store.source(node.workspace, 'design', node.id);
        const count = loaded.schema?.tables.length ?? 0;
        const item = new vscode.TreeItem('表结构', count ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
        item.id = `ws:${node.workspace}:design:${node.id}:tables`;
        item.description = `${count} 张表`;
        item.tooltip = '表、字段和关系（tbls JSON）。点击在画布中打开。';
        item.iconPath = new vscode.ThemeIcon('table');
        item.contextValue = 'designTables';
        item.command = { command: 'harness.design.open', title: '打开表结构', arguments: [node] };
        return item;
      }
      case 'canvasGroup': {
        const count = (await ws.design(node.id).canvasIds()).length;
        const item = new vscode.TreeItem('画布', vscode.TreeItemCollapsibleState.Collapsed);
        item.id = `ws:${node.workspace}:design:${node.id}:canvases`;
        item.description = count ? String(count) : undefined;
        item.tooltip = '画布：显示和编辑表之间的关系';
        item.iconPath = new vscode.ThemeIcon('type-hierarchy');
        item.contextValue = 'canvasGroup';
        return item;
      }
      case 'diagramGroup': {
        const count = (await ws.design(node.id).diagramIds()).length;
        const item = new vscode.TreeItem('设计图', vscode.TreeItemCollapsibleState.Collapsed);
        item.id = `ws:${node.workspace}:design:${node.id}:diagrams`;
        item.description = count ? String(count) : undefined;
        item.tooltip = 'Mermaid 设计图：ER 图、状态图、时序图、流程图、数据流图。ER 图可以确认后同步到表结构。';
        item.iconPath = new vscode.ThemeIcon('graph');
        item.contextValue = 'diagramGroup';
        return item;
      }
      case 'diagramPlaceholder': {
        const item = new vscode.TreeItem('还没有设计图，点击新建', vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon('add');
        item.contextValue = 'placeholder';
        item.command = { command: 'harness.diagram.create', title: '新建设计图', arguments: [{ kind: 'diagramGroup', workspace: node.workspace, id: node.id }] };
        return item;
      }
      case 'diagram': {
        const file = await this.diagrams?.read({ workspace: node.workspace, design: node.design, diagram: node.id });
        const item = new vscode.TreeItem(file?.meta.name ?? node.id, vscode.TreeItemCollapsibleState.None);
        item.id = `ws:${node.workspace}:design:${node.design}:diagram:${node.id}`;
        item.description = file ? diagramTypeLabel(file.meta.type) : undefined;
        item.tooltip = `${file?.meta.name ?? node.id}（ID：${node.id}）${file?.meta.description ? `\n${file.meta.description}` : ''}`;
        item.iconPath = new vscode.ThemeIcon(DIAGRAM_ICONS[file?.meta.type ?? 'er']);
        item.contextValue = 'diagram';
        item.resourceUri = ws.design(node.design).diagramUri(node.id);
        item.command = { command: 'harness.diagram.open', title: '打开设计图', arguments: [node] };
        return item;
      }
      case 'db': {
        const [loaded, meta, dsn] = await Promise.all([
          this.store.source(node.workspace, 'db', node.id),
          ws.db(node.id).readMeta(),
          this.secrets.get(ws.db(node.id).secretKey),
        ]);
        const hasSnapshot = !!loaded.schema;
        const item = new vscode.TreeItem(loaded.name, hasSnapshot ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
        item.id = `ws:${node.workspace}:db:${node.id}`;
        const error = this.syncErrors.get(`${node.workspace}/${node.id}`) ?? loaded.error;
        const connected = meta.connection.kind === 'secret' && !!dsn;
        const driver = meta.connection.kind === 'secret' ? meta.connection.driver : undefined;
        const parts: string[] = [];
        if (loaded.schema) parts.push(`${loaded.schema.tables.length} 张表`);
        if (loaded.snapshot) parts.push(formatTime(loaded.snapshot.takenAt));
        if (!connected) parts.push(meta.connection.kind === 'none' ? '离线' : '未设置连接');
        item.description = parts.join(' · ');
        if (error) item.iconPath = new vscode.ThemeIcon('warning');
        else if (!connected) item.iconPath = new vscode.ThemeIcon(meta.connection.kind === 'none' ? 'database' : 'debug-disconnect');
        else item.iconPath = this.driverIcon(driver);
        const typeLabel = driver ? driverInfo(driver).label : meta.connection.kind === 'none' ? '离线导入' : undefined;
        item.tooltip = error
          ? `最近一次失败：${error}`
          : [loaded.name, typeLabel, `ID：${node.id}`, loaded.snapshot ? `快照：${loaded.snapshot.file}` : '还没有快照'].filter(Boolean).join('\n');
        item.contextValue = connected ? 'db.connected' : 'db.offline';
        return item;
      }
      case 'canvas': {
        const design = ws.design(node.design);
        const uri = design.canvasUri(node.id);
        let label = node.id;
        let description: string | undefined;
        try {
          const canvas = parseCanvas(await readText(uri));
          label = canvas.name;
          description = `${canvas.nodes.length} 张表`;
        } catch {
          description = '读取失败';
        }
        label = this.openCanvasName(uri) ?? label;
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
        item.id = `ws:${node.workspace}:design:${node.design}:canvas:${node.id}`;
        item.description = description;
        item.tooltip = `${label}（ID：${node.id}）`;
        item.iconPath = new vscode.ThemeIcon('type-hierarchy');
        item.contextValue = 'canvas';
        item.resourceUri = uri;
        item.command = { command: 'harness.canvas.open', title: '打开画布', arguments: [{ workspace: node.workspace, design: node.design, kind: 'canvas', id: node.id }] };
        return item;
      }
      case 'table': {
        const t = node.table;
        const item = new vscode.TreeItem(t.key, vscode.TreeItemCollapsibleState.Collapsed);
        item.id = `ws:${node.workspace}:${node.source}:${node.id}:t:${t.key}`;
        item.description = t.comment ?? `${t.columns.length} 列`;
        item.iconPath = new vscode.ThemeIcon(t.type.toUpperCase().includes('VIEW') ? 'eye' : 'table');
        item.contextValue = `table.${node.source}`;
        return item;
      }
      case 'column': {
        const c = node.column;
        const item = new vscode.TreeItem(c.name, vscode.TreeItemCollapsibleState.None);
        const flags = [c.primaryKey && 'PK', node.fk && 'FK', !c.primaryKey && c.unique && 'UQ', !c.nullable && !c.primaryKey && 'NN'].filter(Boolean);
        item.description = [c.rawType, ...flags].join(' · ');
        item.tooltip = c.comment;
        item.iconPath = new vscode.ThemeIcon(c.primaryKey ? 'key' : node.fk ? 'references' : 'symbol-field');
        item.contextValue = 'column';
        return item;
      }
    }
  }

  async getChildren(node?: TreeNode): Promise<TreeNode[]> {
    if (!node) {
      const workspaces = await this.storage.listWorkspaces();
      const named = await Promise.all(workspaces.map(async (w) => ({ id: w.id, name: (await w.readMeta()).name })));
      return named.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true })).map((w) => ({ kind: 'workspace', workspace: w.id }));
    }
    switch (node.kind) {
      case 'workspace':
        return (['design', 'db'] as Group[]).map((group) => ({ kind: 'group', workspace: node.workspace, group }));
      case 'group': {
        const ids = await this.groupIds(node.workspace, node.group);
        if (!ids.length) return [{ kind: 'placeholder', workspace: node.workspace, group: node.group }];
        if (node.group === 'design') return ids.map((id) => ({ kind: 'design', workspace: node.workspace, id }));
        return ids.map((id) => ({ kind: 'db', workspace: node.workspace, id }));
      }
      case 'design':
        return [
          { kind: 'designTables', workspace: node.workspace, id: node.id },
          { kind: 'canvasGroup', workspace: node.workspace, id: node.id },
          { kind: 'diagramGroup', workspace: node.workspace, id: node.id },
        ];
      case 'canvasGroup': {
        const ids = await this.storage.workspace(node.workspace).design(node.id).canvasIds();
        if (!ids.length) {
          return []; // canvases can be empty; design.open creates one on demand
        }
        return ids.map((id) => ({ kind: 'canvas', workspace: node.workspace, design: node.id, id }));
      }
      case 'diagramGroup': {
        const ids = await this.storage.workspace(node.workspace).design(node.id).diagramIds();
        if (!ids.length) return [{ kind: 'diagramPlaceholder', workspace: node.workspace, id: node.id }];
        return ids.map((id) => ({ kind: 'diagram', workspace: node.workspace, design: node.id, id }));
      }
      case 'designTables':
      case 'db': {
        const source: SourceKind = node.kind === 'db' ? 'db' : 'design';
        const loaded = await this.store.source(node.workspace, source, node.id);
        const schema = loaded.schema;
        if (!schema) return [];
        const fks = new Map<string, Set<string>>();
        for (const r of schema.relations) {
          const set = fks.get(r.from.table) ?? new Set<string>();
          r.from.columns.forEach((c) => set.add(c));
          fks.set(r.from.table, set);
        }
        return schema.tables.map((table) => ({
          kind: 'table',
          workspace: node.workspace,
          source,
          id: node.id,
          table,
          fks: fks.get(table.key) ?? new Set(),
        }));
      }
      case 'table':
        return node.table.columns.map((column) => ({
          kind: 'column',
          workspace: node.workspace,
          source: node.source,
          id: node.id,
          table: node.table.key,
          column,
          fk: node.fks.has(column.name),
        }));
      default:
        return [];
    }
  }

  /** Needed by TreeView.reveal; only the nodes we ever reveal (workspace, group, source, canvas) matter. */
  getParent(node: TreeNode): TreeNode | undefined {
    switch (node.kind) {
      case 'workspace':
        return undefined;
      case 'group':
      case 'placeholder':
        return { kind: 'workspace', workspace: node.workspace };
      case 'design':
        return { kind: 'group', workspace: node.workspace, group: 'design' };
      case 'db':
        return { kind: 'group', workspace: node.workspace, group: 'db' };
      case 'designTables':
      case 'canvasGroup':
      case 'diagramGroup':
        return { kind: 'design', workspace: node.workspace, id: node.id };
      case 'canvas':
        return { kind: 'canvasGroup', workspace: node.workspace, id: node.design };
      case 'diagram':
        return { kind: 'diagramGroup', workspace: node.workspace, id: node.design };
      default:
        return undefined;
    }
  }

  /** Numeric order, so `design10` comes after `design9` (creation order). */
  private async groupIds(workspace: string, group: Group): Promise<string[]> {
    const ws = this.storage.workspace(workspace);
    const ids = await (group === 'design' ? ws.designIds() : ws.dbIds());
    return ids.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.subscription.dispose();
    this.emitter.dispose();
  }
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  const today = new Date();
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.toDateString() === today.toDateString() ? `今天 ${time}` : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`;
}

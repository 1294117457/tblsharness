import * as vscode from 'vscode';
import type { DiagramService } from '../diagram/diagramService';
import type { ModelStore } from '../model/store';
import { DESIGN_SOURCE, emptyCanvas, partitionPath, type CanvasFile, type ItemRef } from '../shared/canvas';
import { diagramTypeLabel, type DiagramType } from '../shared/diagram';
import { driverInfo, type ConnectionDriver } from '../shared/connection';
import type { NColumn, NTable } from '../shared/model';
import { effectiveNamespace, namespaceLabel, shortName } from '../shared/namespace';
import { driverLabel, type SourceKind } from '../shared/workspace';
import type { HarnessStorage } from '../workspace/storage';

type Group = 'design' | 'db';
export type LevelGroup = 'tables' | 'diagrams' | 'partitions';

/** Drivers with a brand icon under media/db (`<driver>-light.svg` / `<driver>-dark.svg`). */
const DRIVER_ICONS = new Set<ConnectionDriver>(['postgres', 'mysql', 'mariadb', 'sqlserver', 'sqlite', 'clickhouse', 'redshift']);

/**
 * A "level" is the root design canvas (`partition` undefined) or one of its nested partition canvases.
 * Every level shows the same three groups: 设计表, 设计图, 分区画布.
 */
export type TreeNode =
  | { kind: 'empty'; workspace: '' }
  | { kind: 'workspace'; workspace: string }
  | { kind: 'group'; workspace: string; group: Group }
  | { kind: 'placeholder'; workspace: string; group: Group }
  | { kind: 'design'; workspace: string; id: string }
  | { kind: 'partition'; workspace: string; design: string; id: string }
  | { kind: 'levelGroup'; workspace: string; design: string; partition?: string; group: LevelGroup }
  | { kind: 'diagram'; workspace: string; design: string; id: string; partition?: string }
  | { kind: 'db'; workspace: string; id: string }
  /** `id` is the design or db ID; `partition` is the level a design table sits in. */
  | { kind: 'table'; workspace: string; source: SourceKind; id: string; table: NTable; fks: Set<string>; partition?: string }
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

const LEVEL_GROUPS: Record<LevelGroup, { label: string; icon: string; tooltip: string }> = {
  tables: { label: '设计表', icon: 'table', tooltip: '这一层画布上的设计表（tbls JSON）' },
  diagrams: { label: '设计图', icon: 'graph', tooltip: 'Mermaid 设计图：ER 图、状态图、时序图、流程图、数据流图。ER 图可以确认后同步到表结构。' },
  partitions: { label: '分区画布', icon: 'layout', tooltip: '嵌套在这一层里的分区画布，结构和设计画布一样' },
};

/** The design item a tree node stands for, when it can be copied, cut or dragged. */
export function itemOf(node: TreeNode): { workspace: string; design: string; ref: ItemRef } | undefined {
  if (node.kind === 'partition') return { workspace: node.workspace, design: node.design, ref: { kind: 'partition', id: node.id } };
  if (node.kind === 'diagram') return { workspace: node.workspace, design: node.design, ref: { kind: 'diagram', id: node.id } };
  if (node.kind === 'table' && node.source === 'design') return { workspace: node.workspace, design: node.id, ref: { kind: 'table', id: `${DESIGN_SOURCE}/${node.table.key}` } };
  return undefined;
}

/** The level a node points at when used as a paste or drop target. */
export function levelOf(node: TreeNode): { workspace: string; design: string; partition?: string } | undefined {
  switch (node.kind) {
    case 'design':
      return { workspace: node.workspace, design: node.id };
    case 'partition':
      return { workspace: node.workspace, design: node.design, partition: node.id };
    case 'levelGroup':
    case 'diagram':
      return { workspace: node.workspace, design: node.design, partition: node.partition };
    case 'table':
      return node.source === 'design' ? { workspace: node.workspace, design: node.id, partition: node.partition } : undefined;
    default:
      return undefined;
  }
}

export class WorkspaceTreeProvider implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly subscription: vscode.Disposable;
  private timer: NodeJS.Timeout | undefined;
  /** Last sync failure per db source, already masked. */
  readonly syncErrors = new Map<string, string>();
  /** Layout of a design as currently edited (open editor first); set by the extension. */
  layoutOf: (workspace: string, design: string) => Promise<CanvasFile> = async () => emptyCanvas();
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

  private async layout(workspace: string, design: string): Promise<CanvasFile> {
    try {
      return await this.layoutOf(workspace, design);
    } catch {
      return emptyCanvas();
    }
  }

  /** Design tables, diagrams and child partitions of one level. Tables and diagrams without a layout entry sit at the root. */
  private async levelContents(workspace: string, design: string, partition: string | undefined) {
    const [layout, loaded, diagramIds] = await Promise.all([
      this.layout(workspace, design),
      this.store.source(workspace, 'design', design),
      this.storage.workspace(workspace).design(design).diagramIds(),
    ]);
    const tablePlace = new Map(layout.nodes.filter((n) => n.source === DESIGN_SOURCE).map((n) => [n.table, n]));
    const diagramPlace = new Map(layout.diagrams.map((d) => [d.id, d]));
    return {
      layout,
      schema: loaded.schema,
      tables: (loaded.schema?.tables ?? []).filter((t) => tablePlace.get(t.key)?.partition === partition),
      hiddenTables: new Set([...tablePlace.values()].filter((n) => n.hidden).map((n) => n.table)),
      diagrams: diagramIds.filter((id) => diagramPlace.get(id)?.partition === partition),
      hiddenDiagrams: new Set(layout.diagrams.filter((d) => d.hidden).map((d) => d.id)),
      partitions: layout.partitions.filter((p) => p.parent === partition),
    };
  }

  async getTreeItem(node: TreeNode): Promise<vscode.TreeItem> {
    try {
      return await this.getTreeItemInner(node);
    } catch (err) {
      console.error('[harness.tree] getTreeItem failed:', err);
      throw err;
    }
  }

  private async getTreeItemInner(node: TreeNode): Promise<vscode.TreeItem> {
    if (node.kind === 'empty') {
      const item = new vscode.TreeItem('还没有工作区，点击新建', vscode.TreeItemCollapsibleState.None);
      item.id = 'empty';
      item.iconPath = new vscode.ThemeIcon('add');
      item.contextValue = 'empty';
      item.command = { command: 'harness.workspace.create', title: '新建工作区' };
      return item;
    }
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
          item.tooltip = `${loaded.name}（ID：${node.id}）\n点击打开设计画布`;
          item.iconPath = new vscode.ThemeIcon('symbol-structure');
        }
        item.contextValue = 'design';
        item.command = { command: 'harness.design.open', title: '打开设计画布', arguments: [node] };
        return item;
      }
      case 'partition': {
        const layout = await this.layout(node.workspace, node.design);
        const p = layout.partitions.find((x) => x.id === node.id);
        const item = new vscode.TreeItem(p?.name ?? node.id, vscode.TreeItemCollapsibleState.Collapsed);
        item.id = `ws:${node.workspace}:design:${node.design}:part:${node.id}`;
        const ns = p?.namespace;
        const inherited = !ns ? effectiveNamespace(layout, node.id) : undefined;
        item.description = ns ? namespaceLabel(ns) : inherited ? `${namespaceLabel(inherited)}（继承）` : undefined;
        const path = partitionPath(layout, node.id).map((x) => x.name).join(' / ');
        item.tooltip = `${path}（ID：${node.id}）${p?.description ? `\n${p.description}` : ''}${ns ? `\n命名空间：${ns.kind === 'schema' ? 'schema' : '表名前缀'} ${ns.value}` : ''}\n点击在画布中打开这一层`;
        item.iconPath = new vscode.ThemeIcon('layout');
        item.contextValue = 'partition';
        item.command = { command: 'harness.partition.open', title: '打开分区画布', arguments: [node] };
        return item;
      }
      case 'levelGroup': {
        const info = LEVEL_GROUPS[node.group];
        const c = await this.levelContents(node.workspace, node.design, node.partition);
        const count = node.group === 'tables' ? c.tables.length : node.group === 'diagrams' ? c.diagrams.length : c.partitions.length;
        const item = new vscode.TreeItem(info.label, count ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
        item.id = `ws:${node.workspace}:design:${node.design}:${node.partition ?? 'root'}:${node.group}`;
        item.description = count ? String(count) : undefined;
        item.tooltip = info.tooltip;
        item.iconPath = new vscode.ThemeIcon(info.icon);
        item.contextValue = `levelGroup.${node.group}`;
        return item;
      }
      case 'diagram': {
        const [file, layout] = await Promise.all([this.diagrams?.read({ workspace: node.workspace, design: node.design, diagram: node.id }), this.layout(node.workspace, node.design)]);
        const item = new vscode.TreeItem(file?.meta.name ?? node.id, vscode.TreeItemCollapsibleState.None);
        item.id = `ws:${node.workspace}:design:${node.design}:diagram:${node.id}`;
        const hidden = layout.diagrams.find((d) => d.id === node.id)?.hidden;
        item.description = [file && diagramTypeLabel(file.meta.type), hidden && '已隐藏'].filter(Boolean).join(' · ');
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
      case 'table': {
        const t = node.table;
        let label = t.key;
        const extra: string[] = [];
        if (node.source === 'design') {
          const layout = await this.layout(node.workspace, node.id);
          label = shortName(effectiveNamespace(layout, node.partition), t.key);
          if (label !== t.key) extra.push(t.key);
          if (layout.nodes.some((n) => n.source === DESIGN_SOURCE && n.table === t.key && n.hidden)) extra.push('已隐藏');
        }
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);
        item.id = `ws:${node.workspace}:${node.source}:${node.id}:t:${t.key}`;
        item.description = [...extra, t.comment ?? `${t.columns.length} 列`].join(' · ');
        item.tooltip = label !== t.key ? `真实表名：${t.key}` : undefined;
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
    console.log('[harness.tree] getChildren called, node=', node);
    try {
      return await this.getChildrenInner(node);
    } catch (err) {
      console.error('[harness.tree] getChildren failed:', err);
      throw err;
    }
  }

  private async getChildrenInner(node?: TreeNode): Promise<TreeNode[]> {
    if (!node) {
      const workspaces = await this.storage.listWorkspaces();
      console.log('[harness.tree] getChildren root ->', workspaces.length, 'workspaces');
      if (!workspaces.length) {
        // Cursor ignores package.json `viewsWelcome` in many cases; show an actionable placeholder instead of nothing.
        return [{ kind: 'empty', workspace: '' }];
      }
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
        return levelGroups(node.workspace, node.id, undefined);
      case 'partition':
        return levelGroups(node.workspace, node.design, node.id);
      case 'levelGroup': {
        const c = await this.levelContents(node.workspace, node.design, node.partition);
        if (node.group === 'partitions') return c.partitions.map((p) => ({ kind: 'partition', workspace: node.workspace, design: node.design, id: p.id }));
        if (node.group === 'diagrams') return c.diagrams.map((id) => ({ kind: 'diagram', workspace: node.workspace, design: node.design, id, partition: node.partition }));
        const fks = foreignKeys(c.schema?.relations ?? []);
        return c.tables.map((table) => ({ kind: 'table', workspace: node.workspace, source: 'design', id: node.design, table, fks: fks.get(table.key) ?? new Set(), partition: node.partition }));
      }
      case 'db': {
        const schema = (await this.store.source(node.workspace, 'db', node.id)).schema;
        if (!schema) return [];
        const fks = foreignKeys(schema.relations);
        return schema.tables.map((table) => ({ kind: 'table', workspace: node.workspace, source: 'db', id: node.id, table, fks: fks.get(table.key) ?? new Set() }));
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

  /** Needed by TreeView.reveal; resolves synchronously for the nodes we reveal (workspace, group, source). */
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
      case 'levelGroup':
        return node.partition ? { kind: 'partition', workspace: node.workspace, design: node.design, id: node.partition } : { kind: 'design', workspace: node.workspace, id: node.design };
      case 'diagram':
        return { kind: 'levelGroup', workspace: node.workspace, design: node.design, partition: node.partition, group: 'diagrams' };
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

function levelGroups(workspace: string, design: string, partition: string | undefined): TreeNode[] {
  return (['tables', 'diagrams', 'partitions'] as LevelGroup[]).map((group) => ({ kind: 'levelGroup', workspace, design, partition, group }));
}

function foreignKeys(relations: { from: { table: string; columns: string[] } }[]): Map<string, Set<string>> {
  const fks = new Map<string, Set<string>>();
  for (const r of relations) {
    const set = fks.get(r.from.table) ?? new Set<string>();
    r.from.columns.forEach((c) => set.add(c));
    fks.set(r.from.table, set);
  }
  return fks;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  const today = new Date();
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.toDateString() === today.toDateString() ? `今天 ${time}` : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`;
}

import * as vscode from 'vscode';
import { DESIGN_SOURCE, nextPartitionId, partitionSubtree, type CanvasFile, type CanvasNamespace, type NamespaceKind } from '../shared/canvas';
import type { DesignOp } from '../shared/designOps';
import { defaultNamespaceKind, effectiveNamespace, landingName, normalizeNamespace, shortName } from '../shared/namespace';
import { nextDefaultName, type SourceKind } from '../shared/workspace';
import { itemOf, levelOf, type TreeNode } from '../views/workspaceTree';
import type { HarnessWorkspace } from '../workspace/storage';
import { pickSourceId, pickWorkspace, promptName, register, required, type Harness, type NodeArg } from './common';

export function registerCanvasCommands(h: Harness): void {
  /** Opens the design's editor; from a partition node (or a group inside one) it zooms to that frame. */
  register(h, 'harness.design.open', async (arg) => {
    const ws = await pickWorkspace(h, arg);
    const designId = await pickSourceId(h, ws, 'design', arg);
    const partition = scopeOf(arg);
    await h.canvases.open(ws.id, designId, partition ? { item: { kind: 'partition', id: partition } } : undefined);
  });

  register(h, 'harness.partition.open', async (arg) => {
    const { ws, design, partition } = await partitionFromArg(h, arg);
    await h.canvases.open(ws.id, design, { item: { kind: 'partition', id: partition } });
  });

  register(h, 'harness.partition.create', async (arg) => {
    const ws = await pickWorkspace(h, arg);
    const design = await pickSourceId(h, ws, 'design', arg);
    const parent = scopeOf(arg);
    const layout = await h.canvases.layout(ws.id, design);
    const name = await promptName('新建分区画布', nextDefaultName('分区画布', layout.partitions.map((p) => p.name)));
    const siblings = [...layout.partitions.filter((p) => p.parent === parent), ...layout.nodes.filter((n) => n.partition === parent)];
    const x = siblings.length ? Math.max(...siblings.map((s) => s.x)) + 400 : 0;
    const id = nextPartitionId(layout);
    await h.canvases.editLayout(ws.id, design, `新建分区画布 ${name}`, [{ op: 'partition.put', partition: { id, name, parent, x, y: 0 } }]);
    await h.canvases.open(ws.id, design, { item: { kind: 'partition', id } });
  });

  register(h, 'harness.partition.rename', async (arg) => {
    const { ws, design, partition } = await partitionFromArg(h, arg);
    const layout = await h.canvases.layout(ws.id, design);
    const p = layout.partitions.find((x) => x.id === partition)!;
    const name = await promptName('重命名分区画布', p.name);
    await h.canvases.editLayout(ws.id, design, '重命名分区画布', [{ op: 'partition.put', partition: { ...p, name } }]);
  });

  register(h, 'harness.partition.delete', async (arg) => {
    const { ws, design, partition } = await partitionFromArg(h, arg);
    await h.canvases.deletePartition(ws.id, design, partition);
  });

  register(h, 'harness.partition.setNamespace', async (arg) => {
    const { ws, design, partition } = await partitionFromArg(h, arg);
    await setNamespace(h, ws, design, partition);
  });

  const copyOrCut = (mode: 'copy' | 'cut') => (node?: TreeNode, selected?: TreeNode[]) => {
    const nodes = selected?.length ? selected : node ? [node] : [...h.treeView.selection];
    const items = nodes.map(itemOf).filter((i): i is NonNullable<typeof i> => !!i);
    if (!items.length) return;
    const { workspace, design } = items[0];
    const refs = items.filter((i) => i.workspace === workspace && i.design === design).map((i) => i.ref);
    h.canvases.setClipboard({ workspace, design, mode, items: refs });
    vscode.window.setStatusBarMessage(`Harness：已${mode === 'copy' ? '复制' : '剪切'} ${refs.length} 项，右键目标层级选择"粘贴"`, 4000);
  };
  h.context.subscriptions.push(
    vscode.commands.registerCommand('harness.item.copy', copyOrCut('copy')),
    vscode.commands.registerCommand('harness.item.cut', copyOrCut('cut')),
  );

  register(h, 'harness.item.paste', async (arg) => {
    const node = (arg as TreeNode | undefined) ?? h.treeView.selection[0];
    const level = node && levelOf(node);
    if (!level) throw new Error('请在侧边栏中选择要粘贴到的设计画布或分区画布');
    try {
      const message = await h.canvases.paste(level.workspace, level.design, level.partition);
      vscode.window.setStatusBarMessage(`Harness：${message}`, 4000);
    } catch (err) {
      if ((err as Error).message !== '已取消') throw err;
    }
  });

  /** Adds a database (and optionally one of its tables) to a design canvas. */
  register(h, 'harness.source.addToCanvas', async (arg) => {
    const { ws, kind, ref, table } = await sourceFromArg(h, arg);
    if (kind === 'design') throw new Error('设计表已经在它所在的画布里了');
    const design = await pickSourceId(h, ws, 'design', { workspace: ws.id });
    const d = ws.design(design);
    const meta = await d.readMeta();
    if (!meta.sources?.includes(ref)) {
      await d.writeMeta({ ...meta, sources: [...(meta.sources ?? []), ref] });
      h.store.invalidate({ workspace: ws.id, kind: 'design', id: design });
    }
    if (table) {
      const layout = await h.canvases.layout(ws.id, design);
      if (!layout.nodes.some((n) => n.source === ref && n.table === table)) {
        const root = layout.nodes.filter((n) => !n.partition);
        const x = root.length ? Math.max(...root.map((n) => n.x)) + 320 : 0;
        await h.canvases.editLayout(ws.id, design, `添加表 ${table}`, [{ op: 'nodes.put', nodes: [{ source: ref, table, x, y: 0 }] }]);
      }
      await h.canvases.revealTable(ws.id, design, ref, table);
    } else {
      await h.canvases.open(ws.id, design);
    }
  });

  register(h, 'harness.table.revealInCanvas', async (arg) => {
    const { ws, kind, ref, table } = await sourceFromArg(h, arg);
    if (!table) throw new Error('请选择一张表');
    if (kind === 'design') {
      await h.canvases.revealTable(ws.id, ref, DESIGN_SOURCE, table);
      return;
    }
    const matches: { design: string; name: string }[] = [];
    for (const design of await ws.designIds()) {
      const layout = await h.canvases.layout(ws.id, design).catch(() => undefined);
      if (layout?.nodes.some((n) => n.source === ref && n.table === table)) matches.push({ design, name: (await ws.design(design).readMeta()).name });
    }
    if (!matches.length) {
      const add = await vscode.window.showInformationMessage(`还没有设计画布包含表 ${table}，要添加吗？`, '添加到画布…');
      if (add) await vscode.commands.executeCommand('harness.source.addToCanvas', arg);
      return;
    }
    const open = matches.find((m) => h.canvases.isOpen(ws.id, m.design));
    const target =
      open ??
      (matches.length === 1
        ? matches[0]
        : required(await vscode.window.showQuickPick(matches.map((m) => ({ label: m.name, description: m.design, ...m })), { title: '在哪个设计画布中定位？' })));
    await h.canvases.revealTable(ws.id, target.design, ref, table);
  });
}

/** The level a command argument points at: a partition node, or any node carrying `partition`. */
function scopeOf(arg?: NodeArg): string | undefined {
  if (arg?.kind === 'partition') return arg.id;
  return arg?.partition;
}

async function partitionFromArg(h: Harness, arg?: NodeArg): Promise<{ ws: HarnessWorkspace; design: string; partition: string }> {
  if (arg?.kind === 'partition' && arg.workspace && arg.design && arg.id) return { ws: h.storage.workspace(arg.workspace), design: arg.design, partition: arg.id };
  if (arg?.workspace && arg.design && arg.partition) return { ws: h.storage.workspace(arg.workspace), design: arg.design, partition: arg.partition };
  throw new Error('请在侧边栏或画布中选择一个分区画布');
}

async function sourceFromArg(h: Harness, arg?: NodeArg): Promise<{ ws: HarnessWorkspace; kind: SourceKind; ref: string; table?: string }> {
  const ws = await pickWorkspace(h, arg);
  if (arg?.kind === 'table' && arg.source && arg.id) return { ws, kind: arg.source, ref: arg.id, table: arg.table?.key };
  if ((arg?.kind === 'design' || arg?.kind === 'db') && arg.id) return { ws, kind: arg.kind, ref: arg.id };
  throw new Error('请在侧边栏中选择一个数据源或表');
}

/** Sets or clears a partition's namespace, optionally renaming the tables whose real name should follow. */
export async function setNamespace(h: Harness, ws: HarnessWorkspace, design: string, partition: string): Promise<void> {
  const layout = await h.canvases.layout(ws.id, design);
  const p = layout.partitions.find((x) => x.id === partition);
  if (!p) throw new Error('分区画布不存在');
  const schema = (await h.store.source(ws.id, 'design', design)).schema;
  const preferred = defaultNamespaceKind(schema?.driver?.name);
  const kinds = [
    { label: 'schema', description: '真实表名为 schema.表名，例如 payment.orders', nsKind: 'schema' as NamespaceKind | undefined },
    { label: '表名前缀', description: '真实表名为 前缀_表名，例如 pay_orders', nsKind: 'prefix' as NamespaceKind | undefined },
  ].sort((a, b) => (a.nsKind === preferred ? -1 : b.nsKind === preferred ? 1 : 0));
  const pick = required(
    await vscode.window.showQuickPick([...kinds, { label: '不设置', description: '沿用上级分区画布的命名空间', nsKind: undefined }], {
      title: `"${p.name}"的命名空间`,
      placeHolder: '分区画布里新建或粘贴进来的表会自动加上命名空间，画布上只显示短名',
    }),
  );
  let ns: CanvasNamespace | undefined;
  if (pick.nsKind) {
    const kind = pick.nsKind;
    const value = required(
      await vscode.window.showInputBox({
        title: kind === 'schema' ? 'schema 名' : '表名前缀',
        value: p.namespace?.kind === kind ? p.namespace?.value : '',
        prompt: kind === 'schema' ? '例如 payment' : '例如 pay（会自动补上下划线）',
        validateInput: (v) => {
          const r = normalizeNamespace(kind, v);
          return typeof r === 'string' ? r : undefined;
        },
      }),
    );
    ns = normalizeNamespace(kind, value) as CanvasNamespace;
  }
  if (JSON.stringify(ns) === JSON.stringify(p.namespace)) return;
  const next = { ...p, namespace: ns };
  if (!ns) delete next.namespace;
  const edit = [{ op: 'partition.put' as const, partition: next }];

  const after: CanvasFile = { ...layout, partitions: layout.partitions.map((x) => (x.id === partition ? next : x)) };
  const renames = namespaceRenames(layout, after, partition, schema?.tables.map((t) => t.key) ?? []);
  let ops: DesignOp[] = [];
  if (renames.length) {
    const list = renames.slice(0, 12).map((r) => `${r.from} → ${r.to}`).join('\n');
    const answer = await vscode.window.showInformationMessage(
      `这个分区画布（含子分区）里有 ${renames.length} 张表，要把真实表名一起改成新的命名空间吗？`,
      { modal: true, detail: `${list}${renames.length > 12 ? '\n…' : ''}` },
      '改名',
      '只改设置',
    );
    if (!answer) return;
    if (answer === '改名') ops = renames.map((r) => ({ op: 'table.rename', from: r.from, to: r.to }));
  }
  const error = await h.canvases.applyChange(ws.id, design, { label: '设置命名空间', ops, edit });
  if (error) throw new Error(error);
}

function namespaceRenames(before: CanvasFile, after: CanvasFile, partition: string, tables: string[]): { from: string; to: string }[] {
  const subtree = partitionSubtree(before, partition);
  const taken = new Set(tables);
  const known = new Set(tables);
  const out: { from: string; to: string }[] = [];
  for (const n of before.nodes) {
    if (n.source !== DESIGN_SOURCE || !n.partition || !subtree.has(n.partition) || !known.has(n.table)) continue;
    const oldNs = effectiveNamespace(before, n.partition);
    const newNs = effectiveNamespace(after, n.partition);
    const short = shortName(oldNs, n.table);
    taken.delete(n.table);
    const to = landingName(short, newNs, taken, new Set());
    taken.add(to);
    if (to !== n.table) out.push({ from: n.table, to });
  }
  return out;
}
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import type { Connection } from '@vue-flow/core';
import {
  DESIGN_SOURCE,
  nextPartitionId,
  nodeId,
  parseNodeId,
  partitionPath,
  type CanvasEdit,
  type ColumnDisplay,
  type ComparisonMode,
  type ItemRef,
} from '@shared/canvas';
import { DIAGRAM_TYPES, type DiagramType } from '@shared/diagram';
import type { RelationKind } from '@shared/model';
import { effectiveNamespace, namespaceLabel, qualify } from '@shared/namespace';
import type { SyncGroup } from '@shared/sync';
import { nextDefaultName } from '@shared/workspace';
import { buildView, TABLE_HANDLE, type TableView } from './canvas/viewModel';
import { NODE_WIDTH, PART_HEADER, PART_PAD, type Position } from './canvas/layout';
import CanvasView from './components/CanvasView.vue';
import ContextMenu, { type MenuItem } from './components/ContextMenu.vue';
import DiffPanel from './components/DiffPanel.vue';
import Inspector from './components/Inspector.vue';
import SourcePanel from './components/SourcePanel.vue';
import SyncPanel from './components/SyncPanel.vue';
import {
  applySync,
  canvas,
  deleteDiagram,
  deletePartition,
  designOp,
  editCanvas,
  focusNode,
  handleHostMessage,
  ignoreSync,
  itemOfFlowId,
  moveItems,
  paste,
  setClipboard,
  setScope,
  state,
  toast,
} from './store';
import { getState, onHostMessage, post, setState } from './vscode';

const view = computed(() => buildView(canvas.value, state.sources, state.comparison, state.diagrams, state.scope));
const flow = ref<InstanceType<typeof CanvasView>>();
const rightTab = ref<'inspector' | 'diff' | 'sync'>('inspector');
const menu = ref<{ x: number; y: number; title?: string; items: MenuItem[] }>();
const pointer = { x: 0, y: 0, overCanvas: false };

interface PanelState {
  leftCollapsed?: boolean;
  rightCollapsed?: boolean;
}
const saved = getState<PanelState>() ?? {};
const leftCollapsed = ref(!!saved.leftCollapsed);
const rightCollapsed = ref(!!saved.rightCollapsed);
watch([leftCollapsed, rightCollapsed], ([l, r]) => setState<PanelState>({ ...(getState<PanelState>() ?? {}), leftCollapsed: l, rightCollapsed: r }));

const hasDesignSchema = computed(() => !!state.sources[DESIGN_SOURCE]?.schema);
const dbSources = computed(() => Object.entries(state.sources).filter(([key]) => key !== DESIGN_SOURCE));
const openDiffs = computed(() => state.comparison?.diff.items.filter((i) => !i.accepted).length ?? 0);
const pendingCount = computed(() => state.pending.reduce((n, g) => n + g.result.items.length, 0));
const emptyDesign = computed(() => {
  const schema = state.sources[DESIGN_SOURCE]?.schema;
  return !!schema && !schema.tables.length;
});
const levelEmpty = computed(() => !view.value.tables.length && !view.value.diagrams.length && !view.value.partitions.length && !view.value.notes.length);
const syncBusy = ref(false);

const path = computed(() => partitionPath(canvas.value, state.scope));
const scopeNamespace = computed(() => {
  const ns = effectiveNamespace(canvas.value, state.scope);
  return ns && namespaceLabel(ns);
});

async function onApplySync(group: SyncGroup, ids: string[], choices: Record<string, string>) {
  syncBusy.value = true;
  try {
    await applySync(group, ids, choices);
  } finally {
    syncBusy.value = false;
  }
}

function openDiagram(group: SyncGroup) {
  post({ type: 'diagram/open', diagram: group.diagram });
}

const comparisonValue = computed(() => canvas.value.comparison?.db ?? '');
const comparisonOptions = computed(() => dbSources.value.map(([key, data]) => ({ value: key, label: data.name ?? key })));

function tableView(id: string): TableView | undefined {
  return view.value.tables.find((t) => t.id === id);
}

function center(): Position {
  return flow.value?.centerPosition() ?? { x: 0, y: 0 };
}

function hasEntry(id: string): boolean {
  return canvas.value.nodes.some((n) => nodeId(n.source, n.table) === id);
}

// ── Creating things on a level ─────────────────────────────────────

function uniqueTableName(level: string | undefined): string {
  const taken = new Set((state.sources[DESIGN_SOURCE]?.schema?.tables ?? []).map((t) => t.key));
  const ns = effectiveNamespace(canvas.value, level);
  let name = qualify(ns, 'new_table');
  for (let i = 2; taken.has(name); i++) name = qualify(ns, `new_table_${i}`);
  return name;
}

async function createTable(level: string | undefined = state.scope, position?: Position) {
  if (!hasDesignSchema.value) {
    toast('还没有加载设计库', 'error');
    return;
  }
  const p = position ?? (level === state.scope ? center() : { x: PART_PAD, y: PART_HEADER + PART_PAD });
  const table = uniqueTableName(level);
  const ok = await designOp([{ op: 'table.add', table }], `新建表 ${table}`, [
    { op: 'nodes.put', nodes: [{ source: DESIGN_SOURCE, table, x: p.x, y: p.y, partition: level }] },
  ]);
  if (ok) {
    state.selection = { type: 'table', nodeId: nodeId(DESIGN_SOURCE, table) };
    rightTab.value = 'inspector';
    rightCollapsed.value = false;
    toast(`已新建表 ${table}，可以在右侧修改表名和字段`);
  }
}

function createPartition(level: string | undefined = state.scope, position?: Position) {
  const p = position ?? (level === state.scope ? center() : { x: PART_PAD, y: PART_HEADER + PART_PAD });
  const id = nextPartitionId(canvas.value);
  const name = nextDefaultName('分区画布', canvas.value.partitions.map((x) => x.name));
  editCanvas(`新建分区画布 ${name}`, [{ op: 'partition.put', partition: { id, name, parent: level, x: Math.round(p.x), y: Math.round(p.y) } }]);
  state.selection = { type: 'partition', id };
  rightTab.value = 'inspector';
  rightCollapsed.value = false;
}

function createNote(level: string | undefined = state.scope, position?: Position) {
  const p = position ?? (level === state.scope ? center() : { x: PART_PAD, y: PART_HEADER + PART_PAD });
  const id = `n${Date.now().toString(36)}`;
  editCanvas('添加便签', [{ op: 'note.put', note: { id, text: '', x: Math.round(p.x), y: Math.round(p.y), width: 200, partition: level } }]);
  state.selection = { type: 'note', id };
}

function createDiagram(type: DiagramType, level: string | undefined = state.scope, position?: Position) {
  post({ type: 'diagram/create', diagramType: type, partition: level, at: position ?? (level === state.scope ? center() : undefined) });
}

function diagramMenuItems(level: string | undefined, position?: Position): MenuItem[] {
  return DIAGRAM_TYPES.map((t) => ({ label: `新建${t.label}`, hint: t.syncable ? '可同步到表结构' : undefined, action: () => createDiagram(t.type, level, position) }));
}

function openDiagramMenu(e: MouseEvent) {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  menu.value = { x: r.left, y: r.bottom + 2, title: '新建设计图（放在这一层）', items: diagramMenuItems(state.scope) };
}

// ── Database tables on this level ─────────────────────────────────

function addDbTables(source: string, tables: string[], near?: string) {
  if (!tables.length) return;
  const level = near ? tableView(near)?.partition : state.scope;
  const anchor = near ? flow.value?.currentPosition(near) ?? center() : center();
  const at = (i: number): Position =>
    near ? { x: anchor.x + NODE_WIDTH + 80, y: anchor.y + i * 200 } : { x: anchor.x - NODE_WIDTH / 2 + (i % 4) * (NODE_WIDTH + 40), y: anchor.y + Math.floor(i / 4) * 260 };
  const put: CanvasEdit[number] & { op: 'nodes.put' } = { op: 'nodes.put', nodes: [] };
  const unhide: ItemRef[] = [];
  const moves: { kind: 'table'; id: string; partition: string | null; x: number; y: number }[] = [];
  tables.forEach((table, i) => {
    const id = nodeId(source, table);
    const entry = canvas.value.nodes.find((n) => nodeId(n.source, n.table) === id);
    const p = at(i);
    if (!entry) put.nodes.push({ source, table, x: p.x, y: p.y, partition: level });
    else if (entry.partition !== level) moves.push({ kind: 'table', id, partition: level ?? null, x: p.x, y: p.y });
    else if (entry.hidden) unhide.push({ kind: 'table', id });
  });
  const edit: CanvasEdit = [];
  if (put.nodes.length) edit.push(put);
  if (unhide.length) edit.push({ op: 'hidden.set', items: unhide, hidden: false });
  if (edit.length) editCanvas(tables.length > 1 ? `添加 ${tables.length} 张表到画布` : `添加表 ${tables[0]} 到画布`, edit);
  if (moves.length) void moveItems(moves);
  if (!near && tables.length === 1) focusNode(nodeId(source, tables[0]));
}

function removeDbTables(source: string, tables: string[]) {
  const ids = tables.map((t) => nodeId(source, t));
  if (ids.length) editCanvas(ids.length > 1 ? `从画布移除 ${ids.length} 张表` : '从画布移除', [{ op: 'nodes.remove', ids }]);
}

// ── Selection helpers: hide / delete / clipboard ──────────────────

function selectedIds(): string[] {
  const ids = flow.value?.selectedNodeIds() ?? [];
  if (ids.length) return ids;
  const sel = state.selection;
  if (sel?.type === 'table' || sel?.type === 'column') return [sel.nodeId];
  if (sel?.type === 'note') return [`note:${sel.id}`];
  if (sel?.type === 'diagram') return [`diagram:${sel.id}`];
  if (sel?.type === 'partition') return [`part:${sel.id}`];
  return [];
}

/** Delete key: tables and diagrams are hidden (they still belong to this level); notes are removed. */
function hideItems(ids: string[]) {
  const refs = ids.map(itemOfFlowId);
  const edit: CanvasEdit = [];
  const hide = refs.filter((r) => r.kind === 'table' || r.kind === 'diagram');
  if (hide.length) edit.push({ op: 'hidden.set', items: hide, hidden: true });
  for (const r of refs) if (r.kind === 'note') edit.push({ op: 'note.remove', id: r.id });
  if (edit.length) {
    editCanvas(refs.length > 1 ? `隐藏 ${refs.length} 项` : '隐藏', edit);
    state.selection = undefined;
  }
  const parts = refs.filter((r) => r.kind === 'partition');
  if (parts.length === 1) void deletePartition(parts[0].id);
  else if (parts.length > 1) toast('一次只能删除一个分区画布', 'error');
}

/** Pins implicitly placed items so the host knows where they are before copying or cutting. */
function pinImplicit(ids: string[]): void {
  const edit: CanvasEdit = [];
  const nodes = [];
  for (const id of ids) {
    const ref = itemOfFlowId(id);
    const p = flow.value?.currentPosition(id);
    if (!p) continue;
    if (ref.kind === 'table' && !hasEntry(id)) nodes.push({ ...parseNodeId(id), x: p.x, y: p.y });
    if (ref.kind === 'diagram' && !canvas.value.diagrams.some((d) => d.id === ref.id)) {
      const d = view.value.diagrams.find((x) => x.id === ref.id);
      if (d) edit.push({ op: 'diagrams.put', diagrams: [{ id: d.id, x: p.x, y: p.y, width: d.width, height: d.height }] });
    }
  }
  if (nodes.length) edit.unshift({ op: 'nodes.put', nodes });
  if (edit.length) editCanvas('固定位置', edit);
}

function copyOrCut(mode: 'copy' | 'cut', ids = selectedIds()) {
  if (!ids.length) return;
  pinImplicit(ids);
  setClipboard(mode, ids.map(itemOfFlowId));
}

function pasteHere(target?: { partition: string | undefined; at?: Position }) {
  if (!state.clipboard) {
    toast('剪贴板是空的：先选中表、设计图或分区框，按 Ctrl+C 或 Ctrl+X');
    return;
  }
  if (target) return void paste(target.partition, target.at);
  const ids = flow.value?.selectedNodeIds() ?? [];
  if (ids.length === 1 && ids[0].startsWith('part:')) return void paste(ids[0].slice(5));
  if (pointer.overCanvas && flow.value) {
    const point = flow.value.toFlow({ x: pointer.x, y: pointer.y });
    const frame = flow.value.frameAt(point);
    return void paste(frame ?? state.scope, frame ? flow.value.relativeTo(frame, point) : point);
  }
  void paste(state.scope, center());
}

// ── Relations ─────────────────────────────────────────────────────

function handleColumn(handle: string | null | undefined): string | undefined {
  if (!handle) return undefined;
  const column = handle.slice(0, handle.lastIndexOf(':'));
  return column === TABLE_HANDLE ? undefined : column;
}

const RELATION_KINDS: { kind: RelationKind; label: string; hint: string }[] = [
  { kind: 'fk', label: '外键', hint: '数据库约束' },
  { kind: 'logical', label: '逻辑关系', hint: '代码里维护' },
  { kind: 'virtual', label: '虚拟关系', hint: '仅用于文档' },
  { kind: 'json_array', label: 'JSON 数组', hint: 'ids 存在数组里' },
  { kind: 'polymorphic', label: '多态', hint: '类型 + id' },
  { kind: 'dictionary', label: '字典', hint: '码表' },
];

function onConnect(connection: Connection) {
  const childCol = handleColumn(connection.sourceHandle);
  const parentCol = handleColumn(connection.targetHandle);
  const child = tableView(connection.source);
  const parent = tableView(connection.target);
  if (!child || !parent || !childCol || !parentCol) {
    toast('请从一个字段拖到另一个字段上来建立关系。', 'error');
    return;
  }
  if (child.source !== parent.source || !child.editable || !parent.editable) {
    toast('只能在同一个设计库的表之间建立关系；数据库中的表是只读的。', 'error');
    return;
  }
  if (child.id === parent.id && childCol === parentCol) return;
  menu.value = {
    x: pointer.x,
    y: pointer.y,
    title: `${child.key}.${childCol} → ${parent.key}.${parentCol}`,
    items: RELATION_KINDS.map((k) => ({
      label: k.label,
      hint: k.hint,
      action: () =>
        void designOp(
          [{ op: 'relation.add', from: { table: child.key, columns: [childCol] }, to: { table: parent.key, columns: [parentCol] }, kind: k.kind }],
          `添加关系 ${child.key} → ${parent.key}`,
        ),
    })),
  };
}

function relatedTables(t: TableView): string[] {
  const rels = state.sources[t.source]?.schema?.relations ?? [];
  const out = new Set<string>();
  for (const r of rels) {
    if (r.from.table === t.key) out.add(r.to.table);
    if (r.to.table === t.key) out.add(r.from.table);
  }
  out.delete(t.key);
  if (t.sourceKind === 'db') return [...out].filter((k) => !hasEntry(nodeId(t.source, k)));
  return [...out].filter((k) => canvas.value.nodes.some((n) => n.source === DESIGN_SOURCE && n.table === k && n.hidden && n.partition === t.partition));
}

function showRelated(t: TableView, related: string[]) {
  if (t.sourceKind === 'db') addDbTables(t.source, related, t.id);
  else editCanvas('显示关联的表', [{ op: 'hidden.set', items: related.map((k) => ({ kind: 'table' as const, id: nodeId(DESIGN_SOURCE, k) })), hidden: false }]);
}

function setDisplay(ids: string[], display: ColumnDisplay | undefined) {
  const edit: CanvasEdit = [];
  const pinned = ids.filter((id) => !hasEntry(id));
  if (pinned.length) edit.push({ op: 'nodes.put', nodes: pinned.map((id) => ({ ...parseNodeId(id), ...(flow.value?.currentPosition(id) ?? { x: 0, y: 0 }) })) });
  edit.push({ op: 'nodes.display', ids, display });
  editCanvas('修改字段显示', edit);
}

// ── Context menus ─────────────────────────────────────────────────

function clipboardItems(ids: string[]): MenuItem[] {
  return [
    { label: '复制', hint: 'Ctrl+C', action: () => copyOrCut('copy', ids) },
    { label: '剪切', hint: 'Ctrl+X', action: () => copyOrCut('cut', ids) },
  ];
}

function targetsFor(id: string): string[] {
  const selected = flow.value?.selectedNodeIds() ?? [];
  return selected.includes(id) && selected.length > 1 ? selected : [id];
}

function openNodeMenu({ id, x, y, flow: point }: { id: string; x: number; y: number; flow: Position }) {
  const ref = itemOfFlowId(id);
  const targets = targetsFor(id);
  const many = targets.length > 1;
  let items: MenuItem[] = [];
  let title: string | undefined = many ? `已选中 ${targets.length} 项` : undefined;

  if (ref.kind === 'table') {
    const t = tableView(id);
    if (!t) return;
    title ??= t.key;
    const tableTargets = targets.filter((n) => itemOfFlowId(n).kind === 'table');
    const related = relatedTables(t);
    items = [
      { label: t.sourceKind === 'db' ? '添加关联的表' : '显示关联的表', hint: related.length ? `${related.length} 张` : '无', disabled: !related.length, action: () => showRelated(t, related) },
      { separator: true },
      { label: '字段显示：全部', action: () => setDisplay(tableTargets, 'all') },
      { label: '字段显示：仅主键和外键', action: () => setDisplay(tableTargets, 'keys') },
      { label: '字段显示：只显示表名', action: () => setDisplay(tableTargets, 'none') },
      { label: '字段显示：跟随画布设置', action: () => setDisplay(tableTargets, undefined) },
      { separator: true },
      ...clipboardItems(targets),
      t.sourceKind === 'db'
        ? { label: many ? `从画布移除 ${targets.length} 项` : '从画布移除', hint: 'Delete', action: () => removeOrHide(targets) }
        : { label: many ? `隐藏 ${targets.length} 项` : '隐藏', hint: 'Delete', action: () => hideItems(targets) },
    ];
    if (t.editable) {
      items.push({ separator: true }, { label: '从设计中删除表…', danger: true, action: () => void designOp([{ op: 'table.delete', table: t.key }], `删除表 ${t.key}`) });
    }
  } else if (ref.kind === 'diagram') {
    const d = view.value.diagrams.find((x) => x.id === ref.id);
    if (!d) return;
    title ??= d.name;
    items = [
      { label: '打开设计图', action: () => post({ type: 'diagram/open', diagram: d.id }) },
      ...(d.pending ? [{ label: `查看待同步（${d.pending}）`, action: () => showPending() }] : []),
      { separator: true },
      ...clipboardItems(targets),
      { label: many ? `隐藏 ${targets.length} 项` : '隐藏', hint: 'Delete', action: () => hideItems(targets) },
      { separator: true },
      { label: '删除设计图…', danger: true, action: () => void deleteDiagram(d.id) },
    ];
  } else if (ref.kind === 'partition') {
    const p = view.value.partitions.find((x) => x.id === ref.id);
    const raw = canvas.value.partitions.find((x) => x.id === ref.id);
    if (!p || !raw) return;
    title ??= p.name;
    const inside = p.collapsed ? undefined : flow.value?.relativeTo(p.id, point);
    items = [
      { label: '进入这个分区画布', hint: '双击标题', action: () => setScope(p.id) },
      { label: p.collapsed ? '展开' : '折叠', action: () => editCanvas(p.collapsed ? '展开分区画布' : '折叠分区画布', [{ op: 'partition.put', partition: { ...raw, collapsed: !p.collapsed } }]) },
      { separator: true },
      { label: '在这里新建表', disabled: !hasDesignSchema.value, action: () => void createTable(p.id, inside) },
      { label: '在这里新建子分区画布', action: () => createPartition(p.id, inside) },
      ...diagramMenuItems(p.id, inside).map((m) => ({ ...m, label: `在这里${m.label}` })),
      { separator: true },
      { label: '命名空间…', hint: p.namespace, action: () => post({ type: 'partition/namespace', id: p.id }) },
      { label: '重命名 / 说明', action: () => selectPartition(p.id) },
      { separator: true },
      ...clipboardItems(targets),
      { label: '粘贴到这里', hint: 'Ctrl+V', disabled: !state.clipboard, action: () => pasteHere({ partition: p.id, at: inside }) },
      { separator: true },
      { label: '删除分区画布…', danger: true, hint: '连同里面的内容', action: () => void deletePartition(p.id) },
    ];
  } else {
    items = [{ label: '删除便签', danger: true, action: () => hideItems([id]) }];
  }
  menu.value = { x, y, title, items };
}

function openPaneMenu({ x, y, flow: point }: { x: number; y: number; flow: Position }) {
  const level = state.scope;
  menu.value = {
    x,
    y,
    items: [
      { label: '在这里新建表', hint: '双击空白处', disabled: !hasDesignSchema.value, action: () => void createTable(level, point) },
      { label: '在这里新建分区画布', action: () => createPartition(level, point) },
      { label: '在这里新建便签', action: () => createNote(level, point) },
      ...diagramMenuItems(level, point).map((m) => ({ ...m, label: `在这里${m.label}` })),
      { separator: true },
      { label: state.clipboard ? `粘贴 ${state.clipboard.count} 项` : '粘贴', hint: 'Ctrl+V', disabled: !state.clipboard, action: () => pasteHere({ partition: level, at: point }) },
    ],
  };
}

function removeOrHide(ids: string[]) {
  const db = ids.filter((id) => itemOfFlowId(id).kind === 'table' && tableView(id)?.sourceKind === 'db');
  const rest = ids.filter((id) => !db.includes(id));
  if (db.length) editCanvas(db.length > 1 ? `从画布移除 ${db.length} 张表` : '从画布移除', [{ op: 'nodes.remove', ids: db }]);
  if (rest.length) hideItems(rest);
}

function selectPartition(id: string) {
  state.selection = { type: 'partition', id };
  rightTab.value = 'inspector';
  rightCollapsed.value = false;
}

function showPending() {
  rightTab.value = 'sync';
  rightCollapsed.value = false;
}

// ── Toolbar settings ──────────────────────────────────────────────

function setColumnDisplay(value: string) {
  editCanvas('修改字段显示', [{ op: 'settings.set', settings: { columnDisplay: value as ColumnDisplay } }]);
}

function setComparison(value: string) {
  if (!value) {
    editCanvas('关闭对比', [{ op: 'comparison.set', comparison: undefined }]);
    return;
  }
  editCanvas('开启对比', [{ op: 'comparison.set', comparison: { db: value, mode: canvas.value.comparison?.mode ?? 'overlay' } }]);
  rightTab.value = 'diff';
  rightCollapsed.value = false;
}

function setComparisonMode(mode: string) {
  const c = canvas.value.comparison;
  if (c) editCanvas('切换对比方式', [{ op: 'comparison.set', comparison: { ...c, mode: mode as ComparisonMode } }]);
}

// ── Keyboard and pointer ──────────────────────────────────────────

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
}

function onKeyDown(e: KeyboardEvent) {
  if (isTyping(e.target) || menu.value) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && !e.shiftKey && !e.altKey) {
    const key = e.key.toLowerCase();
    if (key === 'c' || key === 'x') {
      const ids = selectedIds();
      if (!ids.length) return;
      e.preventDefault();
      copyOrCut(key === 'c' ? 'copy' : 'cut', ids);
      return;
    }
    if (key === 'v') {
      e.preventDefault();
      pasteHere();
      return;
    }
  }
  if (e.key === 'Escape' && state.scope && !state.selection) {
    setScope(canvas.value.partitions.find((p) => p.id === state.scope)?.parent);
    return;
  }
  if (e.key !== 'Delete' && e.key !== 'Backspace') return;
  const ids = selectedIds();
  if (ids.length) {
    e.preventDefault();
    removeOrHide(ids);
  } else if (state.selection?.type === 'relation') {
    toast('Delete 只会隐藏画布上的节点。要删除关系，请在右侧属性面板中点击"删除关系"。');
  }
}

function onPointer(e: PointerEvent) {
  pointer.x = e.clientX;
  pointer.y = e.clientY;
  pointer.overCanvas = !!(e.target as HTMLElement | null)?.closest?.('.center-pane');
}

const toastVisible = ref(false);
let toastTimer: ReturnType<typeof setTimeout> | undefined;
watch(
  () => state.toast?.seq,
  () => {
    if (!state.toast) return;
    toastVisible.value = true;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toastVisible.value = false), state.toast.level === 'error' ? 6000 : 3500);
  },
);

watch(
  () => state.selection,
  (sel) => {
    if (sel) rightTab.value = 'inspector';
  },
);

let dispose: (() => void) | undefined;
onMounted(() => {
  dispose = onHostMessage(handleHostMessage);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('pointerup', onPointer, true);
  window.addEventListener('pointerdown', onPointer, true);
  window.addEventListener('pointermove', onPointer, true);
  post({ type: 'ready' });
});

onUnmounted(() => {
  dispose?.();
  window.removeEventListener('keydown', onKeyDown);
  window.removeEventListener('pointerup', onPointer, true);
  window.removeEventListener('pointerdown', onPointer, true);
  window.removeEventListener('pointermove', onPointer, true);
});
</script>

<template>
  <div class="app">
    <div v-if="!state.loaded" class="center muted">正在加载画布…</div>
    <div v-else-if="state.error" class="center error">{{ state.error }}</div>
    <template v-else>
      <header class="toolbar">
        <nav class="crumbs" aria-label="当前画布">
          <a href="#" class="crumb" :class="{ current: !state.scope }" :title="state.scope ? '回到根画布' : '根画布'" @click.prevent="setScope(undefined)">{{ state.design?.name ?? '设计画布' }}</a>
          <template v-for="p in path" :key="p.id">
            <span class="crumb-sep">›</span>
            <a href="#" class="crumb" :class="{ current: p.id === state.scope }" :title="p.description" @click.prevent="setScope(p.id)">{{ p.name }}</a>
          </template>
          <button v-if="state.scope" class="ns-btn" :title="scopeNamespace ? '这一层新建的表会自动带上这个命名空间' : '设置命名空间：这一层新建或粘贴进来的表会自动加上 schema 或前缀'" @click="post({ type: 'partition/namespace', id: state.scope })">
            {{ scopeNamespace ?? '命名空间…' }}
          </button>
        </nav>
        <button :disabled="!hasDesignSchema" title="也可以双击画布空白处" @click="createTable()">+ 新建表</button>
        <button class="secondary" :disabled="!hasDesignSchema" @click="openDiagramMenu">+ 设计图 ▾</button>
        <button class="secondary" @click="createPartition()">+ 分区画布</button>
        <button class="secondary" @click="createNote()">+ 便签</button>
        <span class="sep" />
        <button class="secondary" :disabled="levelEmpty" @click="flow?.autoLayout(false)">自动布局</button>
        <button class="secondary" :disabled="!view.tables.length" title="只重新排列选中的表" @click="flow?.autoLayout(true)">布局选中</button>
        <button class="secondary" :disabled="levelEmpty" @click="flow?.fitView()">适应窗口</button>
        <span class="sep" />
        <label>
          字段
          <select :value="canvas.settings.columnDisplay" @change="setColumnDisplay(($event.target as HTMLSelectElement).value)">
            <option value="all">全部</option>
            <option value="keys">仅键</option>
            <option value="none">只显示表名</option>
          </select>
        </label>
        <label>
          对比
          <select :value="comparisonValue" :disabled="!comparisonOptions.length" @change="setComparison(($event.target as HTMLSelectElement).value)">
            <option value="">{{ comparisonOptions.length ? '不对比' : '需要先添加数据库' }}</option>
            <option v-for="o in comparisonOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>
        </label>
        <select
          v-if="canvas.comparison"
          :value="canvas.comparison.mode"
          title="合并：把数据库的差异画在设计表上；并排：两边的表都显示，用虚线连接"
          @change="setComparisonMode(($event.target as HTMLSelectElement).value)"
        >
          <option value="overlay">合并显示</option>
          <option value="side-by-side">并排显示</option>
        </select>
        <span v-if="state.clipboard" class="clip muted" :title="state.clipboard.mode === 'cut' ? '粘贴后原位置的内容会移走' : '粘贴会新增一份'">
          剪贴板：{{ state.clipboard.mode === 'cut' ? '剪切' : '复制' }} {{ state.clipboard.count }} 项
        </span>
      </header>

      <main class="body">
        <aside v-if="leftCollapsed" class="rail left-rail" title="展开数据源面板" @click="leftCollapsed = false">
          <span class="rail-icon">»</span>
          <span class="rail-text">数据源</span>
        </aside>
        <aside v-else class="left">
          <SourcePanel
            :view="view"
            @add-db-tables="addDbTables"
            @remove-db-tables="removeDbTables"
            @create-table="createTable()"
            @create-diagram="menu = { x: pointer.x, y: pointer.y, title: '新建设计图（放在这一层）', items: diagramMenuItems(state.scope) }"
            @collapse="leftCollapsed = true"
          />
        </aside>
        <section class="center-pane">
          <CanvasView
            ref="flow"
            :view="view"
            :canvas="canvas"
            @connect="onConnect"
            @create-table="(level, p) => void createTable(level, p)"
            @node-menu="openNodeMenu"
            @pane-menu="openPaneMenu"
            @enter="setScope"
            @pending="showPending"
          />
          <div v-if="!hasDesignSchema && !dbSources.length" class="empty-overlay">
            <p>这个画布还是空的。</p>
            <p class="muted">在左侧"数据源"里添加数据库，或者先新建表。</p>
          </div>
          <div v-else-if="!state.scope && levelEmpty && emptyDesign" class="empty-overlay">
            <p>设计画布"{{ state.design?.name ?? 'design' }}"还没有表。</p>
            <p class="muted">可以直接新建表，也可以先写一张 ER 图（复制给 AI 帮你写），再同步成表结构。</p>
            <div class="empty-actions">
              <button @click="createTable()">+ 新建表</button>
              <button class="secondary" @click="createDiagram('er')">新建 ER 图（和 AI 一起设计）</button>
            </div>
          </div>
          <div v-else-if="levelEmpty" class="empty-overlay">
            <p>{{ state.scope ? '这个分区画布还是空的。' : '画布上还没有内容。' }}</p>
            <p class="muted">双击空白处新建表；也可以把表、设计图拖进来，或者 Ctrl+V 粘贴。</p>
          </div>
        </section>
        <aside v-if="rightCollapsed" class="rail right-rail" title="展开属性面板" @click="rightCollapsed = false">
          <span class="rail-icon">«</span>
          <span class="rail-text">属性 · 差异 · 待同步</span>
          <span v-if="pendingCount" class="count">{{ pendingCount }}</span>
        </aside>
        <aside v-else class="right">
          <nav class="tabs">
            <button :class="{ active: rightTab === 'inspector' }" @click="rightTab = 'inspector'">属性</button>
            <button :class="{ active: rightTab === 'diff' }" @click="rightTab = 'diff'">
              差异<span v-if="canvas.comparison && openDiffs" class="count">{{ openDiffs }}</span>
            </button>
            <button :class="{ active: rightTab === 'sync' }" title="设计图（ER 图）和表结构不一致的地方" @click="rightTab = 'sync'">
              待同步<span v-if="pendingCount" class="count">{{ pendingCount }}</span>
            </button>
            <button class="collapse" title="收起右侧面板" @click="rightCollapsed = true">»</button>
          </nav>
          <div class="tab-body">
            <Inspector v-if="rightTab === 'inspector'" :view="view" />
            <DiffPanel v-else-if="rightTab === 'diff'" :view="view" />
            <template v-else>
              <p v-if="!state.pending.length" class="sync-empty muted">
                {{ hasDesignSchema ? 'ER 图和表结构一致，没有需要同步的内容。' : '还没有加载设计库。' }}
              </p>
              <SyncPanel
                v-else
                :groups="state.pending"
                show-titles
                :busy="syncBusy"
                @apply="onApplySync"
                @ignore="(g, ids) => ignoreSync(g, ids)"
                @clear-ignored="(g) => ignoreSync(g, [], true)"
                @open="openDiagram"
              />
            </template>
          </div>
        </aside>
      </main>
    </template>

    <ContextMenu v-if="menu" :x="menu.x" :y="menu.y" :title="menu.title" :items="menu.items" @close="menu = undefined" />
    <div v-if="toastVisible && state.toast" class="toast" :class="state.toast.level" @click="toastVisible = false">{{ state.toast.message }}</div>
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--hn-border);
}

.crumbs {
  display: flex;
  align-items: center;
  gap: 4px;
  max-width: 45%;
  margin-right: 8px;
  overflow: hidden;
  white-space: nowrap;
}

.crumb {
  overflow: hidden;
  color: var(--hn-muted);
  text-decoration: none;
  text-overflow: ellipsis;
}

.crumb:hover {
  color: var(--hn-fg);
  text-decoration: underline;
}

.crumb.current {
  color: var(--hn-fg);
  font-weight: 600;
}

.crumb-sep {
  color: var(--hn-muted);
}

.ns-btn {
  padding: 0 6px;
  border-radius: 3px;
  background: color-mix(in srgb, var(--hn-muted) 18%, transparent);
  color: var(--hn-muted);
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 11px;
}

.toolbar label {
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--hn-muted);
}

.sep {
  width: 1px;
  height: 18px;
  margin: 0 4px;
  background: var(--hn-border);
}

.clip {
  margin-left: auto;
  font-size: 11px;
}

.body {
  display: flex;
  flex: 1;
  min-height: 0;
}

.left {
  width: 240px;
  flex-shrink: 0;
  border-right: 1px solid var(--hn-border);
  background: var(--hn-node-bg);
}

.rail {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  width: 32px;
  flex-shrink: 0;
  padding: 8px 0;
  background: var(--hn-node-bg);
  color: var(--hn-muted);
  cursor: pointer;
  user-select: none;
}

.rail:hover {
  color: var(--hn-fg);
}

.left-rail {
  border-right: 1px solid var(--hn-border);
}

.right-rail {
  border-left: 1px solid var(--hn-border);
}

.rail-text {
  writing-mode: vertical-rl;
  letter-spacing: 2px;
}

.center-pane {
  position: relative;
  flex: 1;
  min-width: 0;
}

.right {
  display: flex;
  flex-direction: column;
  width: 300px;
  flex-shrink: 0;
  border-left: 1px solid var(--hn-border);
  background: var(--hn-node-bg);
}

.tabs {
  display: flex;
  border-bottom: 1px solid var(--hn-border);
}

.tabs button {
  flex: 1;
  padding: 6px;
  border-bottom: 2px solid transparent;
  border-radius: 0;
  color: var(--hn-muted);
  background: transparent;
}

.tabs button.active {
  border-bottom-color: var(--hn-accent);
  color: var(--hn-fg);
}

.tabs button.collapse {
  flex: 0 0 28px;
}

.tab-body {
  flex: 1;
  overflow: auto;
}

.count {
  margin-left: 4px;
  padding: 0 6px;
  border-radius: 8px;
  background: var(--hn-mismatch);
  color: var(--hn-bg);
  font-size: 11px;
}

.center {
  margin: auto;
  padding: 24px;
  text-align: center;
}

.error {
  color: var(--hn-missing);
}

.empty-overlay {
  position: absolute;
  top: 40%;
  left: 50%;
  transform: translate(-50%, -50%);
  text-align: center;
  pointer-events: none;
}

.empty-actions {
  display: flex;
  justify-content: center;
  gap: 8px;
  margin-top: 8px;
  pointer-events: auto;
}

.sync-empty {
  padding: 12px;
}

.toast {
  position: fixed;
  bottom: 16px;
  left: 50%;
  z-index: 200;
  max-width: 70%;
  padding: 8px 14px;
  border: 1px solid var(--hn-border);
  border-radius: 4px;
  background: var(--vscode-notifications-background, var(--hn-node-bg));
  color: var(--vscode-notifications-foreground, var(--hn-fg));
  box-shadow: 0 4px 12px rgb(0 0 0 / 35%);
  transform: translateX(-50%);
  cursor: pointer;
}

.toast.error {
  border-color: var(--hn-missing);
}
</style>

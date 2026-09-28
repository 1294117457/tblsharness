<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import type { Connection } from '@vue-flow/core';
import { nodeId, parseNodeId, type CanvasEdit, type CanvasNode, type ColumnDisplay, type ComparisonMode } from '@shared/canvas';
import type { RelationKind } from '@shared/model';
import { buildView, TABLE_HANDLE, type TableView } from './canvas/viewModel';
import { NODE_WIDTH, type Position } from './canvas/layout';
import CanvasView from './components/CanvasView.vue';
import ContextMenu, { type MenuItem } from './components/ContextMenu.vue';
import DiffPanel from './components/DiffPanel.vue';
import Inspector from './components/Inspector.vue';
import SourcePanel from './components/SourcePanel.vue';
import { canvas, designOp, editCanvas, focusNode, handleHostMessage, state, toast } from './store';
import { onHostMessage, post } from './vscode';

const view = computed(() => buildView(canvas.value, state.sources, state.comparison));
const flow = ref<InstanceType<typeof CanvasView>>();
const rightTab = ref<'inspector' | 'diff'>('inspector');
const menu = ref<{ x: number; y: number; title?: string; items: MenuItem[] }>();
const pointer = { x: 0, y: 0 };

const designSources = computed(() => canvas.value.sources.filter((s) => s.kind === 'design' && state.sources[s.alias]?.schema));
const dbSources = computed(() => canvas.value.sources.filter((s) => s.kind === 'db'));
const openDiffs = computed(() => state.comparison?.diff.items.filter((i) => !i.accepted).length ?? 0);

const comparisonValue = computed(() => {
  const c = canvas.value.comparison;
  return c ? `${c.design}|${c.db}` : '';
});

const comparisonOptions = computed(() =>
  canvas.value.sources
    .filter((s) => s.kind === 'design')
    .flatMap((d) =>
      dbSources.value.map((b) => ({ value: `${d.alias}|${b.alias}`, label: `${sourceName(d.alias)} ↔ ${sourceName(b.alias)}` })),
    ),
);

function sourceName(alias: string): string {
  return state.sources[alias]?.name ?? canvas.value.sources.find((s) => s.alias === alias)?.ref ?? alias;
}

function tableView(id: string): TableView | undefined {
  return view.value.tables.find((t) => t.id === id);
}

function positionOf(id: string): Position {
  return flow.value?.currentPosition(id) ?? { x: 0, y: 0 };
}

function nodeEntry(id: string): CanvasNode {
  const { alias, table } = parseNodeId(id);
  const p = positionOf(id);
  const existing = canvas.value.nodes.find((n) => n.source === alias && n.table === table);
  return { ...existing, source: alias, table, x: p.x, y: p.y };
}

/** Nodes of `tables: 'all'` sources only exist implicitly; pin them before an edit that needs them in `nodes`. */
function materialize(alias: string, except = new Set<string>()): CanvasEdit {
  const ids = view.value.tables.filter((t) => t.alias === alias && !except.has(t.id)).map((t) => t.id);
  return [
    { op: 'source.update', alias, patch: { tables: 'picked' } },
    { op: 'nodes.put', nodes: ids.map(nodeEntry) },
  ];
}

function removeFromCanvas(ids: string[]) {
  const notes = ids.filter((id) => id.startsWith('note:')).map((id) => id.slice(5));
  const tables = ids.filter((id) => !id.startsWith('note:'));
  const removing = new Set(tables);
  const edit: CanvasEdit = [];
  for (const alias of new Set(tables.map((id) => parseNodeId(id).alias))) {
    if (canvas.value.sources.find((s) => s.alias === alias)?.tables === 'all') edit.push(...materialize(alias, removing));
  }
  if (tables.length) edit.push({ op: 'nodes.remove', ids: tables });
  for (const id of notes) edit.push({ op: 'note.remove', id });
  if (!edit.length) return;
  editCanvas(ids.length > 1 ? `从画布移除 ${ids.length} 项` : '从画布移除', edit);
  const sel = state.selection;
  if (sel && ((sel.type === 'note' && notes.includes(sel.id)) || ((sel.type === 'table' || sel.type === 'column') && removing.has(sel.nodeId)))) {
    state.selection = undefined;
  }
}

function pickMode(alias: string) {
  editCanvas('只显示挑选的表', materialize(alias));
}

function addTables(alias: string, tables: string[], near?: string) {
  const fresh = tables.filter((t) => !tableView(nodeId(alias, t)));
  if (!fresh.length) {
    if (tables.length) focusNode(nodeId(alias, tables[0]));
    return;
  }
  const anchor = near ? positionOf(near) : flow.value?.centerPosition() ?? { x: 0, y: 0 };
  const x0 = near ? anchor.x + NODE_WIDTH + 80 : anchor.x - NODE_WIDTH / 2;
  const nodes = fresh.map((table, i) => ({ source: alias, table, x: x0 + (near ? 0 : i * (NODE_WIDTH + 40)), y: anchor.y + (near ? i * 200 : 0) }));
  editCanvas(fresh.length > 1 ? `添加 ${fresh.length} 张表到画布` : `添加表 ${fresh[0]} 到画布`, [{ op: 'nodes.put', nodes }]);
  if (!near) focusNode(nodeId(alias, fresh[0]));
}

function uniqueTableName(alias: string): string {
  const taken = new Set((state.sources[alias]?.schema?.tables ?? []).map((t) => t.key));
  let name = 'new_table';
  for (let i = 2; taken.has(name); i++) name = `new_table_${i}`;
  return name;
}

async function createTableIn(alias: string, position: Position) {
  const table = uniqueTableName(alias);
  const ok = await designOp(alias, [{ op: 'table.add', table }], `新建表 ${table}`, [
    { op: 'nodes.put', nodes: [{ source: alias, table, x: position.x, y: position.y }] },
  ]);
  if (ok) {
    state.selection = { type: 'table', nodeId: nodeId(alias, table) };
    rightTab.value = 'inspector';
    toast(`已新建表 ${table}，可以在右侧修改表名和字段`);
  }
}

function createTable(position?: Position) {
  const targets = designSources.value;
  if (!targets.length) {
    toast('画布上还没有可编辑的设计库。先在左侧“+ 添加”里加入或新建一个设计库。', 'error');
    return;
  }
  const p = position ?? flow.value?.centerPosition() ?? { x: 0, y: 0 };
  if (targets.length === 1) {
    void createTableIn(targets[0].alias, p);
    return;
  }
  menu.value = {
    x: pointer.x,
    y: pointer.y,
    title: '新建表到哪个设计库？',
    items: targets.map((s) => ({ label: sourceName(s.alias), action: () => void createTableIn(s.alias, p) })),
  };
}

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
  if (child.alias !== parent.alias || !child.editable || !parent.editable) {
    toast('只能在同一个设计库的表之间建立关系；数据库中的表是只读的。', 'error');
    return;
  }
  if (child.id === parent.id && childCol === parentCol) return;
  const alias = child.alias;
  menu.value = {
    x: pointer.x,
    y: pointer.y,
    title: `${child.key}.${childCol} → ${parent.key}.${parentCol}`,
    items: RELATION_KINDS.map((k) => ({
      label: k.label,
      hint: k.hint,
      action: () =>
        void designOp(
          alias,
          [{ op: 'relation.add', from: { table: child.key, columns: [childCol] }, to: { table: parent.key, columns: [parentCol] }, kind: k.kind }],
          `添加关系 ${child.key} → ${parent.key}`,
        ),
    })),
  };
}

function relatedTables(t: TableView): string[] {
  const rels = state.sources[t.alias]?.schema?.relations ?? [];
  const out = new Set<string>();
  for (const r of rels) {
    if (r.from.table === t.key) out.add(r.to.table);
    if (r.to.table === t.key) out.add(r.from.table);
  }
  out.delete(t.key);
  return [...out].filter((k) => !tableView(nodeId(t.alias, k)));
}

function setDisplay(ids: string[], display: ColumnDisplay | undefined) {
  const edit: CanvasEdit = [];
  const pinned = ids.filter((id) => !canvas.value.nodes.some((n) => nodeId(n.source, n.table) === id));
  if (pinned.length) edit.push({ op: 'nodes.put', nodes: pinned.map(nodeEntry) });
  edit.push({ op: 'nodes.display', ids, display });
  editCanvas('修改字段显示', edit);
}

function openNodeMenu({ nodeId: id, x, y }: { nodeId: string; x: number; y: number }) {
  const t = tableView(id);
  if (!t) return;
  const selected = flow.value?.selectedNodeIds() ?? [];
  const targets = selected.includes(id) && selected.length > 1 ? selected : [id];
  const tableTargets = targets.filter((n) => !n.startsWith('note:'));
  const related = relatedTables(t);
  const items: MenuItem[] = [
    {
      label: '添加关联的表',
      hint: related.length ? `${related.length} 张` : '无',
      disabled: !related.length,
      action: () => addTables(t.alias, related, id),
    },
    { separator: true },
    { label: '字段显示：全部', action: () => setDisplay(tableTargets, 'all') },
    { label: '字段显示：仅主键和外键', action: () => setDisplay(tableTargets, 'keys') },
    { label: '字段显示：只显示表名', action: () => setDisplay(tableTargets, 'none') },
    { label: '字段显示：跟随画布设置', action: () => setDisplay(tableTargets, undefined) },
    { separator: true },
    { label: targets.length > 1 ? `从画布移除 ${targets.length} 项` : '从画布移除', hint: 'Delete', action: () => removeFromCanvas(targets) },
  ];
  if (t.editable) {
    items.push(
      { separator: true },
      {
        label: '从设计库中删除表…',
        danger: true,
        action: () => void designOp(t.alias, [{ op: 'table.delete', table: t.key }], `删除表 ${t.key}`, [{ op: 'nodes.remove', ids: [id] }]),
      },
    );
  }
  menu.value = { x, y, title: targets.length > 1 ? `已选中 ${targets.length} 项` : t.key, items };
}

function setColumnDisplay(value: string) {
  editCanvas('修改字段显示', [{ op: 'settings.set', settings: { columnDisplay: value as ColumnDisplay } }]);
}

function setComparison(value: string) {
  if (!value) {
    editCanvas('关闭对比', [{ op: 'comparison.set', comparison: undefined }]);
    return;
  }
  const [design, db] = value.split('|');
  editCanvas('开启对比', [{ op: 'comparison.set', comparison: { design, db, mode: canvas.value.comparison?.mode ?? 'overlay' } }]);
  rightTab.value = 'diff';
}

function setComparisonMode(mode: string) {
  const c = canvas.value.comparison;
  if (c) editCanvas('切换对比方式', [{ op: 'comparison.set', comparison: { ...c, mode: mode as ComparisonMode } }]);
}

const editingName = ref(false);
const nameDraft = ref('');
const nameInput = ref<HTMLInputElement>();

function startRename() {
  nameDraft.value = canvas.value.name;
  editingName.value = true;
  requestAnimationFrame(() => nameInput.value?.select());
}

function commitRename() {
  if (!editingName.value) return;
  editingName.value = false;
  const name = nameDraft.value.trim();
  if (name && name !== canvas.value.name) editCanvas('重命名画布', [{ op: 'meta.set', name }]);
}

function addNote() {
  const p = flow.value?.centerPosition() ?? { x: 0, y: 0 };
  const id = `n${Date.now().toString(36)}`;
  editCanvas('添加便签', [{ op: 'note.put', note: { id, text: '', x: Math.round(p.x - 100), y: Math.round(p.y), width: 200 } }]);
  state.selection = { type: 'note', id };
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
}

function onKeyDown(e: KeyboardEvent) {
  if (isTyping(e.target) || menu.value) return;
  if (e.key !== 'Delete' && e.key !== 'Backspace') return;
  const sel = state.selection;
  let ids = flow.value?.selectedNodeIds() ?? [];
  if (!ids.length && sel?.type === 'table') ids = [sel.nodeId];
  if (!ids.length && sel?.type === 'column') ids = [sel.nodeId];
  if (!ids.length && sel?.type === 'note') ids = [`note:${sel.id}`];
  if (ids.length) {
    e.preventDefault();
    removeFromCanvas(ids);
  } else if (sel?.type === 'relation') {
    toast('Delete 只会从画布移除节点。要删除关系，请在右侧属性面板中点击“删除关系”。');
  }
}

function onPointer(e: PointerEvent) {
  pointer.x = e.clientX;
  pointer.y = e.clientY;
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
  post({ type: 'ready' });
});

onUnmounted(() => {
  dispose?.();
  window.removeEventListener('keydown', onKeyDown);
  window.removeEventListener('pointerup', onPointer, true);
  window.removeEventListener('pointerdown', onPointer, true);
});
</script>

<template>
  <div class="app">
    <div v-if="!state.loaded" class="center muted">正在加载画布…</div>
    <div v-else-if="state.error" class="center error">{{ state.error }}</div>
    <template v-else>
      <header class="toolbar">
        <input
          v-if="editingName"
          ref="nameInput"
          v-model="nameDraft"
          class="title-input"
          @keydown.enter.prevent="commitRename"
          @keydown.esc.prevent="editingName = false"
          @blur="commitRename"
        />
        <strong v-else class="title" :title="`${canvas.description ? `${canvas.description}\n` : ''}点击修改画布名称`" @click="startRename">{{ canvas.name }}</strong>
        <button :disabled="!designSources.length" title="也可以双击画布空白处" @click="createTable()">+ 新建表</button>
        <button class="secondary" @click="addNote">+ 便签</button>
        <span class="sep" />
        <button class="secondary" :disabled="!view.tables.length" @click="flow?.autoLayout(false)">自动布局</button>
        <button class="secondary" :disabled="!view.tables.length" title="只重新排列选中的表" @click="flow?.autoLayout(true)">布局选中</button>
        <button class="secondary" :disabled="!view.tables.length" @click="flow?.fitView()">适应窗口</button>
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
            <option value="">{{ comparisonOptions.length ? '不对比' : '需要设计库和数据库各一个' }}</option>
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
      </header>

      <main class="body">
        <aside class="left">
          <SourcePanel :view="view" @add-tables="addTables" @remove-nodes="removeFromCanvas" @pick-mode="pickMode" />
        </aside>
        <section class="center-pane">
          <CanvasView ref="flow" :view="view" :canvas="canvas" @connect="onConnect" @create-table="createTable" @node-menu="openNodeMenu" />
          <div v-if="!canvas.sources.length" class="empty-overlay">
            <p>这个画布还是空的。</p>
            <p class="muted">在左侧“数据源”里添加设计库或数据库，表就会出现在这里。</p>
          </div>
          <div v-else-if="!view.tables.length" class="empty-overlay">
            <p>画布上还没有表。</p>
            <p class="muted">在左侧勾选要显示的表；双击空白处可以在设计库中新建表。</p>
          </div>
        </section>
        <aside class="right">
          <nav class="tabs">
            <button :class="{ active: rightTab === 'inspector' }" @click="rightTab = 'inspector'">属性</button>
            <button :class="{ active: rightTab === 'diff' }" @click="rightTab = 'diff'">
              差异<span v-if="canvas.comparison && openDiffs" class="count">{{ openDiffs }}</span>
            </button>
          </nav>
          <div class="tab-body">
            <Inspector v-if="rightTab === 'inspector'" />
            <DiffPanel v-else :view="view" />
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

.toolbar .title {
  margin-right: 8px;
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 1px 4px;
  border: 1px solid transparent;
  border-radius: 2px;
  cursor: text;
}

.toolbar .title:hover {
  border-color: var(--hn-border);
}

.title-input {
  width: 200px;
  margin-right: 8px;
  font-weight: 600;
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

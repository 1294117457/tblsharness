<script setup lang="ts">
import { computed, ref } from 'vue';
import { nextAlias, nodeId, type CanvasSource } from '@shared/canvas';
import type { SourceKind } from '@shared/workspace';
import type { CanvasView } from '../canvas/viewModel';
import { canvas, editCanvas, focusNode, state } from '../store';
import { post } from '../vscode';

const props = defineProps<{ view: CanvasView }>();
const emit = defineEmits<{
  'add-tables': [alias: string, tables: string[]];
  'remove-nodes': [ids: string[]];
  'pick-mode': [alias: string];
}>();

const search = ref('');
const adding = ref(false);
const collapsed = ref(new Set<string>());

const shown = computed(() => new Set(props.view.tables.map((t) => t.id)));

const available = computed(() => {
  const cat = state.catalog;
  if (!cat) return [];
  const onCanvas = new Set(canvas.value.sources.map((s) => `${s.kind}:${s.ref}`));
  return [
    ...cat.design.map((d) => ({ kind: 'design' as SourceKind, ref: d.id, name: d.name, detail: `${d.tableCount} 张表` })),
    ...cat.db.map((d) => ({ kind: 'db' as SourceKind, ref: d.id, name: d.name, detail: d.hasSnapshot ? `${d.tableCount} 张表` : '还没有快照' })),
  ].filter((s) => !onCanvas.has(`${s.kind}:${s.ref}`));
});

const groups = computed(() => {
  const q = search.value.trim().toLowerCase();
  return canvas.value.sources.map((source) => {
    const data = state.sources[source.alias];
    const tables = (data?.schema?.tables ?? [])
      .filter((t) => !q || t.key.toLowerCase().includes(q) || t.comment?.toLowerCase().includes(q))
      .map((t) => ({ key: t.key, comment: t.comment, id: nodeId(source.alias, t.key) }));
    return { source, data, tables };
  });
});

function addSource(kind: SourceKind, ref: string) {
  const source: CanvasSource = { alias: nextAlias(canvas.value, kind), kind, ref, tables: kind === 'design' ? 'all' : 'picked' };
  editCanvas('添加数据源', [{ op: 'source.add', source }]);
  adding.value = false;
}

/** The new source only appears in the list above; adding it to this canvas is a separate click. */
function createSource(kind: SourceKind) {
  post({ type: 'source/create', kind });
}

const renaming = ref<string>();
const renameDraft = ref('');

function startRename(alias: string, current: string) {
  renaming.value = alias;
  renameDraft.value = current;
}

function commitRename() {
  const alias = renaming.value;
  if (!alias) return;
  renaming.value = undefined;
  const name = renameDraft.value.trim();
  if (name && name !== state.sources[alias]?.name) post({ type: 'source/rename', alias, name });
}

/** Function refs run on every re-render; select only once per input so typing isn't replaced. */
let selectedInput: HTMLInputElement | undefined;
function focusSelect(el: unknown) {
  if (!(el instanceof HTMLInputElement)) {
    selectedInput = undefined;
    return;
  }
  if (el === selectedInput) return;
  selectedInput = el;
  requestAnimationFrame(() => el.select());
}

function removeSource(alias: string) {
  editCanvas('移除数据源', [{ op: 'source.remove', alias }]);
}

function setShowAll(source: CanvasSource, all: boolean) {
  if (all) editCanvas('显示全部表', [{ op: 'source.update', alias: source.alias, patch: { tables: 'all' } }]);
  else emit('pick-mode', source.alias);
}

function toggle(alias: string, key: string, on: boolean) {
  if (on) emit('add-tables', alias, [key]);
  else emit('remove-nodes', [nodeId(alias, key)]);
}

function toggleCollapsed(alias: string) {
  const next = new Set(collapsed.value);
  if (next.has(alias)) next.delete(alias);
  else next.add(alias);
  collapsed.value = next;
}
</script>

<template>
  <div class="source-panel">
    <div class="panel-header">
      <span>数据源</span>
      <button class="secondary small" @click="adding = !adding">+ 添加</button>
    </div>
    <div v-if="adding" class="add-menu">
      <p v-if="!available.length" class="muted">工作区里的数据源都已经在画布上了。</p>
      <button v-for="s in available" :key="`${s.kind}:${s.ref}`" class="menu-item" @click="addSource(s.kind, s.ref)">
        <span>{{ s.kind === 'design' ? '✏️' : '🗄️' }} {{ s.name }}</span>
        <span class="muted">{{ s.detail }}</span>
      </button>
      <div class="menu-sep" />
      <button class="menu-item" @click="createSource('design')">新建设计库…</button>
      <button class="menu-item" @click="createSource('db')">添加数据库…</button>
    </div>
    <input v-model="search" class="search" placeholder="搜索表名或注释" @keydown.stop />

    <div class="groups">
      <p v-if="!canvas.sources.length" class="muted hint">画布里还没有数据源。点击“+ 添加”，把设计库或数据库加进来。</p>
      <section v-for="g in groups" :key="g.source.alias">
        <div class="source-row">
          <button class="twisty" @click="toggleCollapsed(g.source.alias)">{{ collapsed.has(g.source.alias) ? '▸' : '▾' }}</button>
          <input
            v-if="renaming === g.source.alias"
            :ref="focusSelect"
            v-model="renameDraft"
            class="rename-input"
            @keydown.stop
            @keydown.enter.prevent="commitRename"
            @keydown.esc.prevent="renaming = undefined"
            @blur="commitRename"
          />
          <span
            v-else
            class="source-name"
            :title="g.source.kind === 'design' ? `${g.data?.name ?? g.source.ref}（双击重命名）` : g.data?.name ?? g.source.ref"
            @dblclick="g.source.kind === 'design' && startRename(g.source.alias, g.data?.name ?? g.source.ref)"
          >
            {{ g.source.kind === 'design' ? '✏️' : '🗄️' }} {{ g.data?.name ?? g.source.ref }}
          </span>
          <span class="actions">
            <button v-if="g.source.kind === 'db'" class="icon-btn" title="同步数据库结构" @click="post({ type: 'db/sync', alias: g.source.alias })">⟳</button>
            <button class="icon-btn" title="打开原始文件" @click="post({ type: 'openRaw', alias: g.source.alias })">{ }</button>
            <button class="icon-btn" title="从画布移除这个数据源" @click="removeSource(g.source.alias)">✕</button>
          </span>
        </div>
        <template v-if="!collapsed.has(g.source.alias)">
          <p v-if="g.data?.error" class="error">{{ g.data.error }}</p>
          <p v-else-if="g.data && !g.data.schema" class="muted hint">还没有快照，请先同步或导入快照。</p>
          <label class="show-all">
            <input type="checkbox" :checked="g.source.tables === 'all'" @change="setShowAll(g.source, ($event.target as HTMLInputElement).checked)" />
            显示全部表（包括以后新增的）
          </label>
          <ul>
            <li v-for="t in g.tables" :key="t.id">
              <input
                type="checkbox"
                :checked="shown.has(t.id)"
                :disabled="g.source.tables === 'all'"
                @change="toggle(g.source.alias, t.key, ($event.target as HTMLInputElement).checked)"
              />
              <a href="#" :class="{ off: !shown.has(t.id) }" :title="t.comment" @click.prevent="shown.has(t.id) ? focusNode(t.id) : toggle(g.source.alias, t.key, true)">
                {{ t.key }}
              </a>
            </li>
          </ul>
        </template>
      </section>
    </div>
  </div>
</template>

<style scoped>
.source-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  font-weight: 600;
}

.add-menu {
  margin: 0 8px 6px;
  padding: 4px;
  border: 1px solid var(--hn-border);
  border-radius: 4px;
  background: var(--hn-node-bg);
}

.menu-item {
  display: flex;
  justify-content: space-between;
  width: 100%;
  padding: 4px 6px;
  color: var(--hn-fg);
  background: transparent;
  text-align: left;
}

.menu-item:hover {
  background: var(--hn-node-header);
}

.menu-sep {
  margin: 4px 0;
  border-top: 1px solid var(--hn-border);
}

.search {
  margin: 0 8px 6px;
}

.groups {
  flex: 1;
  overflow: auto;
  padding: 0 4px 8px;
}

.source-row {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 2px;
  border-top: 1px solid var(--hn-border);
}

.twisty {
  padding: 0 4px;
  color: var(--hn-muted);
  background: transparent;
}

.source-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
}

.rename-input {
  flex: 1;
  min-width: 0;
}

.actions {
  display: flex;
  gap: 2px;
}

.show-all {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  color: var(--hn-muted);
  font-size: 11px;
}

ul {
  margin: 0;
  padding: 0 0 4px 8px;
  list-style: none;
}

li {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 1px 0;
}

li a {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--hn-fg);
  text-decoration: none;
}

li a.off {
  color: var(--hn-muted);
}

li a:hover {
  text-decoration: underline;
}

.hint {
  padding: 4px 8px;
}

.error {
  padding: 4px 8px;
  color: var(--hn-missing);
  word-break: break-all;
}
</style>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { DESIGN_SOURCE, nodeId } from '@shared/canvas';
import type { CanvasView } from '../canvas/viewModel';
import { canvas, editCanvas, focusNode, state } from '../store';
import { post, request } from '../vscode';

const props = defineProps<{ view: CanvasView }>();
const emit = defineEmits<{
  'add-tables': [source: string, tables: string[]];
  'remove-nodes': [ids: string[]];
  'pick-mode': [];
}>();

const search = ref('');
const adding = ref(false);
const collapsed = ref(new Set<string>());
const shown = computed(() => new Set(props.view.tables.map((t) => t.id)));

const designSchema = computed(() => state.sources[DESIGN_SOURCE]?.schema);
const designTables = computed(() => {
  const q = search.value.trim().toLowerCase();
  return (designSchema.value?.tables ?? [])
    .filter((t) => !q || t.key.toLowerCase().includes(q) || t.comment?.toLowerCase().includes(q))
    .map((t) => ({ key: t.key, comment: t.comment, id: nodeId(DESIGN_SOURCE, t.key) }));
});

const dbSources = computed(() => {
  const q = search.value.trim().toLowerCase();
  return Object.entries(state.sources)
    .filter(([k]) => k !== DESIGN_SOURCE)
    .map(([sourceId, data]) => {
      const tables = (data.schema?.tables ?? [])
        .filter((t) => !q || t.key.toLowerCase().includes(q) || t.comment?.toLowerCase().includes(q))
        .map((t) => ({ key: t.key, comment: t.comment, id: nodeId(sourceId, t.key) }));
      return { sourceId, data, tables };
    });
});

const availableDbs = computed(() => {
  const cat = state.catalog;
  if (!cat) return [];
  const onCanvas = new Set(Object.keys(state.sources).filter((k) => k !== DESIGN_SOURCE));
  return cat.db.filter((d) => !onCanvas.has(d.id));
});

async function addDb(dbId: string) {
  adding.value = false;
  try { await request({ type: 'source/add', dbId }); } catch { /* handled by host */ }
}

async function removeDb(dbId: string) {
  try { await request({ type: 'source/remove', dbId }); } catch { /* handled by host */ }
}

function setDesignShowAll(all: boolean) {
  if (all) editCanvas('显示全部表', [{ op: 'designTables.set', mode: 'all' }]);
  else emit('pick-mode');
}

function toggle(source: string, key: string, on: boolean) {
  if (on) emit('add-tables', source, [key]);
  else emit('remove-nodes', [nodeId(source, key)]);
}

function toggleCollapsed(id: string) {
  const next = new Set(collapsed.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  collapsed.value = next;
}
</script>

<template>
  <div class="source-panel">
    <div class="panel-header">
      <span>数据源</span>
      <button class="secondary small" @click="adding = !adding">+ 添加数据库</button>
    </div>
    <div v-if="adding" class="add-menu">
      <p v-if="!availableDbs.length" class="muted">工作区里的数据库都已经在画布上了。</p>
      <button v-for="d in availableDbs" :key="d.id" class="menu-item" @click="addDb(d.id)">
        <span>🗄️ {{ d.name }}</span>
        <span class="muted">{{ d.hasSnapshot ? `${d.tableCount} 张表` : '还没有快照' }}</span>
      </button>
    </div>
    <input v-model="search" class="search" placeholder="搜索表名或注释" @keydown.stop />

    <div class="groups">
      <!-- Design section -->
      <section v-if="designSchema">
        <div class="source-row">
          <button class="twisty" @click="toggleCollapsed(DESIGN_SOURCE)">{{ collapsed.has(DESIGN_SOURCE) ? '▸' : '▾' }}</button>
          <span class="source-name" :title="state.design?.name ?? '设计'">✏️ {{ state.design?.name ?? '设计' }}</span>
        </div>
        <template v-if="!collapsed.has(DESIGN_SOURCE)">
          <label class="show-all">
            <input type="checkbox" :checked="canvas.designTables === 'all'" @change="setDesignShowAll(($event.target as HTMLInputElement).checked)" />
            显示全部表（包括以后新增的）
          </label>
          <ul>
            <li v-for="t in designTables" :key="t.id">
              <input type="checkbox" :checked="shown.has(t.id)" :disabled="canvas.designTables === 'all'" @change="toggle(DESIGN_SOURCE, t.key, ($event.target as HTMLInputElement).checked)" />
              <a href="#" :class="{ off: !shown.has(t.id) }" :title="t.comment" @click.prevent="shown.has(t.id) ? focusNode(t.id) : toggle(DESIGN_SOURCE, t.key, true)">{{ t.key }}</a>
            </li>
          </ul>
        </template>
      </section>

      <!-- DB sections -->
      <section v-for="g in dbSources" :key="g.sourceId">
        <div class="source-row">
          <button class="twisty" @click="toggleCollapsed(g.sourceId)">{{ collapsed.has(g.sourceId) ? '▸' : '▾' }}</button>
          <span class="source-name" :title="g.data.name">🗄️ {{ g.data.name }}</span>
          <span class="actions">
            <button class="icon-btn" title="同步数据库结构" @click="post({ type: 'db/sync', source: g.sourceId })">⟳</button>
            <button class="icon-btn" title="从画布移除这个数据库" @click="removeDb(g.sourceId)">✕</button>
          </span>
        </div>
        <template v-if="!collapsed.has(g.sourceId)">
          <p v-if="g.data.error" class="error">{{ g.data.error }}</p>
          <p v-else-if="!g.data.schema" class="muted hint">还没有快照，请先同步或导入快照。</p>
          <ul>
            <li v-for="t in g.tables" :key="t.id">
              <input type="checkbox" :checked="shown.has(t.id)" @change="toggle(g.sourceId, t.key, ($event.target as HTMLInputElement).checked)" />
              <a href="#" :class="{ off: !shown.has(t.id) }" :title="t.comment" @click.prevent="shown.has(t.id) ? focusNode(t.id) : toggle(g.sourceId, t.key, true)">{{ t.key }}</a>
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

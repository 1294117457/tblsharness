<script setup lang="ts">
import { computed, ref } from 'vue';
import { DESIGN_SOURCE, nodeId, type ItemRef } from '@shared/canvas';
import { diagramTypeLabel } from '@shared/diagram';
import type { LevelContent } from '../canvas/viewModel';
import { editCanvas, reveal, requestDiagramEdit, state } from '../store';
import { post, request } from '../vscode';

/** Lists the current level only. */
const props = defineProps<{ level: LevelContent }>();
const emit = defineEmits<{
  'add-db-tables': [source: string, tables: string[]];
  'remove-db-tables': [source: string, tables: string[]];
  'create-table': [];
  'create-diagram': [];
  collapse: [];
  export: [];
}>();

const search = ref('');
const adding = ref(false);
const collapsed = ref(new Set<string>());

function matches(...texts: (string | undefined)[]): boolean {
  const q = search.value.trim().toLowerCase();
  return !q || texts.some((t) => t?.toLowerCase().includes(q));
}

const designTables = computed(() => props.level.tables.filter((t) => matches(t.key, t.displayName, t.comment)));
const diagrams = computed(() => props.level.diagrams.filter((d) => matches(d.name)));
const hasDesign = computed(() => !!state.sources[DESIGN_SOURCE]?.schema);

const dbSources = computed(() =>
  Object.entries(state.sources)
    .filter(([k]) => k !== DESIGN_SOURCE)
    .map(([sourceId, data]) => {
      const here = props.level.db[sourceId] ?? new Set<string>();
      const elsewhere = props.level.dbElsewhere[sourceId] ?? new Set<string>();
      const all = data.schema?.tables ?? [];
      const tables = all.filter((t) => matches(t.key, t.comment)).map((t) => ({ key: t.key, comment: t.comment, shown: here.has(t.key), elsewhere: !here.has(t.key) && elsewhere.has(t.key) }));
      return { sourceId, data, tables, allShown: !!all.length && all.every((t) => here.has(t.key)), someShown: here.size > 0 };
    }),
);

const availableDbs = computed(() => {
  const cat = state.catalog;
  if (!cat) return [];
  const onCanvas = new Set(Object.keys(state.sources).filter((k) => k !== DESIGN_SOURCE));
  return cat.db.filter((d) => !onCanvas.has(d.id));
});

const allTablesShown = computed(() => props.level.tables.length > 0 && props.level.tables.every((t) => !t.hidden));
const someTablesShown = computed(() => props.level.tables.some((t) => !t.hidden));
const allDiagramsShown = computed(() => props.level.diagrams.length > 0 && props.level.diagrams.every((d) => !d.hidden));
const someDiagramsShown = computed(() => props.level.diagrams.some((d) => !d.hidden));

async function addDb(dbId: string) {
  adding.value = false;
  try {
    await request({ type: 'source/add', dbId });
  } catch {
    /* reported by the host */
  }
}

async function removeDb(dbId: string) {
  try {
    await request({ type: 'source/remove', dbId });
  } catch {
    /* reported by the host */
  }
}

function setHidden(items: ItemRef[], hidden: boolean, label: string) {
  if (items.length) editCanvas(label, [{ op: 'hidden.set', items, hidden }]);
}

function toggleTable(key: string, on: boolean) {
  setHidden([{ kind: 'table', id: nodeId(DESIGN_SOURCE, key) }], !on, on ? `显示表 ${key}` : `隐藏表 ${key}`);
}

function toggleAllTables(on: boolean) {
  setHidden(
    props.level.tables.map((t) => ({ kind: 'table', id: nodeId(DESIGN_SOURCE, t.key) })),
    !on,
    on ? '显示本层全部设计表' : '隐藏本层全部设计表',
  );
}

function openTable(key: string, hidden: boolean) {
  if (hidden) toggleTable(key, true);
  reveal({ item: { kind: 'table', id: nodeId(DESIGN_SOURCE, key) } });
}

function toggleDiagram(id: string, on: boolean) {
  setHidden([{ kind: 'diagram', id }], !on, on ? '显示设计图' : '隐藏设计图');
}

function toggleAllDiagrams(on: boolean) {
  setHidden(
    props.level.diagrams.map((d) => ({ kind: 'diagram', id: d.id })),
    !on,
    on ? '显示本层全部设计图' : '隐藏本层全部设计图',
  );
}

function openDiagramCard(id: string) {
  reveal({ item: { kind: 'diagram', id } });
}

function toggleDb(source: string, key: string, on: boolean) {
  if (on) emit('add-db-tables', source, [key]);
  else emit('remove-db-tables', source, [key]);
}

function toggleAllDb(source: string, on: boolean) {
  const g = dbSources.value.find((x) => x.sourceId === source);
  if (!g) return;
  const all = g.data.schema?.tables ?? [];
  const here = props.level.db[source] ?? new Set<string>();
  const elsewhere = props.level.dbElsewhere[source] ?? new Set<string>();
  if (on) emit('add-db-tables', source, all.map((t) => t.key).filter((k) => !here.has(k) && !elsewhere.has(k)));
  else emit('remove-db-tables', source, [...here]);
}

function toggleCollapsed(id: string) {
  const next = new Set(collapsed.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  collapsed.value = next;
}

function indeterminate(some: boolean, all: boolean) {
  return some && !all;
}
</script>

<template>
  <div class="source-panel">
    <div class="panel-header">
      <span>数据源</span>
      <span class="header-actions">
        <button class="secondary small" @click="adding = !adding">+ 添加数据库</button>
        <button class="secondary small" title="把当前画布的设计导出成一份 AI 可以直接读取的目录" @click="emit('export')">⬇ 导出</button>
        <button class="icon-btn" title="收起数据源面板" @click="emit('collapse')">«</button>
      </span>
    </div>
    <div v-if="adding" class="add-menu">
      <p v-if="!availableDbs.length" class="muted">工作区里的数据库都已经添加过了。</p>
      <button v-for="d in availableDbs" :key="d.id" class="menu-item" @click="addDb(d.id)">
        <span>🗄️ {{ d.name }}</span>
        <span class="muted">{{ d.hasSnapshot ? `${d.tableCount} 张表` : '还没有快照' }}</span>
      </button>
    </div>
    <input v-model="search" class="search" placeholder="搜索表名、图名或注释" @keydown.stop />

    <div class="groups">
      <section v-if="hasDesign">
        <div class="source-row">
          <button class="twisty" @click="toggleCollapsed('tables')">{{ collapsed.has('tables') ? '▸' : '▾' }}</button>
          <span class="source-name">设计表<span class="count">（本层 {{ level.tables.length }}）</span></span>
          <button class="icon-btn" title="在本层新建表" @click="emit('create-table')">＋</button>
        </div>
        <template v-if="!collapsed.has('tables')">
          <label v-if="level.tables.length" class="show-all">
            <input
              type="checkbox"
              :checked="allTablesShown"
              :indeterminate="indeterminate(someTablesShown, allTablesShown)"
              @change="toggleAllTables(($event.target as HTMLInputElement).checked)"
            />
            全部显示
          </label>
          <p v-else class="muted hint">这一层还没有设计表。</p>
          <ul>
            <li v-for="t in designTables" :key="t.key">
              <input type="checkbox" :checked="!t.hidden" @change="toggleTable(t.key, ($event.target as HTMLInputElement).checked)" />
              <a href="#" :class="{ off: t.hidden }" :title="[t.namespaceTag ? `真实表名：${t.key}` : '', t.comment ?? ''].filter(Boolean).join('\n') || undefined" @click.prevent="openTable(t.key, t.hidden)">
                <span v-if="t.namespaceTag" class="ns">{{ t.namespaceTag }}</span>{{ t.displayName }}
              </a>
            </li>
          </ul>
        </template>
      </section>

      <section v-if="hasDesign">
        <div class="source-row">
          <button class="twisty" @click="toggleCollapsed('diagrams')">{{ collapsed.has('diagrams') ? '▸' : '▾' }}</button>
          <span class="source-name">设计图<span class="count">（本层 {{ level.diagrams.length }}）</span></span>
          <button class="icon-btn" title="在本层新建设计图" @click="emit('create-diagram')">＋</button>
        </div>
        <template v-if="!collapsed.has('diagrams')">
          <label v-if="level.diagrams.length" class="show-all">
            <input
              type="checkbox"
              :checked="allDiagramsShown"
              :indeterminate="indeterminate(someDiagramsShown, allDiagramsShown)"
              @change="toggleAllDiagrams(($event.target as HTMLInputElement).checked)"
            />
            全部显示
          </label>
          <p v-else class="muted hint">这一层还没有设计图。</p>
          <ul>
            <li v-for="d in diagrams" :key="d.id">
              <input type="checkbox" :checked="!d.hidden" @change="toggleDiagram(d.id, ($event.target as HTMLInputElement).checked)" />
              <a href="#" :class="{ off: d.hidden }" title="单击：在画布中定位；双击：编辑 Mermaid 文本" @click.prevent="openDiagramCard(d.id)" @dblclick.prevent="requestDiagramEdit(d.id)">
                {{ d.name }}<span class="muted type">（{{ diagramTypeLabel(d.type) }}）</span>
              </a>
            </li>
          </ul>
        </template>
      </section>

      <section v-for="g in dbSources" :key="g.sourceId">
        <div class="source-row">
          <button class="twisty" @click="toggleCollapsed(g.sourceId)">{{ collapsed.has(g.sourceId) ? '▸' : '▾' }}</button>
          <span class="source-name" :title="g.data.name">🗄️ {{ g.data.name }}</span>
          <span class="actions">
            <button class="icon-btn" title="同步数据库结构" @click="post({ type: 'db/sync', source: g.sourceId })">⟳</button>
            <button class="icon-btn" title="从这个设计画布移除这个数据库" @click="removeDb(g.sourceId)">✕</button>
          </span>
        </div>
        <template v-if="!collapsed.has(g.sourceId)">
          <p v-if="g.data.error" class="error">{{ g.data.error }}</p>
          <p v-else-if="!g.data.schema" class="muted hint">还没有快照，请先同步或导入快照。</p>
          <label v-else-if="g.data.schema.tables.length" class="show-all" title="放在其他层的表保持不动">
            <input
              type="checkbox"
              :checked="g.allShown"
              :indeterminate="indeterminate(g.someShown, g.allShown)"
              @change="toggleAllDb(g.sourceId, ($event.target as HTMLInputElement).checked)"
            />
            显示全部表
          </label>
          <ul>
            <li v-for="t in g.tables" :key="t.key">
              <input type="checkbox" :checked="t.shown" @change="toggleDb(g.sourceId, t.key, ($event.target as HTMLInputElement).checked)" />
              <a
                href="#"
                :class="{ off: !t.shown }"
                :title="[t.elsewhere ? '已放在其他层，勾选会移到这一层' : '', t.comment ?? ''].filter(Boolean).join('\n') || undefined"
                @click.prevent="t.shown ? reveal({ item: { kind: 'table', id: nodeId(g.sourceId, t.key) } }) : toggleDb(g.sourceId, t.key, true)"
              >
                {{ t.key }}<span v-if="t.elsewhere" class="muted type">（其他层）</span>
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
  padding: 6px 6px 6px 10px;
  font-weight: 600;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 4px;
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

.count,
.type {
  font-weight: 400;
  color: var(--hn-muted);
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

.ns {
  margin-right: 2px;
  padding: 0 3px;
  border-radius: 3px;
  background: color-mix(in srgb, var(--hn-muted) 20%, transparent);
  color: var(--hn-muted);
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 10px;
}

.hint {
  margin: 0;
  padding: 4px 8px;
}

.error {
  padding: 4px 8px;
  color: var(--hn-missing);
  word-break: break-all;
}
</style>

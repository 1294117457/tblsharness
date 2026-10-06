<script setup lang="ts">
/**
 * Tree picker for the export: what to export, and where.
 *
 * The tree mirrors the left-hand data source panel (`SourcePanel.vue`) so the user's mental
 * model transfers one-to-one: a row is checked here when it is on the canvas (`onCanvas`)
 * there. The host resolves the chosen keys against its own inventory, so this component
 * cannot rename a table or point a design table at a database source.
 *
 * Layout: three top-level groups (设计表 / 设计图 / 每个数据库), each a tri-state checkbox
 * with a `X / Y` counter. Folding a group only hides its rows; selection is preserved so a
 * user can fold the noise away and still export what was already ticked.
 */
import { computed, ref } from 'vue';
import { diagramTypeLabel } from '@shared/diagram';
import { exportKey, type ExportItem, type ExportRequest } from '@shared/protocol';
import { post } from '../vscode';

const props = defineProps<{ request: ExportRequest }>();
const emit = defineEmits<{ close: []; done: [message: string] }>();

interface Row {
  item: ExportItem;
  key: string;
  label: string;
  hint: string;
}

const search = ref('');
const path = ref(props.request.suggestedPath);
/** Echoed back to the host; it is the id the host filed this inventory under. */
const requestId = props.request.requestId;
const busy = ref(false);
const collapsed = ref(new Set<string>());

/** The key a row is ticked by, and its default state. */
function keyOf(item: ExportItem): string {
  return exportKey(item);
}

/** Pre-tick the rows the data source panel shows as on the canvas. */
const selected = ref(new Set(props.request.items.filter((i) => i.onCanvas).map(keyOf)));

/** A group the user can fold and tick as a whole. */
interface Group {
  /** Stable id, also used as the fold key. */
  id: string;
  /** Header text, including the database name when relevant. */
  title: string;
  /** Counters rendered right of the checkbox, e.g. "3 / 12". */
  counter: { ticked: number; total: number };
  rows: Row[];
}

const groups = computed<Group[]>(() => {
  const q = search.value.trim().toLowerCase();
  const matches = (i: ExportItem): boolean => {
    if (!q) return true;
    const dbLabel = i.kind === 'db-table' ? props.request.dbLabels?.[i.source] ?? '' : '';
    if (dbLabel.toLowerCase().includes(q)) return true;
    if (i.kind === 'diagram') return i.name.toLowerCase().includes(q);
    return `${i.key} ${i.comment ?? ''}`.toLowerCase().includes(q);
  };
  const designTables = props.request.items.filter((i) => i.kind === 'design-table' && matches(i));
  const diagrams = props.request.items.filter((i) => i.kind === 'diagram' && matches(i));
  const bySource = new Map<string, ExportItem[]>();
  for (const i of props.request.items) {
    if (i.kind !== 'db-table' || !matches(i)) continue;
    if (!bySource.has(i.source)) bySource.set(i.source, []);
    bySource.get(i.source)!.push(i);
  }
  const designTablesGroup: Group | undefined = designTables.length
    ? { id: 'design-tables', title: '设计表', counter: count(designTables), rows: designTables.map(row) }
    : undefined;
  const diagramsGroup: Group | undefined = diagrams.length
    ? { id: 'diagrams', title: '设计图', counter: count(diagrams), rows: diagrams.map(row) }
    : undefined;
  // Each database is its own top-level group, sorted by its display name for a stable layout.
  const dbGroups: Group[] = [...bySource.entries()]
    .sort(([a], [b]) => (props.request.dbLabels?.[a] ?? a).localeCompare(props.request.dbLabels?.[b] ?? b, 'zh-Hans-CN'))
    .map(([source, items]) => ({
      id: `db:${source}`,
      title: `🗄️ ${props.request.dbLabels?.[source] ?? source}`,
      counter: count(items),
      rows: items.map(row),
    }));
  return [designTablesGroup, diagramsGroup, ...dbGroups].filter((g): g is Group => !!g);
});

function count(items: ExportItem[]): { ticked: number; total: number } {
  const ticked = items.filter((i) => selected.value.has(keyOf(i))).length;
  return { ticked, total: items.length };
}

function row(i: ExportItem): Row {
  return {
    item: i,
    key: keyOf(i),
    label: i.kind === 'diagram' ? i.name : i.key,
    hint:
      i.kind === 'diagram'
        ? diagramTypeLabel(i.type)
        : `${i.columns} 字段${i.kind === 'db-table' ? ` · ${props.request.dbLabels?.[i.source] ?? i.source}` : ''}`,
  };
}

function isCollapsed(id: string): boolean {
  return collapsed.value.has(id);
}

function toggleGroup(id: string) {
  const next = new Set(collapsed.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  collapsed.value = next;
}

function toggle(key: string, on: boolean) {
  const next = new Set(selected.value);
  if (on) next.add(key);
  else next.delete(key);
  selected.value = next;
}

function setGroup(group: Group, on: boolean) {
  const next = new Set(selected.value);
  for (const r of group.rows) {
    if (on) next.add(r.key);
    else next.delete(r.key);
  }
  selected.value = next;
}

/** Tri-state: all ticked, some ticked, or none. */
function groupState(group: Group): boolean | 'mixed' {
  const { ticked, total } = group.counter;
  return ticked === 0 ? false : ticked === total ? true : 'mixed';
}

/** `indeterminate` is a DOM property, not an attribute, so it has to be assigned. */
function setIndeterminate(el: unknown, value: boolean): void {
  if (el instanceof HTMLInputElement) el.indeterminate = value;
}

const counts = computed(() => {
  const chosen = props.request.items.filter((i) => selected.value.has(keyOf(i)));
  return {
    designTables: chosen.filter((i) => i.kind === 'design-table').length,
    dbTables: chosen.filter((i) => i.kind === 'db-table').length,
    diagrams: chosen.filter((i) => i.kind === 'diagram').length,
  };
});

const totalTables = computed(() => counts.value.designTables + counts.value.dbTables);
const estimate = computed(() => counts.value.designTables * 900 + counts.value.dbTables * 900 + counts.value.diagrams * 1200);
const sizeText = computed(() =>
  estimate.value < 1024 ? `${estimate.value} B` : estimate.value < 1024 * 1024 ? `${(estimate.value / 1024).toFixed(1)} KB` : `${(estimate.value / 1024 / 1024).toFixed(1)} MB`,
);

function pickPath() {
  post({ type: 'export/pickPath', requestId });
}

/** Called when the host answers a path pick or finishes a run. */
function applyResult(result: { path?: string; message?: string; error?: string }) {
  if (result.path) {
    path.value = result.path;
    return;
  }
  if (result.error) {
    busy.value = false;
    emit('done', result.error);
    return;
  }
  if (result.message) {
    busy.value = false;
    emit('close');
  }
}

defineExpose({ applyResult });

function run() {
  busy.value = true;
  post({ type: 'export/run', requestId, keys: [...selected.value], path: path.value });
}
</script>

<template>
  <div class="backdrop" @pointerdown.self="emit('close')">
    <div class="dialog" role="dialog" aria-label="导出">
      <header>
        <strong>导出</strong>
        <span class="muted">{{ request.designName }}</span>
        <button class="icon-btn" title="关闭" @click="emit('close')">✕</button>
      </header>

      <div class="toolbar">
        <input v-model="search" placeholder="搜索表名、图名或数据库" />
      </div>

      <div class="tree">
        <div v-for="group in groups" :key="group.id" class="group">
          <div class="row level">
            <button class="twisty" @click="toggleGroup(group.id)">{{ isCollapsed(group.id) ? '▸' : '▾' }}</button>
            <input
              :ref="(el) => setIndeterminate(el, groupState(group) === 'mixed')"
              type="checkbox"
              :checked="groupState(group) === true"
              @change="setGroup(group, groupState(group) !== true)"
            />
            <span class="group-title">{{ group.title }}</span>
            <span class="muted count">{{ group.counter.ticked }} / {{ group.counter.total }}</span>
          </div>
          <template v-if="!isCollapsed(group.id)">
            <div v-for="row in group.rows" :key="row.key" class="row item">
              <label>
                <input type="checkbox" :checked="selected.has(row.key)" @change="toggle(row.key, ($event.target as HTMLInputElement).checked)" />
                {{ row.label }}
              </label>
              <span class="muted hint" :title="row.hint">{{ row.hint }}</span>
            </div>
          </template>
        </div>
        <p v-if="!groups.length" class="muted empty">没有匹配的内容。</p>
      </div>

      <div class="path-row">
        <span>路径</span>
        <input v-model="path" spellcheck="false" />
        <button class="secondary small" @click="pickPath">📁 选目录</button>
      </div>
      <p class="muted note">会在这个目录下新建一个带时间戳的文件夹。只导出数据模型，不含任何连接信息；表和字段的注释会一并导出。</p>

      <footer>
        <span class="muted">
          已选：{{ totalTables }} 张表 · {{ counts.diagrams }} 张设计图 · 约 {{ sizeText }}
        </span>
        <span class="grow" />
        <button class="secondary" @click="emit('close')">取消</button>
        <button :disabled="!totalTables && !counts.diagrams" :title="totalTables || counts.diagrams ? '' : '先勾选要导出的内容'" @click="run">
          {{ busy ? '导出中…' : '导出' }}
        </button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  z-index: 300;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgb(0 0 0 / 45%);
}

.dialog {
  display: flex;
  flex-direction: column;
  width: min(820px, 92vw);
  max-height: 82vh;
  border: 1px solid var(--hn-border);
  border-radius: 5px;
  background: var(--hn-node-bg);
  box-shadow: 0 10px 30px rgb(0 0 0 / 45%);
}

header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--hn-border);
}

header .grow,
header .muted {
  flex: 1;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px 4px;
}

.toolbar input {
  flex: 1;
}

.tree {
  flex: 1;
  overflow: auto;
  padding: 4px 0;
  border-top: 1px solid var(--hn-border);
  border-bottom: 1px solid var(--hn-border);
}

.row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 10px 2px 0;
}

.row label {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  cursor: pointer;
}

.row.level {
  padding-top: 4px;
  padding-bottom: 4px;
  font-weight: 600;
  background: var(--hn-node-header);
}

.row.item:hover {
  background: color-mix(in srgb, var(--hn-accent) 10%, transparent);
}

.twisty {
  width: 16px;
  padding: 0;
  color: var(--hn-muted);
  background: transparent;
  font-size: 10px;
}

.group-title {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.count {
  font-size: 11px;
  font-weight: 400;
}

.hint {
  margin-left: auto;
  overflow: hidden;
  font-size: 11px;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.empty {
  padding: 12px 10px;
}

.path-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px 0;
}

.path-row input {
  flex: 1;
  font-size: 11px;
}

.note {
  padding: 4px 10px 8px;
  font-size: 11px;
}

footer {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border-top: 1px solid var(--hn-border);
  font-size: 11px;
}

.grow {
  flex: 1;
}
</style>

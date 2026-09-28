<script setup lang="ts">
import { computed, ref } from 'vue';
import { nodeId } from '@shared/canvas';
import type { DiffItem, DiffKind } from '@shared/model';
import type { CanvasView } from '../canvas/viewModel';
import { acceptDiff, canvas, focusNode, state } from '../store';

const props = defineProps<{ view: CanvasView }>();

const KIND_LABELS: Record<DiffKind, string> = {
  table_missing_in_db: '表：设计有，数据库没有',
  table_missing_in_design: '表：数据库有，设计没有',
  column_missing_in_db: '字段：设计有，数据库没有',
  column_missing_in_design: '字段：数据库有，设计没有',
  column_mismatch: '字段：两边不一致',
  relation_missing_in_db: '外键：设计有，数据库没有',
  relation_missing_in_design: '关系：数据库有，设计没有',
};

const onlyOnCanvas = ref(false);
const hideAccepted = ref(false);

const comparison = computed(() => canvas.value.comparison);
const shown = computed(() => new Set(props.view.tables.map((t) => t.id)));

function designSide(item: DiffItem): boolean {
  return item.kind !== 'table_missing_in_design';
}

function targetNode(item: DiffItem): string | undefined {
  const c = comparison.value;
  if (!c) return undefined;
  const design = nodeId(c.design, item.table);
  const db = nodeId(c.db, item.dbTable ?? state.comparison?.tableMappings[item.table] ?? item.table);
  if (designSide(item) && shown.value.has(design)) return design;
  if (shown.value.has(db)) return db;
  return shown.value.has(design) ? design : undefined;
}

const items = computed(() =>
  (state.comparison?.diff.items ?? []).filter((i) => (!onlyOnCanvas.value || targetNode(i)) && (!hideAccepted.value || !i.accepted)),
);

const groups = computed(() => {
  const byKind = new Map<DiffKind, DiffItem[]>();
  for (const item of items.value) byKind.set(item.kind, [...(byKind.get(item.kind) ?? []), item]);
  return (Object.keys(KIND_LABELS) as DiffKind[]).filter((k) => byKind.has(k)).map((k) => ({ kind: k, label: KIND_LABELS[k], items: byKind.get(k)! }));
});

const openCount = computed(() => (state.comparison?.diff.items ?? []).filter((i) => !i.accepted).length);

function focus(item: DiffItem) {
  const id = targetNode(item);
  if (!id) return;
  focusNode(id, item.column);
  state.selection = item.column ? { type: 'column', nodeId: id, column: item.column } : { type: 'table', nodeId: id };
}
</script>

<template>
  <div class="diff-panel">
    <p v-if="!comparison" class="muted hint">画布没有开启对比。在工具栏的“对比”里选择一个设计库和一个数据库。</p>
    <p v-else-if="!state.comparison" class="muted hint">对比的数据源还没有加载完成，或者数据库还没有快照。</p>
    <template v-else>
      <div class="summary">
        <span>未处理 {{ openCount }} 项，共 {{ state.comparison.diff.items.length }} 项</span>
      </div>
      <div class="filters">
        <label><input v-model="onlyOnCanvas" type="checkbox" /> 只看画布上的表</label>
        <label><input v-model="hideAccepted" type="checkbox" /> 隐藏已确认</label>
      </div>
      <p v-if="!state.comparison.diff.items.length" class="muted hint">设计库和数据库一致。</p>
      <p v-else-if="!items.length" class="muted hint">没有符合筛选条件的差异。</p>
      <section v-for="g in groups" :key="g.kind">
        <h4>{{ g.label }} <span class="count">{{ g.items.length }}</span></h4>
        <ul>
          <li v-for="item in g.items" :key="item.id" :class="{ accepted: item.accepted }">
            <a href="#" :class="{ disabled: !targetNode(item) }" :title="targetNode(item) ? '在画布中定位' : '这张表不在画布上'" @click.prevent="focus(item)">
              {{ item.message }}
            </a>
            <button v-if="!item.accepted" class="secondary" title="标记为有意的偏差，之后不再计入" @click="acceptDiff(item.id, true)">确认</button>
            <button v-else class="secondary" title="取消确认" @click="acceptDiff(item.id, false)">撤销确认</button>
          </li>
        </ul>
      </section>
    </template>
  </div>
</template>

<style scoped>
.diff-panel {
  padding: 8px 10px;
}

.summary {
  font-weight: 600;
}

.filters {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin: 6px 0;
  color: var(--hn-muted);
  font-size: 11px;
}

.filters label {
  display: flex;
  align-items: center;
  gap: 4px;
}

h4 {
  margin: 12px 0 6px;
  color: var(--hn-muted);
  font-size: 12px;
}

.count {
  margin-left: 4px;
  padding: 0 6px;
  border-radius: 8px;
  background: var(--hn-node-header);
}

ul {
  margin: 0;
  padding: 0;
  list-style: none;
}

li {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 0;
  border-bottom: 1px solid color-mix(in srgb, var(--hn-border) 50%, transparent);
}

li.accepted a {
  color: var(--hn-muted);
  text-decoration: line-through;
}

a {
  color: var(--vscode-textLink-foreground, #3794ff);
  text-decoration: none;
  word-break: break-all;
}

a.disabled {
  color: var(--hn-fg);
  cursor: default;
}

button {
  flex-shrink: 0;
  padding: 1px 8px;
  font-size: 11px;
}

.hint {
  padding: 4px 0;
}
</style>

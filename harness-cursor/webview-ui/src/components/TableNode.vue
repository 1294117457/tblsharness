<script setup lang="ts">
import { computed } from 'vue';
import { Handle, Position } from '@vue-flow/core';
import { TABLE_HANDLE, type TableView } from '../canvas/viewModel';
import { HEADER_HEIGHT, NODE_WIDTH, ROW_HEIGHT } from '../canvas/layout';
import { state } from '../store';

const props = defineProps<{ data: TableView; selected?: boolean }>();

const selectedColumn = computed(() =>
  state.selection?.type === 'column' && state.selection.nodeId === props.data.id ? state.selection.column : undefined,
);

function selectColumn(column: string) {
  state.selection = { type: 'column', nodeId: props.data.id, column };
}

const hiddenCount = computed(() => props.data.columns.length - props.data.visibleColumns.length);
</script>

<template>
  <div
    class="table-node"
    :class="[data.mark && `mark-${data.mark}`, `source-${data.sourceKind}`, { selected, view: data.isView, missing: data.missing }]"
    :style="{ width: `${NODE_WIDTH}px` }"
    :title="data.note ?? data.comment"
  >
    <div class="header" :style="{ height: `${HEADER_HEIGHT}px` }">
      <Handle :id="`${TABLE_HANDLE}:t`" type="target" :position="Position.Left" class="handle" :connectable="false" />
      <span class="name">{{ data.key }}</span>
      <span class="badge" :title="data.sourceKind === 'db' ? '数据库（只读）' : '设计库'">
        <span v-if="data.sourceKind === 'db'" class="lock">🔒</span>{{ data.sourceName }}
      </span>
      <Handle :id="`${TABLE_HANDLE}:s`" type="source" :position="Position.Right" class="handle" :connectable="false" />
    </div>
    <div v-if="data.missing" class="missing-note">数据源中已没有这张表</div>
    <div
      v-for="col in data.visibleColumns"
      :key="col.name"
      class="row"
      :class="[col.mark && `mark-${col.mark}`, { active: selectedColumn === col.name, 'from-db': col.fromDb }]"
      :style="{ height: `${ROW_HEIGHT}px` }"
      :title="col.note ?? col.comment"
      @click.stop="selectColumn(col.name)"
    >
      <Handle :id="`${col.name}:t`" type="target" :position="Position.Left" class="handle" :connectable="data.editable" />
      <span class="icon">{{ col.primaryKey ? '🔑' : col.foreignKey ? '🔗' : col.unique ? 'U' : '' }}</span>
      <span class="col-name" :class="{ required: !col.nullable }">{{ col.name }}</span>
      <span class="col-type">{{ col.type }}</span>
      <Handle :id="`${col.name}:s`" type="source" :position="Position.Right" class="handle" :class="{ connectable: data.editable }" :connectable="data.editable" />
    </div>
    <div v-if="hiddenCount > 0" class="more">另有 {{ hiddenCount }} 个字段未显示</div>
  </div>
</template>

<style scoped>
.table-node {
  background: var(--hn-node-bg);
  border: 1px solid var(--hn-border);
  border-radius: 4px;
  box-shadow: 0 2px 6px rgb(0 0 0 / 25%);
  overflow: hidden;
  font-size: 12px;
}

.table-node.selected {
  outline: 2px solid var(--hn-accent);
}

.table-node.missing {
  opacity: 0.55;
  border-style: dashed;
}

.table-node.view .name {
  font-style: italic;
}

.header {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding: 0 8px;
  font-weight: 600;
}

.source-design .header {
  background: var(--hn-design-header);
}

.source-db .header {
  background: var(--hn-db-header);
}

.name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.badge {
  flex-shrink: 0;
  max-width: 45%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10px;
  font-weight: 400;
  color: var(--hn-muted);
}

.lock {
  margin-right: 2px;
  font-size: 9px;
}

.missing-note,
.more {
  padding: 3px 8px;
  color: var(--hn-muted);
  font-size: 11px;
}

.row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 8px;
  border-top: 1px solid color-mix(in srgb, var(--hn-border) 50%, transparent);
  cursor: default;
}

.row.active {
  background: color-mix(in srgb, var(--hn-accent) 22%, transparent);
}

.row.from-db .col-name {
  font-style: italic;
}

.icon {
  width: 14px;
  font-size: 10px;
  text-align: center;
  color: var(--hn-muted);
}

.col-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.col-name.required {
  font-weight: 600;
}

.col-type {
  max-width: 45%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--hn-muted);
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 11px;
}

.handle {
  width: 8px;
  height: 8px;
  min-width: 0;
  min-height: 0;
  border: none;
  background: transparent;
}

.table-node:hover .handle.connectable {
  background: var(--hn-accent);
  opacity: 0.7;
}

.mark-design-only {
  border-color: var(--hn-missing);
  background: color-mix(in srgb, var(--hn-missing) 12%, transparent);
}

.mark-db-only {
  border-color: var(--hn-db-only);
  background: color-mix(in srgb, var(--hn-db-only) 14%, transparent);
}

.mark-mismatch {
  border-color: var(--hn-mismatch);
  background: color-mix(in srgb, var(--hn-mismatch) 14%, transparent);
}

.mark-accepted {
  opacity: 0.55;
}

.table-node.mark-design-only,
.table-node.mark-db-only,
.table-node.mark-mismatch {
  border-style: dashed;
  border-width: 2px;
}
</style>

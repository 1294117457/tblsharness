<script setup lang="ts">
import type { PartitionView } from '../canvas/viewModel';
import { PART_HEADER } from '../canvas/layout';

defineProps<{ data: PartitionView; selected?: boolean; current?: boolean; dropTarget?: boolean }>();
const emit = defineEmits<{
  focus: [id: string];
  toggle: [id: string];
}>();
</script>

<template>
  <div
    class="partition"
    :class="{ selected, current, collapsed: data.collapsed, 'drop-target': dropTarget, [`depth-${Math.min(data.depth, 4)}`]: true }"
    :style="{ width: `${data.width}px`, height: `${data.height}px` }"
  >
    <div class="header" :style="{ height: `${PART_HEADER}px` }" :title="data.description ? `${data.name}\n${data.description}` : `${data.name}（双击标题聚焦）`">
      <button class="twisty nodrag" :title="data.collapsed ? '展开' : '折叠'" @click.stop="emit('toggle', data.id)" @dblclick.stop>{{ data.collapsed ? '▸' : '▾' }}</button>
      <span class="name">{{ data.name }}</span>
      <span v-if="data.namespace" class="ns" :title="data.namespaceInherited ? '命名空间（继承自上级分区画布）' : '命名空间'">{{ data.namespace }}{{ data.namespaceInherited ? '（继承）' : '' }}</span>
      <span class="counts">{{ data.counts.tables }} 表 · {{ data.counts.diagrams }} 图<template v-if="data.counts.partitions"> · {{ data.counts.partitions }} 分区</template></span>
      <button class="focus nodrag" title="聚焦：缩放视图到这个分区画布（F）" @click.stop="emit('focus', data.id)" @dblclick.stop>⤢</button>
    </div>
  </div>
</template>

<style scoped>
.partition {
  --part-color: var(--hn-accent);
  box-sizing: border-box;
  border: 1.5px dashed color-mix(in srgb, var(--part-color) 70%, transparent);
  border-radius: 8px;
  background: color-mix(in srgb, var(--part-color) 5%, transparent);
}

.partition.depth-2 {
  background: color-mix(in srgb, var(--part-color) 8%, transparent);
}

.partition.depth-3,
.partition.depth-4 {
  background: color-mix(in srgb, var(--part-color) 11%, transparent);
}

.partition.selected {
  border-style: solid;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--part-color) 30%, transparent);
}

/* The current level: where creating and pasting go. */
.partition.current:not(.collapsed) {
  border-style: solid;
  background: color-mix(in srgb, var(--part-color) 9%, transparent);
}

.partition.drop-target {
  border-style: solid;
  border-width: 2px;
  background: color-mix(in srgb, var(--part-color) 16%, transparent);
}

.partition.collapsed {
  border-style: solid;
  background: var(--hn-node-bg);
}

.header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 8px 0 4px;
  color: var(--part-color);
  font-size: 12px;
  cursor: grab;
  user-select: none;
}

.twisty,
.focus {
  padding: 0 4px;
  color: inherit;
  background: transparent;
}

.focus {
  opacity: 0;
}

.header:hover .focus,
.partition.selected .focus {
  opacity: 0.7;
}

.focus:hover {
  opacity: 1 !important;
}

.name {
  overflow: hidden;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ns {
  padding: 0 4px;
  border-radius: 3px;
  background: color-mix(in srgb, var(--hn-muted) 20%, transparent);
  color: var(--hn-muted);
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 10px;
  white-space: nowrap;
}

.counts {
  margin-left: auto;
  color: var(--hn-muted);
  font-size: 11px;
  white-space: nowrap;
}
</style>

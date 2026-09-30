<script setup lang="ts">
import { ref } from 'vue';
import { diagramTypeLabel } from '@shared/diagram';
import type { DiagramView } from '../canvas/viewModel';
import MermaidPreview from '../diagram/MermaidPreview.vue';

const MIN_WIDTH = 200;
const MIN_HEIGHT = 120;

const props = defineProps<{ data: DiagramView; selected?: boolean }>();
const emit = defineEmits<{
  resize: [payload: { id: string; width: number; height: number }];
  pending: [id: string];
}>();

const draft = ref<{ width: number; height: number }>();
let start = { x: 0, y: 0, width: 0, height: 0, zoom: 1 };

function onResizeStart(e: PointerEvent) {
  e.stopPropagation();
  e.preventDefault();
  const el = (e.currentTarget as HTMLElement).parentElement!;
  const zoom = el.getBoundingClientRect().width / props.data.width || 1;
  start = { x: e.clientX, y: e.clientY, width: props.data.width, height: props.data.height, zoom };
  draft.value = { width: props.data.width, height: props.data.height };
  document.addEventListener('pointermove', onResizeMove);
  document.addEventListener('pointerup', onResizeEnd);
}

function onResizeMove(e: PointerEvent) {
  draft.value = {
    width: Math.max(MIN_WIDTH, start.width + (e.clientX - start.x) / start.zoom),
    height: Math.max(MIN_HEIGHT, start.height + (e.clientY - start.y) / start.zoom),
  };
}

function onResizeEnd() {
  document.removeEventListener('pointermove', onResizeMove);
  document.removeEventListener('pointerup', onResizeEnd);
  const d = draft.value;
  draft.value = undefined;
  if (d && (Math.round(d.width) !== props.data.width || Math.round(d.height) !== props.data.height)) {
    emit('resize', { id: props.data.id, width: Math.round(d.width), height: Math.round(d.height) });
  }
}
</script>

<template>
  <div
    class="diagram-card"
    :class="{ selected }"
    :style="{ width: `${draft?.width ?? data.width}px`, height: `${draft?.height ?? data.height}px` }"
    title="双击打开设计图编辑器"
  >
    <div class="header">
      <span class="name">{{ data.name }}</span>
      <span class="type">{{ diagramTypeLabel(data.type) }}</span>
      <button v-if="data.pending" class="pending nodrag" title="ER 图和表结构不一致，点击查看待同步内容" @click.stop="emit('pending', data.id)" @dblclick.stop>
        待同步 {{ data.pending }}
      </button>
    </div>
    <div class="body">
      <MermaidPreview :code="data.code" compact />
    </div>
    <div class="resize nodrag" title="拖动调整大小" @pointerdown="onResizeStart" />
  </div>
</template>

<style scoped>
.diagram-card {
  position: relative;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  border: 1px solid var(--hn-border);
  border-radius: 4px;
  background: var(--hn-node-bg);
  box-shadow: 0 2px 6px rgb(0 0 0 / 25%);
  overflow: hidden;
  font-size: 12px;
}

.diagram-card.selected {
  outline: 2px solid var(--hn-accent);
}

.header {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 8px;
  background: var(--hn-node-header);
  font-weight: 600;
}

.name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.type {
  flex-shrink: 0;
  color: var(--hn-muted);
  font-size: 10px;
  font-weight: 400;
}

.pending {
  flex-shrink: 0;
  margin-left: auto;
  padding: 0 6px;
  border-radius: 8px;
  background: var(--hn-mismatch);
  color: var(--hn-bg);
  font-size: 11px;
}

.body {
  flex: 1;
  min-height: 0;
}

.resize {
  position: absolute;
  right: 0;
  bottom: 0;
  width: 12px;
  height: 12px;
  cursor: se-resize;
  background: linear-gradient(135deg, transparent 50%, var(--hn-muted) 50%);
  opacity: 0.4;
}

.diagram-card:hover .resize {
  opacity: 0.8;
}
</style>

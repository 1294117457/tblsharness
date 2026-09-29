<script setup lang="ts">
import { ref } from 'vue';
import type { ZoneView } from '../canvas/viewModel';

const RESIZE_HANDLE_SIZE = 12;
const MIN_SIZE = 120;

const props = defineProps<{ data: ZoneView; selected?: boolean }>();
const emit = defineEmits<{
  resize: [payload: { id: string; width: number; height: number; dx: number; dy: number }];
  'rename-zone': [id: string];
}>();

const resizing = ref(false);
let startX = 0;
let startY = 0;
let startW = 0;
let startH = 0;
let corner: 'se' | 'sw' | 'ne' | 'nw' = 'se';

function onResizeStart(e: PointerEvent, c: typeof corner) {
  e.stopPropagation();
  e.preventDefault();
  corner = c;
  startX = e.clientX;
  startY = e.clientY;
  startW = props.data.width;
  startH = props.data.height;
  resizing.value = true;
  document.addEventListener('pointermove', onResizeMove);
  document.addEventListener('pointerup', onResizeEnd);
}

function onResizeMove(e: PointerEvent) {
  const rawDx = e.clientX - startX;
  const rawDy = e.clientY - startY;
  let w = startW;
  let h = startH;
  let dx = 0;
  let dy = 0;
  if (corner === 'se' || corner === 'ne') w = Math.max(MIN_SIZE, startW + rawDx);
  if (corner === 'sw' || corner === 'nw') {
    w = Math.max(MIN_SIZE, startW - rawDx);
    dx = startW - w;
  }
  if (corner === 'se' || corner === 'sw') h = Math.max(MIN_SIZE, startH + rawDy);
  if (corner === 'ne' || corner === 'nw') {
    h = Math.max(MIN_SIZE, startH - rawDy);
    dy = startH - h;
  }
  emit('resize', { id: props.data.id, width: Math.round(w), height: Math.round(h), dx: Math.round(dx), dy: Math.round(dy) });
}

function onResizeEnd() {
  resizing.value = false;
  document.removeEventListener('pointermove', onResizeMove);
  document.removeEventListener('pointerup', onResizeEnd);
}

function onDoubleClickTitle() {
  emit('rename-zone', props.data.id);
}
</script>

<template>
  <div
    class="zone-node"
    :class="{ selected, resizing }"
    :style="{
      width: `${data.width}px`,
      height: `${data.height}px`,
      '--zone-color': data.color ?? 'var(--hn-accent)',
    }"
  >
    <div class="zone-header" @dblclick="onDoubleClickTitle">
      <span class="zone-name">{{ data.name }}</span>
      <span v-if="data.viewpoint" class="zone-badge">模块</span>
      <span class="zone-count">{{ data.tableCount }}</span>
    </div>
    <div
      v-for="c in (['se', 'sw', 'ne', 'nw'] as const)"
      :key="c"
      class="resize-handle"
      :class="c"
      :style="{ width: `${RESIZE_HANDLE_SIZE}px`, height: `${RESIZE_HANDLE_SIZE}px` }"
      @pointerdown="(e) => onResizeStart(e, c)"
    />
  </div>
</template>

<style scoped>
.zone-node {
  border: 2px dashed var(--zone-color);
  border-radius: 8px;
  background: color-mix(in srgb, var(--zone-color) 6%, transparent);
  pointer-events: all;
  position: relative;
}

.zone-node.selected {
  border-style: solid;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--zone-color) 30%, transparent);
}

.zone-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  font-size: 12px;
  color: var(--zone-color);
  cursor: grab;
  user-select: none;
}

.zone-name {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.zone-badge {
  font-size: 10px;
  padding: 0 4px;
  border: 1px solid var(--zone-color);
  border-radius: 4px;
  opacity: 0.7;
}

.zone-count {
  margin-left: auto;
  opacity: 0.5;
  font-size: 11px;
}

.resize-handle {
  position: absolute;
  opacity: 0;
  transition: opacity 0.15s;
}

.zone-node:hover .resize-handle,
.zone-node.selected .resize-handle {
  opacity: 1;
  background: var(--zone-color);
  border-radius: 3px;
}

.resize-handle.se {
  bottom: -2px;
  right: -2px;
  cursor: se-resize;
}
.resize-handle.sw {
  bottom: -2px;
  left: -2px;
  cursor: sw-resize;
}
.resize-handle.ne {
  top: -2px;
  right: -2px;
  cursor: ne-resize;
}
.resize-handle.nw {
  top: -2px;
  left: -2px;
  cursor: nw-resize;
}

.resizing {
  cursor: default;
}
</style>

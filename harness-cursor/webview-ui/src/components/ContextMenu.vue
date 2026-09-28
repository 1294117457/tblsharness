<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue';

export interface MenuItem {
  label?: string;
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  separator?: boolean;
  action?: () => void;
}

const props = defineProps<{ x: number; y: number; title?: string; items: MenuItem[] }>();
const emit = defineEmits<{ close: [] }>();

const el = ref<HTMLElement>();
const pos = ref({ left: props.x, top: props.y });

function run(item: MenuItem) {
  if (item.disabled || item.separator) return;
  emit('close');
  item.action?.();
}

function onPointerDown(e: PointerEvent) {
  if (el.value && !el.value.contains(e.target as Node)) emit('close');
}

function onKeyDown(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close');
}

onMounted(async () => {
  await nextTick();
  const rect = el.value?.getBoundingClientRect();
  if (rect) {
    pos.value = {
      left: Math.max(4, Math.min(props.x, window.innerWidth - rect.width - 4)),
      top: Math.max(4, Math.min(props.y, window.innerHeight - rect.height - 4)),
    };
  }
  window.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('keydown', onKeyDown, true);
});

onBeforeUnmount(() => {
  window.removeEventListener('pointerdown', onPointerDown, true);
  window.removeEventListener('keydown', onKeyDown, true);
});
</script>

<template>
  <div ref="el" class="context-menu" :style="{ left: `${pos.left}px`, top: `${pos.top}px` }" @contextmenu.prevent>
    <div v-if="title" class="title">{{ title }}</div>
    <template v-for="(item, i) in items" :key="i">
      <div v-if="item.separator" class="sep" />
      <button v-else class="item" :class="{ danger: item.danger }" :disabled="item.disabled" @click="run(item)">
        <span>{{ item.label }}</span>
        <span v-if="item.hint" class="hint">{{ item.hint }}</span>
      </button>
    </template>
  </div>
</template>

<style scoped>
.context-menu {
  position: fixed;
  z-index: 100;
  min-width: 180px;
  padding: 4px;
  border: 1px solid var(--vscode-menu-border, var(--hn-border));
  border-radius: 4px;
  background: var(--vscode-menu-background, var(--hn-node-bg));
  box-shadow: 0 4px 12px rgb(0 0 0 / 35%);
}

.title {
  padding: 4px 8px;
  color: var(--hn-muted);
  font-size: 11px;
}

.item {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  width: 100%;
  padding: 4px 8px;
  border-radius: 3px;
  color: var(--vscode-menu-foreground, var(--hn-fg));
  background: transparent;
  text-align: left;
}

.item:hover:not(:disabled) {
  color: var(--vscode-menu-selectionForeground, var(--hn-fg));
  background: var(--vscode-menu-selectionBackground, var(--hn-button-bg));
}

.item:disabled {
  opacity: 0.45;
  cursor: default;
}

.item.danger {
  color: var(--hn-missing);
}

.hint {
  color: var(--hn-muted);
}

.sep {
  margin: 4px 0;
  border-top: 1px solid var(--vscode-menu-separatorBackground, var(--hn-border));
}
</style>

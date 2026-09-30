<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue';
import { loadMermaid, shortError } from './mermaid';

/** `compact`: no zoom bar, the diagram shrinks to fit (canvas cards). */
const props = defineProps<{ code: string; compact?: boolean }>();

const svg = ref('');
const error = ref('');
const rendering = ref(false);
const zoom = ref(1);

let seq = 0;
const uid = Math.random().toString(36).slice(2, 8);
let timer: ReturnType<typeof setTimeout> | undefined;

async function render(code: string) {
  const mine = ++seq;
  if (!code.trim()) {
    svg.value = '';
    error.value = '';
    return;
  }
  rendering.value = true;
  try {
    const m = await loadMermaid();
    const out = await m.render(`hn-mermaid-${uid}-${mine}`, code);
    if (mine !== seq) return;
    svg.value = out.svg;
    error.value = '';
  } catch (err) {
    if (mine !== seq) return;
    error.value = shortError(err);
    document.getElementById(`dhn-mermaid-${uid}-${mine}`)?.remove();
  } finally {
    if (mine === seq) rendering.value = false;
  }
}

watch(
  () => props.code,
  (code) => {
    clearTimeout(timer);
    timer = setTimeout(() => void render(code), 350);
  },
);

onMounted(() => void render(props.code));
onUnmounted(() => clearTimeout(timer));
</script>

<template>
  <div class="preview" :class="{ compact }">
    <div v-if="!compact" class="zoom">
      <button class="secondary small" title="缩小" @click="zoom = Math.max(0.2, zoom - 0.1)">−</button>
      <span class="muted">{{ Math.round(zoom * 100) }}%</span>
      <button class="secondary small" title="放大" @click="zoom = Math.min(3, zoom + 0.1)">+</button>
      <button class="secondary small" @click="zoom = 1">100%</button>
      <span v-if="rendering" class="muted">渲染中…</span>
    </div>
    <pre v-if="error" class="error">Mermaid 语法错误：{{ error }}</pre>
    <div class="canvas" :class="{ stale: !!error }">
      <!-- eslint-disable-next-line vue/no-v-html -- mermaid output, rendered with securityLevel strict -->
      <div class="svg" :style="compact ? undefined : { transform: `scale(${zoom})` }" v-html="svg" />
      <p v-if="!svg && !error" class="muted empty">{{ compact ? '（空白设计图，双击在右侧编辑）' : '在左侧写 Mermaid，这里会显示预览。' }}</p>
    </div>
  </div>
</template>

<style scoped>
.preview {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.zoom {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border-bottom: 1px solid var(--hn-border);
}

.canvas {
  flex: 1;
  overflow: auto;
  padding: 16px;
}

.canvas.stale {
  opacity: 0.45;
}

.svg {
  transform-origin: 0 0;
}

.error {
  margin: 0;
  padding: 6px 10px;
  border-bottom: 1px solid var(--hn-border);
  color: var(--hn-missing);
  white-space: pre-wrap;
  font-size: 12px;
}

.empty {
  text-align: center;
}

.compact .canvas {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 6px;
  overflow: hidden;
}

.compact .svg :deep(svg) {
  display: block;
  max-width: 100%;
  max-height: 100%;
  height: auto;
}

.compact .svg {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
}

.compact .error {
  padding: 4px 6px;
  font-size: 11px;
}
</style>

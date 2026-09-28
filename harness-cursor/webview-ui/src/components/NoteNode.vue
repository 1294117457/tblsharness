<script setup lang="ts">
import { ref, watch } from 'vue';
import type { CanvasNote } from '@shared/canvas';
import { editCanvas } from '../store';

const props = defineProps<{ data: CanvasNote; selected?: boolean }>();
const text = ref(props.data.text);

watch(
  () => props.data.text,
  (t) => (text.value = t),
);

function commit() {
  if (text.value !== props.data.text) {
    editCanvas('编辑便签', [{ op: 'note.put', note: { ...props.data, text: text.value } }]);
  }
}
</script>

<template>
  <div class="note" :class="{ selected }" :style="{ width: `${data.width}px` }">
    <textarea v-model="text" class="nodrag" rows="3" placeholder="输入注释…" @blur="commit" @keydown.stop />
  </div>
</template>

<style scoped>
.note {
  padding: 6px;
  border-radius: 4px;
  background: var(--hn-note-bg);
  box-shadow: 0 2px 6px rgb(0 0 0 / 25%);
}

.note.selected {
  outline: 2px solid var(--hn-accent);
}

textarea {
  box-sizing: border-box;
  width: 100%;
  min-height: 48px;
  border: none;
  outline: none;
  resize: vertical;
  background: transparent;
  color: var(--hn-note-fg);
  font: inherit;
  font-size: 12px;
}
</style>

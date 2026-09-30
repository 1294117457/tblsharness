<script setup lang="ts">
import type { ItemRef } from '@shared/canvas';
import { focusItems } from '../store';

defineProps<{ item: ItemRef }>();
</script>

<template>
  <button class="focus-btn nodrag" title="聚焦：缩放视图到这里（F）" @click.stop="focusItems([item])" @dblclick.stop @pointerdown.stop>⤢</button>
</template>

<style scoped>
.focus-btn {
  flex-shrink: 0;
  padding: 0 4px;
  border-radius: 3px;
  background: var(--hn-accent);
  color: var(--hn-accent-fg, #fff);
  font-size: 12px;
  line-height: 18px;
}
</style>

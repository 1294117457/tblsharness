<script setup lang="ts">
import { computed } from 'vue';
import { DESIGN_SOURCE, nodeId } from '@shared/canvas';
import { diagramTypeLabel } from '@shared/diagram';
import type { CanvasView } from '../canvas/viewModel';
import { canvas, editCanvas, reveal, state } from '../store';

/** What one level holds directly; clicking an entry selects it and zooms to it. */
const props = defineProps<{ level: string | undefined; view: CanvasView }>();

interface Entry {
  key: string;
  icon: string;
  label: string;
  /** Namespace shown before the name. */
  ns?: string;
  /** Grey note after the name. */
  tag?: string;
  hint?: string;
  hidden?: boolean;
  open: () => void;
}

const entries = computed<Entry[]>(() => {
  const own = props.view.levels.get(props.level ?? '');
  const out: Entry[] = [];
  for (const p of canvas.value.partitions) {
    if (p.parent !== props.level) continue;
    out.push({ key: `part:${p.id}`, icon: '▣', label: p.name, hint: p.description, open: () => reveal({ item: { kind: 'partition', id: p.id } }) });
  }
  for (const t of own?.tables ?? []) {
    const id = nodeId(DESIGN_SOURCE, t.key);
    out.push({
      key: id,
      icon: '▦',
      label: t.displayName,
      ns: t.namespaceTag,
      hint: [t.namespaceTag ? `真实表名：${t.key}` : '', t.comment ?? ''].filter(Boolean).join('\n') || undefined,
      hidden: t.hidden,
      open: () => {
        if (t.hidden) editCanvas(`显示表 ${t.key}`, [{ op: 'hidden.set', items: [{ kind: 'table', id }], hidden: false }]);
        reveal({ item: { kind: 'table', id } });
      },
    });
  }
  for (const d of own?.diagrams ?? []) {
    out.push({ key: `diagram:${d.id}`, icon: '◇', label: d.name, tag: diagramTypeLabel(d.type), hidden: d.hidden, open: () => reveal({ item: { kind: 'diagram', id: d.id } }) });
  }
  for (const [src, keys] of Object.entries(own?.db ?? {})) {
    const name = state.sources[src]?.name ?? src;
    for (const key of [...keys].sort()) {
      out.push({ key: nodeId(src, key), icon: '🗄', label: key, hint: `数据库表 · ${name}`, open: () => reveal({ item: { kind: 'table', id: nodeId(src, key) } }) });
    }
  }
  for (const n of canvas.value.notes) {
    if (n.partition !== props.level) continue;
    const first = n.text.split('\n')[0].trim();
    out.push({ key: `note:${n.id}`, icon: '✎', label: first || '（空便签）', hint: n.text || undefined, open: () => reveal({ item: { kind: 'note', id: n.id } }) });
  }
  return out;
});
</script>

<template>
  <div class="level-contents">
    <p v-if="!entries.length" class="muted empty">这一层还是空的。</p>
    <ul v-else>
      <li v-for="e in entries" :key="e.key" :class="{ off: e.hidden }" :title="e.hint" @click="e.open()">
        <span class="icon">{{ e.icon }}</span>
        <span class="label"><span v-if="e.ns" class="ns">{{ e.ns }}</span>{{ e.label }}</span>
        <span v-if="e.tag" class="muted tag">{{ e.tag }}</span>
        <span v-if="e.hidden" class="muted tag">已隐藏</span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.empty {
  margin: 0;
  font-size: 12px;
}

ul {
  margin: 0;
  padding: 0;
  list-style: none;
}

li {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 4px;
  border-radius: 3px;
  cursor: pointer;
}

li:hover {
  background: var(--hn-node-header);
}

li.off .label {
  color: var(--hn-muted);
}

.icon {
  flex-shrink: 0;
  width: 14px;
  color: var(--hn-muted);
  text-align: center;
  font-size: 11px;
}

.label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tag {
  flex-shrink: 0;
  font-size: 11px;
}

.ns {
  margin-right: 2px;
  padding: 0 3px;
  border-radius: 3px;
  background: color-mix(in srgb, var(--hn-muted) 20%, transparent);
  color: var(--hn-muted);
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 10px;
}
</style>

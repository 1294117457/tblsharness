<script setup lang="ts">
import { computed, ref } from 'vue';
import { DIAGRAM_TYPES, diagramTypeLabel } from '@shared/diagram';
import type { DiagramData } from '@shared/protocol';
import type { SyncGroup } from '@shared/sync';
import MermaidCodeEditor from '../diagram/MermaidCodeEditor.vue';
import { applySync, deleteDiagram, editCanvas, ignoreSync, state } from '../store';
import { post } from '../vscode';
import FocusButton from './FocusButton.vue';
import SyncPanel from './SyncPanel.vue';

/**
 * A diagram selected on the canvas: its text is edited here and the card re-renders as you type.
 * Text changes are written to the diagram file and are not part of the canvas's undo history.
 */
const props = defineProps<{ diagram: DiagramData }>();

const syncable = computed(() => DIAGRAM_TYPES.find((t) => t.type === props.diagram.type)?.syncable ?? false);
const group = computed(() => state.pending.find((g) => g.diagram === props.diagram.id));
const focusSeq = computed(() => (state.editDiagram?.id === props.diagram.id ? state.editDiagram.seq : 0));
const busy = ref(false);

function onCode(code: string, id: string) {
  const i = state.diagrams.findIndex((d) => d.id === id);
  if (i >= 0 && state.diagrams[i].code !== code) state.diagrams.splice(i, 1, { ...state.diagrams[i], code });
  post({ type: 'diagram/code', diagram: id, code });
}

function rename(e: Event) {
  const name = (e.target as HTMLInputElement).value.trim();
  if (name && name !== props.diagram.name) post({ type: 'diagram/meta', diagram: props.diagram.id, name });
}

function describe(e: Event) {
  const description = (e.target as HTMLTextAreaElement).value;
  if (description.trim() !== (props.diagram.description ?? '')) post({ type: 'diagram/meta', diagram: props.diagram.id, description });
}

function hide() {
  editCanvas('隐藏设计图', [{ op: 'hidden.set', items: [{ kind: 'diagram', id: props.diagram.id }], hidden: true }]);
  state.selection = undefined;
}

async function apply(g: SyncGroup, ids: string[], choices: Record<string, string>) {
  busy.value = true;
  try {
    await applySync(g, ids, choices);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="diagram-inspector">
    <h3>
      <span>设计图 <span class="type">{{ diagramTypeLabel(diagram.type) }}</span></span>
      <FocusButton :item="{ kind: 'diagram', id: diagram.id }" />
    </h3>
    <label>
      名称
      <input :value="diagram.name" @change="rename" @keydown.enter="($event.target as HTMLInputElement).blur()" />
    </label>
    <label>
      说明
      <textarea :value="diagram.description ?? ''" rows="2" placeholder="这张图画的是什么（可选）" @change="describe" />
    </label>
    <div class="section-title">
      <span>Mermaid</span>
      <span class="muted small-note">输入后自动保存；Ctrl+Z 只撤销文本</span>
    </div>
    <MermaidCodeEditor :code="diagram.code" :doc-key="diagram.id" :focus-seq="focusSeq" @change="onCode" />

    <template v-if="syncable">
      <div class="section-title">
        <span>与表结构的差异<span v-if="group?.result.items.length" class="count">{{ group.result.items.length }}</span></span>
      </div>
      <p v-if="!group || !group.result.items.length" class="muted hint">ER 图和表结构一致。</p>
      <template v-else>
        <p class="muted hint">设计图不会自动改表结构。勾选要采纳的改动，点击同步；删除类的改动默认不勾选。</p>
        <SyncPanel :groups="[group]" :busy="busy" @apply="apply" @ignore="(g, ids) => ignoreSync(g, ids)" @clear-ignored="(g) => ignoreSync(g, [], true)" />
      </template>
    </template>
    <p v-else class="muted hint">{{ diagramTypeLabel(diagram.type) }}只用来表达设计，不会修改表结构。</p>

    <div class="row-actions">
      <button class="secondary" title="复制格式说明和当前内容，粘贴给 AI" @click="post({ type: 'diagram/copyForAI', diagram: diagram.id })">复制给 AI</button>
      <button class="secondary" title="大一些的编辑区和预览" @click="post({ type: 'diagram/openInTab', diagram: diagram.id })">单独标签页</button>
      <span class="spacer" />
      <button class="secondary" title="从画布上隐藏，文件保留" @click="hide">隐藏</button>
      <button class="secondary danger" @click="deleteDiagram(diagram.id)">删除…</button>
    </div>
  </div>
</template>

<style scoped>
.diagram-inspector {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

h3 {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  margin: 0;
  font-size: 13px;
}

.type {
  margin-left: 4px;
  padding: 1px 6px;
  border-radius: 2px;
  background: var(--hn-design-header);
  font-size: 11px;
  font-weight: 400;
}

label {
  display: flex;
  flex-direction: column;
  gap: 2px;
  color: var(--hn-muted);
  font-size: 11px;
}

input,
textarea {
  width: 100%;
  color: var(--hn-fg);
  font-size: 12px;
}

textarea {
  resize: vertical;
  font-family: inherit;
}

.section-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  margin-top: 4px;
  font-weight: 600;
}

.small-note {
  font-size: 11px;
  font-weight: 400;
}

.count {
  margin-left: 6px;
  padding: 0 6px;
  border-radius: 8px;
  background: var(--hn-mismatch);
  color: var(--hn-bg);
  font-size: 11px;
}

.hint {
  margin: 0;
  font-size: 12px;
}

.row-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.spacer {
  flex: 1;
}

.danger {
  color: var(--hn-missing);
}
</style>

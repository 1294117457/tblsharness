<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { DIAGRAM_TYPES, diagramTypeLabel } from '@shared/diagram';
import type { DiagramContext, DiagramDocState } from '@shared/diagramProtocol';
import type { SyncGroup } from '@shared/sync';
import SyncPanel from '../components/SyncPanel.vue';
import MermaidPreview from './MermaidPreview.vue';
import { onMessage, request, send } from './host';

const doc = ref<DiagramDocState>();
const context = ref<DiagramContext>();
const error = ref<string>();
const group = ref<SyncGroup>();
const undoLabel = ref<string>();
const code = ref('');
const busy = ref(false);
const notice = ref<{ text: string; level: 'info' | 'error' }>();
const editor = ref<HTMLTextAreaElement>();

const isEr = computed(() => doc.value?.meta.type === 'er');
const syncable = computed(() => DIAGRAM_TYPES.find((t) => t.type === doc.value?.meta.type)?.syncable ?? false);
const pendingCount = computed(() => group.value?.result.items.length ?? 0);

onMessage((msg) => {
  switch (msg.type) {
    case 'init':
      doc.value = msg.doc;
      code.value = msg.doc.code;
      context.value = msg.context;
      error.value = msg.error;
      return;
    case 'doc':
      doc.value = msg.doc;
      // Local keystrokes not yet sent are newer than any echo of what we sent before.
      if (!sendPending && msg.doc.code !== lastSent && msg.doc.code !== code.value) code.value = msg.doc.code;
      return;
    case 'context':
      context.value = msg.context;
      return;
    case 'sync':
      group.value = msg.group;
      undoLabel.value = msg.undo;
      return;
  }
});

let timer: ReturnType<typeof setTimeout> | undefined;
let sendPending = false;
let lastSent: string | undefined;
watch(code, (value) => {
  if (value === doc.value?.code) return;
  clearTimeout(timer);
  sendPending = true;
  timer = setTimeout(() => {
    sendPending = false;
    lastSent = value;
    send({ type: 'code', code: value });
  }, 250);
});

let noticeTimer: ReturnType<typeof setTimeout> | undefined;
function show(text: string, level: 'info' | 'error' = 'info') {
  notice.value = { text, level };
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => (notice.value = undefined), level === 'error' ? 6000 : 3500);
}

async function run(fn: () => ReturnType<typeof request>) {
  busy.value = true;
  try {
    const r = await fn();
    if (!r.ok && r.error && r.error !== '已取消') show(r.error, 'error');
    else if (r.ok && r.message) show(r.message);
  } finally {
    busy.value = false;
  }
}

function apply(_g: SyncGroup, ids: string[], choices: Record<string, string>) {
  void run(() => request({ type: 'sync/apply', ids, choices }));
}

function ignore(_g: SyncGroup, ids: string[]) {
  void run(() => request({ type: 'sync/ignore', ids }));
}

function clearIgnored() {
  void run(() => request({ type: 'sync/ignore', ids: [], clear: true }));
}

function undo() {
  void run(() => request({ type: 'sync/undo' }));
}

function regenerate() {
  void run(() => request({ type: 'regenerate' }));
}

function rename(e: Event) {
  const name = (e.target as HTMLInputElement).value.trim();
  if (name && name !== doc.value?.meta.name) send({ type: 'meta', name });
}

/** Tab inserts two spaces instead of leaving the textarea. */
function onKeydown(e: KeyboardEvent) {
  if (e.key !== 'Tab' || e.shiftKey) return;
  e.preventDefault();
  const el = editor.value!;
  const { selectionStart: s, selectionEnd: t } = el;
  code.value = `${code.value.slice(0, s)}  ${code.value.slice(t)}`;
  requestAnimationFrame(() => el.setSelectionRange(s + 2, s + 2));
}
</script>

<template>
  <div class="app">
    <div v-if="!doc" class="center muted">正在加载设计图…</div>
    <template v-else>
      <header class="toolbar">
        <input class="title-input" :value="doc.meta.name" title="设计图名称" @change="rename" @keydown.enter="($event.target as HTMLInputElement).blur()" />
        <span class="type">{{ diagramTypeLabel(doc.meta.type) }}</span>
        <span v-if="context" class="muted">
          {{ context.designName }}<template v-if="context.driver"> · {{ context.driver }}</template> · {{ context.tableCount }} 张表
        </span>
        <span class="spacer" />
        <button class="secondary" title="复制格式说明和当前内容，粘贴给 AI" @click="send({ type: 'command', command: 'copyForAI' })">复制给 AI</button>
        <button v-if="isEr" class="secondary" :disabled="busy" title="用表结构的当前内容替换图里的 Mermaid" @click="regenerate">用表结构重新生成</button>
        <button class="secondary" @click="send({ type: 'command', command: 'openCanvas' })">打开 ER 画布</button>
        <button class="secondary" title="用普通文本编辑器打开这个 .md 文件" @click="send({ type: 'command', command: 'openText' })">以文本打开</button>
      </header>
      <p v-if="error" class="banner">{{ error }}</p>
      <p v-for="p in doc.problems" :key="p" class="banner">{{ p }}</p>

      <main class="body">
        <section class="code-pane">
          <div class="pane-title">Mermaid</div>
          <textarea
            ref="editor"
            v-model="code"
            class="code"
            spellcheck="false"
            placeholder="粘贴 AI 给出的 Mermaid，或者直接编写"
            @keydown="onKeydown"
          />
        </section>
        <section class="preview-pane">
          <MermaidPreview :code="code" />
        </section>
        <aside class="right">
          <div class="pane-title">
            与表结构的差异
            <span v-if="pendingCount" class="count">{{ pendingCount }}</span>
          </div>
          <div class="right-body">
            <p v-if="!syncable" class="muted hint">{{ diagramTypeLabel(doc.meta.type) }}只用来表达设计，不会修改表结构。只有 ER 图可以同步到表结构。</p>
            <template v-else>
              <p class="muted hint">设计图不会自动改表结构。勾选要采纳的改动，点击同步；删除类的改动默认不勾选。</p>
              <div v-if="undoLabel" class="undo">
                <span>{{ undoLabel }}</span>
                <button class="secondary small" :disabled="busy" @click="undo">撤销</button>
              </div>
              <SyncPanel v-if="group" :groups="[group]" :busy="busy" @apply="apply" @ignore="ignore" @clear-ignored="clearIgnored" />
              <p v-else class="muted hint">正在比较…</p>
            </template>
          </div>
        </aside>
      </main>
    </template>
    <div v-if="notice" class="toast" :class="notice.level" @click="notice = undefined">{{ notice.text }}</div>
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--hn-border);
}

.title-input {
  width: 200px;
  font-weight: 600;
}

.type {
  padding: 1px 6px;
  border-radius: 2px;
  background: var(--hn-design-header);
  font-size: 11px;
}

.spacer {
  flex: 1;
}

.banner {
  margin: 0;
  padding: 4px 10px;
  border-bottom: 1px solid var(--hn-border);
  color: var(--hn-mismatch);
}

.body {
  display: flex;
  flex: 1;
  min-height: 0;
}

.code-pane {
  display: flex;
  flex-direction: column;
  width: 36%;
  min-width: 260px;
  border-right: 1px solid var(--hn-border);
}

.pane-title {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-bottom: 1px solid var(--hn-border);
  color: var(--hn-muted);
  font-size: 11px;
  font-weight: 600;
}

.code {
  flex: 1;
  width: 100%;
  padding: 8px 10px;
  border: none;
  border-radius: 0;
  resize: none;
  outline: none;
  font-family: var(--vscode-editor-font-family, Consolas, monospace);
  font-size: var(--vscode-editor-font-size, 13px);
  line-height: 1.5;
  tab-size: 2;
  white-space: pre;
}

.preview-pane {
  flex: 1;
  min-width: 0;
}

.right {
  display: flex;
  flex-direction: column;
  width: 320px;
  flex-shrink: 0;
  border-left: 1px solid var(--hn-border);
  background: var(--hn-node-bg);
}

.right-body {
  flex: 1;
  overflow: auto;
  padding: 8px 10px;
}

.count {
  padding: 0 6px;
  border-radius: 8px;
  background: var(--hn-mismatch);
  color: var(--hn-bg);
}

.undo {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
  padding: 4px 6px;
  border-left: 2px solid var(--hn-accent);
  font-size: 12px;
}

.hint {
  margin: 0 0 8px;
  font-size: 12px;
}

.center {
  margin: auto;
  padding: 24px;
}

.toast {
  position: fixed;
  bottom: 16px;
  left: 50%;
  z-index: 200;
  max-width: 70%;
  padding: 8px 14px;
  border: 1px solid var(--hn-border);
  border-radius: 4px;
  background: var(--vscode-notifications-background, var(--hn-node-bg));
  color: var(--vscode-notifications-foreground, var(--hn-fg));
  box-shadow: 0 4px 12px rgb(0 0 0 / 35%);
  transform: translateX(-50%);
  cursor: pointer;
}

.toast.error {
  border-color: var(--hn-missing);
}
</style>

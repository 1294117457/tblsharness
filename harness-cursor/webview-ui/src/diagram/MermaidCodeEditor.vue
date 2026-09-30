<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { mermaidError } from './mermaid';

/**
 * Mermaid text box shared by the canvas's right panel and the separate diagram tab.
 *
 * `code` is the latest text known to the host. Edits are sent (debounced) through `change`
 * together with the `docKey` they belong to. An echo of what was sent is ignored; a real
 * outside change replaces the text unless the user is in the middle of editing, in which case
 * a "reload" prompt is shown instead of throwing their typing away.
 *
 * Keystrokes do not bubble out: Ctrl+Z must stay the textarea's own undo instead of reaching
 * the canvas (or VS Code's custom editor undo).
 */
const props = withDefaults(defineProps<{ code: string; docKey: string; focusSeq?: number; debounce?: number; fill?: boolean }>(), {
  focusSeq: 0,
  debounce: 300,
  fill: false,
});
const emit = defineEmits<{ change: [code: string, docKey: string] }>();

const text = ref(props.code);
const external = ref<string>();
const error = ref<string>();
const editor = ref<HTMLTextAreaElement>();
const gutter = ref<HTMLElement>();

/** The host's text our local text started from; differs from `text` while there are unsent or unconfirmed edits. */
let baseline = props.code;
let lastSent: string | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let pending = false;

const lineCount = computed(() => text.value.split('\n').length);

function flush() {
  if (!pending) return;
  clearTimeout(timer);
  pending = false;
  lastSent = text.value;
  emit('change', text.value, props.docKey);
}

watch(text, (value) => {
  if (value === baseline && !pending) return;
  clearTimeout(timer);
  pending = true;
  timer = setTimeout(flush, props.debounce);
});

watch(
  () => props.docKey,
  (_next, prev) => {
    if (pending) {
      clearTimeout(timer);
      pending = false;
      emit('change', text.value, prev);
    }
    lastSent = undefined;
    external.value = undefined;
    baseline = props.code;
    text.value = props.code;
  },
);

watch(
  () => props.code,
  (code) => {
    if (code === text.value || code === lastSent) {
      baseline = code;
      if (code === text.value) external.value = undefined;
      return;
    }
    const editing = pending || (document.activeElement === editor.value && text.value !== baseline);
    if (editing) {
      external.value = code;
      return;
    }
    baseline = code;
    text.value = code;
    external.value = undefined;
  },
);

function reload() {
  if (external.value === undefined) return;
  clearTimeout(timer);
  pending = false;
  baseline = external.value;
  text.value = external.value;
  external.value = undefined;
}

let checkTimer: ReturnType<typeof setTimeout> | undefined;
let checkSeq = 0;
watch(
  text,
  (value) => {
    clearTimeout(checkTimer);
    checkTimer = setTimeout(async () => {
      const mine = ++checkSeq;
      const e = await mermaidError(value);
      if (mine === checkSeq) error.value = e;
    }, 400);
  },
  { immediate: true },
);

function focus() {
  const el = editor.value;
  if (!el) return;
  el.focus();
  el.setSelectionRange(el.value.length, el.value.length);
  el.scrollTop = el.scrollHeight;
}

watch(
  () => props.focusSeq,
  (seq) => {
    if (seq) requestAnimationFrame(focus);
  },
);

/** Tab indents with two spaces; `insertText` keeps the browser's undo history intact. */
function onKeydown(e: KeyboardEvent) {
  e.stopPropagation();
  if (e.key !== 'Tab' || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
  e.preventDefault();
  if (!document.execCommand('insertText', false, '  ')) {
    const el = editor.value!;
    const { selectionStart: s, selectionEnd: t } = el;
    text.value = `${text.value.slice(0, s)}  ${text.value.slice(t)}`;
    requestAnimationFrame(() => el.setSelectionRange(s + 2, s + 2));
  }
}

function onInput() {
  text.value = editor.value!.value;
}

function syncScroll() {
  if (gutter.value && editor.value) gutter.value.scrollTop = editor.value.scrollTop;
}

onUnmounted(() => {
  flush();
  clearTimeout(checkTimer);
});

defineExpose({ focus, flush });
</script>

<template>
  <div class="mermaid-editor" :class="{ fill }">
    <p v-if="external !== undefined" class="external">
      <span>这张图在别处被修改了（例如在单独的标签页或文本编辑器中）。</span>
      <button class="secondary small" @click="reload">重新载入</button>
      <button class="secondary small" title="保留这里的内容，下次输入时覆盖外部修改" @click="external = undefined">保留我的</button>
    </p>
    <div class="box">
      <div ref="gutter" class="gutter" aria-hidden="true">
        <div v-for="n in lineCount" :key="n">{{ n }}</div>
      </div>
      <textarea
        ref="editor"
        :value="text"
        class="code"
        spellcheck="false"
        wrap="off"
        placeholder="粘贴 AI 给出的 Mermaid，或者直接编写"
        @input="onInput"
        @keydown="onKeydown"
        @scroll="syncScroll"
        @blur="flush"
      />
    </div>
    <pre v-if="error" class="error">Mermaid 语法错误：{{ error }}</pre>
  </div>
</template>

<style scoped>
.mermaid-editor {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-height: 0;
}

.box {
  display: flex;
  min-height: 180px;
  height: 320px;
  border: 1px solid var(--hn-border);
  border-radius: 2px;
  background: var(--vscode-input-background, var(--hn-node-bg));
  resize: vertical;
  overflow: hidden;
}

.fill,
.fill .box {
  flex: 1;
  height: auto;
  border: none;
  resize: none;
}

.gutter {
  flex-shrink: 0;
  min-width: 2.2em;
  padding: 8px 6px 8px 4px;
  overflow: hidden;
  border-right: 1px solid var(--hn-border);
  color: var(--hn-muted);
  font-family: var(--vscode-editor-font-family, Consolas, monospace);
  font-size: var(--vscode-editor-font-size, 13px);
  line-height: 1.5;
  text-align: right;
  user-select: none;
}

.code {
  flex: 1;
  min-width: 0;
  padding: 8px 10px;
  border: none;
  border-radius: 0;
  resize: none;
  outline: none;
  background: transparent;
  color: var(--hn-fg);
  font-family: var(--vscode-editor-font-family, Consolas, monospace);
  font-size: var(--vscode-editor-font-size, 13px);
  line-height: 1.5;
  tab-size: 2;
  white-space: pre;
}

.external {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin: 0;
  padding: 4px 6px;
  border-left: 2px solid var(--hn-mismatch);
  font-size: 12px;
}

.error {
  margin: 0;
  padding: 4px 6px;
  color: var(--hn-missing);
  white-space: pre-wrap;
  font-size: 11px;
}
</style>

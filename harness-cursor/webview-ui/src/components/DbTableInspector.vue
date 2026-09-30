<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { nodeId } from '@shared/canvas';
import type { NColumn, NRelation, NTable } from '@shared/model';
import type { CanvasView } from '../canvas/viewModel';
import { editCanvas, reveal, select, setClipboard, state } from '../store';
import { post } from '../vscode';
import FocusButton from './FocusButton.vue';

/** Read-only structure of a database table on the canvas, straight from the normalized snapshot. */
const props = defineProps<{ source: string; table: NTable; view: CanvasView }>();
const emit = defineEmits<{ 'add-db-tables': [source: string, tables: string[]] }>();

const id = computed(() => nodeId(props.source, props.table.key));
const data = computed(() => state.sources[props.source]);
const relations = computed(() => data.value?.schema?.relations ?? []);
const outgoing = computed(() => relations.value.filter((r) => r.from.table === props.table.key));
const incoming = computed(() => relations.value.filter((r) => r.to.table === props.table.key && r.from.table !== props.table.key));
/** A related table that was clicked but is not on the canvas. */
const missing = ref<string>();
watch(id, () => (missing.value = undefined));

const takenAt = computed(() => {
  const at = data.value?.snapshot?.takenAt;
  if (!at) return undefined;
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? at : d.toLocaleString('zh-CN', { hour12: false });
});

function foreignTarget(c: NColumn): string | undefined {
  for (const r of outgoing.value) {
    const i = r.from.columns.indexOf(c.name);
    if (i >= 0) return `${r.to.table}.${r.to.columns[i] ?? r.to.columns[0]}`;
  }
  return undefined;
}

function columnFlags(c: NColumn): string[] {
  const out = [c.nullable ? '可空' : '非空'];
  if (c.unique && !c.primaryKey) out.push('唯一');
  if (c.autoIncrement) out.push('自增');
  if (c.default != null && c.default !== '') out.push(`默认 ${c.default}`);
  return out;
}

function indexKind(def: string, name: string): string | undefined {
  const d = def.toUpperCase();
  if (d.includes('PRIMARY KEY') || name.endsWith('_pkey') || name === 'PRIMARY') return '主键';
  if (d.includes('UNIQUE')) return '唯一';
  return undefined;
}

function ends(r: NRelation, side: 'from' | 'to'): string {
  return `${r[side].table}.${r[side].columns.join(',')}`;
}

function openTable(key: string) {
  if (key === props.table.key) return;
  if (props.view.dbPlaced[props.source]?.has(key)) {
    missing.value = undefined;
    reveal({ item: { kind: 'table', id: nodeId(props.source, key) } });
  } else {
    missing.value = key;
  }
}

function addMissing() {
  const key = missing.value;
  if (!key) return;
  missing.value = undefined;
  emit('add-db-tables', props.source, [key]);
}

function removeFromCanvas() {
  editCanvas('从画布移除', [{ op: 'nodes.remove', ids: [id.value] }]);
  state.selection = undefined;
}
</script>

<template>
  <div class="db-inspector">
    <h3>
      <span>数据库表 <span class="name">{{ table.key }}</span></span>
      <FocusButton :item="{ kind: 'table', id }" />
    </h3>
    <p class="meta muted">
      <span :title="data?.snapshot?.file">来源 {{ data?.name ?? source }}<template v-if="takenAt"> · 快照 {{ takenAt }}</template></span>
      <button class="secondary small" title="重新读取数据库结构" @click="post({ type: 'db/sync', source })">⟳ 同步</button>
    </p>
    <p v-if="table.comment" class="comment">{{ table.comment }}</p>
    <p v-if="table.type && table.type.toUpperCase() !== 'BASE TABLE' && table.type.toUpperCase() !== 'TABLE'" class="muted">类型 {{ table.type }}</p>

    <div class="section-title">字段（{{ table.columns.length }}）</div>
    <ul class="cols">
      <li v-for="c in table.columns" :key="c.name" :title="c.comment" @click="select({ type: 'column', nodeId: id, column: c.name })">
        <span class="col-name"><span class="pk">{{ c.primaryKey ? '🔑' : '' }}</span>{{ c.name }}</span>
        <span class="col-type mono">{{ c.rawType }}</span>
        <span class="col-flags muted">
          {{ columnFlags(c).join('  ') }}
          <a v-if="foreignTarget(c)" href="#" @click.prevent.stop="openTable(foreignTarget(c)!.split('.')[0])">→ {{ foreignTarget(c) }}</a>
          <template v-else-if="c.comment">{{ c.comment }}</template>
        </span>
      </li>
    </ul>

    <div class="kv">
      <span class="k">索引</span>
      <span v-if="!table.indexes.length" class="muted">无</span>
      <span v-else class="v">
        <span v-for="ix in table.indexes" :key="ix.name" class="chip" :title="ix.def">
          {{ ix.name }} ({{ ix.columns.join(', ') }})<template v-if="indexKind(ix.def, ix.name)"> {{ indexKind(ix.def, ix.name) }}</template>
        </span>
      </span>
    </div>
    <div class="kv">
      <span class="k">外键</span>
      <span v-if="!outgoing.length" class="muted">无</span>
      <span v-else class="v">
        <span v-for="r in outgoing" :key="r.key" class="chip">
          {{ r.from.columns.join(',') }} → <a href="#" @click.prevent="openTable(r.to.table)">{{ ends(r, 'to') }}</a>
        </span>
      </span>
    </div>
    <div class="kv">
      <span class="k">被引用</span>
      <span v-if="!incoming.length" class="muted">无</span>
      <span v-else class="v">
        <span v-for="r in incoming" :key="r.key" class="chip">
          <a href="#" @click.prevent="openTable(r.from.table)">{{ ends(r, 'from') }}</a> → {{ ends(r, 'to') }}
        </span>
      </span>
    </div>

    <p v-if="missing" class="missing">
      <span>{{ missing }} 不在画布上</span>
      <button class="secondary small" @click="addMissing">添加到这一层</button>
    </p>

    <div class="row-actions">
      <button class="secondary" title="粘贴到某一层后成为设计表（Ctrl+C）" @click="setClipboard('copy', [{ kind: 'table', id }])">复制</button>
      <span class="spacer" />
      <button class="secondary" title="只从画布上拿掉，数据库不受影响（Delete）" @click="removeFromCanvas">从画布移除</button>
    </div>
    <p class="muted hint">数据库表只读。复制后在想要的层粘贴，会生成一张设计表。</p>
  </div>
</template>

<style scoped>
.db-inspector {
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

.name {
  font-family: var(--vscode-editor-font-family, monospace);
}

.meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  margin: 0;
  font-size: 11px;
}

.comment {
  margin: 0;
}

.section-title {
  margin-top: 4px;
  font-weight: 600;
}

.cols {
  margin: 0;
  padding: 4px 0;
  border: 1px solid var(--hn-border);
  border-radius: 3px;
  list-style: none;
}

.cols li {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  column-gap: 6px;
  padding: 2px 6px;
  cursor: pointer;
}

.cols li:hover {
  background: var(--hn-node-header);
}

.col-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pk {
  display: inline-block;
  width: 16px;
  font-size: 10px;
}

.col-type {
  color: var(--hn-muted);
  font-size: 11px;
}

.col-flags {
  grid-column: 1 / -1;
  padding-left: 16px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
}

.mono {
  font-family: var(--vscode-editor-font-family, monospace);
}

.kv {
  display: flex;
  gap: 8px;
  font-size: 12px;
}

.k {
  flex-shrink: 0;
  width: 40px;
  color: var(--hn-muted);
}

.v {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.chip {
  overflow-wrap: anywhere;
}

.missing {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  margin: 0;
  padding: 4px 6px;
  border-left: 2px solid var(--hn-mismatch);
}

.row-actions {
  display: flex;
  gap: 6px;
}

.spacer {
  flex: 1;
}

.hint {
  margin: 0;
  font-size: 11px;
}
</style>

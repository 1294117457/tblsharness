<script setup lang="ts">
import { computed } from 'vue';
import { nodeId, parseNodeId } from '@shared/canvas';
import type { ColumnPatch, RelationPatch } from '@shared/designOps';
import type { NColumn, NRelation, NTable, RelationKind } from '@shared/model';
import type { TblsCardinality } from '@shared/tbls';
import { canvas, designOp, editCanvas, focusNode, state } from '../store';

const RELATION_KINDS: { value: RelationKind; label: string }[] = [
  { value: 'fk', label: '外键（数据库约束）' },
  { value: 'virtual', label: '虚拟关系' },
  { value: 'logical', label: '逻辑关系' },
  { value: 'json_array', label: 'JSON 数组' },
  { value: 'polymorphic', label: '多态' },
  { value: 'dictionary', label: '字典' },
];

const CARDINALITIES: { value: TblsCardinality; label: string }[] = [
  { value: '', label: '（未指定）' },
  { value: 'zero_or_one', label: '0..1' },
  { value: 'exactly_one', label: '1' },
  { value: 'zero_or_more', label: '0..n' },
  { value: 'one_or_more', label: '1..n' },
];

const COMMON_TYPES = [
  'bigint',
  'integer',
  'smallint',
  'numeric(10,2)',
  'boolean',
  'varchar(64)',
  'varchar(255)',
  'text',
  'date',
  'timestamp',
  'timestamptz',
  'json',
  'jsonb',
  'uuid',
];

interface Target {
  alias: string;
  kind: 'design' | 'db';
  editable: boolean;
  table?: NTable;
  column?: NColumn;
  relation?: NRelation;
}

const target = computed<Target | undefined>(() => {
  const sel = state.selection;
  if (!sel || sel.type === 'note') return undefined;
  const alias = sel.type === 'relation' ? sel.alias : parseNodeId(sel.nodeId).alias;
  const source = canvas.value.sources.find((s) => s.alias === alias);
  const schema = state.sources[alias]?.schema;
  if (!source) return undefined;
  const editable = source.kind === 'design' && !!schema;
  if (sel.type === 'relation') {
    return { alias, kind: source.kind, editable, relation: schema?.relations.find((r) => r.key === sel.key) };
  }
  const table = schema?.tables.find((t) => t.key === parseNodeId(sel.nodeId).table);
  const column = sel.type === 'column' ? table?.columns.find((c) => c.name === sel.column) : undefined;
  return { alias, kind: source.kind, editable, table, column };
});

const note = computed(() => {
  const sel = state.selection;
  return sel?.type === 'note' ? canvas.value.notes.find((n) => n.id === sel.id) : undefined;
});

const tableRelations = computed(() => {
  const t = target.value;
  if (!t?.table || t.column) return [];
  const rels = state.sources[t.alias]?.schema?.relations ?? [];
  return rels.filter((r) => r.from.table === t.table!.key || r.to.table === t.table!.key);
});

function value(e: Event): string {
  return (e.target as HTMLInputElement).value;
}

function checked(e: Event): boolean {
  return (e.target as HTMLInputElement).checked;
}

async function renameTable(to: string) {
  const t = target.value;
  to = to.trim();
  if (!t?.table || !to || to === t.table.key) return;
  if (await designOp(t.alias, [{ op: 'table.rename', from: t.table.key, to }], `重命名表 ${t.table.key}`)) {
    state.selection = { type: 'table', nodeId: nodeId(t.alias, to) };
  }
}

function updateTableComment(comment: string) {
  const t = target.value;
  if (!t?.table || comment === (t.table.comment ?? '')) return;
  void designOp(t.alias, [{ op: 'table.update', table: t.table.key, comment }], `修改表注释 ${t.table.key}`);
}

async function addColumn() {
  const t = target.value;
  if (!t?.table) return;
  const taken = new Set(t.table.columns.map((c) => c.name));
  let name = 'new_column';
  for (let i = 2; taken.has(name); i++) name = `new_column_${i}`;
  const ok = await designOp(t.alias, [{ op: 'column.add', table: t.table.key, column: { name, type: 'varchar(255)', nullable: true } }], `添加字段 ${name}`);
  if (ok) state.selection = { type: 'column', nodeId: nodeId(t.alias, t.table.key), column: name };
}

async function updateColumn(patch: ColumnPatch, label: string) {
  const t = target.value;
  if (!t?.table || !t.column) return;
  const ok = await designOp(t.alias, [{ op: 'column.update', table: t.table.key, column: t.column.name, patch }], label);
  if (ok && patch.name) state.selection = { type: 'column', nodeId: nodeId(t.alias, t.table.key), column: patch.name };
}

function renameColumn(name: string) {
  name = name.trim();
  const c = target.value?.column;
  if (!c || !name || name === c.name) return;
  void updateColumn({ name }, `重命名字段 ${c.name}`);
}

function moveColumn(delta: number) {
  const t = target.value;
  if (!t?.table || !t.column) return;
  const index = t.table.columns.findIndex((c) => c.name === t.column!.name);
  const toIndex = index + delta;
  if (toIndex < 0 || toIndex >= t.table.columns.length) return;
  void designOp(t.alias, [{ op: 'column.move', table: t.table.key, column: t.column.name, toIndex }], `移动字段 ${t.column.name}`);
}

async function deleteColumn() {
  const t = target.value;
  if (!t?.table || !t.column) return;
  const table = t.table.key;
  if (await designOp(t.alias, [{ op: 'column.delete', table, column: t.column.name }], `删除字段 ${t.column.name}`)) {
    state.selection = { type: 'table', nodeId: nodeId(t.alias, table) };
  }
}

function updateRelation(patch: RelationPatch) {
  const t = target.value;
  if (t?.relation) void designOp(t.alias, [{ op: 'relation.update', key: t.relation.key, patch }], '修改关系');
}

async function deleteRelation() {
  const t = target.value;
  if (!t?.relation) return;
  if (await designOp(t.alias, [{ op: 'relation.delete', key: t.relation.key }], '删除关系')) state.selection = undefined;
}

function selectColumn(column: string) {
  const t = target.value;
  if (t?.table) state.selection = { type: 'column', nodeId: nodeId(t.alias, t.table.key), column };
}

function selectRelation(r: NRelation) {
  const t = target.value;
  if (t) state.selection = { type: 'relation', alias: t.alias, key: r.key };
}

function updateNote(text: string) {
  if (note.value && text !== note.value.text) editCanvas('编辑便签', [{ op: 'note.put', note: { ...note.value, text } }]);
}

function removeNote() {
  if (!note.value) return;
  editCanvas('删除便签', [{ op: 'note.remove', id: note.value.id }]);
  state.selection = undefined;
}

function cardinalityLabel(c: TblsCardinality): string {
  return CARDINALITIES.find((x) => x.value === c)?.label ?? c;
}
</script>

<template>
  <div class="inspector" @keydown.stop>
    <p v-if="!state.selection" class="muted hint">选中画布上的表、字段或关系，在这里查看和编辑。双击画布空白处可以新建表。</p>

    <template v-else-if="note">
      <h3>便签</h3>
      <textarea :value="note.text" rows="6" @change="updateNote(value($event))" />
      <div class="row-actions">
        <button class="secondary" @click="removeNote">删除便签</button>
      </div>
    </template>

    <template v-else-if="target?.relation">
      <h3>关系</h3>
      <p class="muted">
        {{ target.relation.from.table }}({{ target.relation.from.columns.join(', ') }}) →
        {{ target.relation.to.table }}({{ target.relation.to.columns.join(', ') }})
      </p>
      <p v-if="!target.editable" class="readonly">数据库中的关系只能查看。</p>
      <label>
        类型
        <select :value="target.relation.kind" :disabled="!target.editable" @change="updateRelation({ kind: value($event) as RelationKind })">
          <option v-for="k in RELATION_KINDS" :key="k.value" :value="k.value">{{ k.label }}</option>
        </select>
      </label>
      <label>
        子表一侧
        <select :value="target.relation.cardinality" :disabled="!target.editable" @change="updateRelation({ cardinality: value($event) as TblsCardinality })">
          <option v-for="c in CARDINALITIES" :key="c.value" :value="c.value">{{ c.label }}</option>
        </select>
      </label>
      <label>
        父表一侧
        <select
          :value="target.relation.parentCardinality"
          :disabled="!target.editable"
          @change="updateRelation({ parentCardinality: value($event) as TblsCardinality })"
        >
          <option v-for="c in CARDINALITIES" :key="c.value" :value="c.value">{{ c.label }}</option>
        </select>
      </label>
      <label v-if="target.relation.kind === 'polymorphic'">
        类型区分字段
        <input :value="target.relation.discriminator ?? ''" :disabled="!target.editable" @change="updateRelation({ discriminator: value($event) })" />
      </label>
      <label>
        说明
        <textarea :value="target.relation.note ?? ''" rows="3" :disabled="!target.editable" @change="updateRelation({ note: value($event) })" />
      </label>
      <div v-if="target.editable" class="row-actions">
        <button class="secondary danger" @click="deleteRelation">删除关系</button>
      </div>
    </template>

    <template v-else-if="target?.column && target.table">
      <h3>
        字段
        <a href="#" class="crumb" @click.prevent="state.selection = { type: 'table', nodeId: nodeId(target.alias, target.table.key) }">{{ target.table.key }}</a>
      </h3>
      <p v-if="!target.editable" class="readonly">数据库中的字段只能查看。</p>
      <label>
        名称
        <input :value="target.column.name" :disabled="!target.editable" @change="renameColumn(value($event))" />
      </label>
      <label>
        类型
        <input
          :value="target.column.rawType"
          list="hn-column-types"
          :disabled="!target.editable"
          @change="updateColumn({ type: value($event).trim() }, `修改字段类型 ${target.column.name}`)"
        />
        <datalist id="hn-column-types">
          <option v-for="t in COMMON_TYPES" :key="t" :value="t" />
        </datalist>
      </label>
      <div class="checks">
        <label>
          <input
            type="checkbox"
            :checked="target.column.primaryKey"
            :disabled="!target.editable"
            @change="updateColumn({ primaryKey: checked($event) }, `修改主键 ${target.column.name}`)"
          />
          主键
        </label>
        <label>
          <input
            type="checkbox"
            :checked="target.column.nullable"
            :disabled="!target.editable || target.column.primaryKey"
            @change="updateColumn({ nullable: checked($event) }, `修改可空 ${target.column.name}`)"
          />
          可空
        </label>
        <label>
          <input
            type="checkbox"
            :checked="target.column.unique"
            :disabled="!target.editable"
            @change="updateColumn({ unique: checked($event) }, `修改唯一 ${target.column.name}`)"
          />
          唯一
        </label>
      </div>
      <label>
        默认值
        <input
          :value="target.column.default ?? ''"
          placeholder="例如 now()、0、'draft'"
          :disabled="!target.editable"
          @change="updateColumn({ default: value($event).trim() || null }, `修改默认值 ${target.column.name}`)"
        />
      </label>
      <label>
        注释
        <textarea
          :value="target.column.comment ?? ''"
          rows="3"
          :disabled="!target.editable"
          @change="updateColumn({ comment: value($event) }, `修改字段注释 ${target.column.name}`)"
        />
      </label>
      <div v-if="target.editable" class="row-actions">
        <button class="secondary" title="上移" @click="moveColumn(-1)">↑</button>
        <button class="secondary" title="下移" @click="moveColumn(1)">↓</button>
        <span class="spacer" />
        <button class="secondary danger" @click="deleteColumn">删除字段</button>
      </div>
    </template>

    <template v-else-if="target?.table">
      <h3>{{ target.kind === 'design' ? '设计表' : '数据库表' }}</h3>
      <p v-if="!target.editable" class="readonly">数据库中的表只能查看。要修改结构，请在设计库中修改后生成 SQL 执行。</p>
      <label>
        表名
        <input :value="target.table.key" :disabled="!target.editable" @change="renameTable(value($event))" />
      </label>
      <label>
        注释
        <textarea :value="target.table.comment ?? ''" rows="2" :disabled="!target.editable" @change="updateTableComment(value($event))" />
      </label>
      <div class="section-title">
        <span>字段（{{ target.table.columns.length }}）</span>
        <button v-if="target.editable" class="secondary small" @click="addColumn">+ 字段</button>
      </div>
      <ul class="columns">
        <li v-for="c in target.table.columns" :key="c.name" @click="selectColumn(c.name)">
          <span class="col-name">
            <span v-if="c.primaryKey" class="badge">PK</span>
            {{ c.name }}
          </span>
          <span class="muted">{{ c.rawType }}{{ c.nullable ? '' : ' 非空' }}</span>
        </li>
      </ul>
      <template v-if="tableRelations.length">
        <div class="section-title"><span>关系（{{ tableRelations.length }}）</span></div>
        <ul class="columns">
          <li v-for="r in tableRelations" :key="r.key" @click="selectRelation(r)">
            <span class="col-name">{{ r.from.table }}.{{ r.from.columns.join(',') }} → {{ r.to.table }}</span>
            <span class="muted">{{ r.kind }} {{ cardinalityLabel(r.cardinality) }}</span>
          </li>
        </ul>
      </template>
      <div class="row-actions">
        <button class="secondary" @click="focusNode(nodeId(target.alias, target.table.key))">在画布中定位</button>
      </div>
    </template>

    <p v-else class="muted hint">选中的对象在数据源中已经不存在了。</p>
  </div>
</template>

<style scoped>
.inspector {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px 10px;
}

h3 {
  margin: 0;
  font-size: 13px;
}

.crumb {
  margin-left: 6px;
  color: var(--hn-muted);
  font-weight: normal;
}

label {
  display: flex;
  flex-direction: column;
  gap: 2px;
  color: var(--hn-muted);
  font-size: 11px;
}

.checks {
  display: flex;
  gap: 12px;
}

.checks label {
  flex-direction: row;
  align-items: center;
  gap: 4px;
  color: var(--hn-fg);
  font-size: 12px;
}

input,
select,
textarea {
  width: 100%;
  color: var(--hn-fg);
  font-size: 12px;
}

.checks input {
  width: auto;
}

textarea {
  resize: vertical;
  font-family: inherit;
}

.row-actions {
  display: flex;
  gap: 6px;
}

.spacer {
  flex: 1;
}

.danger {
  color: var(--hn-missing);
}

.section-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 4px;
  font-weight: 600;
}

.columns {
  margin: 0;
  padding: 0;
  list-style: none;
}

.columns li {
  display: flex;
  justify-content: space-between;
  gap: 6px;
  padding: 3px 4px;
  border-radius: 3px;
  cursor: pointer;
}

.columns li:hover {
  background: var(--hn-node-header);
}

.col-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.badge {
  padding: 0 3px;
  border-radius: 2px;
  background: var(--hn-accent);
  color: var(--hn-accent-fg, #fff);
  font-size: 10px;
}

.readonly {
  padding: 4px 6px;
  border-left: 2px solid var(--hn-db-only);
  color: var(--hn-muted);
}

.hint {
  padding: 4px 0;
}
</style>

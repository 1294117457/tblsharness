<script setup lang="ts">
import { reactive } from 'vue';
import type { SyncGroup, SyncItem } from '@shared/sync';

const props = defineProps<{
  groups: SyncGroup[];
  /** Canvas: several diagrams, each with a title and an "open" link. */
  showTitles?: boolean;
  busy?: boolean;
}>();

const emit = defineEmits<{
  apply: [group: SyncGroup, ids: string[], choices: Record<string, string>];
  ignore: [group: SyncGroup, ids: string[]];
  clearIgnored: [group: SyncGroup];
  open: [group: SyncGroup];
}>();

/** User toggles survive re-detection because item ids are stable. */
const checked = reactive(new Map<string, boolean>());
const choices = reactive(new Map<string, string>());

const ACTION_LABEL: Record<SyncItem['action'], string> = { add: '新增', change: '修改', delete: '删除' };

function key(g: SyncGroup, id: string): string {
  return `${g.design}/${g.diagram}/${id}`;
}

function isChecked(g: SyncGroup, item: SyncItem): boolean {
  return checked.get(key(g, item.id)) ?? item.defaultChecked;
}

function toggle(g: SyncGroup, item: SyncItem, on: boolean) {
  checked.set(key(g, item.id), on);
  if (on) {
    for (const dep of item.requires ?? []) if (g.result.items.some((i) => i.id === dep)) checked.set(key(g, dep), true);
  } else {
    for (const other of g.result.items) if (other.requires?.includes(item.id)) checked.set(key(g, other.id), false);
  }
}

function choiceOf(g: SyncGroup, item: SyncItem): string {
  return choices.get(key(g, item.id)) ?? item.choice?.value ?? '';
}

function selected(g: SyncGroup): SyncItem[] {
  return g.result.items.filter((i) => isChecked(g, i));
}

function blocked(g: SyncGroup, item: SyncItem): string | undefined {
  if (item.choice && !choiceOf(g, item)) return item.choice.label;
  if (!item.ops && !item.choice) return item.detail ?? '信息不完整';
  return undefined;
}

function apply(g: SyncGroup) {
  const items = selected(g);
  const picked: Record<string, string> = {};
  for (const i of items) {
    const v = choiceOf(g, i);
    if (i.choice && v) picked[i.id] = v;
  }
  emit(
    'apply',
    g,
    items.map((i) => i.id),
    picked,
  );
}

function ignoreSelected(g: SyncGroup) {
  emit(
    'ignore',
    g,
    selected(g).map((i) => i.id),
  );
}

function canApply(g: SyncGroup): boolean {
  const items = selected(g);
  return !props.busy && items.length > 0 && items.every((i) => !blocked(g, i));
}
</script>

<template>
  <div class="sync-panel">
    <section v-for="g in groups" :key="`${g.design}/${g.diagram}`" class="group">
      <header v-if="showTitles" class="group-title">
        <a href="#" title="打开设计图" @click.prevent="emit('open', g)">{{ g.diagramName }}</a>
        <span class="muted">{{ g.designName }}</span>
      </header>

      <p v-if="g.error" class="problem">{{ g.error }}</p>
      <ul v-if="g.result.problems.length" class="problems">
        <li v-for="(p, i) in g.result.problems" :key="i">
          <span class="line">第 {{ p.line }} 行</span>
          {{ p.message }}
        </li>
      </ul>

      <p v-if="!g.result.items.length && !g.error" class="muted hint">
        {{ g.result.problems.length ? '修正上面的问题后再看差异。' : '设计图和表结构一致。' }}
      </p>

      <ul v-else class="items">
        <li v-for="item in g.result.items" :key="item.id" :class="[item.action, { off: !isChecked(g, item) }]">
          <label class="row">
            <input type="checkbox" :checked="isChecked(g, item)" @change="toggle(g, item, ($event.target as HTMLInputElement).checked)" />
            <span class="badge">{{ ACTION_LABEL[item.action] }}</span>
            <span class="msg">{{ item.message }}</span>
          </label>
          <p v-if="item.detail" class="detail muted">{{ item.detail }}</p>
          <label v-if="item.choice" class="choice">
            {{ item.choice.label }}
            <select :value="choiceOf(g, item)" @change="choices.set(key(g, item.id), ($event.target as HTMLSelectElement).value)">
              <option value="" disabled>请选择</option>
              <option v-for="o in item.choice.options" :key="o" :value="o">{{ o }}</option>
            </select>
          </label>
          <p v-if="isChecked(g, item) && blocked(g, item)" class="blocked">{{ blocked(g, item) }}</p>
        </li>
      </ul>

      <div v-if="g.result.items.length" class="actions">
        <button :disabled="!canApply(g)" @click="apply(g)">同步选中的 {{ selected(g).length }} 项到表结构</button>
        <button class="secondary" :disabled="!selected(g).length || busy" title="以后不再提示这些差异（记在设计图里）" @click="ignoreSelected(g)">忽略</button>
      </div>
      <p v-if="g.result.ignored" class="muted ignored">
        已忽略 {{ g.result.ignored }} 项
        <a href="#" @click.prevent="emit('clearIgnored', g)">恢复</a>
      </p>
    </section>
  </div>
</template>

<style scoped>
.sync-panel {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.group-title {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
  font-weight: 600;
}

a {
  color: var(--vscode-textLink-foreground, #3794ff);
  text-decoration: none;
}

.problems {
  margin: 0 0 8px;
  padding: 6px 8px;
  border-left: 2px solid var(--hn-mismatch);
  list-style: none;
  font-size: 12px;
}

.problem {
  color: var(--hn-missing);
}

.line {
  margin-right: 4px;
  color: var(--hn-muted);
}

.items {
  margin: 0;
  padding: 0;
  list-style: none;
}

.items li {
  padding: 5px 0;
  border-bottom: 1px solid color-mix(in srgb, var(--hn-border) 50%, transparent);
}

.row {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  cursor: pointer;
}

.row input {
  margin-top: 2px;
}

.badge {
  flex-shrink: 0;
  padding: 0 4px;
  border-radius: 2px;
  font-size: 10px;
  line-height: 16px;
}

li.add .badge {
  background: color-mix(in srgb, var(--hn-design-only, #3fb950) 30%, transparent);
}

li.change .badge {
  background: color-mix(in srgb, var(--hn-mismatch) 30%, transparent);
}

li.delete .badge {
  background: color-mix(in srgb, var(--hn-missing) 30%, transparent);
}

li.off .msg {
  color: var(--hn-muted);
}

.msg {
  word-break: break-all;
}

.detail,
.blocked {
  margin: 2px 0 0 22px;
  font-size: 11px;
}

.blocked {
  color: var(--hn-missing);
}

.choice {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 4px 0 0 22px;
  color: var(--hn-muted);
  font-size: 11px;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}

.ignored {
  margin-top: 6px;
  font-size: 11px;
}

.hint {
  padding: 4px 0;
}
</style>

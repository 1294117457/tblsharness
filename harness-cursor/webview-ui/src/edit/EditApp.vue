<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import type { EditInit, EditKind } from '@shared/editProtocol';
import { onInit, save, send } from './host';

const KIND_LABEL: Record<EditKind, string> = { workspace: '工作区', design: '设计画布', partition: '分区画布' };

const init = ref<EditInit>();
const form = reactive({ name: '', description: '', driver: '' });
const submitted = ref(false);
const busy = ref(false);
const error = ref<string>();

const nameError = computed(() => (submitted.value && !form.name.trim() ? '名称不能为空' : undefined));
const driverChanged = computed(() => !!init.value?.driver && form.driver !== init.value.driver);
const driverUnset = computed(() => init.value?.kind === 'design' && !init.value.driver);

onInit((data) => {
  init.value = data;
  form.name = data.name;
  form.description = data.description ?? '';
  form.driver = data.driver ?? '';
});

async function submit() {
  submitted.value = true;
  if (!init.value || !form.name.trim() || busy.value) return;
  busy.value = true;
  error.value = undefined;
  const res = await save({
    name: form.name,
    description: form.description,
    driver: init.value.kind === 'design' && form.driver ? form.driver : undefined,
  });
  busy.value = false;
  if (!res.ok) error.value = res.message ?? '保存失败';
}

function focusSelect(el: unknown) {
  if (el instanceof HTMLInputElement) requestAnimationFrame(() => el.select());
}
</script>

<template>
  <div class="page">
    <div v-if="!init" class="muted loading">正在加载…</div>
    <form v-else class="card" @submit.prevent="submit">
      <h1>
        编辑{{ KIND_LABEL[init.kind] }}
        <span v-if="init.kind !== 'workspace'" class="muted">· {{ init.workspaceName }}</span>
      </h1>

      <div class="grid">
        <label class="label" for="ed-name">名称</label>
        <div>
          <input id="ed-name" :ref="focusSelect" v-model="form.name" class="full" spellcheck="false" @keydown.esc.prevent="send({ type: 'close' })" />
          <p v-if="nameError" class="field-error">{{ nameError }}</p>
        </div>

        <template v-if="init.kind === 'design'">
          <label class="label" for="ed-driver">目标数据库类型</label>
          <div>
            <select id="ed-driver" v-model="form.driver" class="driver">
              <option v-if="driverUnset" value="">未指定</option>
              <option v-for="d in init.drivers" :key="d.name" :value="d.name">{{ d.label }}</option>
            </select>
            <p class="muted note">决定字段类型按哪种数据库解析，以及和哪类数据库对比。</p>
            <p v-if="driverChanged && init.tableCount" class="warn">已有 {{ init.tableCount }} 张表的字段类型不会自动转换，保存后请按需检查。</p>
          </div>
        </template>

        <label class="label" for="ed-desc">说明</label>
        <textarea id="ed-desc" v-model="form.description" class="full" rows="3" placeholder="可选" />
      </div>

      <p v-if="error" class="field-error status">✖ {{ error }}</p>

      <footer class="actions">
        <button type="submit" :disabled="busy">{{ busy ? '正在保存…' : '保存' }}</button>
        <button type="button" class="secondary" @click="send({ type: 'close' })">取消</button>
      </footer>
    </form>
  </div>
</template>

<style scoped>
.page {
  box-sizing: border-box;
  height: 100%;
  overflow: auto;
  padding: 24px;
}

.loading {
  padding: 24px;
}

.card {
  max-width: 560px;
  margin: 0 auto;
}

h1 {
  margin: 0 0 16px;
  font-size: 18px;
  font-weight: 600;
}

h1 .muted {
  font-weight: 400;
}

.grid {
  display: grid;
  grid-template-columns: 110px 1fr;
  gap: 10px 12px;
  align-items: start;
  margin-bottom: 8px;
}

.label {
  padding-top: 4px;
  color: var(--hn-muted);
  text-align: right;
}

.full {
  box-sizing: border-box;
  width: 100%;
}

.driver {
  min-width: 240px;
}

.note {
  margin: 2px 0 0;
  font-size: 12px;
}

.warn {
  margin: 4px 0 0;
  color: var(--hn-mismatch);
}

.field-error {
  margin: 2px 0 0;
  color: var(--hn-missing);
}

.status {
  margin: 12px 0;
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 12px;
}
</style>

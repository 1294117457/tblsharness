<script setup lang="ts">
import { computed, ref } from 'vue';
import { CUSTOM_DSN_EXAMPLES, driverInfo, TBLS_DSN_DOC_URL, type ConnectionField } from '@shared/connection';
import type { ConnectionForm } from './form';
import { pickFile, send } from './host';

const props = defineProps<{
  form: ConnectionForm;
  errors: Partial<Record<ConnectionField, string>>;
  /** Edit mode with a saved password (or custom DSN): empty means keep it. */
  savedSecret: boolean;
}>();
const emit = defineEmits<{ touch: [field: 'port' | 'security'] }>();

const info = computed(() => driverInfo(props.form.driver));
const has = (f: ConnectionField) => info.value.fields.includes(f);
const showPassword = ref(false);

async function browse() {
  const picked = await pickFile('sqlite');
  if (picked.path) props.form.file = picked.path;
}
</script>

<template>
  <template v-if="has('host')">
    <label class="label" for="cf-host">主机</label>
    <div class="row">
      <input id="cf-host" v-model="form.host" class="grow" placeholder="localhost 或 IP 地址" autocomplete="off" spellcheck="false" />
      <label class="inline-label" for="cf-port">端口</label>
      <input
        id="cf-port"
        v-model="form.port"
        class="port"
        inputmode="numeric"
        :placeholder="String(info.defaultPort ?? '')"
        @input="emit('touch', 'port')"
      />
    </div>
    <p v-if="errors.host || errors.port" class="field-error">{{ errors.host ?? errors.port }}</p>
  </template>

  <template v-if="has('database')">
    <label class="label" for="cf-db">数据库</label>
    <div>
      <input id="cf-db" v-model="form.database" class="full" autocomplete="off" spellcheck="false" />
      <p v-if="errors.database" class="field-error">{{ errors.database }}</p>
    </div>
  </template>

  <template v-if="has('user')">
    <label class="label" for="cf-user">用户名</label>
    <div>
      <input id="cf-user" v-model="form.user" class="full" autocomplete="off" spellcheck="false" />
      <p v-if="errors.user" class="field-error">{{ errors.user }}</p>
    </div>
  </template>

  <template v-if="has('password')">
    <label class="label" for="cf-pw">密码</label>
    <div class="row">
      <input
        id="cf-pw"
        v-model="form.password"
        class="grow"
        :type="showPassword ? 'text' : 'password'"
        :placeholder="savedSecret ? '已保存，不修改请留空' : ''"
        autocomplete="new-password"
        spellcheck="false"
      />
      <button type="button" class="secondary small" @click="showPassword = !showPassword">{{ showPassword ? '隐藏' : '显示' }}</button>
    </div>
  </template>

  <template v-if="has('file')">
    <label class="label" for="cf-file">数据库文件</label>
    <div>
      <div class="row">
        <input id="cf-file" v-model="form.file" class="grow" placeholder="例如 C:\data\app.db" spellcheck="false" />
        <button type="button" class="secondary small" @click="browse">浏览…</button>
      </div>
      <p v-if="errors.file" class="field-error">{{ errors.file }}</p>
    </div>
  </template>

  <template v-if="has('dsn')">
    <label class="label" for="cf-dsn">连接串</label>
    <div>
      <textarea
        id="cf-dsn"
        v-model="form.dsn"
        class="full mono"
        rows="3"
        :placeholder="savedSecret ? '已保存，不修改请留空' : 'bigquery://project-id/dataset-id?creds=/path/to/credentials.json'"
        spellcheck="false"
      />
      <p v-if="errors.dsn" class="field-error">{{ errors.dsn }}</p>
      <details class="examples">
        <summary>连接串示例</summary>
        <ul>
          <li v-for="e in CUSTOM_DSN_EXAMPLES" :key="e.label">
            <span class="muted">{{ e.label }}</span> <code>{{ e.example }}</code>
          </li>
        </ul>
        <a href="#" @click.prevent="send({ type: 'openUrl', url: TBLS_DSN_DOC_URL })">tbls 文档：各数据库的连接串格式</a>
      </details>
    </div>
  </template>

  <template v-if="info.security">
    <label class="label" for="cf-sec">{{ info.security.label }}</label>
    <div>
      <select id="cf-sec" v-model="form.security" @change="emit('touch', 'security')">
        <option v-for="o in info.security.options" :key="o.value" :value="o.value">{{ o.label }}</option>
      </select>
    </div>
  </template>
</template>

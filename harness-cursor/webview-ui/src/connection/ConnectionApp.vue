<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import {
  CONNECTION_DRIVERS,
  connectionLabel,
  defaultPort,
  defaultSecurity,
  driverInfo,
  formatParams,
  isLocalHost,
  validateProfile,
  type ConnectionDriver,
} from '@shared/connection';
import type { ConnectionInit, ConnectionResult } from '@shared/connectionProtocol';
import DriverFields from './DriverFields.vue';
import { lines, toProfile, type ConnectionForm } from './form';
import { installTbls, onInit, pickFile, pickTblsPath, run, send, testTbls } from './host';

const DRIVER_ICONS: Record<ConnectionDriver, string> = {
  postgres: '🐘',
  mysql: '🐬',
  mariadb: '🦭',
  sqlserver: '🗄️',
  sqlite: '📄',
  clickhouse: '⚡',
  redshift: '🟥',
  custom: '🔗',
};

const init = ref<ConnectionInit>();
const tab = ref<'connect' | 'import'>('connect');
const form = reactive<ConnectionForm>({
  driver: 'postgres',
  host: 'localhost',
  port: '5432',
  database: '',
  user: '',
  password: '',
  file: '',
  dsn: '',
  security: 'disable',
  schema: '',
  params: '',
  exclude: '',
  include: '',
});
/** Fields the user changed by hand; those stop following the database type / host. */
const touched = reactive({ port: false, security: false });
const advanced = ref(false);
const submitted = ref(false);
const busy = ref<'test' | 'connect' | 'import'>();
const result = ref<{ res: ConnectionResult; signature: string; kind: 'test' | 'connect' }>();
const detailOpen = ref(false);
const imported = ref<{ path: string; name?: string; tables?: number; error?: string }>();
const tblsTesting = ref(false);
const tblsTest = ref<{ ok: boolean; version?: string; error?: string; detail?: string } | undefined>();
const tblsInstalling = ref(false);
const tblsPathPicker = ref(false);
/** Set when the user picks a file: the outcome of validating it. */
const tblsPick = ref<{ path: string; ok: boolean; version?: string; error?: string } | undefined>();

const editing = computed(() => init.value?.mode === 'edit');
const info = computed(() => driverInfo(form.driver));
const profile = computed(() => toProfile(form));
const filters = computed(() => ({ exclude: lines(form.exclude), include: lines(form.include) }));
const signature = computed(() => JSON.stringify([profile.value, filters.value]));
const allErrors = computed(() => validateProfile(profile.value, { passwordOptional: editing.value && !!init.value?.hasSavedPassword }));
const errors = computed(() => {
  if (submitted.value) return allErrors.value;
  const e = allErrors.value;
  return e.port ? { port: e.port } : {};
});
const displayName = computed(() => connectionLabel(profile.value));
const stale = computed(() => !!result.value && result.value.signature !== signature.value);
const remoteWithoutTls = computed(() => {
  const s = info.value.security;
  return !!s && !!form.host.trim() && !isLocalHost(form.host) && form.security === s.local;
});

watch(
  () => form.driver,
  (driver, previous) => {
    if (!touched.port || !form.port.trim() || form.port === String(defaultPort(previous) ?? '')) {
      form.port = String(defaultPort(driver) ?? '');
      touched.port = false;
    }
    if (!touched.security || !driverInfo(driver).security?.options.some((o) => o.value === form.security)) {
      form.security = defaultSecurity(driver, form.host) ?? '';
      touched.security = false;
    }
    if (!form.schema.trim() || form.schema === driverInfo(previous).schemaHint) form.schema = '';
  },
);

watch(
  () => form.host,
  (host) => {
    if (!touched.security) form.security = defaultSecurity(form.driver, host) ?? '';
  },
);

onInit((data) => {
  init.value = data;
  form.driver = data.driver;
  form.port = String(defaultPort(data.driver) ?? '');
  form.security = defaultSecurity(data.driver, form.host) ?? '';
  form.exclude = data.filters.exclude.join('\n');
  form.include = data.filters.include.join('\n');
  form.schema = data.defaultSchema ?? '';
  const p = data.profile;
  if (p) {
    form.host = p.host ?? '';
    form.port = p.port ? String(p.port) : String(defaultPort(p.driver) ?? '');
    form.database = p.database ?? '';
    form.user = p.user ?? '';
    form.file = p.file ?? '';
    form.dsn = p.dsn ?? '';
    form.security = p.security ?? defaultSecurity(p.driver, p.host) ?? '';
    form.params = formatParams(p.params);
    touched.port = !!p.port;
    touched.security = !!p.security;
    advanced.value = !!(p.params && Object.keys(p.params).length) || !!data.defaultSchema;
  }
});

async function submit(kind: 'test' | 'connect') {
  submitted.value = true;
  if (Object.keys(allErrors.value).length || busy.value) return;
  busy.value = kind;
  detailOpen.value = false;
  const sig = signature.value;
  const res =
    kind === 'test'
      ? await run({ type: 'test', profile: profile.value, filters: filters.value })
      : await run({
          type: 'connect',
          profile: profile.value,
          filters: filters.value,
          defaultSchema: form.schema.trim() || undefined,
        });
  busy.value = undefined;
  if (!res.ok && res.message === '已取消') {
    result.value = undefined;
    return;
  }
  result.value = { res, signature: sig, kind };
}

function cancelOrClose() {
  if (busy.value) send({ type: 'cancel' });
  else send({ type: 'close' });
}

async function pickJson() {
  const picked = await pickFile('json');
  if (!picked.path) return;
  imported.value = { path: picked.path, name: picked.name, tables: picked.tables, error: picked.error };
}

async function doImport() {
  if (!imported.value || imported.value.error || busy.value) return;
  busy.value = 'import';
  const res = await run({ type: 'importFile' });
  busy.value = undefined;
  result.value = { res, signature: '', kind: 'connect' };
}

function seconds(ms: number): string {
  return (ms / 1000).toFixed(1);
}

function setTblsPath() {
  send({ type: 'openTblsSettings' });
}

/**
 * Picks a local tbls. The host validates the file before saving it, so the reply tells us
 * whether it actually works — surface that instead of silently reloading the form.
 */
async function chooseTblsPath() {
  if (busy.value || tblsPathPicker.value) return;
  tblsPathPicker.value = true;
  tblsPick.value = undefined;
  try {
    const picked = await pickTblsPath();
    if (!picked.path) return; // dialog cancelled
    tblsPick.value = { path: picked.path, ok: !!picked.ok, version: picked.version, error: picked.error };
    if (picked.ok) send({ type: 'ready' });
  } finally {
    tblsPathPicker.value = false;
  }
}

async function verifyTbls() {
  if (busy.value || tblsTesting.value) return;
  tblsTesting.value = true;
  tblsTest.value = undefined;
  tblsPick.value = undefined;
  try {
    tblsTest.value = await testTbls();
  } finally {
    tblsTesting.value = false;
  }
}

async function downloadTbls() {
  if (busy.value || tblsInstalling.value) return;
  tblsInstalling.value = true;
  tblsTest.value = undefined;
  tblsPick.value = undefined;
  try {
    const res = await installTbls();
    if (res.ok) {
      tblsTest.value = { ok: true, version: res.version ? `已安装 tbls ${res.version}` : `已安装到 ${res.path ?? ''}` };
    } else {
      tblsTest.value = { ok: false, error: res.error ?? '下载失败', detail: res.detail };
    }
    send({ type: 'ready' });
  } finally {
    tblsInstalling.value = false;
  }
}
</script>

<template>
  <div class="page">
    <div v-if="!init" class="muted loading">正在加载…</div>
    <form v-else class="card" @submit.prevent="submit('connect')">
      <h1>{{ editing ? '编辑连接' : '添加数据库' }} <span class="muted">· {{ init.workspaceName }}</span></h1>

      <nav v-if="!editing" class="tabs">
        <button type="button" :class="{ active: tab === 'connect' }" @click="tab = 'connect'">连接数据库</button>
        <button type="button" :class="{ active: tab === 'import' }" @click="tab = 'import'">导入 tbls JSON 文件</button>
      </nav>

      <template v-if="tab === 'connect' || editing">
        <div class="grid">
          <label class="label" for="cf-driver">数据库类型</label>
          <div>
            <select id="cf-driver" v-model="form.driver" class="driver">
              <option v-for="d in CONNECTION_DRIVERS" :key="d.id" :value="d.id">{{ DRIVER_ICONS[d.id] }} {{ d.label }}</option>
            </select>
            <p v-if="info.note" class="muted note">{{ info.note }}</p>
          </div>

          <DriverFields :form="form" :errors="errors" :saved-secret="!!init.hasSavedPassword" @touch="(f) => (touched[f] = true)" />
        </div>

        <p v-if="remoteWithoutTls" class="warn">连接远程数据库建议开启加密。</p>

        <details class="advanced" :open="advanced" @toggle="advanced = ($event.target as HTMLDetailsElement).open">
          <summary>高级选项</summary>
          <div class="grid">
            <label class="label" for="cf-schema">默认 schema</label>
            <input id="cf-schema" v-model="form.schema" class="full" :placeholder="info.schemaHint ?? '留空使用数据库的默认值'" spellcheck="false" />

            <template v-if="form.driver !== 'custom' && form.driver !== 'sqlite'">
              <label class="label" for="cf-params">附加参数</label>
              <div>
                <textarea id="cf-params" v-model="form.params" class="full mono" rows="2" placeholder="每行一个 key=value，例如 application_name=harness" spellcheck="false" />
              </div>
            </template>

            <label class="label" for="cf-exclude">排除的表</label>
            <div>
              <textarea id="cf-exclude" v-model="form.exclude" class="full mono" rows="4" spellcheck="false" />
              <p class="muted note">每行一个，支持 <code>schema.*</code> 这样的通配符。</p>
            </div>

            <label class="label" for="cf-include">只包含的表</label>
            <div>
              <textarea id="cf-include" v-model="form.include" class="full mono" rows="2" placeholder="留空表示全部" spellcheck="false" />
            </div>
          </div>
        </details>

        <div class="grid">
          <span class="label">显示为</span>
          <div class="display-name">
            <strong v-if="displayName">{{ displayName }}</strong>
            <span v-else class="muted">填写连接信息后自动生成</span>
          </div>
        </div>

        <div class="tbls-status">
          <div class="tbls-row">
            <span class="label">tbls</span>
            <div class="tbls-info">
              <template v-if="init.tblsStatus.source === 'bundled'">
                <span v-if="init.tblsStatus.verified" class="ok">✔ 内置 v{{ init.tblsStatus.verifiedVersion ?? init.tblsStatus.bundledVersion }}</span>
                <span v-else class="warn">⚠ 内置 v{{ init.tblsStatus.bundledVersion }} 无法运行{{ init.tblsStatus.error ? `：${init.tblsStatus.error}` : '' }}</span>
                <span class="muted path" :title="init.tblsStatus.resolvedPath">{{ init.tblsStatus.resolvedPath }}</span>
              </template>
              <template v-else-if="init.tblsStatus.source === 'user-configured'">
                <span v-if="init.tblsStatus.verified" class="ok">✔ 本地 tbls {{ init.tblsStatus.verifiedVersion ?? '已验证' }}</span>
                <span v-else class="field-error">✖ 本地 tbls 无法运行{{ init.tblsStatus.error ? `：${init.tblsStatus.error}` : '' }}</span>
                <span class="muted path" :title="init.tblsStatus.resolvedPath">{{ init.tblsStatus.resolvedPath }}</span>
              </template>
              <template v-else>
                <span class="field-error">✖ 还没有内置 tbls（v{{ init.tblsStatus.bundledVersion }}）</span>
              </template>
            </div>
          </div>
          <div class="tbls-actions">
            <button type="button" class="secondary small" @click="downloadTbls" :disabled="!!busy || tblsInstalling">下载内置 tbls</button>
            <button type="button" class="secondary small" @click="chooseTblsPath" :disabled="!!busy || tblsPathPicker">
              {{ tblsPathPicker ? '正在验证…' : '选择本地文件…' }}
            </button>
            <button type="button" class="secondary small" @click="verifyTbls" :disabled="!!busy || tblsTesting">{{ tblsTesting ? '正在测试…' : '测试' }}</button>
          </div>
          <p v-if="tblsPick" class="tbls-info-text" :class="tblsPick.ok ? 'ok' : 'field-error'">
            <template v-if="tblsPick.ok">✔ 已使用本地 tbls {{ tblsPick.version ?? '' }}：{{ tblsPick.path }}</template>
            <template v-else>✖ {{ tblsPick.error }}<br /><span class="muted">没有修改当前设置，请重新选择一个可执行文件。</span></template>
          </p>
          <p v-else-if="tblsTest" class="tbls-info-text" :class="{ ok: tblsTest.ok, 'field-error': !tblsTest.ok }">
            <template v-if="tblsTest.ok">✔ {{ tblsTest.version || '可执行' }}</template>
            <template v-else>✖ {{ tblsTest.error }}</template>
          </p>
          <details v-if="tblsTest?.detail" class="detail">
            <summary>详细信息</summary>
            <pre>{{ tblsTest.detail }}</pre>
          </details>
        </div>

        <p class="muted hint">ⓘ 建议使用只读账号。连接信息（主机、用户名、密码）只保存在系统凭据中，不会写入任何文件。Harness 只读取表结构，不读取表里的数据。</p>
      </template>

      <template v-else>
        <div class="import">
          <p class="muted">选择在其他机器上用 <code>tbls out -t json</code> 导出的文件。以后可以右键"编辑连接…"改为直接连接。</p>
          <div class="row">
            <button type="button" class="secondary" @click="pickJson">选择文件…</button>
            <span v-if="imported" class="path" :title="imported.path">{{ imported.path }}</span>
          </div>
          <p v-if="imported?.error" class="field-error">{{ imported.error }}</p>
          <p v-else-if="imported" class="ok">文件里有 {{ imported.tables }} 张表。</p>
          <div v-if="imported && !imported.error" class="grid">
            <span class="label">显示为</span>
            <div class="display-name"><strong>{{ imported.name }}</strong></div>
          </div>
        </div>
      </template>

      <div v-if="busy" class="status muted">{{ busy === 'import' ? '正在导入…' : '正在连接并读取表结构…' }}</div>
      <div v-else-if="result" class="status" :class="{ stale: stale && result.res.ok }">
        <template v-if="result.res.ok">
          <span v-if="stale">参数已修改，需要重新测试。</span>
          <span v-else class="ok">✔ 连接成功：{{ result.res.tables }} 张表、{{ result.res.relations }} 条关系（用时 {{ seconds(result.res.elapsedMs) }} 秒）</span>
        </template>
        <template v-else>
          <span class="field-error">✖ {{ result.res.message }}</span>
          <button v-if="result.res.action === 'setTblsPath'" type="button" class="secondary small" @click="setTblsPath">设置 tbls 路径</button>
          <button v-else-if="result.res.action === 'downloadTbls'" type="button" class="secondary small" @click="downloadTbls">下载 tbls</button>
          <button v-else-if="result.res.action === 'testTbls'" type="button" class="secondary small" @click="verifyTbls">测试 tbls</button>
          <details v-if="result.res.detail" :open="detailOpen" class="detail" @toggle="detailOpen = ($event.target as HTMLDetailsElement).open">
            <summary>详细信息</summary>
            <pre>{{ result.res.detail }}</pre>
          </details>
        </template>
      </div>

      <footer class="actions">
        <template v-if="tab === 'connect' || editing">
          <button type="button" class="secondary" :disabled="!!busy" @click="submit('test')">{{ busy === 'test' ? '正在测试…' : '测试连接' }}</button>
          <button type="submit" :disabled="!!busy">{{ busy === 'connect' ? '正在连接…' : editing ? '保存' : '连接' }}</button>
        </template>
        <button v-else type="button" :disabled="!imported || !!imported.error || !!busy" @click="doImport">导入</button>
        <button type="button" class="secondary" @click="cancelOrClose">取消</button>
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
  max-width: 640px;
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

.tabs {
  display: flex;
  gap: 4px;
  margin-bottom: 16px;
  border-bottom: 1px solid var(--hn-border);
}

.tabs button {
  padding: 6px 12px;
  border-bottom: 2px solid transparent;
  border-radius: 0;
  color: var(--hn-muted);
  background: transparent;
}

.tabs button.active {
  border-bottom-color: var(--hn-accent);
  color: var(--hn-fg);
}

.grid {
  display: grid;
  grid-template-columns: 110px 1fr;
  gap: 8px 12px;
  align-items: start;
  margin-bottom: 8px;
}

:deep(.label) {
  padding-top: 4px;
  color: var(--hn-muted);
  text-align: right;
}

:deep(.row) {
  display: flex;
  gap: 8px;
  align-items: center;
}

:deep(.grow) {
  flex: 1;
  min-width: 0;
}

:deep(.full) {
  width: 100%;
}

:deep(.port) {
  width: 80px;
}

:deep(.inline-label) {
  color: var(--hn-muted);
}

:deep(.mono) {
  font-family: var(--vscode-editor-font-family, monospace);
}

:deep(.field-error) {
  margin-top: 2px;
  color: var(--hn-missing);
}

:deep(.examples) {
  margin-top: 4px;
  color: var(--hn-muted);
}

:deep(.examples ul) {
  margin: 4px 0;
  padding-left: 16px;
}

:deep(.examples code) {
  word-break: break-all;
}

:deep(a) {
  color: var(--vscode-textLink-foreground, var(--hn-accent));
}

.driver {
  min-width: 240px;
}

.note {
  margin-top: 2px;
  font-size: 12px;
}

.warn {
  margin: 0 0 8px 122px;
  color: var(--hn-mismatch);
}

.advanced {
  margin: 8px 0 12px;
}

.advanced summary {
  margin-bottom: 8px;
  color: var(--hn-muted);
  cursor: pointer;
}

.display-name {
  padding-top: 4px;
  word-break: break-all;
}

.tbls-status {
  margin: 8px 0 12px;
  padding: 10px 12px;
  border-left: 2px solid var(--hn-accent);
  background: var(--hn-node-bg);
}

.tbls-row {
  display: grid;
  grid-template-columns: 110px 1fr;
  gap: 8px 12px;
  align-items: baseline;
}

.tbls-info {
  min-width: 0;
}

.path {
  display: block;
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 12px;
}

.tbls-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}

.tbls-info-text {
  margin: 6px 0 0;
  font-size: 12px;
}

.hint {
  margin: 12px 0;
  padding: 8px 10px;
  border-left: 2px solid var(--hn-accent);
  background: var(--hn-node-bg);
}

.import {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-bottom: 12px;
}

.path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--hn-muted);
}

.status {
  min-height: 20px;
  margin: 12px 0;
}

.status.stale {
  color: var(--hn-muted);
}

.ok {
  color: var(--hn-db-only);
}

.detail {
  margin-top: 6px;
}

.detail pre {
  max-height: 200px;
  overflow: auto;
  padding: 8px;
  background: var(--hn-node-bg);
  white-space: pre-wrap;
  word-break: break-all;
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 8px;
}
</style>

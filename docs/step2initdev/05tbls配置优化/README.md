# tbls 配置优化（问题 1 / 2 / 3）

> **状态：已实施（2026-10-04）。** 本文的问题分析仍然有效；第 5 节"优化方案"里标注 ✅ 的项已落地，第 7 节"影响范围"是实际改动清单，第 8 节"实施顺序"已全部完成。实现细节见 `docs/当前实现文档/README.md` §2 设置项、§5.7.1 tbls 二进制管理、§9 约定。**第 6 节"其他发现"里第 4/5/7/8 项仍未做**，已记入"已知限制"。
>
> 对应反馈：①下载内置 tbls 报 404；②选完本地 tbls 没有任何成功提示；③选完本地 tbls 点"测试"报 `spawn tbls ENOENT`。
> 结论：**三个问题其实是同一个根因链** —— 内置下载地址拼错导致 404（问题 1），而"选择本地文件"把用户选的路径写进设置后没有做**任何存在性与可执行性校验**（问题 2），于是 `resolveTblsPath` 把一个无效值当成有效值返回，最终 `execFile` 找不到可执行文件（问题 3）。
> 本文原为"只做分析、不改代码"的方案文档，代码已按第 5 节实施。代码根目录：`harness-cursor/`（下文路径均相对于它）。

---

## 0. 实施结果速览

| 问题 | 根因 | 修复 | 关键文件 |
| :-- | :-- | :-- | :-- |
| ① 下载 404 | base URL 少了 `/download`；版本号 fallback 到扩展版本（`0.0.4`，tbls 无此 release） | base URL 改为 `.../releases/download` 并对旧值自动归一化；版本改用常量 `BUNDLED_TBLS_VERSION = '1.96.1'`；下载前查 GitHub API 确认 tag 存在 | `shared/tblsConfig.ts`（新增）、`tbls/config.ts`（新增）、`tbls/manager.ts` |
| ② 选文件无提示 | 选完只写设置，不校验、不回填结果；Webview 把返回值丢弃 | 选完先跑 `--version`，**不通过就不写设置**；`tblsPathPicked` 带 `ok` / `version` / `error`，状态行显示 ✔ / ✖ | `connection/connectionPanel.ts`、`shared/connectionProtocol.ts`、`webview-ui/src/connection/ConnectionApp.vue` |
| ③ `spawn tbls ENOENT` | `runTbls` / `db.sync` 读配置写成 `config.get('tblsPath')`（缺 `harness.` 前缀）→ 永远拿默认 `'tbls'`；`looksLikeFile` 失败就当 PATH 名放行 | 所有 `harness.tbls*` 统一走 `readTblsConfig()`；`resolveTbls` 改成分级校验（路径 / PATH 名 / 内置），失败抛带原因的 `TblsResolveError` | `tbls/config.ts`（新增）、`tbls/resolver.ts`、`commands/db.ts` |
| 附：sha256 形同虚设 | 假设包旁有 `.sha256`，实际是 `checksums-<平台>.txt`，取不到就静默跳过 | 改读 `checksums-<平台>.txt` 并按文件名精确匹配；记录 `verified` 标志，`verify()` 不再把未校验当通过 | `shared/tblsConfig.ts`、`tbls/manager.ts` |
| 附：三份重复的 `--version` 实现 | `commands/tbls.ts` / `connectionPanel.ts` 各写一份，`pathExists` 再一份 | 统一到 `tbls/probeVersion.ts`（`probeTblsVersion` / `whichTbls`），失败原因分类 | `tbls/probeVersion.ts`（新增） |
| 附：下载无进度 / 失败留残渣 | 无 `withProgress`、不可取消；`mkdirp` 在 `try` 外 | 流式下载 + 百分比进度 + 取消；失败删除半成品目录；解压后冒烟测试 `--version` | `tbls/manager.ts`、`commands/tbls.ts` |
| 附：状态行假成功 | `buildTblsStatus` 只看"配置里有字符串"，`installedVersion` 还拿内置探测结果冒充 | 探测用户自己的路径，`TblsStatus` 增加 `verified` / `verifiedVersion` / `error` | `connection/connectionPanel.ts` |

回归测试：`test/tblsConfig.test.ts`（新增 20 个用例，含 base URL 归一化、防 404、版本常量解耦、真实 checksums 格式解析）。全量 **160 个单元测试 + typecheck + build 通过**。

---

## 1. 问题 1：下载内置 tbls 报 404

### 1.1 现象

```
下载失败 https://github.com/k1LoW/tbls/releases/v0.0.4/tbls_v0.0.4_windows_amd64.zip 返回 404
```

### 1.2 根因 A：下载地址少了 `/download` 段（**直接原因**）

代码把 base URL 默认值设成了 releases **列表页**，并在这个基础上直接拼 `/v<版本>/<文件名>`：

```10:10:harness-cursor/src/tbls/releases.ts
export function resolveBaseUrl(config: vscode.WorkspaceConfiguration): string {
  return config.get<string>('harness.tblsDownloadBaseUrl', 'https://github.com/k1LoW/tbls/releases').replace(/\/$/, '');
}
```

```92:93:harness-cursor/src/tbls/manager.ts
  const tagVersion = asset.key.version.replace(/^v/, '');
  const url = `${baseUrl.replace(/\/$/, '')}/v${tagVersion}/${asset.filename}`;
```

拼出来是：

```
https://github.com/k1LoW/tbls/releases / v0.0.4 / tbls_v0.0.4_windows_amd64.zip
```

而 GitHub 的**下载**地址必须是 `releases/download/<tag>/<文件>`。已实测：

```
https://github.com/k1LoW/tbls/releases/v1.96.1/tbls_v1.96.1_windows_amd64.zip   → HTTP 404
https://github.com/k1LoW/tbls/releases/download/v1.96.1/tbls_v1.96.1_windows_amd64.zip → HTTP 200
```

**配置文件里的默认值也是错的**，改代码不够，设置项描述必须一起改：

```718:721:harness-cursor/package.json
        "harness.tblsDownloadBaseUrl": {
          "type": "string",
          "default": "https://github.com/k1LoW/tbls/releases",
          "description": "下载内置 tbls 时的基地址。仅在 harness.tblsPath 留空时生效。"
        },
```

> 注：用户如果手动改过 `harness.tblsDownloadBaseUrl`，那报错地址会是他们自己填的值。

### 1.3 根因 B：版本号来源错误，把扩展版本当成了 tbls 版本（**更深的问题**）

`0.0.4` 这个版本号**不是 tbls 的版本**，是 Harness 扩展自己的版本。`resolveVersion` 在用户没有显式配置时，直接 fallback 到扩展版本：

```9:10:harness-cursor/src/tbls/releases.ts
export function resolveVersion(config: vscode.WorkspaceConfiguration, extensionVersion: string): string {
  return config.get<string>('harness.tblsVersion', extensionVersion).replace(/^v/, '');
}
```

`harness.tblsVersion` 的默认值是 `""`，而**空字符串在 `get<string>(key, default)` 里会走 default**（`""` 本身是合法的已设置值，此处是代码里 `|| context.extension.packageJSON.version` 的 fallback 逻辑在起作用）：

```15:15:harness-cursor/src/tbls/ensure.ts
  const version = (config.get<string>('harness.tblsVersion', '') || context.extension.packageJSON.version).replace(/^v/, '');
```

于是链路变成：

| 位置 | 取版本的方式 | 得到的值 |
| :-- | :-- | :-- |
| `ensure.ts` | `tblsVersion \|\| extension.version` | `0.0.4` |
| `connectionPanel.handleInstallTbls` | 同上 | `0.0.4` |
| `connectionPanel.buildTblsStatus` | 同上 | `0.0.4` |
| `commands/tbls.ts extensionVersion()` | `resolveVersion(config, ext.version)` | `0.0.4` |

**即使修好了 `/download`，下载 `v0.0.4` 依然会 404**，因为 tbls 根本没有 `v0.0.4` 这个 release（已实测 `api.github.com/repos/k1LoW/tbls/releases/tags/v0.0.4` → 404）。tbls 最新是 `v1.96.1`。

这是一个**设计层面的耦合错误**：把"Harness 扩展的版本"和"Harness 捆绑的 tbls 的版本"绑在一起。扩展升到 0.0.5 就会去下载 `tbls v0.0.5`，而 tbls 的版本号空间是 1.x，两者不可能对齐。

### 1.4 根因 C：sha256 校验文件的假设不成立（校验形同虚设）

代码假设每个压缩包旁边有一个同名 `.sha256` 文件：

```174:183:harness-cursor/src/tbls/manager.ts
/** Tries to fetch a sibling sha256 file; returns undefined if not present. */
async function tryFetchSha256(fetchImpl: typeof fetch, archiveUrl: string, filename: string): Promise<string | undefined> {
  try {
    const shaUrl = archiveUrl.replace(/[^/]+$/, `${filename}.sha256`);
    const res = await fetchImpl(shaUrl);
    if (!res.ok) return undefined;
    const text = (await res.text()).trim().split(/\s+/)[0] ?? '';
    return text || undefined;
  } catch {
    return undefined;
  }
}
```

但 tbls 实际发布的是**按平台分文件**的 `checksums-<平台>.txt`，不是逐包 `.sha256`。实测 `tbls_v1.96.1_windows_amd64.zip.sha256` 必然 404，于是 `tryFetchSha256` 静默返回 `undefined`：

```100:107:harness-cursor/src/tbls/manager.ts
    if (sha) {
      const actual = await sha256OfFile(archivePath);
      if (actual.toLowerCase() !== sha.toLowerCase()) {
        throw new Error(`tbls 下载校验失败（sha256 不匹配）。期望 ${sha}，下载 ${actual}`);
      }
    }
```

`sha` 为空 → **整段校验被跳过**，并且 `CurrentRecord.sha256` 记成 `''`：

```118:125:harness-cursor/src/tbls/manager.ts
    const record: CurrentRecord = {
      version: tagVersion,
      platform: asset.key.platform,
      arch: asset.key.arch,
      filename: asset.filename,
      sha256: sha ?? '',
      installedAt: new Date().toISOString(),
      source: 'downloaded',
    };
```

`verify()` 也因为 `if (record.sha256)` 为假而直接返回 `ok: true` —— **装一个损坏的二进制也能"自检通过"**。

### 1.5 根因 D：`manager.ts` 里 `readCurrent` 的返回类型不一致（有潜在崩溃风险）

```38:46:harness-cursor/src/tbls/manager.ts
export async function readCurrent(context: vscode.ExtensionContext): Promise<CurrentRecord | undefined> {
  if (!(await exists(currentFile(context)))) return undefined;
  try {
    const text = await readText(currentFile(context));
    const parsed = JSON.parse(text) as CurrentRecord;
    if (!parsed.version || !parsed.platform || !parsed.arch || !parsed.filename) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}
```

这段本身没问题，但 `verify()` 内部对 `asset` 的使用要注意：

```152:155:harness-cursor/src/tbls/manager.ts
  if (!asset) return { ok: false, record, reason: '当前平台的二进制不支持' };
  const dir = vscode.Uri.joinPath(binDir(context), binDirName(asset));
  const bin = binaryPathIn(dir, asset);
  if (!(await exists(bin))) return { ok: false, record, reason: '找不到已安装的 tbls 二进制' };
```

（这一处是安全的，仅记录以免后续改动时误用。）

### 1.6 关于 `binDirName` 的历史文档偏差

早期方案文档（`04tbls配置/03-推荐方案.md`）写的是 `tbls-1.96.0-windows-amd64` 和 `tbls_1.96.0_windows_amd64.zip`（**没有 `v` 前缀**），而实测 tbls 真实资产名是 `tbls_v1.96.1_windows_amd64.zip`（**有 `v`**）。**当前代码是对的**（`pickAsset` 用了 `v${v}`），是旧文档过时了。优化时应同步修正文档，避免后续按旧文档"改回"错误命名。

---

## 2. 问题 2：选择本地 tbls 后没有任何成功提示

### 2.1 现象与根因

`handlePickTblsPath` 拿到文件后**只做了两件事**：写设置、回复 webview。**没有做任何校验，也没有通知**：

```417:430:harness-cursor/src/connection/connectionPanel.ts
  private async handlePickTblsPath(requestId: string): Promise<void> {
    const [file] = (await vscode.window.showOpenDialog({
      title: '选择 tbls 可执行文件',
      canSelectMany: false,
      filters: { '所有文件': ['*'] },
    })) ?? [];
    if (!file) {
      this.post({ type: 'tblsPathPicked', requestId });
      return;
    }
    await vscode.workspace.getConfiguration('harness').update('tblsPath', file.fsPath, vscode.ConfigurationTarget.Global);
    this.post({ type: 'tblsPathPicked', requestId, path: file.fsPath });
  }
```

协议类型里**预留了 `error` 字段但主进程从不填**，Webview 侧也**根本不读**：

```56:59:harness-cursor/src/shared/connectionProtocol.ts
  | { type: 'filePicked'; requestId: string; path?: string; name?: string; tables?: number; error?: string }
  | { type: 'tblsPathPicked'; requestId: string; path?: string; error?: string }
  | { type: 'tblsTested'; requestId: string; ok: boolean; version?: string; error?: string }
  | { type: 'tblsInstalled'; requestId: string; ok: boolean; path?: string; error?: string };
```

```62:67:harness-cursor/webview-ui/src/connection/host.ts
export async function pickTblsPath(): Promise<Omit<TblsPathPicked, 'type' | 'requestId'>> {
  const reply = await request({ type: 'pickTblsPath' });
  if (reply.type !== 'tblsPathPicked') return {};
  const { type: _type, requestId: _id, ...rest } = reply;
  return rest;
}
```

```176:183:webview-ui/src/connection/ConnectionApp.vue
async function chooseTblsPath() {
  if (busy.value || tblsPathPicker.value) return;
  tblsPathPicker.value = true;
  try {
    await pickTblsPath();
    send({ type: 'ready' });
  } finally {
    tblsPathPicker.value = false;
  }
}
```

`await pickTblsPath()` 的**返回值被整个丢弃**。唯一的反馈是 `send({type:'ready'})` 触发的 `sendInit` → `buildTblsStatus()`，而它只看设置里**有没有字符串**：

```193:209:harness-cursor/src/connection/connectionPanel.ts
  private async buildTblsStatus(): Promise<TblsStatus> {
    const config = vscode.workspace.getConfiguration('harness');
    const configuredPath = (config.get<string>('harness.tblsPath', '') || '').trim();
    const bundledVersion = (config.get<string>('harness.tblsVersion', '') || this.h.context.extension.packageJSON.version).replace(/^v/, '');
    const installed = await probe(this.h.context, bundledVersion);
    if (configuredPath) {
      return {
        source: 'user-configured',
        bundledVersion,
        installedVersion: installed ? bundledVersion : undefined,
        resolvedPath: configuredPath,
      };
    }
```

所以哪怕用户选了**一个 txt 文件**，状态行也会显示 `⚠ 使用本地 tbls` + 该路径 —— **假成功**。设置行也只显示路径，不显示"已验证可用"。

### 2.2 缺失的成功校验

应该在选择之后立刻做**一次真实的可执行性探测**（`--version`），代码里其实已有现成能力，只是没在选文件的路径上用：

```432:446:harness-cursor/src/connection/connectionPanel.ts
  private async handleTestTbls(requestId: string): Promise<void> {
    try {
      const path = await resolveTblsPath(this.h.context, undefined, { extensionVersion: this.h.context.extension.packageJSON.version as string });
      const { execFile } = await import('node:child_process');
      const version = await new Promise<string>((resolve, reject) => {
        execFile(path, ['--version'], { timeout: 10_000, windowsHide: true }, (err, stdout) => {
          if (err) reject(err);
          else resolve(String(stdout).trim());
        });
      });
      this.post({ type: 'tblsTested', requestId, ok: true, version });
    } catch (err) {
      this.post({ type: 'tblsTested', requestId, ok: false, error: (err as Error).message });
    }
  }
```

`commands/tbls.ts` 里的 `runTblsVersion` + `pathExists` 是同一套逻辑的第二份实现（见 §5 去重建议）。

### 2.3 顺带发现：`buildTblsStatus` 的 `installedVersion` 语义错误

```203:206:harness-cursor/src/connection/connectionPanel.ts
      return {
        source: 'user-configured',
        bundledVersion,
        installedVersion: installed ? bundledVersion : undefined,
        resolvedPath: configuredPath,
      };
```

`installed` 是 `probe(context, bundledVersion)`，即查的是**内置目录**里的二进制，跟用户配的本地路径毫无关系。用它决定 `installedVersion` 会让 UI 显示"内置已安装 vX"这种和当前路径无关的信息。应为 `user-configured` 场景单独探测用户路径。

---

## 3. 问题 3：点"测试"报 `spawn tbls ENOENT`

### 3.1 根因 A：配置键名错误，`harness.` 前缀丢失（**最致命**）

`connectionPanel.runTbls` 读配置时**少写了 `harness.` 前缀**：

```255:262:harness-cursor/src/connection/connectionPanel.ts
        tblsPath: await resolveTblsPath(
          this.h.context,
          config.get<string>('tblsPath', 'tbls') || 'tbls',
          { extensionVersion: this.h.context.extension.packageJSON.version as string },
        ),
```

`vscode.workspace.getConfiguration('harness')` 之后，读键必须是 `'tblsPath'`，**不能**是 `'harness.tblsPath'`。所以这一行**永远读不到用户在连接页"选择本地文件"时写入的值**（`handlePickTblsPath` 里 `.update('tblsPath', ...)` 写的是 `harness.tblsPath`）。

它永远拿到 default `'tbls'`，于是 `resolveTblsPath` 收到 `configured = 'tbls'`：

```39:47:harness-cursor/src/tbls/resolver.ts
export async function resolveTblsPath(
  context: vscode.ExtensionContext,
  configured: string | undefined,
  options: ResolveOptions,
): Promise<string> {
  const config = vscode.workspace.getConfiguration('harness');
  const configuredPath = (configured ?? getConfiguredTblsPath(config)).trim();

  if (configuredPath) {
    if (await looksLikeFile(configuredPath)) return configuredPath;
    // Looks like a PATH-style name; trust it and let the runner surface errors.
    return configuredPath;
  }
```

`'tbls'` 被当成 **PATH 命令名**原样返回。`runner.ts` 执行时：

```86:91:harness-cursor/src/tbls/runner.ts
        if (err) {
          const e = err as NodeJS.ErrnoException & { killed?: boolean };
          if (e.code === 'ENOENT') {
            reject(new TblsError(`找不到 tbls 可执行文件：${file}。可以打开设置把 harness.tblsPath 指向本地 tbls，或清空它让 Harness 自动下载内置版本。`, 'notFound'));
          } else if (e.name === 'AbortError' || options.signal?.aborted) {
```

`execFile('tbls', ...)` 在 Windows 上找不到 `tbls.exe` → `ENOENT`。

**这解释了为什么"选择成功了"却仍然 ENOENT**：设置里其实已经有用户选的那个文件了，只是这段代码没读到它。

### 3.2 根因 B：`getConfiguredTblsPath` 的默认值是 `'tbls'`，与整体设计冲突

```9:12:harness-cursor/src/tbls/resolver.ts
/** Reads the raw user-configured path; `""` means "use bundled/downloaded version". */
export function getConfiguredTblsPath(config: vscode.WorkspaceConfiguration): string {
  return config.get<string>(CONFIG_KEY, 'tbls');
}
```

`CONFIG_KEY = 'harness.tblsPath'`（相对 `getConfiguration('harness')` 而言多了一次前缀）。注释说 `""` 表示用内置版本，但默认值给的是 `'tbls'`，**默认值本身就会绕过内置下载**。`package.json` 里 `harness.tblsPath` 的默认值是 `""`，所以实际运行时会取 `""`；但这个函数作为"库"的自带默认值是错的，任何直接调用它的路径都会拿到 `'tbls'`。

### 3.3 根因 C：`looksLikeFile` 的判断过于宽松，把无效值当成有效值

```67:76:harness-cursor/src/tbls/resolver.ts
async function looksLikeFile(path: string): Promise<boolean> {
  // Absolute / relative paths with separators are files; names without separators are PATH entries.
  if (!path.includes('/') && !path.includes('\\')) return false;
  try {
    const stat = await fs.stat(path);
    return stat.isFile();
  } catch {
    return false;
  }
}
```

`resolveTblsPath` 里"不是文件 → 就当 PATH 命令名 → 直接返回"，这个假设是问题 3 的放大器：**任何拼错的绝对路径、任何 Windows Store 应用的假 `tbls` 命令名，都会一路带到 `execFile` 才失败**。

### 3.4 同样的键名 bug 在 `db.ts` 里也有一份

```36:40:harness-cursor/src/commands/db.ts
    const tblsPath = await resolveTblsPath(
      h.context,
      config.get<string>('tblsPath', 'tbls') || 'tbls',
      { extensionVersion: h.context.extension.packageJSON.version as string },
    );
```

同样的 `'tblsPath'`（缺前缀）+ 同样的 `|| 'tbls'`。**所以"同步数据库"这条路径也永远用不上用户配置的本地 tbls**，会去下载内置版本（然后撞上问题 1 的 404）。

### 3.5 配置键名不一致总表

| 位置 | 读取写法 | 正确？ |
| :-- | :-- | :-- |
| `resolver.ts` `getConfiguredTblsPath` | `config.get('harness.tblsPath', 'tbls')`，`config = getConfiguration('harness')` | ✗ 键多前缀 + 默认值应为 `''` |
| `ensure.ts` | `config.get('harness.tblsPath', '')`，同上 | ✗ 键多前缀（`''` 时侥幸正确） |
| `commands/tbls.ts` | `getConfiguration('harness').get('harness.tblsPath', '')` | ✗ 键多前缀 |
| `commands/tbls.ts` | `openSettings('harness.tblsPath')` | ✔ |
| `connectionPanel.buildTblsStatus` | `config.get('harness.tblsPath', '')` | ✗ 键多前缀 |
| `connectionPanel.runTbls` | `config.get('tblsPath', 'tbls')` | ✔ 键名对，但默认值 `'tbls'` 错 |
| `db.ts` sync | `config.get('tblsPath', 'tbls')` | ✔ 键名对，但默认值 `'tbls'` 错 |
| `releases.ts` | `config.get('harness.tblsVersion')` / `('harness.tblsDownloadBaseUrl')` | ✗ 键多前缀 |
| `connectionPanel.handleInstallTbls` | `config.get('harness.tblsVersion', '')` | ✗ 键多前缀 |

**规律**：`getConfiguration('harness')` 之后要么用短键（`tblsPath`），要么用 `getConfiguration()`（无 section）配长键（`harness.tblsPath`）。当前代码两种写法混用，**13 处里 8 处键名是错的**。

---

## 4. 三个问题的因果链

```
问题1（404）
  根因A：base URL 少了 /download
  根因B：版本号 fallback 到扩展版本（0.0.4），tbls 无此 release
        ↓
  结果：内置 tbls 永远装不上
        ↓
问题2（无提示）
  根因：handlePickTblsPath 不校验、不通知，UI 假成功
        ↓
问题3（ENOENT）
  根因A：runTbls 读 'tblsPath'（缺前缀）→ 读不到用户设置 → 拿到 'tbls'
  根因B：getConfiguredTblsPath 默认值 'tbls' 绕过内置
  根因C：looksLikeFile 失败就当 PATH 名，不报错
        ↓
  结果：用户选的本地 tbls 被完全忽略，execFile('tbls') → ENOENT
```

**修复顺序建议**：键名 bug（§3.1/§3.4）→ base URL（§1.2）→ 版本号解耦（§1.3）→ 选文件校验（§2）→ sha256（§1.4）→ 路径校验（§3.3）。

---

## 5. 优化方案

### 5.1 统一配置读取（P0，直接修掉问题 3）

**新增 `src/tbls/config.ts`**，成为配置读取的唯一入口：

```typescript
// src/tbls/config.ts —— 唯一的配置读取入口，禁止其它文件直接 getConfiguration
import * as vscode from 'vscode';

export interface TblsConfig {
  /** 用户指定的本地 tbls 路径；"" = 用内置下载的版本 */
  tblsPath: string;
  /** 要下载的内置 tbls 版本；默认走 BUNDLED_TBLS_VERSION 常量，不是扩展版本 */
  version: string;
  baseUrl: string;
  autoDownload: boolean;
  timeoutSeconds: number;
}

/** 内置 tbls 的目标版本。与扩展版本解耦，升级扩展不会影响它。 */
export const BUNDLED_TBLS_VERSION = '1.96.1';

/** 必须是 releases/download/<tag>，不是 releases 列表页 */
export const DEFAULT_TBLS_DOWNLOAD_BASE_URL =
  'https://github.com/k1LoW/tbls/releases/download';

export function readTblsConfig(extensionVersion: string): TblsConfig {
  const c = vscode.workspace.getConfiguration('harness');
  return {
    tblsPath: (c.get<string>('tblsPath', '') || '').trim(),
    version: (c.get<string>('tblsVersion', '') || BUNDLED_TBLS_VERSION).replace(/^v/, ''),
    baseUrl: (c.get<string>('tblsDownloadBaseUrl', '') || DEFAULT_TBLS_DOWNLOAD_BASE_URL).replace(/\/$/, ''),
    autoDownload: c.get<boolean>('tblsAutoDownload', true),
    timeoutSeconds: Math.max(5, c.get<number>('tblsTimeoutSeconds', 120)),
  };
}
```

然后把 §3.5 表里 8 处错误读法全部替换成 `readTblsConfig(...)`。配套加 lint 规则 / code review 检查项：**`getConfiguration('harness')` 之后不允许出现 `'harness.` 开头的键**。

**下载 URL 拼装**改为以 `.../releases/download` 为基准，拼 tag + 文件名：

```
${baseUrl}/${'v' + version}/${filename}
→ https://github.com/k1LoW/tbls/releases/download/v1.96.1/tbls_v1.96.1_windows_amd64.zip
```

同时**保持对旧值的兼容**：如果用户配置里存的还是不含 `/download` 的旧值（列表页），`readTblsConfig` 里做一次归一化 —— 结尾是 `/releases` 就补成 `/releases/download`。避免老用户升级后继续 404。

### 5.2 版本号与扩展版本解耦（P0，修掉 404 的深层原因）

三条要求：

1. **常量 `BUNDLED_TBLS_VERSION = '1.96.1'`** 写死在代码里，作为内置版本。**绝不再 fallback 到 `extension.packageJSON.version`**。
2. `harness.tblsVersion` 的语义改成"覆盖内置版本"，默认 `""`，空 = 用常量。`package.json` 描述同步改。
3. 加一个**版本存在性预检**：下载前先请求 GitHub API（`https://api.github.com/repos/k1LoW/tbls/releases/tags/v<version>`），404 就直接报"tbls v<version> 不存在"，而不是先拼一个必然 404 的下载 URL。

> 备选：用 `https://api.github.com/repos/k1LoW/tbls/releases/latest` 拿 `tag_name`，这样连版本号都不用配。缺点是依赖 GitHub API（未认证有 60 次/小时限流）+ 内网用户拿不到。**建议做成两段式**：默认用常量，用户显式配置了 `tblsVersion` 才走 API 预检。

### 5.3 下载与校验（P1）

**sha256 改成读 `checksums-<平台>.txt`**（实测格式为 `<64位hex>  <文件名>`，两个空格分隔）：

```
https://github.com/k1LoW/tbls/releases/download/v1.96.1/checksums-windows.txt
https://github.com/k1LoW/tbls/releases/download/v1.96.1/checksums-linux.txt
https://github.com/k1LoW/tbls/releases/download/v1.96.1/checksums-darwin.txt
```

要点：

- 解析时**按文件名精确匹配**，不要只取第一行。
- 拿不到 checksums 时**不要静默跳过**：`CurrentRecord` 增加 `verified: boolean`，`verify()` 在 `verified === false` 时返回"未校验"，而不是 `ok: true`。
- `install()` 步骤改为：探测已有 → 下载压缩包 → 取 checksums → 校验 → 解压 → **冒烟测试（`--version`）** → 写 `tbls.current.json`。任一步失败清理临时目录**并删除半成品目录**（当前 `install` 失败时会把已建好的空 `bin/tbls-*/` 留在盘上）。
- 加 `withProgress` + `CancellationToken`（下载大文件时用户无法取消，见 §6）。

### 5.4 选本地文件时的成功校验（修掉问题 2）

`handlePickTblsPath` 改为**选完立即探测**，不通过就**不写设置**：

```
选中文件
  ├─ stat：存在吗？是文件吗？        ──否→ 报错，不写设置
  ├─ Windows 下检查扩展名是 .exe/.cmd/.bat ──否→ 提示"看起来不是 Windows 可执行文件"
  ├─ execFile(path, ['--version'])  ──失败→ 报错（ENOENT / 权限 / 缺 DLL 等分类提示），不写设置
  ├─ 成功 → 写 harness.tblsPath = path
  ├─ 回 tblsPathPicked { ok:true, version, path }
  └─ Webview 显示 ✔ 已验证：tbls version 1.96.1（<路径>）
```

协议与 UI：

- `TblsStatus` 扩展为 `{ source, bundledVersion, installedVersion?, resolvedPath?, verified?: boolean, verifiedVersion?: string, error?: string }`。
- `user-configured` 且未验证 → 状态行显示 `⚠ 使用本地 tbls（未验证）` + 一个"验证"按钮；已验证 → `✔ 本地 tbls 1.96.1`。
- `pickTblsPath` 的返回值**必须被消费**（现在被 `await pickTblsPath()` 丢弃），失败时把 `error` 显示在状态行下方（复用现有的 `tblsTest` 区域）。
- **不再自动触发整页 `sendInit`**：现在 `chooseTblsPath` 成功后发 `ready` 重拉 init，丢失了滚动位置等本地状态。改为只更新状态行。

### 5.5 路径解析健壮性（修掉问题 3 的放大器）

`resolveTblsPath` 改为**分级策略**，不再"猜"：

```
configured 非空
  ├─ 像路径（含分隔符）
  │    ├─ 存在且是文件 → 再 execFile('--version') 探测 → 成功返回
  │    └─ 不存在/不是文件 → 抛 TblsResolveError('bad-path', 明确提示"配置的路径不存在")
  └─ 纯名字（无分隔符，当 PATH 命令）
       ├─ 用 which/where 找到 → 返回绝对路径
       └─ 找不到 → 抛 TblsResolveError('not-on-path', "PATH 里没有 tbls，请用『选择本地文件…』指定绝对路径")
```

新增 `TblsResolveError` 的 reason：

```typescript
export class TblsResolveError extends Error {
  constructor(
    public readonly reason:
      | 'missing-bundled'   // 内置没装
      | 'download-failed'   // 内置下载失败
      | 'bad-path'          // 配的路径不存在
      | 'not-on-path'       // 配的名字在 PATH 里找不到
      | 'not-executable',   // 路径存在但跑不起来
    message?: string,
  ) { ... }
}
```

`friendlyMissingTblsError` 相应扩充（`bad-path` / `not-on-path` / `not-executable` 都应给 `action: 'setTblsPath'`，但文案不同），并让连接页状态行在 `user-configured` 时**主动显示探测结果**，而不是等到用户点"测试"。

### 5.6 去重：`--version` 探测只有一份实现

现在 `runTblsVersion`（`commands/tbls.ts`）、`handleTestTbls`（`connectionPanel.ts`）、`pathExists`（`commands/tbls.ts`）是三份近似实现。抽到 `src/tbls/probeVersion.ts`：

```typescript
export interface TblsVersionInfo {
  ok: boolean;
  version?: string;   // 解析出的语义化版本，如 '1.96.1'
  raw?: string;       -- 原始 stdout 首行，如 'tbls version 1.96.1'
  reason?: 'notFound' | 'permission' | 'notExecutable' | 'timeout';
  error?: string;     // 已遮罩、可直接展示
}

export function probeTblsVersion(tblsPath: string, opts?: { timeoutMs?: number }): Promise<TblsVersionInfo>;
export function whichTbls(name: string): Promise<string | undefined>;
```

统一从 `tbls version 1.96.1` 里用正则 `/(\d+\.\d+\.\d+)/` 抽出版本号（当前代码是把整行塞进 `version` 字段，UI 显示会很怪）。

---

## 6. 其他发现（非本次反馈，但相关）

| # | 位置 | 问题 |
| :-- | :-- | :-- |
| 1 | `ensure.ts` / `manager.ts` | 下载**无进度、不可取消**。tbls 压缩包几十 MB，`activate` 时静默下载 + 手动下载都没有进度条，失败也只有 console.error |
| 2 | `ensure.ts` | 自动下载失败**只写 console**，用户完全无感。应在通知区给一条可点击的提示 |
| 3 | `manager.ts install` | 失败时**残留空目录**（`mkdirp(dir)` 在 try 之前，异常时 finally 只清 tmpDir） |
| 4 | `manager.ts probe` | `pickAsset(record.platform, record.arch, record.version)` 用**记录里的** platform/arch 而非当前机器。跨机器复制 globalStorage 后会算出错误目录 |
| 5 | `manager.ts` | `readCurrent` 只有**一个** `tbls.current.json`，而目录设计是**多版本并存**（`bin/tbls-<v>-<plat>-<arch>/`）。`checkUpdate` 里"已安装版本 vs 内置版本"的比较实际上永远等于内置版本（`installedVersion = current?.version ?? bundledVersion`，而 `probe` 已在前面校验过 `record.version === bundledVersion`） |
| 6 | `connectionPanel.handleTestTbls` | 传 `undefined` 让 `resolveTblsPath` 自己读配置，**绕过了 runTbls 的解析路径** —— 测试成功不代表"测试连接"能用 |
| 7 | `manager.ts extractZip` | 手写 ZIP 解析**不支持 ZIP64**；`compSize === 0xFFFFFFFF` 时会写错偏移。tbls 包目前不超 4GB，但脆 |
| 8 | `extractZip` | `offset` 推进靠 `compSize`，遇到**数据描述符（bit 3）**的条目会错位。tbls 用 Go 的 `zip.Writer` 生成，一般不设描述符，但值得加注释说明这个前提 |
| 9 | `commands/tbls.ts pathExists` | 用 `execFile('where', [p])` 判存在，但 `where` 会找到**目录**和**多个**结果；且 Windows 上 `where tbls` 在 tbls 不在 PATH 时返回非 0，报错文案不够准 |
| 10 | `package.json` | `harness.tblsVersion` 描述"留空时使用扩展的版本号" —— **这个描述本身就是错的**，是 bug 的文档化 |

---

## 7. 影响范围

| 文件 | 改动 | 优先级 |
| :-- | :-- | :-- |
| `src/tbls/config.ts`（新增） | 统一配置入口 + `BUNDLED_TBLS_VERSION` + base URL 归一化 | P0 |
| `src/tbls/probeVersion.ts`（新增） | `--version` 探测 / `which` 的唯一实现 | P1 |
| `src/tbls/releases.ts` | 改用 `readTblsConfig`，删掉 `resolveVersion` 的扩展版本 fallback | P0 |
| `src/tbls/manager.ts` | base URL 修正、`checksums-<平台>.txt` 校验、失败清理、`verified` 字段、下载进度/取消 | P0/P1 |
| `src/tbls/resolver.ts` | 分级解析、`TblsResolveError` 新 reason、默认值 `''` | P0 |
| `src/tbls/ensure.ts` | 改用 `readTblsConfig`，失败给用户通知 | P0 |
| `src/connection/connectionPanel.ts` | `runTbls` 键名修正、`handlePickTblsPath` 加校验、`buildTblsStatus` 正确探测、`TblsStatus` 扩展 | P0 |
| `src/commands/db.ts` | `sync` 的键名修正 | P0 |
| `src/commands/tbls.ts` | 改用 `readTblsConfig` / `probeTblsVersion`，去掉 `pathExists` | P1 |
| `src/connection/errors.ts` | 新 reason 的友好文案 | P1 |
| `src/shared/connectionProtocol.ts` | `TblsStatus` 扩展、`tblsPathPicked` 加 `ok`/`version` | P0 |
| `webview-ui/src/connection/host.ts` | `pickTblsPath` 返回值透传 | P0 |
| `webview-ui/src/connection/ConnectionApp.vue` | 消费 `pickTblsPath` 结果、状态行显示验证状态、不再重发 `ready` | P0 |
| `webview-ui/src/dev/mockConnectionHost.ts` | mock 同步 | P1 |
| `package.json` | `harness.tblsDownloadBaseUrl` 默认值改 `.../releases/download`；`harness.tblsVersion` 描述改对 | P0 |
| `test/tbls.test.ts` | 补 base URL 拼接、版本常量、checksums 解析的用例 | P0 |
| `test/config.test.ts`（新增） | 配置读取（短键 vs 长键）的回归测试 | P0 |
| `docs/当前实现文档/README.md` | §2 设置表、§5.7.1 二进制管理同步更新 | P1 |
| `docs/step2initdev/04tbls配置/03-推荐方案.md` | 修正资产命名（`tbls_v1.96.1_...`，有 `v` 前缀） | P2 |

---

## 8. 实施顺序

**第一批（修 3 个反馈问题）**

1. `src/tbls/config.ts` + 全量替换配置读取（含 8 处键名修正）
2. `package.json` base URL 默认值 + `BUNDLED_TBLS_VERSION` 常量
3. `resolver.ts` 分级解析 + 新 reason
4. `handlePickTblsPath` 加校验 + 协议/UI 显示
5. `test/config.test.ts`（**必须**：键名 bug 就是缺回归测试导致的）

**第二批（质量）**

6. `probeVersion.ts` 去重 + `commands/tbls.ts` 改写
7. checksums 校验 + `verified` 字段
8. 下载进度 / 取消 / 失败清理

**第三批（文档一致性）**

9. `README.md` §2 / §5.7.1
10. 旧方案文档的资产命名修正
11. §6 表里 4/5/7/8/10 各项

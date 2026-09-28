# 01 Webview 接入 Vite 热更新

## 一、现状和目标

插件由两部分组成，热更新的做法不一样：


| 部分         | 代码位置            | 运行环境            | 能否热更新                                  |
| ---------- | --------------- | --------------- | -------------------------------------- |
| 插件主进程      | `src/**/*.ts`   | Node.js（扩展宿主进程） | **不能**。VS Code 没有提供模块热替换，只能重新构建后重启扩展宿主 |
| Webview 页面 | `webview-ui/`** | 编辑器里嵌入的浏览器页面    | **能**。让 Webview 直接加载 Vite 开发服务器上的页面即可  |


现在 `CanvasPanel.renderHtml()` 固定加载 `dist/webview/index.js`，所以每次改 Webview 代码都要重新执行 `vite build`，然后关闭再打开画板。

改造后的目标：

- 修改 `.vue` 或 `.css` 文件，画板在 1 秒内更新，组件状态（缩放、选中项、当前页签）保留。
- 修改 Webview 里的普通 `.ts` 文件，最多刷新一次页面，刷新后插件自动重新推送数据。
- 正式打包的产物和现在完全一样，不包含任何开发服务器相关的代码。
- 额外提供"浏览器独立调试模式"：不启动插件，直接在浏览器里打开画板，用本地样例数据调试界面。

## 二、方案选择


| 方案                                                                            | 说明                                                          | 结论                                                              |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------- |
| A. 自己实现：开发模式下 Webview 的 HTML 指向 Vite 开发服务器：开发模式下 Webview 的 HTML 指向 Vite 开发服务器 | 改动集中在 `renderHtml()` 和 `vite.config.mts`，大约 60 行代码，CSP 完全可控 | **采用**                                                          |
| B. 社区插件 `@tomjs/vite-plugin-vscode`                                           | 把插件主进程和 Webview 都交给 Vite 构建，自动注入开发地址                        | 不采用。它要接管插件主进程的构建（我们用的是 esbuild），并且会自己生成 CSP，多个 Webview 的场景下不好控制 |


## 三、工作原理

```
┌──────────────── Cursor（扩展开发宿主窗口）────────────────┐
│  插件主进程                                                │
│   └─ 开发模式：生成的 HTML 指向 http://localhost:5173      │
│                                                           │
│  Webview（画板）                                           │
│   ├─ <script src="http://localhost:5173/@vite/client">    │──── WebSocket（热更新通知）
│   └─ <script src="http://localhost:5173/src/main.ts">     │──── HTTP（按需加载模块）
└───────────────────────────────────────────────────────────┘
                              │
                     Vite 开发服务器（npm run dev:webview）
```

Webview 本质上是一个浏览器页面。只要 CSP 允许，它就可以从本机的 Vite 开发服务器加载模块，并通过 WebSocket 接收热更新通知。

## 四、改动明细

### 4.1 如何判断"开发模式"

两个条件**同时满足**时才使用开发服务器：

1. `context.extensionMode === vscode.ExtensionMode.Development`，也就是通过 F5 启动的扩展开发宿主。
2. 环境变量 `HARNESS_WEBVIEW_DEV_URL` 有值，例如 `http://localhost:5173`。这个变量由 `launch.json` 注入。

这样安装后的正式插件永远不会去访问 localhost。F5 调试时，也可以选择不带热更新的启动配置，调试构建产物。

### 4.2 抽出公共的 HTML 生成函数

后面会有多个 Webview（画布编辑器、可能还有设计表单），所以把 `renderHtml()` 抽到 `src/webview/html.ts`：

```ts
export interface WebviewHtmlOptions {
  webview: vscode.Webview;
  context: vscode.ExtensionContext;
  title: string;
}

export function renderWebviewHtml(opts: WebviewHtmlOptions): string {
  const devUrl = getDevServerUrl(opts.context); // 不满足 4.1 的两个条件时返回 undefined
  return devUrl ? renderDevHtml(opts, devUrl) : renderProdHtml(opts);
}
```

`renderProdHtml` 就是现在 `CanvasPanel.renderHtml()` 的内容，不做改动。

### 4.3 开发模式的 HTML 和 CSP

```html
<meta http-equiv="Content-Security-Policy" content="
  default-src 'none';
  img-src ${cspSource} ${devUrl} data:;
  style-src ${cspSource} ${devUrl} 'unsafe-inline';
  font-src ${cspSource} ${devUrl};
  script-src 'nonce-${nonce}' ${devUrl};
  connect-src ${devUrl} ${devWsUrl};
">
...
<div id="app"></div>
<script type="module" nonce="${nonce}" src="${devUrl}/@vite/client"></script>
<script type="module" nonce="${nonce}" src="${devUrl}/src/main.ts"></script>
```

说明：

- `devWsUrl` 由 `devUrl` 转换得到，比如 `http://localhost:5173` 对应 `ws://localhost:5173`。
- `script-src` 必须写上 `devUrl`。入口脚本靠 nonce 放行，但它再 `import` 的模块是按来源地址校验的。
- 开发模式下 Vite 通过插入 `<style>` 标签注入 CSS，已经被 `'unsafe-inline'` 覆盖。Vue Flow 本来就需要这一项。
- 开发模式不需要 `localResourceRoots` 里的 `dist/webview`，但保留它也没有影响。

### 4.4 Vite 配置

在 `webview-ui/vite.config.mts` 里增加 `server` 配置：

```ts
server: {
  port: 5173,
  strictPort: true,                        // 端口被占用时直接报错，不要自动换端口，否则和 launch.json 对不上
  origin: 'http://localhost:5173',         // 让 CSS 里 url(...) 引用的资源生成绝对地址
  cors: { origin: /^vscode-webview:\/\// },// Webview 页面的来源是 vscode-webview://，加载模块脚本需要跨域许可
  hmr: { protocol: 'ws', host: 'localhost', port: 5173 },
  fs: { allow: [fileURLToPath(new URL('..', import.meta.url))] }, // 允许读取 ../src/shared（@shared 别名）
},
```

每一项都有必要，漏掉任何一项都会出问题：


| 配置           | 不配置会怎样                                             |
| ------------ | -------------------------------------------------- |
| `strictPort` | 5173 被占用时 Vite 改用 5174，Webview 加载失败，只显示空白页         |
| `origin`     | 图片、字体会按 `vscode-webview://` 的来源去解析，结果加载不到          |
| `cors`       | 新版本 Vite 默认只允许 localhost 来源跨域，Webview 的模块脚本会被浏览器拦截 |
| `fs.allow`   | `@shared/*` 在 `webview-ui` 目录之外，Vite 会拒绝读取，返回 403  |


### 4.5 `acquireVsCodeApi` 只能调用一次

`webview-ui/src/vscode.ts` 现在在模块顶层调用 `acquireVsCodeApi()`。热更新时，如果这个模块被重新执行，第二次调用会直接抛异常，导致画板白屏。修改方法是把结果缓存在全局对象上：

```ts
const g = globalThis as { __harnessVsCodeApi?: VsCodeApi };
const api: VsCodeApi =
  g.__harnessVsCodeApi ??=
    typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : createMockApi();
```

同时在 `vscode.ts` 里补充 `getState()` 和 `setState()`（VS Code API 本身就提供），用来保存画布视口、当前选中的页签等界面状态。这样整页刷新后也能恢复到刷新前的样子。

### 4.6 页面刷新后的数据恢复

整页刷新后，Webview 会重新发送 `ready` 消息。插件主进程收到后重新推送完整数据，这部分 `CanvasPanel.onMessage` 已经实现了。需要注意的是：`ready` 标志要在每次收到 `ready` 消息时重置，不能只处理第一次。

### 4.7 npm 脚本和调试配置

`package.json` 增加：

```json
"dev:webview": "vite --config webview-ui/vite.config.mts"
```

`.vscode/tasks.json` 增加两个后台任务，以及一个把它们组合起来的任务：

```jsonc
{
  "label": "dev:webview",
  "type": "npm",
  "script": "dev:webview",
  "isBackground": true,
  "problemMatcher": {
    "pattern": { "regexp": "^x^" },                 // 不从输出里解析错误
    "background": {
      "activeBeginsPattern": "VITE v",
      "activeEndsPattern": "Local:"                 // 出现 Local: 表示服务器已经启动好
    }
  }
},
{
  "label": "watch:ext",
  "type": "npm",
  "script": "watch:ext",
  "isBackground": true,
  "problemMatcher": {
    "pattern": { "regexp": "^x^" },
    "background": {
      "activeBeginsPattern": "\\[watch\\] build started",
      "activeEndsPattern": "\\[watch\\] build finished"
    }
  }
},
{
  "label": "dev",
  "dependsOn": ["watch:ext", "dev:webview"]
}
```

`esbuild.mjs` 在 watch 模式下需要加一个小插件，在每次构建开始和结束时分别输出 `[watch] build started` 和 `[watch] build finished`，供上面的任务判断构建是否完成。

`.vscode/launch.json` 增加一个启动配置，保留原来的配置：

```jsonc
{
  "name": "Run Extension (Webview HMR)",
  "type": "extensionHost",
  "request": "launch",
  "args": ["--extensionDevelopmentPath=${workspaceFolder}"],
  "outFiles": ["${workspaceFolder}/dist/**/*.js"],
  "env": { "HARNESS_WEBVIEW_DEV_URL": "http://localhost:5173" },
  "preLaunchTask": "dev"
}
```

## 五、日常开发流程

1. 在 `harness-cursor` 目录下执行 `nvm use 22.14.0`（Vite 8 要求 Node 20.19 以上或 22.12 以上）。
2. 在 Cursor 的"运行和调试"面板中选择 **Run Extension (Webview HMR)**，按 F5。
3. 在新打开的扩展开发宿主窗口里打开画板。
4. 修改代码：


| 修改的内容                          | 生效方式                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------- |
| `webview-ui/**/*.vue`、`*.css`  | 自动热更新，状态保留                                                                      |
| `webview-ui/**/*.ts`（非组件）      | 自动更新依赖它的组件；个别情况会整页刷新，插件自动重新推送数据                                                 |
| `src/shared/`**（两边共用的类型和常量）    | Webview 自动更新；插件主进程需要按下面一行的方式处理                                                  |
| `src/**/*.ts`（插件主进程）           | esbuild 自动重新构建；在扩展开发宿主窗口执行"开发人员: 重新加载窗口"（`Ctrl+R`），或者在调试工具栏点重启（`Ctrl+Shift+F5`） |
| `package.json` 的 `contributes` | 必须重启调试                                                                          |


## 六、浏览器独立调试模式

适合调整样式、布局算法、交互细节，不需要启动插件。

1. 执行 `npm run dev:webview`，在浏览器中打开 `http://localhost:5173`。
2. `vscode.ts` 检测到没有 `acquireVsCodeApi`，改用模拟的插件主进程 `webview-ui/src/dev/mockHost.ts`：
  - 收到 `ready` 后，读取 `webview-ui/dev-fixtures/` 里的样例数据，按真实协议推送给页面；
  - 对设计表的编辑操作，在内存中执行并推送更新，行为和真实插件主进程保持一致（复用同一套纯函数，见 04 文档第五节）；
  - 其他消息只输出到控制台。
3. 浏览器里没有 VS Code 的主题 CSS 变量，所以要加一个 `webview-ui/src/dev/theme-fallback.css`，提供一套默认的深色主题变量值，只在模拟模式下引入。

保证模拟代码不会进入正式产物：

```ts
if (import.meta.env.DEV && typeof acquireVsCodeApi !== 'function') {
  await import('./dev/mockHost'); // 正式构建时 import.meta.env.DEV 为 false，这段代码会被整体删除
}
```

**样例数据的要求：** `dev-fixtures` 里只能放脱敏后的样例结构，不要直接复制公司真实数据库的导出文件，更不能包含任何 DSN 或密码。

## 七、已知限制

- **远程开发（Remote SSH、WSL、Dev Container）：** 插件主进程和 Vite 运行在远程机器上，而 Webview 运行在本地，`localhost:5173` 指向的是本地机器。VS Code 提供的 Webview `portMapping` 能转发 HTTP 请求，但热更新用的 WebSocket 不一定能转发。本阶段只支持本地开发时使用热更新，远程环境下使用普通构建模式。
- **只有 Webview 能热更新：** 插件主进程的改动始终需要重新加载窗口。所以业务逻辑（数据标准化、差异对比、设计表编辑操作）尽量写成不依赖 `vscode` 模块的纯函数，用 vitest 做单元测试，减少重启调试的次数。

## 八、验收标准

- 用 **Run Extension (Webview HMR)** 启动后，修改 `TableNode.vue` 的样式，画板在不刷新的情况下更新，缩放和选中状态保留。
- 修改 `webview-ui/src/vscode.ts` 后画板不会白屏。
- 用原来的 **Run Extension** 启动时，Webview 加载的是 `dist/webview`，不会访问 localhost。
- `npm run package` 打出的 `.vsix` 里不包含 `mockHost`、`dev-fixtures` 和 `theme-fallback.css`。
- 在浏览器里打开 `http://localhost:5173`，能看到样例数据渲染出的画布。


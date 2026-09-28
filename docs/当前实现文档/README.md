# Harness 工程索引（当前实现）

> 面向开发者和 AI agent 的快速上手索引。先读"一分钟概览"和"目录地图"，改功能时查"改什么去哪里"。
> 代码根目录：`harness-cursor/`（下文路径均相对于它）。最后更新：2026-09-28（M1 自动命名、M2 连接页面、"设计库"命名与数据库显示名调整后）。

## 1. 一分钟概览

Harness 是一个 Cursor / VS Code 插件，用 **tbls 的 JSON 格式**作为统一数据标准：

- **设计库（design）**：用户在画布上设计的表结构，存为 tbls 格式 `schema.json` + 扩展信息 `ext.json`，不需要连接数据库。代码里的 kind 仍叫 `design`。
- **数据库（db）**：调用 `tbls out -t json` 读取真实数据库的**表结构**（不读数据），原样存成快照，只读。界面上显示为 `host:port/db`（见 4 节"数据库显示名"）。
- **画布（canvas）**：`*.canvas.json`，只记录引用了哪些数据源、放了哪些表、坐标。表内容每次从数据源实时读取。
- **对比（diff）**：设计库 vs 数据库快照，差异标在画布上，可"确认为有意偏差"。

侧边栏树：工作区 → 三个分组 **设计库 / 数据库 / 画布** → 表 → 字段。

硬性原则：

1. **插件永远不写数据库**。改结构由用户/AI 根据差异生成 SQL，用户自己执行后再同步。
2. **连接信息（主机、用户名、密码、DSN）只存系统凭据**（`context.secrets`），不写入任何文件、日志、快照、画布；报错里遮掉密码。
3. 数据全部存在插件自己的存储目录（不在用户项目里）。

## 2. 技术栈与运行

| 部分 | 技术 |
| :-- | :-- |
| 插件主进程 | TypeScript，esbuild 打包到 `dist/extension.js`，VS Code API ≥ 1.90 |
| Webview | Vue 3 + Vue Flow（画布）+ elkjs（自动布局），Vite 8 构建到 `dist/webview/` |
| 外部工具 | tbls（v1.96.0 验证过），通过 `harness.tblsPath` 找到 |
| 测试 | vitest（`test/`，只测纯函数，不依赖 vscode） |
| 依赖 | `yaml`、`vue`、`@vue-flow/*`、`elkjs` |

**必须用 Node 22**（`.nvmrc` = `22.14.0`；老版本 Node 跑 `esbuild.mjs` 会报 `Unexpected token *`）。

```powershell
nvm use 22.14.0
npm install
npm run build        # esbuild 插件 + vite webview
npm run typecheck    # tsc + vue-tsc
npm test             # vitest
npm run dev:webview  # Vite 开发服务器 :5173，浏览器里用 mock 调试
npm run package      # 打 .vsix
```

- F5 **Run Extension (Webview HMR)**：`preLaunchTask: dev`（esbuild watch + Vite），环境变量 `HARNESS_WEBVIEW_DEV_URL=http://localhost:5173`，Webview 从 Vite 加载，改 `webview-ui/src` 立即生效；改 `src/` 后在宿主窗口执行 `Developer: Restart Extension Host`。
- F5 **Run Extension**：使用构建好的 `dist/webview`（生产模式）。
- 浏览器调试：`http://localhost:5173`（画布，mock 数据）；`http://localhost:5173/?view=connection`（连接页面 mock，主机 `fail.example.test` 模拟失败，密码 `wrong` 模拟认证失败）；`http://localhost:5173/?view=edit&kind=design|workspace|canvas`（编辑页面 mock，名称填 `fail` 模拟保存失败）。

设置项：

| 设置 | 默认 | 作用 |
| :-- | :-- | :-- |
| `harness.tblsPath` | `tbls` | tbls 可执行文件路径，在 PATH 里就不用改 |
| `harness.storageDir` | 空 | 存储根目录；空时用 `context.globalStorageUri` |
| `harness.tblsTimeoutSeconds` | 120 | 单次 tbls 执行超时 |

## 3. 目录地图

```
harness-cursor/
├─ package.json            命令、菜单、视图、自定义编辑器、快捷键(F2)、设置 —— UI 入口全在这里声明
├─ esbuild.mjs             插件主进程打包
├─ media/db/               数据库品牌图标 <driver>-light.svg / -dark.svg（simple-icons，CC0）：postgres/mysql/mariadb/sqlite/clickhouse/redshift/sqlserver
├─ .vscode/launch.json     两个 F5 配置；tasks.json 定义 dev / build 任务
├─ src/                    插件主进程
│  ├─ extension.ts         activate：组装 storage/store/tree/canvases/connections，注册命令，启动存储目录文件监听
│  ├─ shared/              ★ 插件和 Webview 共用，纯 TS，不依赖 vscode（Webview 通过别名 @shared 引用）
│  │  ├─ tbls.ts           tbls JSON 的类型（TblsSchema/Table/Column/Relation/Index…）
│  │  ├─ model.ts          统一模型 NormalizedSchema/NTable/NColumn/NRelation、RelationKind、DesignExt、DiffItem/DiffResult、ComparisonPair
│  │  ├─ workspace.ts      文件元数据类型（WorkspaceMeta/DesignSourceMeta/DbSourceMeta/HarnessRootMeta）、ID 与默认名规则（nextSeq/nextDefaultName/uniqueName）、DESIGN_DRIVERS
│  │  ├─ canvas.ts         画布文件类型 CanvasFile、画布编辑操作 CanvasOp 与 applyCanvasEdit（纯函数）、parse/serializeCanvas
│  │  ├─ designOps.ts      设计编辑操作 DesignOp 与 applyDesignOps（纯函数）、parseExt、designFromSnapshot、serializeDesign
│  │  ├─ connection.ts     连接配置 ConnectionProfile、CONNECTION_DRIVERS（各库字段/端口/加密选项）、buildDsn、validateProfile、connectionLabel（显示名 host:port/db）、默认连接名、凭据序列化、遮罩
│  │  ├─ protocol.ts       画布 Webview ⇄ 主进程消息（HostMessage / WebviewMessage）
│  │  ├─ connectionProtocol.ts  连接页面 Webview ⇄ 主进程消息
│  │  └─ editProtocol.ts   编辑页面 Webview ⇄ 主进程消息（EditInit / EditValues）
│  ├─ workspace/
│  │  ├─ storage.ts        ★ 存储目录读写：HarnessStorage / HarnessWorkspace / DesignSource / DbSource；ID 独占分配 claim()
│  │  ├─ refactor.ts       跨文件联动：改表名同步所有画布和 comparisons.json；删除数据源时清理引用
│  │  └─ fsUtil.ts         读写 JSON/YAML/文本、列目录的小工具（基于 vscode.workspace.fs）
│  ├─ model/
│  │  ├─ normalize.ts      tbls JSON → NormalizedSchema（去默认 schema 前缀、推主键/唯一/自增、关联 enum、关系类型）
│  │  ├─ types.ts          原始字段类型 → LogicalType + 长度/精度
│  │  └─ store.ts          ★ ModelStore(storage, secrets)：按数据源缓存归一化模型和设计文档；dbName() 计算数据库显示名；invalidate 事件驱动所有视图刷新；识别自己写的文件；监听凭据变化
│  ├─ diff/diff.ts         diffSchemas(design, db, pair)：表/字段/关系对比
│  ├─ canvas/canvasEditor.ts  ★ 画布自定义编辑器（CustomEditorProvider）：文档、撤销重做、保存、备份、与 Webview 通信、设计编辑落盘
│  ├─ connection/
│  │  ├─ connectionPanel.ts   连接页面（WebviewPanel）：新建/编辑连接、测试、连接后创建 db、导入 JSON
│  │  └─ errors.ts            tbls 报错 → 中文友好提示 friendlyTblsError
│  ├─ edit/editPanel.ts    编辑页面（WebviewPanel）：工作区/设计库/画布的名称、说明，设计库的目标数据库类型
│  ├─ tbls/runner.ts       调用 tbls（DSN 走环境变量 TBLS_DSN，超时、取消、报错遮罩），stripDsnFromTblsConfig
│  ├─ views/workspaceTree.ts  侧边栏树 TreeDataProvider（工作区 → 设计库/数据库/画布 → 表 → 字段），数据库品牌图标，getParent 支持 reveal
│  ├─ commands/            命令实现（见第 7 节）
│  │  ├─ common.ts         Harness 上下文接口、register、pickWorkspace/pickSourceId(h,…)、sourceName、designNames、revealInTree、confirm 等
│  │  ├─ workspace.ts / design.ts / db.ts / canvas.ts
│  └─ webview/html.ts      Webview HTML（生产：dist + nonce CSP；开发：指向 Vite），<body data-view> 选择页面
├─ webview-ui/src/         Webview 前端（一个 bundle，两个页面）
│  ├─ main.ts              按 data-view 挂载 App.vue（画布）/ ConnectionApp.vue（连接页面）/ EditApp.vue（编辑页面）；浏览器开发时安装对应 mock host
│  ├─ vscode.ts            acquireVsCodeApi 封装：post / request（带 requestId 等回复）/ onHostMessage
│  ├─ store.ts             画布页面状态：canvas(shallowRef)、sources、catalog、comparison、selection；editCanvas / designOp / acceptDiff
│  ├─ App.vue              画布页面外壳：工具栏（标题可点击改名）、对比选择、面板布局、快捷键
│  ├─ canvas/viewModel.ts  buildView：CanvasFile + SourceData + 对比结果 → 节点/连线视图（含差异标记、overlay 合并）
│  ├─ canvas/layout.ts     elkjs 自动布局、新表放置
│  ├─ components/          CanvasView(Vue Flow 画布) / TableNode / NoteNode / Inspector(属性面板，编辑表/字段/关系)
│  │                       DiffPanel(差异列表) / SourcePanel(数据源面板，双击改名、新建) / ContextMenu
│  ├─ connection/          ConnectionApp.vue（连接页面）、DriverFields.vue（按库类型渲染字段）、form.ts、host.ts
│  ├─ edit/                EditApp.vue（编辑页面）、host.ts
│  └─ dev/                 mockHost.ts / mockConnectionHost.ts / mockEditHost.ts / fixtures.ts（仅开发模式，不进生产包）
└─ test/                   canvas / connection / designOps / diff / workspace / fixtures 单元测试
```

## 4. 存储结构（磁盘上的数据）

```
<storageDir 或 globalStorage>/
├─ harness.json                       { version:1, seq:{ workspace:N } }  工作区编号计数器
└─ workspaces/<workspaceN>/
   ├─ workspace.yml                   name, description, seq:{design,db,canvas}（各类最后发出的编号）
   ├─ comparisons.json                pairs[]: {design, db, tableMappings, acceptedDiffs}
   ├─ design/<designN>/
   │  ├─ source.yml                   name, description, createdFrom
   │  ├─ schema.json                  tbls 格式（可直接 tbls doc json://...）
   │  └─ ext.json                     {version:2, relations:[{key,kind,...}], modules:[]}  tbls 表达不了的信息
   ├─ db/<dbN>/
   │  ├─ source.yml                   name（备用名，不含主机）, connection:{kind:'secret',driver} | {kind:'none'}, defaultSchema, include, exclude, snapshotRetention
   │  ├─ .tbls.yml                    可选，导入时已去掉 dsn
   │  └─ snapshots/<ISO时间>.json     tbls out 原始输出，文件名可排序，保留最近 N 个（默认 10）
   └─ canvas/<canvasN>.canvas.json    CanvasFile
```

**ID 与名称规则**（`shared/workspace.ts` + `storage.ts`）：

- ID 形如 `workspace3`、`design2`、`db1`、`canvas4`，内部分配，**只增不复用**（删除后也不回收）。
- 编号 = max(计数器, 现有 ID 的数字) + 1；创建时用**独占方式**占位（`fs.mkdir` 非递归 / `writeFile` flag `wx`），遇到 EEXIST 换下一个号，最多 20 次 —— 多窗口同时新建也不冲突。
- 工作区、设计库、画布的名称可以改（F2、画布标题、数据源面板双击），ID 不变。默认名："工作区 N"、"设计库 N"、"画布 N"（重名追加 " (2)"）。早期创建的"设计模型 N"保持原名，不自动迁移。
- **数据库不能改名，也没有别名**，名称由连接信息计算（见下）。

**数据库显示名**（`shared/connection.ts connectionLabel` + `ModelStore.dbName`）：

| 情况 | 显示 |
| :-- | :-- |
| 主机类数据库 | `host:port/db`，**端口始终显示**（没填用该库默认端口），IPv6 加方括号 `[::1]:5432/db`，没填库名时是 `host:port` |
| SQLite | 文件名，如 `app.db` |
| 自定义 DSN | 按 URL 解析出 `host:port/db`（支持 `?database=`），解析不了时用备用名 |
| 离线导入 / 未设置连接 | `source.yml` 的 `name`（导入时取 schema 名或文件名） |

- 运行时从凭据读取并计算，**不写入任何文件**（`source.yml` 只存不含主机的备用名 `defaultConnectionName`，如 "PostgreSQL · orders"）。
- 同一工作区内按 ID 数字顺序去重，重名追加 " (2)"。结果缓存在 `ModelStore.dbNames`，`invalidate` 时清除；`secrets.onDidChange`（键 `harness.dsn:v2:<ws>:<db>`）也会触发刷新。
- **只给界面用**：显示名包含主机，AI / MCP 相关代码只能用 ID，不能用这个名字。
- "从数据库复制"新建的设计库默认叫"设计库 N"（不再是"<数据库名> 的设计"，避免把主机写进 `source.yml`）。

**凭据**：`context.secrets` 键 `harness.dsn:v2:<workspaceId>:<dbId>`，值为 `ConnectionProfile` 的 JSON（旧版纯 DSN 字符串会被当作 `custom` 类型读取）。
**globalState**：`harness.lastConnectionDriver`（连接页默认库类型）、`harness.lastDesignDriver`（新设计库默认库类型）。

## 5. 核心概念与数据流

### 5.1 主进程对象关系（`extension.ts`）

```
HarnessStorage + secrets ──► ModelStore(缓存 + onDidChange + dbName) ──► WorkspaceTreeProvider（树）
                         │                          └► CanvasEditorProvider → CanvasSession（每个打开的画布）
                         └── StorageWatcher（存储目录文件变化 → store.onFileEvent → invalidate）
Harness 上下文 h = { context, storage, store, tree, treeView, canvases, connections } 传给所有命令
```

- **所有读取都走 `ModelStore`**，所有写入后调用 `store.invalidate({workspace, kind, id})`，树和打开的画布自动刷新。
- 自己写的文件通过 `noteOwnWrite` / `writeDesignDoc` 记录，文件监听会跳过，避免循环刷新。

### 5.2 画布编辑（布局类）

Webview `editCanvas()` 本地立即应用 → `canvas/edit` 消息 → `CanvasSession.applyCanvasEdit` 更新文档并 `recordEdit`（进入 VS Code 撤销栈，文档变脏）→ Ctrl+S 保存由 `saveCustomDocument` 写 `*.canvas.json`。撤销/重做/还原会把整份 canvas 推回 Webview（`{type:'canvas'}`）。

### 5.3 设计编辑（改表、字段、关系）

Webview `designOp()` → `design/op`（带 requestId，等回复）→ `applyDesignOps`：
检查 schema/ext 是否有未保存的文本编辑 → 删除表时弹模态确认 → 纯函数 `applyDesignOps` 计算新文档 → `store.writeDesignDoc` 立即落盘 → 表改名时 `refactor.renameDesignTable` 同步所有画布和 comparisons → `recordEdit` 注册撤销（撤销前校验文件没被别处改过）→ `reply`。
**注意**：画布上按 Delete 只是从画布移除节点（canvas op），从设计库删表必须走右键菜单 + 二次确认。

### 5.4 对比

画布 `comparison: {design: alias, db: alias, mode}` → `store.comparison()` = `diffSchemas(normalize(design), normalize(dbSnapshot), pair)` → `{type:'comparison'}` 推给 Webview → `viewModel.buildView` 生成标记。
差异 ID 格式 `kind:table:column|relation`；确认偏差写 `comparisons.json.acceptedDiffs`；表名不同靠 `tableMappings`。

### 5.5 添加数据库（连接页面，M2）

`harness.db.create` → `ConnectionPanels.openCreate(ws)` 打开 WebviewPanel（`view:'connection'`）：

1. `init`：库类型列表默认上次选择。页面**没有名称输入框**，只显示"显示为"预览（`connectionLabel(profile)`，随输入实时变化）。
2. 测试连接：`validateProfile` → `buildDsn` → `tblsOutJson`（`TBLS_DSN` 环境变量、超时、可取消）→ 结果按 profile+过滤条件的 sha256 缓存 5 分钟。
3. 连接：（有缓存用缓存，否则执行 tbls）→ `ws.claimDb()` 占 `dbN` 目录 → 写 `source.yml`（备用名 + driver，不含主机）→ 存凭据 → 写快照；任何一步失败回滚（删凭据、删目录）。
4. 成功后关闭页面、在树中定位新数据库。**不会加入任何画布**。

编辑连接：`harness.db.editConnection` → `openEdit(db)`，密码/自定义 DSN 不回传给 Webview，留空表示沿用已保存值。
同步：`harness.db.sync` 读凭据 → `parseStoredConnection` → `buildDsn` → tbls → 写快照，错误经 `friendlyTblsError` 提示并提供"编辑连接…"。

### 5.6 新建（M1）

- 工作区：`storage.createWorkspace(nextDefaultName('工作区'), '画布 1')`，自带空画布，树中定位。
- 设计库：`ws.createDesign(meta, doc)`，默认名 `nextDefaultName('设计库', designNames(ws))`，只出现在树里，不加入画布；库类型推断顺序：最新快照 driver → 上次选择 → postgres。
- 画布：`ws.createCanvas(emptyCanvas(nextDefaultName('画布')))` 后打开。
- 编辑：树节点上的铅笔按钮 / 右键"编辑…" → `harness.edit` → `EditPanels.open(kind, ws, id)` 打开编辑页面（每个对象一个，重复打开只聚焦）。可以改名称和说明，设计库还能改目标数据库类型（只改 `schema.json` 的 `driver.name`，已有字段类型不转换，页面会提示）。画布已打开时通过 `transformIfOpen` 改内存中的文档。保存后关闭页面并 `invalidate`。数据库节点没有这个按钮，用"编辑连接…"。
- 重命名：F2 → `harness.rename` 按选中节点类型转发到工作区/设计库/画布的 rename 命令；选中数据库时提示"名称来自连接信息"，并提供"编辑连接…"；画布标题点击 → `meta.set` op；数据源面板双击 → `source/rename` 消息（**只对设计库生效**，改的是设计库本身的 `source.yml`）。

## 6. 消息协议速查

**画布**（`src/shared/protocol.ts`）

| 方向 | type | 说明 |
| :-- | :-- | :-- |
| Host→Web | `init` | canvas + sources(SourceData[]) + catalog + comparison |
| Host→Web | `canvas` / `source` / `comparison` / `catalog` | 增量更新 |
| Host→Web | `reply` | 对 request 的回复 {requestId, ok, error} |
| Host→Web | `focus` | 定位到某表/字段 |
| Web→Host | `ready` | Webview 就绪，主进程随后发 init |
| Web→Host | `canvas/edit` | 画布布局编辑（CanvasEdit） |
| Web→Host | `design/op` | 设计编辑（DesignOp[]，可附带 canvasEdit），需要 reply |
| Web→Host | `diff/accept` | 确认/取消确认差异，需要 reply |
| Web→Host | `viewport` / `db/sync` / `openRaw` / `source/create` / `source/rename` | 视口、同步、打开原始文件、新建数据源（只建不加）、改设计库名（数据库忽略） |

**连接页面**（`src/shared/connectionProtocol.ts`）：Web→Host `ready | test | connect | importFile | pickFile | openUrl | openTblsSettings | cancel | close`；Host→Web `init | result | filePicked`。`connect` / `importFile` 不带名称：连接用 `defaultConnectionName` 作为备用名，导入用 schema 名或文件名。

**编辑页面**（`src/shared/editProtocol.ts`）：Web→Host `ready | save{name, description, driver?} | close`；Host→Web `init{kind, name, description, driver?, drivers?, tableCount?} | result`。

## 7. 命令一览（`package.json` 声明，`src/commands/*` 实现）

| 文件 | 命令 |
| :-- | :-- |
| `workspace.ts` | `workspace.create`（一键）/ `rename` / `delete` / `add`（新建…快捷菜单）、`harness.rename`（F2 分发）、`harness.edit`（树上的"编辑…"按钮，打开编辑页面）、`refresh`、`openStorage` |
| `design.ts` | `design.create`（一键空白）/ `createBlank` / `createFromDb` / `createFromFile` / `setDriver` / `openRaw` / `openExt` / `rename` / `delete`；子菜单 `harness.design.newMenu` |
| `db.ts` | `db.create`（打开连接页）/ `editConnection` / `sync` / `clearConnection` / `importSnapshot` / `importTblsConfig` / `openConfig` / `openSnapshot` / `delete`（没有 rename） |
| `canvas.ts` | `canvas.create` / `open` / `rename` / `delete`、`source.addToCanvas`、`table.revealInCanvas` |

命令参数统一是 `NodeArg`（`{workspace?, id?, ...}`，来自树节点或 Webview），缺省时弹选择框（`pickWorkspace` / `pickSourceId`）。

## 8. 改什么去哪里

| 需求 | 位置 |
| :-- | :-- |
| 新增/修改命令、菜单、快捷键、设置 | `package.json` + `src/commands/*.ts` |
| 新增画布上的编辑动作（布局类） | `shared/canvas.ts` 加 CanvasOp → Webview 调 `editCanvas` |
| 新增设计编辑动作 | `shared/designOps.ts` 加 DesignOp（写测试 `test/designOps.test.ts`）→ Webview 调 `designOp` |
| 新增画布 Webview⇄主进程消息 | `shared/protocol.ts` → `canvasEditor.ts onMessage` → `webview-ui/src/store.ts` / 组件；同步改 `dev/mockHost.ts` |
| 支持新的数据库类型 / 修改 DSN 拼接 | `shared/connection.ts`（`CONNECTION_DRIVERS`、`buildDsn`）+ `test/connection.test.ts` |
| tbls 报错提示 | `connection/errors.ts` |
| tbls 调用参数、超时 | `tbls/runner.ts` |
| 存储格式、新文件类型、ID 分配 | `shared/workspace.ts`（类型）+ `workspace/storage.ts`（读写） |
| 跨画布联动（改名/删除） | `workspace/refactor.ts` |
| tbls → 统一模型的转换、类型映射 | `model/normalize.ts`、`model/types.ts` |
| 差异规则 | `diff/diff.ts` + `test/diff.test.ts` |
| 树节点显示（描述"25 张表 · 今天 15:13"、图标、提示） | `views/workspaceTree.ts` |
| 数据库显示名规则 | `shared/connection.ts connectionLabel`（+ `test/connection.test.ts`）、`model/store.ts dbName` |
| 数据库品牌图标 | `media/db/*.svg` + `workspaceTree.ts DRIVER_ICONS` |
| 画布节点/连线渲染、差异标记 | `webview-ui/src/canvas/viewModel.ts`、`components/TableNode.vue`、`CanvasView.vue` |
| 属性面板 | `components/Inspector.vue` |
| 连接页面 UI | `webview-ui/src/connection/*` + `dev/mockConnectionHost.ts` |
| 编辑页面（名称、说明、设计库类型） | `src/edit/editPanel.ts` + `shared/editProtocol.ts` + `webview-ui/src/edit/*` + `dev/mockEditHost.ts` |
| Webview CSP / 开发服务器 | `src/webview/html.ts`、`webview-ui/vite.config.mts` |

## 9. 约定与注意事项

- `src/shared/` 不能 import `vscode`（Webview 和测试都要用）。纯逻辑尽量放这里并写 vitest。
- 纯函数编辑（`applyCanvasEdit` / `applyDesignOps` / `meta.set`）在"无变化"时返回**同一个对象**，调用方用 `===` 判断是否需要记录撤销。
- 文件输出保持稳定（`serializeCanvas` 排序、取整；`serializeDesign`），保存两次不产生 Git diff。
- 写完数据一定 `store.invalidate(...)`；自己写的文件要登记 ownWrite。
- 安全：DSN 只能通过 `TBLS_DSN` 环境变量传给 tbls，不进 argv；任何错误文本都过 `maskSecret`；测试/fixture 只用占位值（`reader` / `example-secret` / `db.example.test`）。
- 数据库只读：只执行 `tbls out -t json`，不读取表数据。
- 数据库显示名含主机，只能出现在界面上；不能写进文件，也不能交给 AI。
- 编辑文件不要用 PowerShell `Get-Content/Set-Content`（会破坏 UTF-8 中文）。
- Webview 生产包中 mock 代码由 `import.meta.env.DEV` 排除；Vite `cssCodeSplit:false`，动态 chunk 可用。

## 10. 测试

| 文件 | 覆盖 |
| :-- | :-- |
| `test/canvas.test.ts` | 画布操作、改表名、alias 分配、`meta.set`、序列化稳定性 |
| `test/designOps.test.ts` | 设计编辑操作 |
| `test/diff.test.ts` | 差异对比 |
| `test/workspace.test.ts` | `nextSeq` / `nextDefaultName` / `uniqueName` / ID 校验 |
| `test/connection.test.ts` | `connectionLabel` 显示名、各库 `buildDsn`、编码、IPv6、默认加密、参数覆盖、SQLite 路径、校验、凭据序列化、遮罩、`friendlyTblsError` |
| `test/fixtures.test.ts` | 浏览器 mock 示例数据（`webview-ui/src/dev/fixtures.ts`）能归一化，并覆盖画布要展示的各类差异 |

## 11. 已知限制 / 待办

- 画布分组框、从面板拖表到画布、Ctrl+F 搜索表未做。
- 不识别改名（显示为一边缺少一边多出）；复合外键在画布上只连第一列。
- MCP Server（不得向 AI 暴露连接信息）、`tbls lint` 接入未做。
- 连接页面、自动命名尚未在真实 Cursor 环境中完整走查（单元测试、typecheck、build 已通过）。

## 12. 相关文档

| 文档 | 内容 |
| :-- | :-- |
| `harness-cursor/README.md` | 用户使用说明、开发脚本、适配器与差异规则 |
| `docs/design.md`、`docs/DDD.md`、`docs/init.md` | 早期整体设计 |
| `docs/setp1/` | 第一阶段需求、tbls 调研 |
| `docs/tbls/tbls使用.md` | tbls 用法 |
| `docs/step2initdev/01初始化/` | 阶段二：Vite HMR、工作区模型、侧边栏、画布、开发计划、实现记录 |
| `docs/step2initdev/02新增设置/` | 自动命名（01）、连接页面（02）、tbls 能力分析（03）、开发计划（04） |

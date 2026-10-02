# Harness 工程索引（当前实现）

> 面向开发者和 AI agent 的快速上手索引。先读"一分钟概览"和"目录地图"，改功能时查"改什么去哪里"。
> 代码根目录：`harness-cursor/`（下文路径均相对于它）。最后更新：2026-10-02（第二阶段方案 E 上线：tbls 自动下载 + 用户覆盖 + 错误兜底三按钮）。

## 1. 一分钟概览

Harness 是一个 Cursor / VS Code 插件，用 **tbls 的 JSON 格式**作为统一数据标准：

- **设计画布（design）**：一份表结构 + 若干张设计图 + 引用的数据库 + 一个布局文件。表结构存为 tbls 格式 `schema.json` + 扩展信息 `ext.json`，不需要连接数据库。默认名"设计画布 1"。（第一阶段叫"设计库"，第二阶段合并为"设计画布"。代码里的 kind 仍叫 `design`。）
- **布局（layout）**：`design/<designN>/layout.json`（`CanvasFile` v3），每个设计画布只有一个，一个编辑器标签页。记录所有**分区画布**（可无限嵌套）、每张设计表 / 设计图 / 数据库表 / 便签在哪一层、坐标、是否隐藏。表内容每次从数据源实时读取。代码里的 kind 叫 `canvas`，ID 就是设计 ID。
- **分区画布（partition）**：设计画布里嵌套的子画布（`partN`），和根画布一样可以放设计表、设计图、数据库表、子分区画布。可以设置**命名空间**（数据库 schema 或表名前缀，子分区继承），画布上显示短名 + 灰色命名空间标签，真实表名唯一。设计表 / 设计图属于某一层，可以像 Windows 文件一样复制 / 剪切 / 粘贴。
- **数据库（db）**：调用 `tbls out -t json` 读取真实数据库的**表结构**（不读数据），原样存成快照，只读。界面上显示为 `host:port/db`（见 4 节"数据库显示名"）。
- **对比（diff）**：设计画布 vs 数据库快照，差异标在画布上，可"确认为有意偏差"。对比数据按设计+数据库存储在设计内部的 `comparisons.json`。
- **设计图（diagram）**：设计画布下的 Mermaid 图（ER 图 / 状态图 / 时序图 / 流程图 / 数据流图），存为 `design/<designN>/diagrams/<diagramN>.md`。**AI 只写 Mermaid**；ER 图和表结构不一致时，由用户在右侧"差异/待同步"面板里勾选确认后才写入 `schema.json`，其他类型只预览不同步。
- 画布上的设计图显示为 **Mermaid 卡片**（所有类型，含 ER 图；ER 图和表结构不一致时卡片上有"待同步 N"徽标）。

侧边栏树：工作区 → 两个分组 **设计画布 / 数据库**；每个设计画布、每个分区画布下都是 **设计表**（本层的表 → 字段）/ **设计图** / **分区画布**（递归）。点击设计画布 = 打开编辑器；点击分区画布 / 设计表 / 设计图 = 在画布中选中并聚焦（`reveal`）。树支持多选、`Ctrl+C / X / V`、右键复制 / 剪切 / 粘贴、拖拽（= 剪切到目标层）。

硬性原则：

1. **插件永远不写数据库**。改结构由用户/AI 根据差异生成 SQL，用户自己执行后再同步。
2. **连接信息（主机、用户名、密码、DSN）只存系统凭据**（`context.secrets`），不写入任何文件、日志、快照、画布；报错里遮掉密码。
3. 数据全部存在插件自己的存储目录（不在用户项目里）。

## 2. 技术栈与运行

| 部分 | 技术 |
| :-- | :-- |
| 插件主进程 | TypeScript，esbuild 打包到 `dist/extension.js`，VS Code API ≥ 1.90 |
| Webview | Vue 3 + Vue Flow（画布）+ elkjs（自动布局）+ mermaid 12（设计图预览，按需加载），Vite 8 构建到 `dist/webview/` |
| 外部工具 | tbls（v1.96.0 验证过）；默认自动下载到 `<globalStorage>/bin/`（方案 E），需要时也可用 `harness.tblsPath` 指向本地 tbls |
| 测试 | vitest（`test/`，只测纯函数，不依赖 vscode） |
| 依赖 | `yaml`、`vue`、`@vue-flow/*`、`elkjs`、`mermaid` |

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
- 浏览器调试：`http://localhost:5173`（画布，mock 数据）；`http://localhost:5173/?view=connection`（连接页面 mock，主机 `fail.example.test` 模拟失败，密码 `wrong` 模拟认证失败）；`http://localhost:5173/?view=edit&kind=design|workspace`（编辑页面 mock，名称填 `fail` 模拟保存失败）；`http://localhost:5173/?view=diagram`（设计图编辑器 mock，差异面板是写死的示例）。

设置项：

| 设置 | 默认 | 作用 |
| :-- | :-- | :-- |
| `harness.tblsPath` | `""` | tbls 可执行文件。空 = 用内置版本（自动下载到 `<globalStorage>/bin/`）；填 `tbls` 等 PATH 名或绝对路径时优先用本地版本 |
| `harness.tblsVersion` | `""`（= 扩展版本） | 内置 tbls 的目标版本（带不带 `v` 都行）。`tblsPath` 为空时生效 |
| `harness.tblsDownloadBaseUrl` | `https://github.com/k1LoW/tbls/releases` | 内置 tbls 的 release 页地址 |
| `harness.tblsAutoDownload` | `true` | 是否在 `activate` 时自动下载缺失的内置 tbls。关掉就只能手动调 `harness.tbls.repair` |
| `harness.storageDir` | 空 | 存储根目录；空时用 `context.globalStorageUri` |
| `harness.tblsTimeoutSeconds` | 120 | 单次 tbls 执行超时 |

## 3. 目录地图

```
harness-cursor/
├─ package.json            命令、菜单、视图、自定义编辑器、快捷键(F2)、设置 —— UI 入口全在这里声明
├─ esbuild.mjs             插件主进程打包
├─ media/db/               数据库品牌图标 <driver>-light.svg / -dark.svg（simple-icons，CC0）：postgres/mysql/mariadb/sqlite/clickhouse/redshift/sqlserver
├─ media/spec/mermaid-design.md  "复制给 AI"时附带的设计图书写规范（ER 图写法、关系关键字等）
├─ .vscode/launch.json     两个 F5 配置；tasks.json 定义 dev / build 任务
├─ src/                    插件主进程
│  ├─ extension.ts         activate：组装 storage/store/tree/canvases/connections，注册命令，启动存储目录文件监听
│  ├─ shared/              ★ 插件和 Webview 共用，纯 TS，不依赖 vscode（Webview 通过别名 @shared 引用）
│  │  ├─ tbls.ts           tbls JSON 的类型（TblsSchema/Table/Column/Relation/Index…）
│  │  ├─ model.ts          统一模型 NormalizedSchema/NTable/NColumn/NRelation、RelationKind、DesignExt、DiffItem/DiffResult
│  │  ├─ workspace.ts      文件元数据类型（WorkspaceMeta/DesignMeta/DbSourceMeta/HarnessRootMeta/ComparisonsFile/ComparisonEntry）、ID 与默认名规则（nextSeq/nextDefaultName/uniqueName）、DESIGN_DRIVERS
│  │  ├─ canvas.ts         ★ 布局文件类型 CanvasFile v3（partitions / nodes / diagrams / notes / seq / viewports 按层）、
│  │  │                    CanvasPartition { id, name, description?, parent?, x, y, width?, height?, collapsed?, namespace? }：width/height 是手动最小值，
│  │  │                    最终大小 = max(手动, 内容包围盒 + padding, PART_MIN)；折叠时固定为 PART_COLLAPSED，不受 width/height 影响
│  │  │                    CanvasOp（nodes.put/remove/display、diagrams.put/remove、hidden.set、move、partition.put/remove（含 width/height）、note.put/remove、comparison.set、settings.set）、
│  │  │                    applyCanvasEdit（纯函数）、parse/serializeCanvas（round + 稳定排序 + 容错）、partitionSubtree/partitionPath/partitionOf/partitionContents、nextPartitionId、
│  │  │                    removeDbFromCanvas、removeDiagramFromCanvas、renameTableInCanvas、nodeId/parseNodeId、ItemRef/MoveItem
│  │  ├─ namespace.ts      ★ 命名空间：按库类型默认 schema/前缀、继承计算 effectiveNamespace、qualify/shortName/inNamespace、落地命名 landingName（_copy 规则）、copyNamespace
│  │  ├─ clipboard.ts      ★ 复制 / 剪切纯函数：planCopy（深度复制、改名、外键改指向、设计图副本）、planCut（换层、命名空间改名）、topLevelItems、levelTables
│  │  ├─ copyTables.ts     ★ 数据库快照表 → DesignOp[]（复制字段/主键/唯一/注释/关系，处理重名：skip 或 rename）
│  │  ├─ designOps.ts      设计编辑操作 DesignOp 与 applyDesignOps（纯函数）、parseExt、designFromSnapshot、serializeDesign、emptyDesignSchema
│  │  ├─ diagram.ts        设计图类型 DIAGRAM_TYPES、文件格式 parseDiagram / serializeDiagram（YAML frontmatter + ```mermaid 代码块）
│  │  ├─ mermaid/er.ts     erDiagram 解析 parseErDiagram（容错、带行号）与生成 generateErDiagram（表结构 → ER 图）
│  │  ├─ sync.ts           同步项 SyncItem / SyncGroup、collectSyncOps（校验依赖、按顺序合并 DesignOp）
│  │  ├─ quickColumns.ts   属性面板"快速添加字段"一行语法解析、常用字段模板（按库类型选类型）
│  │  ├─ diagramProtocol.ts  设计图编辑器 Webview ⇄ 主进程消息
│  │  ├─ connection.ts     连接配置 ConnectionProfile、CONNECTION_DRIVERS（各库字段/端口/加密选项）、buildDsn、validateProfile、connectionLabel（显示名 host:port/db）、默认连接名、凭据序列化、遮罩
│  │  ├─ protocol.ts       ★ 画布 Webview ⇄ 主进程消息（HostMessage / WebviewMessage）、SourceData、DesignContext、WorkspaceCatalog、ComparisonData
│  │  ├─ connectionProtocol.ts  连接页面 Webview ⇄ 主进程消息（含 `pickTblsPath` / `testTbls` / `installTbls` / `openTblsReleases`、TblsStatus）
│  │  ├─ tblsPlatform.ts        纯函数：根据 platform/arch 选 tbls release 资产（pickAsset）、二进制文件名（binaryFilename）、bin 子目录名（binDirName）
│  │  └─ editProtocol.ts   编辑页面 Webview ⇄ 主进程消息（EditInit / EditValues）
│  ├─ workspace/
│  │  ├─ storage.ts        ★ 存储目录读写：HarnessStorage / HarnessWorkspace / Design（design.yml、schema.json、ext.json、layout.json、diagrams/、comparisons.json） / DbSource；ID 独占分配 claim()
│  │  ├─ refactor.ts       跨文件联动：transformLayout（编辑器打开时改文档，否则改文件）、改表名同步 layout.json；删数据库时清理所有设计的引用；designNamesReferencingDb
│  │  └─ fsUtil.ts         读写 JSON/YAML/文本、列目录的小工具（基于 vscode.workspace.fs）
│  ├─ model/
│  │  ├─ normalize.ts      tbls JSON → NormalizedSchema（去默认 schema 前缀、推主键/唯一/自增、关联 enum、关系类型）
│  │  ├─ types.ts          原始字段类型 → LogicalType + 长度/精度
│  │  └─ store.ts          ★ ModelStore(storage, secrets)：按数据源缓存归一化模型和设计文档；dbName() 计算数据库显示名；comparison() 按设计+数据库计算差异；invalidate 事件驱动所有视图刷新；识别自己写的文件；监听凭据变化
│  ├─ diff/diff.ts         diffSchemas(design, db, pair)：表/字段/关系对比
│  ├─ canvas/canvasEditor.ts  ★ 设计画布自定义编辑器（CustomEditorProvider，selector `**/design/*/layout.json`）：一个设计一个文档、撤销重做、保存、备份、与 Webview 通信、
│  │                         applyChange（DesignOp + 布局 op + 设计图文件，编辑器打开时进撤销栈，否则直接写盘）、scope 切换、剪贴板（setClipboard/paste/pasteItems）、
│  │                         moveItems（跨层移动 + 命名空间改名确认）、deletePartition（连同内容，可撤销）、placeDiagram/deleteDiagram、source/add & remove、table/copyToDesign、design/rename
│  ├─ connection/
│  │  ├─ connectionPanel.ts   连接页面（WebviewPanel）：新建/编辑连接、测试、连接后创建 db、导入 JSON；init 消息带 TblsStatus，渲染 tbls 状态行 + 下载/测试/选文件按钮
│  │  └─ errors.ts            tbls 报错 → 中文友好提示（friendlyTblsError / friendlyMissingTblsError），错误里带 `action` 让 UI 给出按按钮
│  ├─ diagram/
│  │  ├─ erSync.ts         computeErSync(doc, diagram)：ER 图 vs 表结构 → 同步项（新增/修改/删除表、字段、关系；外键列推断；多选项）
│  │  ├─ diagramService.ts ★ 设计图读写（打开的文档优先）、计算待同步、prepare（按当前文本重新检测）、删除确认、编辑器内撤销、改 refs/ignored
│  │  └─ diagramEditor.ts  设计图自定义文本编辑器（CustomTextEditorProvider，viewType harness.diagram）
│  ├─ edit/editPanel.ts    编辑页面（WebviewPanel）：工作区 / 设计画布 / 分区画布的名称、说明，设计画布的目标数据库类型。open(kind, ws, id?, designId?)。
│  ├─ tbls/
│  │  ├─ runner.ts       调用 tbls（DSN 走环境变量 TBLS_DSN，超时、取消、报错遮罩），stripDsnFromTblsConfig
│  │  ├─ resolver.ts     解析 tbls 路径：用户配置 > 内置版本（必要时自动下载）；throw TblsResolveError 给 UI 兜底
│  │  ├─ manager.ts      写 `<globalStorage>/bin/tbls-<v>-<plat>-<arch>/tbls(.exe)` 与 tbls.current.json；install（下载 + 校验 sha256 + 解压 + chmod）/ probe / verify / readCurrent / uninstall
│  │  ├─ ensure.ts       activate 时（非阻塞）自动下载缺失的内置 tbls
│  │  └─ releases.ts     resolveBaseUrl / resolveVersion：从配置读 base URL 和版本
│  ├─ views/workspaceTree.ts  ★ 侧边栏树 TreeDataProvider：工作区 → 设计画布/数据库 两组 → 每层 设计表/设计图/分区画布（levelGroup.*，递归）→ 表/字段；layoutOf 读编辑器里的布局；数据库品牌图标；getParent 支持 reveal
│  ├─ views/treeDragAndDrop.ts  树拖拽：拖到设计画布 / 分区画布 / 分组节点 = 剪切到那一层（canvases.pasteItems）
│  ├─ commands/            命令实现（见第 7 节）
│  │  ├─ common.ts         Harness 上下文接口、register、pickWorkspace/pickSourceId/pickDesign(h,…)、sourceName、canvasNames、revealInTree、confirm 等
│  │  ├─ workspace.ts      新建工作区（自动创建设计画布）/ rename / delete / add / rename(F2分发) / edit（工作区/设计画布/分区画布） / refresh / openStorage
│  │  ├─ design.ts         新建设计画布（默认名"设计画布"）/ createBlank / createFromDb / createFromFile / setDriver / openRaw / openExt / rename / delete（列出分区画布和设计图数量）
│  │  ├─ db.ts             create / editConnection / sync / clearConnection / importSnapshot / importTblsConfig / openConfig / openSnapshot / delete；sync 错误用 friendlyMissingTblsError，action 字段驱动"下载 tbls / 设置 tbls 路径 / 查看 Releases…"三按钮
│  │  ├─ tbls.ts           harness.tbls.checkUpdate（已安装版本 vs 内置版本）/ repair（重新下载）/ openFolder（打开 `<globalStorage>/bin/`）
│  │  ├─ canvas.ts         design.open、partition.open / create / rename / delete / setNamespace、item.copy / cut / paste、source.addToCanvas、table.revealInCanvas
│  │  └─ diagram.ts        diagram.create / open / openText / rename / delete / copyForAI、design.copyForAI
│  └─ webview/html.ts      Webview HTML（生产：dist + nonce CSP；开发：指向 Vite），<body data-view> 选择页面
├─ webview-ui/src/         Webview 前端（一个 bundle，多个页面）
│  ├─ main.ts              按 data-view 挂载 App.vue（画布）/ ConnectionApp.vue / EditApp.vue / DiagramApp.vue；浏览器开发时安装对应 mock host
│  ├─ vscode.ts            acquireVsCodeApi 封装：post / request（带 requestId 等回复）/ onHostMessage
│  ├─ store.ts             ★ 画布页面状态：canvas(shallowRef)、design、sources、diagrams、catalog、comparison、level（当前层）、clipboard、selection（table/column/relation/note/diagram/partition）；
│  │                       editCanvas / designOp / setLevel / setClipboard / paste / moveItems / deletePartition / deleteDiagram / acceptDiff / focusNode / focusItems / focusLevel / reveal；savedViewport（根视口）
│  ├─ App.vue              ★ 画布页面外壳：面包屑（当前层路径 + 聚焦）、工具栏（新建表、+ 设计图 ▾、+ 分区画布、+ 便签、自动布局、字段显示、对比）、按当前层创建、
│  │                       Ctrl+C / X / V、Esc 先清选中再缩放到父层、F 聚焦选中、Delete = 隐藏、右键菜单、左右面板折叠成 32px 竖条（记住状态）；
│  │                       新建表只能通过工具栏 / 右键 / 属性面板，**不再支持双击画布空白或框内**（容易误触）
│  ├─ canvas/viewModel.ts  ★ buildView(canvas, sources, comparison, diagrams)：总是从根生成全部层 → tables（displayName/namespaceTag）/ edges / partitions（父在前）/ diagrams / notes / levels（各层内容列表）
│  ├─ canvas/layout.ts     ★ elkjs 自动布局：layoutTables、layoutLevel（多层复合节点，INCLUDE_CHILDREN）、placeNewTables
│  ├─ components/
│  │  ├─ CanvasView.vue    ★ Vue Flow 画布：分区框用 parentNode 嵌套（坐标相对父框）；拖入 / 拖出分区框（跨层走 items/move，用迟滞带 DRAG_ENTER_INSET/DRAG_LEAVE_OUTSET=16px 避免边缘闪烁，dropTarget 只更新高亮不再触发 rebuild）；双击设计图卡片 = 右侧 Mermaid 编辑获得焦点；双击分区框任意位置 = 聚焦；设计图卡片可调大小；onlyRenderVisibleElements；focusOn 自算 bbox + maxZoom 1.5
│  │  ├─ TableNode.vue     表节点（短名 + 灰色命名空间标签，悬停显示真实表名，选中时 FocusButton）
│  │  ├─ PartitionNode.vue ★ 分区框：标题栏（折叠、名称、命名空间、数量、聚焦 ⤢），双击标题/任意空白 = 聚焦，标题以外的任意位置（不在子节点上）都可以拖动整体框架；未折叠时右下角调整大小手柄（拖动时显示草稿尺寸，emit resize 由 CanvasView 写入 partition.put）；collapsed 状态隐藏手柄
│  │  ├─ DiagramNode.vue   ★ 设计图卡片：Mermaid 预览（MermaidPreview compact）、类型、"待同步 N"、选中时 FocusButton、右下角调整大小
│  │  ├─ NoteNode.vue      便签节点（选中时 FocusButton）
│  │  ├─ FocusButton.vue   选中时显示的 ⤢ 聚焦按钮，点击 → focusItems
│  │  ├─ Inspector.vue     属性面板（设计表/字段/关系编辑；分区画布：名称、说明、命名空间、本层内容列表、聚焦、删除；空选中：当前层概况 + 本层内容列表 + 新建按钮）
│  │  ├─ DiagramInspector.vue 设计图属性：名称、类型、说明、MermaidCodeEditor（300ms debounce）、per-diagram SyncPanel、复制给 AI / 隐藏 / 删除 / 单独标签页
│  │  ├─ DbTableInspector.vue 数据库表只读结构视图：来源、快照时间、注释、字段（类型/标志/FK 指向）、索引、外键、被引用、复制按钮、从画布移除
│  │  ├─ LevelContents.vue 层内内容列表（分区框、设计表、设计图、数据库表、便签），点击 = reveal
│  │  ├─ DiffPanel.vue     差异列表
│  │  ├─ SourcePanel.vue   ★ 数据源面板（只显示当前层）：设计表（本层 N，全部显示）、设计图（本层 N，全部显示）、每个数据库（显示全部表、⟳、✕）+ 添加数据库
│  │  ├─ ContextMenu.vue   右键菜单
│  │  └─ SyncPanel.vue     同步项勾选列表（画布"待同步"页签和设计图编辑器共用）
│  ├─ diagram/             DiagramApp.vue（文本 + 预览 + 差异面板）、MermaidCodeEditor.vue（从 DiagramApp 抽取的文本框：行号、Tab、防抖、外部修改提示，画布右侧和独立编辑器共用）、MermaidPreview.vue（按需 import mermaid）、mermaid.ts（共享 loader）、host.ts
│  ├─ connection/          ConnectionApp.vue（连接页面）、DriverFields.vue（按库类型渲染字段）、form.ts、host.ts
│  ├─ edit/                EditApp.vue（编辑页面）、host.ts
│  └─ dev/                 mockHost.ts（v3 布局，示例分区画布 + 设计图；浏览器模式不支持粘贴） / mockConnectionHost.ts / mockEditHost.ts / mockDiagramHost.ts / fixtures.ts（仅开发模式，不进生产包）
└─ test/                   canvas / clipboard / copyTables / connection / designOps / diff / workspace / fixtures / mermaidEr / diagramSync / quickColumns 单元测试
```

## 4. 存储结构（磁盘上的数据）

```
<storageDir 或 globalStorage>/
├─ harness.json                       { version:1, seq:{ workspace:N } }  工作区编号计数器
└─ workspaces/<workspaceN>/
   ├─ workspace.yml                   name, description, seq:{design,db}
   ├─ design/<designN>/
   │  ├─ design.yml                   name, description, createdFrom, sources:[dbN…], seq:{diagram}
   │  ├─ schema.json                  tbls 格式（可直接 tbls doc json://...）；全部设计表只有这一份；模块存在 tbls 自带的 viewpoints 里
   │  ├─ ext.json                     {version:2, relations:[{key,kind,...}]}  tbls 表达不了的信息
   │  ├─ comparisons.json             {version:1, dbs:{[dbN]:{tableMappings?,acceptedDiffs?}}}  按数据库 ID 分开存
   │  ├─ layout.json                  CanvasFile v3：{version:3, seq, partitions[], nodes[], diagrams[], notes[], comparison?, settings, viewports{root|partN}}
   │  └─ diagrams/<diagramN>.md       设计图：YAML frontmatter（type/name/description/refs/bind/ignored/layout）+ 一个 ```mermaid 代码块
   └─ db/<dbN>/
      ├─ source.yml                   name（备用名，不含主机）, connection:{kind:'secret',driver} | {kind:'none'}, defaultSchema, include, exclude, snapshotRetention
      ├─ .tbls.yml                    可选，导入时已去掉 dsn
      └─ snapshots/<ISO时间>.json     tbls out 原始输出，文件名可排序，保留最近 N 个（默认 10）
```

**与第一阶段的区别**：

- `workspace.yml` 的 `seq` 不再有 `canvas`。
- 设计画布目录从 `source.yml` 改为 `design.yml`，增加 `sources`（引用的数据库 ID 列表）。
- 多画布 `canvases/<canvasN>.json` 和 `lastCanvas`、`seq.canvas` 已去掉，改为每个设计一个 `layout.json`。**旧的 `canvases/` 目录不迁移、不删除**，只是不再读取；设计表会自动显示在根画布上。
- 对比数据从 `comparisons.json`（工作区一级）移到 `design/<designN>/comparisons.json`，按数据库 ID 索引。

**`layout.json` 要点**：

- `nodes` 是数组（设计表 `source:'design'` 和数据库表 `source:dbN` 放在一起），每条可带 `partition`、`hidden`、`display`。一张表（含数据库表）在一个设计画布里只出现在一层。
- 坐标相对所在的分区框左上角；在根画布上是绝对坐标。
- 分区框可带 `width?` / `height?`（手动最小值）。最终大小 = `max(手动, 内容包围盒 + padding, PART_MIN)`：空分区框保留至少 PART_MIN（320×160）大小以便圈地；内容超出时撑大。折叠时固定 PART_COLLAPSED（240×58），手动值不生效。
- `schema.json` 里有、`layout.json` 没记录的设计表（例如 AI 直接改了 `schema.json`）和没记录的设计图：显示在根画布上（自动排位），复制 / 剪切前会先写入记录。
- 分区画布 ID `partN` 由 `layout.json` 的 `seq` 分配，只增不复用。
- `partitions[].namespace = {kind:'schema'|'prefix', value}`；`prefix` 的值自动补 `_`。

**ID 与名称规则**（`shared/workspace.ts` + `storage.ts`）：

- ID 形如 `workspace3`、`design2`、`db1`、`diagram4`、`part2`，内部分配，**只增不复用**（删除后也不回收）。
- 编号 = max(计数器, 现有 ID 的数字) + 1；创建时用**独占方式**占位（`fs.mkdir` 非递归 / `writeFile` flag `wx`），遇到 EEXIST 换下一个号，最多 20 次 —— 多窗口同时新建也不冲突。
- 工作区、设计画布、分区画布的名称可以改（F2、编辑页面、属性面板），ID 不变。默认名："工作区 N"、"设计画布 N"、"分区画布 N"（重名追加 " (2)"）。
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

**凭据**：`context.secrets` 键 `harness.dsn:v2:<workspaceId>:<dbId>`，值为 `ConnectionProfile` 的 JSON（旧版纯 DSN 字符串会被当作 `custom` 类型读取）。
**globalState**：`harness.lastConnectionDriver`（连接页默认库类型）、`harness.lastDesignDriver`（新设计画布默认库类型）。

## 5. 核心概念与数据流

### 5.1 主进程对象关系（`extension.ts`）

```
HarnessStorage + secrets ──► ModelStore(缓存 + onDidChange + dbName) ──► WorkspaceTreeProvider（树）
                         │                          └► CanvasEditorProvider → CanvasSession（每个打开的设计画布一个，记住当前层 scope）
                         └── StorageWatcher（存储目录文件变化 → store.onFileEvent → invalidate）
Harness 上下文 h = { context, storage, store, tree, treeView, canvases, diagrams, connections } 传给所有命令
canvases.onDidChangeLayout → tree.refresh()（树的层级内容来自布局，编辑器里没保存的改动也会反映到树上）
```

- **所有读取都走 `ModelStore`**，所有写入后调用 `store.invalidate({workspace, kind, id})`，树和打开的画布自动刷新。
- 自己写的文件通过 `noteOwnWrite` / `writeDesignDoc` 记录，文件监听会跳过，避免循环刷新。
- 布局变化的 `StoreChange` 是 `{kind:'canvas', id: designId, design: designId}`。

### 5.2 画布编辑（布局类）

Webview `editCanvas()` 本地立即应用 → `canvas/edit` 消息 → `CanvasSession.applyCanvasEdit` 更新文档并 `recordEdit`（进入 VS Code 撤销栈，文档变脏）→ Ctrl+S 保存由 `saveCustomDocument` 写 `layout.json`。撤销/重做/还原会把整份 canvas 推回 Webview（`{type:'canvas'}`）。

树命令和跨层操作统一走 `CanvasEditorProvider.applyChange(ws, design, {label, ops, edit, files?, confirmed?})`：编辑器打开时进它的撤销栈（含设计图文件的删除 / 恢复），没打开时直接写 `schema.json` / `ext.json` / `layout.json` / 设计图文件。

### 5.3 设计编辑（改表、字段、关系）

Webview `designOp()` → `design/op`（带 requestId，等回复）→ `applyDesignOps`：
检查 schema/ext 是否有未保存的文本编辑 → 删除表时弹模态确认 → 纯函数 `applyDesignOps` 计算新文档 → `store.writeDesignDoc` 立即落盘 → 表改名时 `refactor.renameDesignTable` 同步本设计的所有画布 → `recordEdit` 注册撤销（撤销前校验文件没被别处改过）→ `reply`。
**注意**：画布上按 Delete 只是隐藏（设计表 / 设计图 `hidden.set`，数据库表从画布移除，便签删除），从设计画布删表必须走右键「删除表」+ 二次确认。

### 5.4 复制数据库表到设计

Webview `table/copyToDesign`（source: dbId, tables: string[]）→ `CanvasSession.copyTablesToDesign`：
读取原始 db snapshot（`TblsSchema`，不是归一化后的 `NormalizedSchema`）→ 若有重名弹对话框选跳过/改名 → `copyTableOps(tables, relations, {existingTables, onConflict})` 纯函数生成 `DesignOp[]` → `applyDesignOps` + 同时在画布上放新节点。

### 5.5 对比

画布 `comparison: {db: dbId, mode}` → `store.comparison(workspace, designId, dbId)` = `diffSchemas(normalize(design), normalize(dbSnapshot), pair)` → `{type:'comparison'}` 推给 Webview → `viewModel.buildView` 生成标记。
差异 ID 格式 `kind:table:column|relation`；确认偏差写 `design/<designN>/comparisons.json` 的 `dbs[dbId].acceptedDiffs`；表名不同靠 `tableMappings`。

### 5.6 分区画布、命名空间、复制 / 剪切

- **整张画布渲染 + 当前层 + 聚焦**（修复文档 3 R1–R2）：画布始终渲染全部层（不再按 scope 裁剪），`buildView` 从根构建。当前层（`level`）只影响左侧面板列表、工具栏新建位置和粘贴目标。面包屑显示当前层路径，点击 = `focusLevel`（缩放视图而不切换页面）。`Esc`：先清选中，再缩放到父层。选中对象右上角显示聚焦按钮 `⤢`，`F` 快捷键 = 聚焦选中的 bounding box。`focusOn()` 自算 bbox + maxZoom 1.5。`onlyRenderVisibleElements` 始终开启。只记一个根视口（`savedViewport`）。
- **当前层规则**：选中分区框 = 这个分区；选中表 / 图 / 便签 = 它所在的层；点画布空白 = 根；点分区框内空白 = 这个框。
- **创建**：在哪层创建就属于哪层（工具栏、右键、树上 +）。新建表按所在层的命名空间补前缀 / schema。**不再支持双击画布空白或框内新建表**——双击分区框（标题或任意空白处）= 聚焦；双击设计图卡片 = 右侧 Mermaid 编辑。
- **移动**：画布上把表 / 设计图 / 便签 / 分区框拖进或拖出分区框 = 剪切到那层（`items/move` → `moveItems`）；目标层命名空间不同时弹窗问"改名 / 保持原名"。树上拖拽同理（只做移动）。分区不能移到自己的子分区里。**拖入 / 拖出分区框的判定有 16px 迟滞带**（节点中心必须进入框内 16px 才算进入，离开外侧 16px 才算离开），避免在框边轻微抖动时反复切换放置目标；`dropTarget` 只更新高亮，不再触发整图重建。**分区框整体可拖动**（标题以外的空白区域也可以），方便拖大 / 拖空框。
- **手动调整大小**：分区框未折叠时，右下角有调整大小手柄（与设计图卡片一致）。拖动时显示草稿尺寸，松开时 `partition.put` 写入 `width`/`height`；折叠时手柄隐藏。
- **复制 / 剪切 / 粘贴**：树和画布都支持 `Ctrl+C / X / V` 与右键；剪贴板在主进程（`harness.clipboard` context key）。复制是深度复制：表按 `_copy`、`_copy2` 改名或换命名空间，副本内部外键指向副本；设计图复制文件并改 `refs`（Mermaid 代码不改写）；数据库表复制后粘贴成设计表（`clipboard.ts` 的 `dbSchemas/fromDb/relationOp`），剪切拒绝。粘贴到当前层（鼠标在层内 → 鼠标位置，否则 freeSpot）。
- **命名空间**：`harness.partition.setNamespace`（树右键 / 面包屑 / 属性面板）。PostgreSQL、SQL Server、Redshift、Oracle 默认 schema，其他默认前缀；子分区不设置时继承。设置时可以选择把本层已有的表改名。画布上显示短名 + 灰色标签，同层短名冲突时回退显示真实名。
- **删除分区画布**：连同子分区、设计表、设计图、便签、数据库表一起删除，删除前模态列出数量；编辑器打开时可 `Ctrl+Z`（设计图文件也会恢复）。
- **自动布局**：`layoutLevel`（ELK 复合节点，`hierarchyHandling: INCLUDE_CHILDREN`，多层分区一起排）；对无子内容的叶子分区使用 `PartitionView.width/height`（已包含手动值），不再硬编码 PART_MIN。只排选中的表时用 `layoutTables`。

### 5.7 添加数据库（连接页面）

`harness.db.create` → `ConnectionPanels.openCreate(ws)` 打开 WebviewPanel（`view:'connection'`）：

1. `init`：库类型列表默认上次选择。页面**没有名称输入框**，只显示"显示为"预览（`connectionLabel(profile)`，随输入实时变化）。同时下发 `TblsStatus`：
   - `bundled`：内置 tbls 已下载，状态行显示版本和路径。
   - `user-configured`：`harness.tblsPath` 已设置，状态行显示 ⚠ 提示用本地版本。
   - `missing`：内置还没下载，状态行提示缺失，附「下载内置 tbls / 选择本地文件… / 测试」三个按钮；测试会立刻下载并验证。
2. 测试连接：`validateProfile` → `buildDsn` → `resolveTblsPath`（内置版本不存在时**同步触发下载**，下载失败抛 `TblsResolveError`，UI 显示"下载 tbls / 设置 tbls 路径 / 查看 Releases…"）→ `tblsOutJson`（`TBLS_DSN` 环境变量、超时、可取消）→ 结果按 profile+过滤条件的 sha256 缓存 5 分钟。
3. 连接：（有缓存用缓存，否则执行 tbls）→ `ws.claimDb()` 占 `dbN` 目录 → 写 `source.yml`（备用名 + driver，不含主机）→ 存凭据 → 写快照；任何一步失败回滚（删凭据、删目录）。
4. 成功后关闭页面、在树中定位新数据库。**不会加入任何画布**。

编辑连接：`harness.db.editConnection` → `openEdit(db)`，密码/自定义 DSN 不回传给 Webview，留空表示沿用已保存值。
同步：`harness.db.sync` 读凭据 → `parseStoredConnection` → `buildDsn` → `resolveTblsPath` → tbls → 写快照，错误经 `friendlyTblsError` / `friendlyMissingTblsError` 提示并提供"编辑连接… / 设置 tbls 路径 / 下载 tbls / 查看 Releases…"。

#### 5.7.1 tbls 二进制管理（方案 E）

`harness.tblsPath` 留空时使用内置版本。布局：

```
<globalStorage>/bin/
├─ tbls.current.json                  { version, platform, arch, filename, sha256, installedAt, source }
└─ tbls-<v>-<platform>-<arch>/
   ├─ tbls.exe（windows）或 tbls（mac/linux）
   ├─ tbls_v1.86.0_windows_amd64.zip（下载原文件，可选）
   └─ *.sha256 文件（下载时一并获取时记录）
```

- **激活**：`extension.ts` 在 `activate` 末尾调用 `ensureTbls(context)`（**非阻塞** catch 记日志）。`ensureTbls` 仅当 `harness.tblsPath` 为空 + `harness.tblsAutoDownload !== false` + `probe` 找不到对应版本时调 `install`。
- **`install(context, version, baseUrl)`**（`tbls/manager.ts`）：
  1. `pickAsset(platform, arch, version)` 决定文件名（`tbls_v1.86.0_<plat>_<arch>.zip|tar.gz`），不支持组合抛错。
  2. `probe` 已存在则直接返回。
  3. 用 `globalThis.fetch` 拼 `${baseUrl}/v${version}/<filename>` 下载，存到 `os.tmpdir()` 临时目录。
  4. 优先尝试下载 `<filename>.sha256`，命中则在解压前校验压缩包 sha256，不一致抛 `下载校验失败`。
  5. 解压：`tar.x` 解 `.tar.gz`，手写 PKZIP 解 `.zip`（找条目名以 `tbls` 或目标名结尾的，只写这一个文件，避免依赖第三方 unzip）。
  6. 非 Windows 上 `chmod 0o755`。
  7. 写 `tbls.current.json` 记录 `source: 'downloaded'`。
- **`resolveTblsPath(context, configured?, { extensionVersion, skipBundled?, skipDownload? })`**（`tbls/resolver.ts`）：
  1. 配置非空且路径存在 → 返回它（用户覆盖）。
  2. 否则 `probe(context, extensionVersion)`。
  3. 没有就抛 `TblsResolveError('missing-bundled')`（或自动下载失败时 `'download-failed'`），由调用方决定 UI 兜底。
- **状态查询**：`connectionPanel.buildTblsStatus()` 读 `probe` + 配置 → `TblsStatus`，init 消息里下发；状态行按钮触发 `pickTblsPath`（写设置）/ `testTbls`（`execFile --version`）/ `installTbls`（调 `install`）；完成都重新发 `ready` 重拉 init。
- **命令**（`commands/tbls.ts`）：
  - `harness.tbls.checkUpdate`：跑 `--version` 对比 installedVersion 和 bundledVersion，提示"已是最新 / 可下载 v…"，并提供"重新下载"。
  - `harness.tbls.repair`：`withProgress` 调 `install`，完成后 `verify`（再 sha256 一次），开 `openFolder`。
  - `harness.tbls.openFolder`：确保 `bin/` 存在后 `env.openExternal`。
- **同步/连接错误兜底**：`friendlyMissingTblsError(TblsResolveError)` → `{ message, action: 'downloadTbls' }`；`db.ts` 错误对话框展示 "下载 tbls / 设置 tbls 路径 / 查看 Releases…" 三按钮，分别跳到 `harness.tbls.repair` / 打开设置 / 浏览器打开 GitHub Releases。
- **方案文档**：`docs/step2initdev/04tbls配置/`（README + 4 篇）。

### 5.8 新建

- 工作区：`storage.createWorkspace(name)`，自动创建一个设计画布（`emptyDesignSchema`），树中定位。
- 设计画布：`ws.createDesign(meta, doc)`，默认名 `设计画布`（`nextDefaultName` 去重），只出现在树里；库类型推断顺序：最新快照 driver → 上次选择 → postgres。`layout.json` 在第一次打开时创建（`ensureLayout`）。
- 分区画布：`harness.partition.create`（树）或工具栏"+ 分区画布"（`partition.put`，ID 用 `nextPartitionId`）。
- 编辑：树节点上的铅笔按钮 / 右键"编辑…" → `harness.edit` → `EditPanels.open(kind, ws, id, designId?)`，kind 为 workspace / design / partition。
- 重命名：F2 → `harness.rename` 按选中节点类型转发（含 `partition.rename`）；数据源面板中 `design/rename` 消息改设计画布名；数据库提示"名称来自连接信息"。

### 5.9 设计图与同步

- **新建**：树上某层"设计图"分组的 + / 画布工具栏"+ 设计图 ▾" / 右键 → `harness.diagram.create`：选类型；ER 图可以选空白 / 全部表 / 某个 viewpoint / 挑选的表（用 `generateErDiagram` 生成）→ `design.createDiagram(text)`（独占分配 `diagramN`，`design.yml` 记 `seq.diagram`）→ `placeDiagram` 放到目标层 → 选中卡片，右侧面板显示 Mermaid 文本。
- **画布卡片**：`DiagramNode.vue` 显示 Mermaid 预览，双击 = 选中 + 右侧文本框获得焦点，右下角调整大小；删除设计图（树 / 属性面板）会删文件并移出布局，编辑器打开时可撤销。
- **右侧编辑**（修复文档 3 R3）：选中设计图后，右侧属性面板显示 `DiagramInspector.vue`：名称、类型、说明、Mermaid 文本（`MermaidCodeEditor.vue`，行号、Tab 缩进、300ms debounce、语法错误、外部修改"重新载入"提示、`execCommand('insertText')` 保留原生 undo）、per-diagram `SyncPanel`、复制给 AI / 隐藏 / 删除 / 单独标签页。文本变化走 `diagram/code` 消息直接写盘（不进画布撤销栈），同时本地更新 `state.diagrams[i].code` 使卡片实时重渲。
- **单独标签页编辑器**：`CustomTextEditorProvider`（`harness.diagram`），文本文档就是数据源，AI / 用户也可以直接改 `.md` 文件（"以文本打开"）。Webview 左边 Mermaid 文本（250ms 防抖回写代码块），中间 mermaid.js 预览（`securityLevel: 'strict'`），右边"与表结构的差异"。双向回写用"上次发送的文本"去重，避免吞字。保留在右键"在单独标签页中打开"和 `diagram.openInTab` 命令。
- **差异计算**：`DiagramService.compute` = `parseDiagram` → `parseErDiagram` → `computeErSync(designDoc, er)`。范围：图里画出的实体 + frontmatter `refs`（上次同步时图里的表）；`refs` 里有但图里没画的表才会建议删除。删除类默认不勾选；没有字段块的实体只表示"引用"，不比较字段。
- **应用**：勾选 → `prepare`（按当前文本重新检测，id 对不上就报"设计图已经变化"）→ 有删表时模态确认 → `applyDesignOps`。从画布"待同步"页签应用时走画布的撤销栈（Ctrl+Z）；从设计图编辑器应用时，面板上有一次"撤销上次同步"（校验文件没被别处改过）。成功后把图里的表写回 `refs`。
- **忽略**：同步项 id 稳定（如 `column.add:users.email`），"忽略"写入 frontmatter `ignored`，可以"恢复"。
- **复制给 AI**：`harness.diagram.copyForAI` / `harness.design.copyForAI` 把 `media/spec/mermaid-design.md` + 当前内容（设计画布名、库类型、图的代码或整库 ER 图）+ "我的需求"占位复制到剪贴板。**只包含模型内容，不含任何连接信息。**
- **画布**：画布上每个设计画布的 ER 图有差异时，右侧"待同步"页签显示数量（`pendingSync` 消息，文件变化后 300ms 重新计算）；设计画布没有表时，空状态提供"新建表"和"新建 ER 图（和 AI 一起设计）"。
- **快速添加字段**：属性面板表视图里一行 `email varchar(128) not null unique 登录邮箱`，多行或 `;` 分隔；常用模板 id / created_at / updated_at / deleted_at，类型按设计画布的库类型选。

## 6. 消息协议速查

**画布**（`src/shared/protocol.ts`）

| 方向 | type | 说明 |
| :-- | :-- | :-- |
| Host→Web | `init` | canvas + design(DesignContext) + sources(SourceData[]) + diagrams(DiagramData[]) + catalog + comparison + clipboard |
| Host→Web | `canvas` / `source` / `design` / `diagrams` / `comparison` / `catalog` | 增量更新 |
| Host→Web | `reveal` | RevealTarget：选中并聚焦某项（item?、column?、edit?），edit = 把光标放到 Mermaid 文本 |
| Host→Web | `clipboard` | 剪贴板状态 {mode, count}（树和画布共用） |
| Host→Web | `reply` | 对 request 的回复 {requestId, ok, error, message?} |
| Host→Web | `pendingSync` | 画布上各设计图的待同步项 SyncGroup[] |
| Web→Host | `ready` | Webview 就绪，主进程随后发 init |
| Web→Host | `canvas/edit` | 画布布局编辑（CanvasEdit） |
| Web→Host | `design/op` | 设计编辑（DesignOp[]，可附带 canvasEdit），需要 reply |
| Web→Host | `diff/accept` | 确认/取消确认差异，需要 reply |
| Web→Host | `viewport` / `db/sync` / `openRaw` | 根视口保存、同步数据库、打开原始文件 |
| Web→Host | `level` | 当前层变化（选中/聚焦决定，通知树跟随） |
| Web→Host | `clipboard/set` / `clipboard/paste` | 复制或剪切 ItemRef[] / 粘贴到当前层（可带位置），paste 需要 reply |
| Web→Host | `items/move` | 跨层移动 MoveItem[]（可能弹命名空间改名确认），需要 reply |
| Web→Host | `partition/delete` / `partition/namespace` | 删除分区画布（需要 reply） / 设置命名空间 |
| Web→Host | `diagram/create` | 在某层新建设计图（partition?、at?、diagramType?）；主进程 reveal {edit:true} 回来 |
| Web→Host | `diagram/code` | 右侧面板的 Mermaid 文本变化，直接写盘（不进画布撤销栈） |
| Web→Host | `diagram/meta` | 改设计图名称/说明 |
| Web→Host | `diagram/openInTab` / `diagram/copyForAI` | 在单独标签页打开 / 复制给 AI |
| Web→Host | `diagram/delete` | 删除设计图，需要 reply |
| Web→Host | `source/add` / `source/remove` | 添加/移除设计画布引用的数据库，需要 reply |
| Web→Host | `design/rename` | 重命名设计画布，需要 reply |
| Web→Host | `table/copyToDesign` | 数据库表复制到设计（source + tables[] + partition? + at?），需要 reply |
| Web→Host | `sync/apply` / `sync/ignore` | 把勾选的同步项写入表结构 / 忽略或恢复，需要 reply |

**设计图编辑器**（`src/shared/diagramProtocol.ts`）：Host→Web `init | doc | context | sync{group?, undo?} | reply`；Web→Host `ready | code | meta | sync/apply | sync/ignore | sync/undo | regenerate | command{copyForAI|openText|openCanvas}`。

**连接页面**（`src/shared/connectionProtocol.ts`）：Web→Host `ready | test | connect | importFile | pickFile | pickTblsPath | testTbls | installTbls | openTblsSettings | openTblsReleases | openUrl | cancel | close`；Host→Web `init{..., tblsStatus}`、`result | filePicked | tblsPathPicked | tblsTested | tblsInstalled`。`connect` / `importFile` 不带名称：连接用 `defaultConnectionName` 作为备用名，导入用 schema 名或文件名。`tblsStatus` 是 `{ source: 'bundled' | 'user-configured' | 'missing', bundledVersion, installedVersion?, resolvedPath? }`。

**编辑页面**（`src/shared/editProtocol.ts`）：Web→Host `ready | save{name, description, driver?} | close`；Host→Web `init{kind: workspace|design|partition, name, description, driver?, drivers?, tableCount?} | result`。

## 7. 命令一览（`package.json` 声明，`src/commands/*` 实现）

| 文件 | 命令 |
| :-- | :-- |
| `workspace.ts` | `workspace.create`（一键，自带设计画布）/ `rename` / `delete` / `add`（新建…快捷菜单：设计画布 + 数据库）、`harness.rename`（F2 分发）、`harness.edit`（打开编辑页面）、`refresh`、`openStorage` |
| `design.ts` | `design.create`（一键空白，默认名"设计画布"）/ `createBlank` / `createFromDb` / `createFromFile` / `setDriver` / `openRaw` / `openExt` / `rename` / `delete`；子菜单 `harness.design.newMenu` |
| `diagram.ts` | `diagram.create` / `open` / `openText` / `rename` / `delete` / `copyForAI`、`design.copyForAI` |
| `db.ts` | `db.create`（打开连接页）/ `editConnection` / `sync` / `clearConnection` / `importSnapshot` / `importTblsConfig` / `openConfig` / `openSnapshot` / `delete`（删除确认列出受影响的设计画布）；`sync` 错误对话框带 "下载 tbls / 设置 tbls 路径 / 查看 Releases…" 三按钮 |
| `tbls.ts` | `tbls.checkUpdate`（对比内置版本 vs 已装版本）/ `repair`（重新下载并 sha256 自检）/ `openFolder`（打开 `<globalStorage>/bin/`） |
| `canvas.ts` | `design.open`（打开设计画布，可带层级）、`partition.open` / `create` / `rename` / `delete` / `setNamespace`、`item.copy` / `cut` / `paste`（树上 Ctrl+C / X / V，表、设计图、分区画布通用）、`source.addToCanvas`、`table.revealInCanvas`（跨设计搜索，切换到表所在层） |

多画布命令 `canvas.*` 和分区命令 `zone.*` 已删除。

命令参数统一是 `NodeArg`（`{workspace?, id?, design?, ...}`，来自树节点或 Webview），缺省时弹选择框（`pickWorkspace` / `pickSourceId` / `pickDesign`）。

## 8. 改什么去哪里

| 需求 | 位置 |
| :-- | :-- |
| 新增/修改命令、菜单、快捷键、设置 | `package.json` + `src/commands/*.ts` |
| 新增画布上的编辑动作（布局类） | `shared/canvas.ts` 加 CanvasOp → Webview 调 `editCanvas` |
| 新增设计编辑动作 | `shared/designOps.ts` 加 DesignOp（写测试 `test/designOps.test.ts`）→ Webview 调 `designOp` |
| 新增画布 Webview⇄主进程消息 | `shared/protocol.ts` → `canvasEditor.ts onMessage` → `webview-ui/src/store.ts` / 组件；同步改 `dev/mockHost.ts` |
| 支持新的数据库类型 / 修改 DSN 拼接 | `shared/connection.ts`（`CONNECTION_DRIVERS`、`buildDsn`）+ `test/connection.test.ts` |
| tbls 报错提示 / 友好错误 | `connection/errors.ts`（`friendlyTblsError` + `friendlyMissingTblsError`，后者带 `action`） |
| tbls 调用参数、超时 | `tbls/runner.ts` |
| tbls 二进制解析（用户覆盖、内置下载、自动选择） | `tbls/resolver.ts` + `tblsPlatform.ts`（`pickAsset`） |
| tbls 下载 / 安装 / 校验 / 查版本 | `tbls/manager.ts`（`install` / `probe` / `verify` / `readCurrent` / `uninstall`） |
| tbls 自动下载入口 | `tbls/ensure.ts`（`ensureTbls`）+ `extension.ts` activate 末尾 |
| tbls 命令（checkUpdate / repair / openFolder） | `commands/tbls.ts` |
| 存储格式、新文件类型、ID 分配 | `shared/workspace.ts`（类型）+ `workspace/storage.ts`（读写） |
| 跨文件联动（改名/删除） | `workspace/refactor.ts` |
| 分区画布、层级、跨层移动 | `shared/canvas.ts`（op）+ `canvasEditor.ts`（moveItems / deletePartition）+ `components/CanvasView.vue`（拖入拖出 / 迟滞带 / dropTarget 高亮） |
| 分区框手动大小 | `shared/canvas.ts`（`CanvasPartition.width/height`）+ `viewModel.ts buildView`（`max(手动, 内容包围盒)`）+ `layout.ts layoutLevel`（叶子节点使用 PartitionView 尺寸）+ `PartitionNode.vue`（`.resize` 手柄 emit resize）+ `CanvasView.vue`（resizePartition → `partition.put`） |
| 复制 / 剪切 / 粘贴规则 | `shared/clipboard.ts` + `test/clipboard.test.ts`；主进程 `canvasEditor.ts paste/pasteItems`；树 `views/treeDragAndDrop.ts` |
| 命名空间规则 | `shared/namespace.ts` + `test/clipboard.test.ts`；设置命令 `commands/canvas.ts setNamespace` |
| 复制数据库表到设计 | `shared/copyTables.ts` + `test/copyTables.test.ts`；画布端 `canvasEditor.ts copyTablesToDesign` |
| tbls → 统一模型的转换、类型映射 | `model/normalize.ts`、`model/types.ts` |
| 差异规则 | `diff/diff.ts` + `test/diff.test.ts` |
| 树节点显示（描述、图标、提示） | `views/workspaceTree.ts` |
| 数据库显示名规则 | `shared/connection.ts connectionLabel`（+ `test/connection.test.ts`）、`model/store.ts dbName` |
| 数据库品牌图标 | `media/db/*.svg` + `workspaceTree.ts DRIVER_ICONS` |
| 画布节点/连线/分区框/设计图卡片渲染、差异标记 | `webview-ui/src/canvas/viewModel.ts`、`components/TableNode.vue`、`PartitionNode.vue`、`DiagramNode.vue`、`CanvasView.vue` |
| 多层自动布局（ELK 复合节点） | `canvas/layout.ts layoutLevel` |
| 属性面板（选中对象） | `components/Inspector.vue`（总入口、设计表/字段/关系、分区画布、便签、空选中概况）、`DiagramInspector.vue`（设计图）、`DbTableInspector.vue`（数据库表）、`LevelContents.vue`（层内容列表） |
| 右侧 Mermaid 编辑 | `diagram/MermaidCodeEditor.vue`（行号、Tab、防抖、错误、外部修改提示）；`diagram/mermaid.ts`（共享 loader） |
| 连接页面 UI | `webview-ui/src/connection/*` + `dev/mockConnectionHost.ts` |
| 编辑页面（名称、说明、设计画布类型） | `src/edit/editPanel.ts` + `shared/editProtocol.ts` + `webview-ui/src/edit/*` + `dev/mockEditHost.ts` |
| Webview CSP / 开发服务器 | `src/webview/html.ts`、`webview-ui/vite.config.mts` |
| 设计图文件格式、新的图类型 | `shared/diagram.ts`（`DIAGRAM_TYPES`）+ `test/mermaidEr.test.ts` |
| ER 图写法（解析/生成） | `shared/mermaid/er.ts` + `test/mermaidEr.test.ts`；AI 规范同步改 `media/spec/mermaid-design.md` |
| ER 图 → 表结构的同步规则 | `diagram/erSync.ts` + `test/diagramSync.test.ts` |
| 设计图编辑器 UI | `diagram/diagramEditor.ts` + `shared/diagramProtocol.ts` + `webview-ui/src/diagram/*` + `dev/mockDiagramHost.ts` |
| 快速添加字段语法、字段模板 | `shared/quickColumns.ts` + `test/quickColumns.test.ts` |

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
- **无别名架构**：画布节点的 `source` 直接用 `'design'` 或数据库 ID（如 `'db1'`），不再有 `d1`/`b1` 别名和 `sources` 数组。`DESIGN_SOURCE = 'design'` 是固定常量。

## 10. 测试

| 文件 | 覆盖 |
| :-- | :-- |
| `test/canvas.test.ts` | 布局 v3 操作（nodes.put/display、hidden.set、move 换层、禁止移到自己的子分区、partition.put 的 ID 不复用、partition.put 写入并 round width/height、partition.remove 连同内容）、partitionPath、移除数据库、改表名、解析容错、序列化稳定性 |
| `test/clipboard.test.ts` | 命名空间（按库类型默认、前缀补 `_`、继承）；复制（`_copy` 命名、命名空间里保留短名、一起复制的外键指向副本、分区深度复制、禁止粘贴到自己的子分区）；剪切（默认不改名、命名空间改名、禁止移到自己的子分区） |
| `test/copyTables.test.ts` | 数据库表复制到设计：字段/主键/唯一/注释/关系、重名跳过和改名、虚拟关系、空输入 |
| `test/designOps.test.ts` | 设计编辑操作 |
| `test/diff.test.ts` | 差异对比 |
| `test/workspace.test.ts` | `nextSeq` / `nextDefaultName` / `uniqueName` / ID 校验 |
| `test/connection.test.ts` | `connectionLabel` 显示名、各库 `buildDsn`、编码、IPv6、默认加密、参数覆盖、SQLite 路径、校验、凭据序列化、遮罩、`friendlyTblsError` |
| `test/tbls.test.ts` | `pickAsset` 各平台/架构映射（zip/tar.gz、文件名前缀 `v` 处理）、不支持组合返回 undefined、`binDirName` 稳定 |
| `test/fixtures.test.ts` | 浏览器 mock 示例数据（`webview-ui/src/dev/fixtures.ts`）能归一化，并覆盖画布要展示的各类差异 |
| `test/mermaidEr.test.ts` | 设计图文件读写往返、erDiagram 解析（别名、键、注释、行号、错误）、表结构 → ER 图 → 解析往返 |
| `test/diagramSync.test.ts` | ER 图同步项：新增/修改/删除、依赖、没字段块的实体、关系类型/基数、外键列推断与多选、多对多、忽略；viewpoints 表改名和删除 |
| `test/quickColumns.test.ts` | 快速添加字段语法、类型猜测、模板、生成 DesignOp |

## 11. 已知限制 / 待办

- 不识别改名（显示为一边缺少一边多出）；复合外键在画布上只连第一列。
- MCP Server（不得向 AI 暴露连接信息）、`tbls lint` 接入未做。
- 连接页面、自动命名、tbls 自动下载 / 状态行 / 三按钮兜底尚未在真实 Cursor 环境中完整走查（单元测试、typecheck、build 已通过）。
- 设计图：表改名不会同步改图里的名字和 `refs`；不能手动把"删除 + 新增"配对成改名；编辑器内撤销只有一次、用按钮；非 ER 图不同步。详见 `docs/step2initdev/03设计库开发/第一阶段完成说明与第二阶段方案.md`。
- 旧版 `canvases/*.json` 不迁移到 `layout.json`（旧布局里的坐标、数据库表、便签会丢失，设计表本身不受影响）。
- 分区画布没有"默认展开 2 层"，只按每个框的 `collapsed` 显示；折叠的框不能作为拖放目标。
- 左侧数据源列表项没有右键复制 / 剪切，也不能直接拖到画布上（在画布或树上操作）。
- 复制 ER 图时只改 `refs`，不改写 Mermaid 代码里的表名。
- 缩小时简化显示（只显示表名）未做。
- 聚焦时不淡化其他对象（只缩放视图），可在后续加"淡化其他内容"开关。
- 修复文档 4（去双击创建表、分区手动调整大小、拖动迟滞消除闪烁）以及方案 E（tbls 自动下载 + 用户覆盖 + 错误兜底）已完成开发（typecheck、140 个单元测试、build 已通过），尚未在真实 Cursor 环境中完整走查。

## 12. 相关文档

| 文档 | 内容 |
| :-- | :-- |
| `harness-cursor/README.md` | 用户使用说明、开发脚本、适配器与差异规则 |
| `docs/design.md`、`docs/DDD.md`、`docs/init.md` | 早期整体设计 |
| `docs/setp1/` | 第一阶段需求、tbls 调研 |
| `docs/tbls/tbls使用.md` | tbls 用法 |
| `docs/step2initdev/01初始化/` | 阶段二：Vite HMR、工作区模型、侧边栏、画布、开发计划、实现记录 |
| `docs/step2initdev/02新增设置/` | 自动命名（01）、连接页面（02）、tbls 能力分析（03）、开发计划（04） |
| `docs/step2initdev/03设计库开发/` | 设计库需求分析、初步优化方案、第一阶段完成说明与第二阶段方案、**第二阶段方案**（合并为设计画布、画布分区、数据库表复制）、**第二阶段修复文档**（树结构调整、显示全部表 toggle）、**第二阶段修复文档 2**（嵌套分区画布、命名空间、复制剪切、设计图卡片、面板折叠；第 5.12 节是实现与方案的偏差）、**第二阶段修复文档 3**（R1 去掉层级切换改为聚焦、R2 聚焦按钮、R3 右侧设计图编辑、R4 右侧面板增强、R5 收尾）、**第二阶段修复文档 4**（去双击创建表、P2 分区框手动调整大小、P3 拖动边缘迟滞消除闪烁） |
| `docs/step2initdev/04tbls配置/` | 第二阶段方案 E：tbls 现状与问题、方案与选型、推荐方案、影响范围和实现计划 |

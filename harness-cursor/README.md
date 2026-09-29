# Harness（Cursor 插件）

以 [tbls](https://github.com/k1LoW/tbls) 的 JSON 格式为统一数据标准，在画布上编排和编辑**设计库**，查看**数据库实际结构**，并对比两者的差异。

- **工作区**：组织设计库、数据库和画布。可以有任意多个，保存在插件自己的存储目录里，不写进项目目录。工作区、设计库、画布新建时默认叫"工作区 1""设计库 1""画布 1"，都可以重命名（F2），也可以点树节点上的铅笔按钮打开编辑页面，修改名称、说明，以及设计库的目标数据库类型。
- **设计库**：tbls 格式的 `schema.json` 加上扩展信息 `ext.json`。不需要连接数据库就能创建和编辑，可以直接用 `tbls doc json://...` 生成文档。
- **数据库**：调用 `tbls out -t json` 读取数据库结构，原样保存为快照。在画布上只读。名称直接显示连接的 `主机:端口/库名`（端口始终显示，SQLite 显示文件名，离线导入的显示导入时的名称），不能单独改名；图标按数据库类型显示。这个名称只在界面上显示，不会写进任何文件。
- **画布**：`*.canvas.json`，只保存引用了哪些数据源、放了哪些表、放在哪里。表的内容每次都从数据源实时读取，同一张表可以出现在多个画布里。
- **设计图**：设计库下的 Mermaid 图，支持 ER 图、状态图、时序图、流程图、数据流图。可以把图"复制给 AI"，让 AI 按规范修改 Mermaid 文本；ER 图和表结构不一致时，差异列在右侧面板里，由你勾选确认后才同步到表结构。AI 不会直接改表结构。

插件不会修改数据库。要改数据库结构，由用户和 AI 根据差异生成 SQL，用户自己执行后再同步。

## 使用

1. 点击活动栏的 Harness 图标，点"新建工作区"。
2. 在工作区下新建设计库（空白、从数据库快照复制、或者导入 tbls JSON 文件），或者添加数据库（连接数据库，或者导入别处导出的 tbls JSON）。
3. 新建画布，把数据源加进去。在画布上：
   - 双击空白处新建表，在右侧属性面板编辑表和字段；
   - 从一个字段拖到另一张表的字段上建立关系，选择关系类型（外键、逻辑关系、JSON 数组、多态、字典）；
   - 按 **Delete 只从画布移除**。要从设计库中删除表，用右键菜单"从设计库中删除表…"，并在弹窗中确认；
   - 工具栏"对比"选择一个设计库和一个数据库，差异会直接标在表上，右侧"差异"页签列出全部差异，可以确认为有意的偏差；
   - Ctrl+Z / Ctrl+Shift+Z 撤销和重做，设计编辑也可以撤销；
   - 属性面板选中一张表时，可以在"快速添加字段"里一行写一个字段，例如 `email varchar(128) not null unique 登录邮箱`，或者点 id / created_at / updated_at / deleted_at 模板。
4. 用设计图和 AI 一起设计：
   - 在设计库的"设计图"下点 +，选择图的类型。ER 图可以从空白开始，也可以从全部表、某个模块或挑选的表生成；
   - 编辑器左边是 Mermaid 文本，中间是预览，右边是"与表结构的差异"。点"复制给 AI"会把书写规范和当前内容一起复制，粘贴到对话里再写上你的需求；把 AI 返回的 ER 图粘回来，右侧会列出要新增、修改、删除的表、字段和关系；
   - 勾选要同步的项，点"同步选中的项到表结构"。删除类默认不勾选，删表还会再确认一次。不想同步的项可以"忽略"；
   - 画布右侧的"待同步"页签也会列出画布上各设计库 ER 图的差异，在那里同步的内容可以用 Ctrl+Z 撤销。

连接串只保存在系统凭据里，不会写进任何文件。建议使用只读的数据库账号。导入带 `dsn` 的 `.tbls.yml` 时，插件会去掉 `dsn` 再保存，并提示把它存入凭据。

### 设置

| 设置 | 作用 |
| :-- | :-- |
| `harness.tblsPath` | tbls 可执行文件的路径。已经在 PATH 里时不用填 |
| `harness.storageDir` | 工作区的存放目录。不填时使用插件的全局存储目录；可以改成网盘或单独的 Git 仓库来备份、共享 |

## 开发

需要 Node.js **22.12 以上**（Vite 8 的要求），`.nvmrc` 里是 `22.14.0`。

```powershell
nvm use 22.14.0
npm install
npm run build
```

| 脚本 | 作用 |
| :-- | :-- |
| `npm run build` | 构建插件主进程（esbuild）和 Webview（Vite） |
| `npm run typecheck` | 用 `tsc` 检查插件代码，用 `vue-tsc` 检查 Webview 代码 |
| `npm test` | 运行 vitest 单元测试（`test/`） |
| `npm run dev:webview` | 启动 Vite 开发服务器（端口 5173） |
| `npm run package` | 打包成 `.vsix`，在 Cursor 里选择"从 VSIX 安装" |

### Webview 热更新

在"运行和调试"里选择 **Run Extension (Webview HMR)** 按 F5：先启动 esbuild 监听和 Vite 开发服务器，再打开扩展开发宿主窗口，Webview 直接从 Vite 加载。修改 `webview-ui/src` 下的文件会立即生效；修改 `src/` 下的插件代码后，esbuild 自动重新构建，在开发宿主窗口里执行 `Developer: Restart Extension Host`。

**Run Extension** 配置使用构建好的 `dist/webview`，用来检查生产模式。

### 在浏览器里调试 Webview

`npm run dev:webview` 后打开 `http://localhost:5173`。页面不在 VS Code 里时会加载 `webview-ui/src/dev/mockHost.ts`，在内存里模拟插件主进程，带一组手写的示例数据。

## 存储目录的结构

```
<存储目录>/workspaces/<工作区ID>/
├─ workspace.yml
├─ comparisons.json               # 设计源和数据库源之间的表名映射、已确认的差异
├─ design/<ID>/source.yml, schema.json, ext.json, diagrams/<ID>.md
├─ db/<ID>/source.yml, .tbls.yml（可选，不含 dsn）, snapshots/*.json
└─ canvas/<ID>.canvas.json
```

ID 创建后不能修改，"重命名"只改显示名称。详细格式见 `docs/step2initdev/02-workspace-model.md`。

## 代码结构

```
src/
├─ extension.ts                 # 入口
├─ shared/                      # 插件和 Webview 共用，不依赖 vscode
│  ├─ tbls.ts / model.ts        # tbls 格式、统一模型、差异结果
│  ├─ workspace.ts              # 工作区和数据源的文件类型、ID 规则
│  ├─ canvas.ts                 # 画布文件和画布编辑操作
│  ├─ designOps.ts              # 设计编辑操作（纯函数）
│  └─ protocol.ts               # 插件和 Webview 之间的消息
├─ workspace/                   # 存储目录读写、跨文件联动修改
├─ model/                       # normalize（tbls JSON → 统一模型）、类型映射、模型缓存
├─ diff/diff.ts                 # 设计库与数据库的结构对比
├─ canvas/canvasEditor.ts       # 画布自定义编辑器：撤销重做、保存、和 Webview 通信
├─ diagram/                     # 设计图编辑器、ER 图与表结构的差异和同步
├─ views/workspaceTree.ts       # 侧边栏树视图
├─ commands/                    # 各类命令
├─ webview/html.ts              # Webview HTML（生产模式 / Vite 开发模式）
└─ tbls/runner.ts               # 调用 tbls（报错信息里会遮掉密码）
webview-ui/src/                 # Vue 3 + Vue Flow + elkjs + mermaid
test/                           # 单元测试
```

### 适配器做了什么

tbls 的 JSON 是数据库的原始快照，`normalize.ts` 负责把它转换成便于对比的统一模型：

- 去掉默认 schema 前缀，例如 `public.users` → `users`，得到每张表的 `key`
- 从 `constraints` 和 `indexes` 推出字段的主键、唯一标记
- 从 `default`（`nextval(...)`）、`extra_def`、`serial` 类型推出是否自增
- 把字段类型映射成逻辑类型，并拆出长度、精度（`types.ts`）
- 把字段关联到对应的 enum
- 关系类型：数据库里的真实外键是 `fk`，`.tbls.yml` 里声明的是 `virtual`；设计库里 `virtual: true` 的关系当作 `logical`。`ext.json` 的 `relations` 可以改成 `json_array`、`polymorphic`、`dictionary`

### 差异对比的规则

- 表按 `key` 匹配，名字不同时在 `comparisons.json` 的 `tableMappings` 里写映射
- 字段按名字匹配，比较逻辑类型、长度、是否可空、是否主键，以及 enum 的取值
- 只有设计中 `kind` 为 `fk` 的关系，才要求数据库里有外键；`logical` 等其他类型不要求
- 已确认的差异写入 `comparisons.json` 的 `acceptedDiffs`，之后不再计入待处理数量

## 已知限制

- 画布分组框、从面板拖表到画布、Ctrl+F 搜索表还没做
- 还没有检测改名：改名会显示成"一边缺少、一边多出"
- 复合外键在画布上只连接第一列
- MCP Server、接入 `tbls lint` 都还没做
- 设计图：表改名后图里的名字不会跟着改；只有 ER 图能同步到表结构；默认值、索引、enum 不能在 ER 图里表达

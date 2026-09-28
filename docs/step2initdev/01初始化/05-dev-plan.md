# 05 开发计划：改动清单、里程碑、验收标准

> 这是开发前的计划。实际的文件划分（例如 `project.ts` 等合并成 `storage.ts`、没有 `migrate.ts`）、未完成的部分和验收清单，以 [06-implementation-notes.md](./06-implementation-notes.md) 为准。

## 一、代码改动清单

路径都相对于 `harness-cursor/`。

### 1.1 新增

| 文件 | 内容 | 对应文档 |
| :-- | :-- | :-- |
| `src/webview/html.ts` | Webview HTML 生成，区分开发模式和正式模式 | 01 |
| `src/shared/workspace.ts` | `ProjectConfig`、`WorkspaceMeta`、`DesignSourceMeta`、`DbSourceMeta`、`ComparisonsFile`、`SourceRef` 类型；ID 格式校验和生成函数 | 02 |
| `src/shared/canvas.ts` | `CanvasFile` 等类型，`applyCanvasEdit` 纯函数，画布文件的固定格式输出 | 04 |
| `src/shared/designOps.ts` | `DesignOp` 类型，`applyDesignOp` 纯函数 | 04 |
| `src/workspace/project.ts` | `HarnessProject`：`.harness/` 目录、工作区列表、旧版本检测 | 02 |
| `src/workspace/workspace.ts` | `HarnessWorkspace`：数据源和画布的增删改、`comparisons.json` | 02 |
| `src/workspace/designSource.ts` | `DesignSource` | 02、04 |
| `src/workspace/dbSource.ts` | `DbSource`：同步、导入快照、快照保留数量、凭据 | 02 |
| `src/workspace/refactor.ts` | 改名、删除时的跨文件引用更新 | 02 |
| `src/workspace/migrate.ts` | 第一阶段目录结构的迁移（纯函数 + 执行器） | 02 |
| `src/workspace/fsUtil.ts` | 从现在的 `harnessWorkspace.ts` 中抽出的 `exists`、`readText`、`writeJson` 等 | — |
| `src/model/store.ts` | `ModelStore`：按数据源缓存标准化模型，文件变化时刷新 | 02 |
| `src/views/workspaceTree.ts` | 新的树视图 | 03 |
| `src/commands/workspace.ts`、`design.ts`、`db.ts`、`canvas.ts` | 按对象类型拆分命令 | 03 |
| `src/canvas/canvasEditorProvider.ts` | 自定义编辑器的注册和 Webview 消息处理 | 04 |
| `src/canvas/canvasDocument.ts` | `CanvasDocument`：画布内容、撤销记录、保存、备份 | 04 |
| `webview-ui/src/store/`、`components/*`、`dev/*` | 见 04 文档第九节 | 04 |
| `test/**/*.test.ts` | vitest 单元测试 | 本文第三节 |

### 1.2 修改

| 文件 | 改动 |
| :-- | :-- |
| `package.json` | 视图 ID 改为 `harness.workspaces`；替换命令、菜单、欢迎页；增加 `customEditors`；增加 `dev:webview`、`test` 脚本；增加 `vitest`、`@vscode-elements/elements` 依赖 |
| `webview-ui/vite.config.mts` | 增加 `server` 配置 |
| `webview-ui/src/vscode.ts` | 缓存 `acquireVsCodeApi` 的结果；增加 `request`、`getState`、`setState`；浏览器模式接入 `mockHost` |
| `esbuild.mjs` | watch 模式下输出构建开始和结束的标记 |
| `.vscode/launch.json`、`tasks.json` | 增加热更新的启动配置和后台任务 |
| `src/extension.ts` | 注册新的树视图、命令、自定义编辑器；文件监听改为按数据源刷新；设置 `harness.needsMigration` |
| `src/shared/model.ts` | `HarnessExt` 改为 `DesignExt`（version 2，去掉 `tableMappings`、`acceptedDiffs`，`groups` 改名为 `modules`） |
| `src/model/normalize.ts` | 参数中的 `ext` 类型改为 `DesignExt`；增加 `defaultSchema` 来自 `DbSourceMeta` 的情况 |
| `src/diff/diff.ts` | 第三个参数从 `HarnessExt` 改为 `ComparisonPair` |
| `src/tbls/runner.ts` | 支持 `--include`；导入 `.tbls.yml` 时检查 `dsn` 字段的函数放在这里 |
| `src/shared/protocol.ts` | 替换为 04 文档第八节的协议 |
| `webview-ui/src/canvas/model.ts` | 改名为 `viewModel.ts`，输入改为"画布文件 + 多个数据源 + 差异" |
| `webview-ui/src/components/TableNode.vue`、`ErCanvas.vue`、`DiffList.vue`、`App.vue` | 按 04 文档的界面改造 |
| `README.md` | 更新目录结构和使用说明 |

### 1.3 删除

| 文件 | 由什么代替 |
| :-- | :-- |
| `src/harnessService.ts` | `HarnessProject` + `ModelStore` |
| `src/workspace/harnessWorkspace.ts` | `project.ts`、`workspace.ts`、`designSource.ts`、`dbSource.ts` |
| `src/workspace/config.ts` | 默认排除规则移到 `dbSource.ts`，项目配置移到 `project.ts` |
| `src/views/schemaTree.ts` | `workspaceTree.ts` |
| `src/webview/canvasPanel.ts` | `src/canvas/canvasEditorProvider.ts` |
| `src/commands.ts` | `src/commands/*.ts` |

## 二、里程碑

按顺序开发。每个里程碑完成后都应该能够编译通过，并且可以在扩展开发宿主中运行。

### S1 Webview 热更新（0.5 到 1 天）

内容：01 文档的全部内容。浏览器调试模式中的 `mockHost` 先只支持第一阶段的消息，S4 时再按新协议更新。

验收：01 文档第八节的所有条目。

### S2 工作区模型和存储（2 到 3 天）

内容：`src/shared/workspace.ts`、`src/workspace/*`、`src/model/store.ts`；`normalize.ts` 和 `diff.ts` 的参数调整；迁移功能。

验收：

- [ ] 用单元测试覆盖：ID 生成和校验；各个 `.yml` 文件的解析和默认值；迁移纯函数（输入第一阶段的文件内容，输出的文件列表正确）。
- [ ] 在一个第一阶段的测试项目里执行迁移，得到 02 文档第七节描述的目录结构，旧的连接串可以继续使用。
- [ ] 导入一个带 `dsn` 字段的 `.tbls.yml`，写入磁盘的文件中不包含 `dsn`，并出现保存到凭据的提示。
- [ ] 在项目目录里全文搜索连接串中的密码，找不到任何结果。

### S3 侧边栏和命令（2 天）

内容：03 文档的全部内容。本阶段"打开画布"先打开一个只显示文件名的占位 Webview。

验收：

- [ ] 在一个没有 `.harness/` 的项目中，打开 Harness 侧边栏，显示"新建工作区"欢迎页。
- [ ] 不连接任何数据库：新建工作区 → 新建空白设计源 → 新建画布，全程没有要求输入连接串。
- [ ] 添加数据库源，分别使用"连接数据库"和"导入 JSON 文件"两种方式，树中的节点状态和图标正确。
- [ ] 同步失败时，错误提示中不包含密码。
- [ ] 数据源改名后，`comparisons.json` 和画布文件中的引用同步更新，凭据跟着移动。

### S4 画布：显示和编排（3 到 5 天）

内容：自定义编辑器；画布文件的读写；多数据源显示；第四节的全部编排操作；撤销、重做、保存；增量布局。

验收：

- [ ] 在资源管理器中双击 `.canvas.json` 打开画布；同时打开两个画布互不影响。
- [ ] 在同一个画布里同时放入设计源和数据库源的表，两种表外观可以明显区分，数据库表不能编辑。
- [ ] 拖动、添加、移除节点后标签页显示未保存；Ctrl+Z 可以逐步撤销；保存后文件格式稳定（重复保存不产生 Git diff）。
- [ ] 数据库同步出新快照后，打开着的画布自动更新；已经不存在的表显示为"缺失"节点。
- [ ] 用 200 张表的测试数据打开画布，满足 04 文档第十节的性能目标。

### S5 画布：编辑设计表（4 到 6 天）

内容：`designOps.ts`；属性面板；新建表、拖线建立关系；写入冲突处理；设计编辑的撤销。

验收：

- [ ] `applyDesignOp` 的每种操作都有单元测试，包括联动修改（字段改名后约束、索引、关系都已更新）和反向操作（执行后再执行 `inverse`，结果和原来完全相同）。
- [ ] 在画布上修改设计表后，用 `tbls doc json://<schema.json 的路径> <输出目录>` 可以正常生成文档，确认文件仍然是合法的 tbls 格式。
- [ ] 在画布 A 中修改设计表，同时打开的画布 B 立即更新。
- [ ] 在画布 A 中修改后，再在画布 B 中修改同一张表，然后回到画布 A 撤销，会被拒绝并给出提示。
- [ ] 文本编辑器中 `schema.json` 有未保存的修改时，画布上的编辑被拒绝并提示原因。

### S6 画布：对比（2 到 3 天）

内容：04 文档第六节。

验收：

- [ ] 合并显示和并排显示可以切换，切换后节点位置保持不变。
- [ ] 在画布 A 中确认的偏差，在画布 B 中也显示为已确认。
- [ ] 点击差异可以定位到画布上对应的表和字段。
- [ ] 用第一阶段做过的冒烟测试数据验证：设计和数据库完全相同时，差异为 0；修改设计后，缺失、多出、不一致都能正确检出。

### 合计

大约 14 到 20 天（按业余时间计算会更长）。S1 到 S3 完成后就可以体验"离线设计"，S4 到 S6 是画布本身的功能。

## 三、测试

增加 vitest，只测试不依赖 `vscode` 模块的纯函数。这也是 01 文档第七节提到的原因：插件主进程改一次代码就要重新加载窗口，逻辑放在纯函数里用单元测试验证，效率高得多。

| 被测模块 | 重点 |
| :-- | :-- |
| `model/types.ts`、`model/normalize.ts` | 各数据库的类型解析；schema 前缀的去除；主键、唯一、自增的推导；关系类型的判断 |
| `diff/diff.ts` | 7 种差异；表映射；已确认的偏差 |
| `shared/designOps.ts` | 每种操作、联动修改、反向操作、校验错误 |
| `shared/canvas.ts` | 每种编排操作及其反向操作；保存格式稳定 |
| `workspace/migrate.ts` | 第一阶段各种文件组合（有没有快照、有没有 `.tbls.yml`、`ext.json` 为空等） |
| 凭据相关 | `maskDsn`、`maskSecret`；`.tbls.yml` 中 `dsn` 的检测和删除 |

测试数据放在 `test/fixtures/`，要求和 01 文档第六节的样例数据一样：只能用脱敏后的结构，不能包含任何连接串或密码。

## 四、风险和对策

| 风险 | 对策 |
| :-- | :-- |
| Vite 新版本调整跨域或文件访问的默认规则，导致开发模式白屏 | 01 文档 4.4 节的配置逐项显式写出；白屏时先看 Webview 开发者工具（命令"开发人员: 打开 Webview 开发人员工具"）的控制台 |
| 自定义编辑器中，输入框里的 Ctrl+Z 被当成画布撤销 | S4 开始时先做一个最小原型验证；如果有问题，在 Webview 中判断焦点位置，自己处理按键 |
| 快照很大（比如第一阶段那份包含约 9000 行扩展函数的导出） | 发送给 Webview 的是标准化后的模型，不包含函数和触发器；`exclude` 默认排除常见扩展表 |
| 设计编辑后 tbls 格式不合法，`tbls doc` 无法读取 | S5 的验收里包含真实运行 `tbls doc`；可以考虑在单元测试里用 tbls 的 JSON Schema（`tbls/spec/tbls.schema.json_schema.json`）校验输出 |
| 改名导致引用失效 | 所有改名都走 `refactor.ts`；画布中引用不到的表显示为"缺失"节点，而不是直接丢弃 |
| 连接串泄露 | 02 文档第五节的硬性要求；S2 的验收里包含全文搜索密码的检查 |

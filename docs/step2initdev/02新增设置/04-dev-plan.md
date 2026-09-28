# 04 开发计划

路径都相对于 `harness-cursor/`。

## 一、代码改动清单

### 1.1 新增

| 文件 | 内容 | 文档 |
| :-- | :-- | :-- |
| `src/shared/connection.ts` | `ConnectionProfile`、`buildDsn`、`validateProfile`、`defaultPort`、`describeProfile`、各数据库的字段和选项定义 | 02 第三、四节 |
| `src/shared/connectionProtocol.ts` | 连接页面的消息类型 | 02 8.2 节 |
| `src/connection/connectionPanel.ts` | 连接页面：打开和复用、测试、连接、导入文件、取消、编辑已有连接 | 02 |
| `src/connection/errors.ts` | tbls 错误信息 → 中文提示 | 02 6.4 节 |
| `webview-ui/src/connection/ConnectionApp.vue`、`DriverFields.vue` | 连接页面的界面 | 02 第二、三节 |
| `webview-ui/src/dev/mockConnectionHost.ts` | 浏览器调试模式下模拟测试和连接结果 | 02 8.1 节 |
| `test/connection.test.ts` | 连接串拼接和校验的单元测试 | 第三节 |

### 1.2 修改

| 文件 | 改动 | 文档 |
| :-- | :-- | :-- |
| `src/shared/workspace.ts` | 新增 `nextSeq`、`nextDefaultName`；`WorkspaceMeta` 增加 `seq`；`DbSourceMeta.connection` 增加 `driver` | 01 第二节、02 第五节 |
| `src/workspace/storage.ts` | 新增 `harness.json` 的读写；`allocateWorkspace()`、`HarnessWorkspace.allocate(kind)`：分配序号并独占创建目录或文件，冲突时重试 | 01 2.3 节 |
| `src/tbls/runner.ts` | 连接串改用环境变量 `TBLS_DSN`；增加 `timeoutMs`、`signal` | 02 6.3 节 |
| `src/commands/workspace.ts` | 新建工作区不再询问，自动创建"画布 1"；新增 `harness.rename`（F2） | 01 3.1 节、第四节 |
| `src/commands/design.ts` | 新建空白设计模型不再询问；"从数据库复制"、"从文件导入"拆成单独的命令；三种方式创建后都只在树中展开并选中，删除"在新画布中打开 / 添加到已有画布"；新增 `harness.design.setDriver` | 01 3.2 节 |
| `src/commands/canvas.ts` | 新建画布不再询问，直接打开 | 01 3.3 节 |
| `src/commands/db.ts` | `harness.db.create` 打开连接页面；`harness.db.setConnection` 改为 `harness.db.editConnection`，打开编辑模式的连接页面；同步时从 `ConnectionProfile` 拼接连接串，兼容旧的整串格式 | 02 第五、七节 |
| `src/commands/common.ts` | 删除 `promptId`、`promptDsn` | 01 第五节 |
| `src/canvas/canvasEditor.ts` | 提供"已打开画布的名称"查询；处理 `meta.set` 和数据源改名消息；数据源新建完成后向所有打开的画布推送最新的数据源列表（只刷新"+ 添加"菜单，不加入画布） | 01 3.5 节、第四节 |
| `src/shared/canvas.ts` | 新增画布操作 `meta.set`（名称、说明） | 01 第四节 |
| `src/shared/protocol.ts` | 新增 `source/rename`；`source/create` 只负责创建，不再带"加入当前画布"的选项 | 01 3.5 节、第四节 |
| `src/views/workspaceTree.ts` | 提示里显示 ID；画布节点优先使用已打开文档的名称；数据库节点的图标和描述使用 `connection.driver`；提供 `reveal(节点)`，新建后展开所在分组并选中 | 01 第三、四节 |
| `src/webview/html.ts` | `renderWebviewHtml` 增加 `view` 参数 | 02 8.1 节 |
| `webview-ui/src/main.ts` | 按 `data-view` 挂载画布或连接页面 | 02 8.1 节 |
| `webview-ui/src/App.vue` | 工具栏上的画布名称可以点击编辑 | 01 第四节 |
| `webview-ui/src/components/SourcePanel.vue` | 双击数据源名称改名 | 01 第四节 |
| `package.json` | 新增命令、`contributes.submenus`（新建设计模型的子菜单）、F2 快捷键、设置 `harness.tblsTimeoutSeconds`；删除 `harness.db.setConnection` | 01、02 |

## 二、里程碑

### M1 自动命名（约 1 天）

内容：`nextSeq`、`nextDefaultName`、序号的保存和独占创建；工作区（带一个空画布）、空白设计模型、画布的一键新建；F2 重命名；画布工具栏改名；数据源面板改名。

验收：

- [ ] 点工作区的 `+`，不弹任何输入框，出现"工作区 1"，存储目录下是 `workspace1/`，里面有 `canvas/canvas1.canvas.json`，树里的画布分组下是"画布 1"。
- [ ] 连续点三次设计分组的 `+`，得到"设计模型 1/2/3"，目录是 `design/design1/2/3`，每个目录里有 `source.yml`、`schema.json`、`ext.json`。删掉 `design3` 后再新建，目录是 `design4`，名称是"设计模型 3"。
- [ ] 新建设计模型后，树里展开"设计"分组并选中新节点；没有打开任何画布，已打开的画布内容没有变化，但它的"+ 添加"列表里能看到新模型。
- [ ] "从数据库复制"、"从 tbls JSON 文件导入"创建的设计模型，行为同上。
- [ ] 开两个 Cursor 窗口，同时点新建工作区，得到两个不同的目录，没有报错。
- [ ] 选中树节点按 F2 可以改名；在画布工具栏点击名称可以改名，Ctrl+Z 可以撤销。

### M2 连接页面（约 2 天）

内容：`connection.ts`、连接页面的界面和消息处理、测试和连接、导入 JSON 文件、编辑已有连接、错误提示、`TBLS_DSN` 和超时。

验收：

- [ ] 点数据库分组的 `+`，打开连接页面。第一个字段是数据库类型，下拉框里有 8 个选项。
- [ ] 在类型之间切换：字段、默认端口、加密选项、默认名称跟着变化；已填的主机、库名、用户名保留；改过的端口和名称不被覆盖。
- [ ] 选择 PostgreSQL，填入本地数据库的参数，点"测试连接"显示表数量。
- [ ] 点"连接"：树里出现"PostgreSQL · <库名>"并被选中，已经有一份快照，没有第二次读取数据库（看 tbls 的调用次数，或者看耗时）。
- [ ] 连接成功后没有任何画布发生变化；从画布数据源面板发起的"添加数据库"也一样，只是"+ 添加"列表里多了这个数据库。
- [ ] 存储目录里搜索主机地址、用户名、密码，都找不到；`source.yml` 的 `connection` 只有 `kind` 和 `driver`。
- [ ] 密码里带 `#`、`@`、`%`、空格时能正常连接。
- [ ] 填错密码、填错端口、填一个不存在的主机，分别显示对应的中文提示，并且没有创建任何文件。
- [ ] 连接一个不可达的公网地址，10 秒左右显示超时，点"取消"可以立即停止。
- [ ] 右键"编辑连接…"：表单已回填，密码框为空；不填密码直接保存，仍然可以同步。
- [ ] 第二阶段第一版保存的整串连接串，仍然可以同步，编辑时显示为"自定义连接串"。
- [ ] 同步时查看系统进程列表，tbls 的命令行参数里没有连接串。

## 三、单元测试

| 测试 | 内容 |
| :-- | :-- |
| `nextSeq` | 没有记录时从目录名推算；有记录时取两者较大值；忽略不符合格式的旧 ID（如 `order-system`） |
| `nextDefaultName` | 空列表返回"X 1"；有"X 1"、"X 3"时返回"X 4"；忽略用户自定义的名称 |
| `buildDsn` | 每种数据库的基本格式；用户名、密码、库名的编码；IPv6；安全连接选项；附加参数的顺序；SQLite 的 Windows 路径 |
| `validateProfile` | 必填字段、端口范围、SQLite 只要求文件路径、custom 只要求连接串 |
| 旧凭据兼容 | 非 JSON 的凭据被解析为 `custom` |
| 错误提示转换 | 每一类原始错误都能匹配到对应提示，并且结果里不包含密码 |

所有测试数据都用手写的示例值，例如 `reader` / `example-secret` / `db.example.test`，不使用任何真实的连接信息。

## 四、不在本次范围内

- 读取表里的数据（已确认暂不做，方案分析见 03 文档第四节）。
- 新建设计模型或数据库后自动加入画布（已确认不做）。
- 证书文件（CA、客户端证书）的表单字段。
- BigQuery、Snowflake 等云数据库的专用表单（先用"自定义连接串"）。
- Oracle 数据库的连接。

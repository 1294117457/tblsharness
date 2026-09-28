# 03 侧边栏、欢迎页与命令

> 实现时有调整：工作区放在插件存储目录里，所以没有"项目文件夹"这一层，不需要先打开文件夹；没有迁移功能（`harness.migrate`、`harness.needsMigration` 和对应的欢迎页都去掉了）；"重命名"只改显示名称；新增 `harness.openStorage`（在资源管理器中打开存储目录）。详见 [06-implementation-notes.md](./06-implementation-notes.md)。

## 一、改动要点

现在点击活动栏的 Harness 图标后，如果还没有同步过数据库，欢迎页显示"设置数据库连接 / 同步数据库结构"两个按钮。这意味着用户必须先有数据库才能开始。

改为：

1. 欢迎页只有一个主要按钮 **新建工作区**，文案说明"不需要连接数据库"。
2. 视图标题栏常驻一个 **新建工作区** 按钮（`$(add)` 图标），可以重复创建多个工作区。
3. 连接数据库、同步结构变成数据库数据源节点上的操作，不再是全局操作。
4. 原来树视图里的"差异"分组去掉，差异只在画布里显示（见 04 文档）。

## 二、树视图结构

视图 ID 从 `harness.schema` 改为 `harness.workspaces`，名称为"工作区"。

```
工作区                                          [新建工作区] [刷新]
▾ 订单系统                                      [+]
  ▾ 设计                                        [+]
    ▾ 核心模型          postgres · 12 张表
      ▾ orders          订单
          id            bigint · PK
          user_id       bigint · FK → users
    ▸ 二期草稿          postgres · 3 张表
  ▾ 数据库                                      [+]
    ▸ 开发库            34 张表 · 今天 10:50     [同步]
    ▸ 生产库            未设置连接
  ▾ 画布                                        [+]
      总览              2 个数据源 · 46 张表
      下单流程          2 个数据源 · 8 张表
▸ 用户中心
```

- 方括号里是鼠标悬停时出现在行尾的内联按钮。
- 如果 VS Code 打开了多个项目文件夹（多根工作区），最外面再加一层项目文件夹节点；只有一个文件夹时省略这一层。
- "设计 / 数据库 / 画布"三个分组节点始终显示，即使下面是空的。空分组显示一行灰色的提示节点，例如"还没有设计模型，点击 + 新建"，点击后执行对应的新建命令。

### 2.1 各类节点

| 节点 | `contextValue` | 描述文字 | 图标 | 单击 | 双击 |
| :-- | :-- | :-- | :-- | :-- | :-- |
| 工作区 | `workspace` | 说明的第一行 | `$(folder-library)` | 展开 | — |
| 分组：设计 | `group.design` | 数据源个数 | `$(edit)` | 展开 | — |
| 分组：数据库 | `group.db` | 数据源个数 | `$(database)` | 展开 | — |
| 分组：画布 | `group.canvas` | 画布个数 | `$(layout)` | 展开 | — |
| 设计数据源 | `design` | `<driver> · N 张表` | `$(symbol-structure)` | 展开 | 打开 `schema.json` |
| 数据库数据源 | `db.connected` 或 `db.offline` | `N 张表 · <同步时间>` 或"未设置连接" | 已设置连接：`$(plug)`；未设置：`$(debug-disconnect)`；最近一次同步失败：`$(warning)` | 展开 | 打开最新快照 |
| 画布 | `canvas` | `N 个数据源 · M 张表` | `$(type-hierarchy)` | **打开画布** | — |
| 表 | `table.design` 或 `table.db` | 表注释 | `$(table)` | 展开 | 在画布中定位（见 2.2） |
| 字段 | `column` | `类型 · PK / FK / UQ / NN` | `$(symbol-field)` | — | — |

`db.connected` 只表示"凭据里保存了连接串"，不代表数据库当前能连上。树视图不主动连接数据库。

### 2.2 "在画布中定位"的规则

1. 如果有打开着的画布包含这张表，切换到最近使用的那个画布，选中并居中显示这张表。
2. 否则，在所有画布文件里查找包含这张表的画布。只有一个就直接打开；有多个就让用户选。
3. 都没有，就询问"添加到哪个画布"，列出已有画布和"新建画布"。

## 三、欢迎页

欢迎页只在树视图为空时显示。按下面的条件从上到下匹配：

| 条件 | 内容 |
| :-- | :-- |
| 没有打开文件夹 | 请先打开一个项目文件夹。<br>[打开文件夹](command:vscode.openFolder) |
| 检测到第一阶段的目录结构 | 检测到旧版本的 Harness 目录结构，需要迁移后才能使用。<br>[迁移](command:harness.migrate)<br>迁移前会自动备份到 `.harness/.backup-v1/` |
| 还没有工作区 | 工作区用来组织设计模型、数据库结构和画布。不需要连接数据库，也可以直接开始设计。<br>[新建工作区](command:harness.workspace.create) |

`package.json` 中的写法：

```jsonc
"viewsWelcome": [
  {
    "view": "harness.workspaces",
    "contents": "请先打开一个项目文件夹。\n[打开文件夹](command:vscode.openFolder)",
    "when": "workbenchState == empty"
  },
  {
    "view": "harness.workspaces",
    "contents": "检测到旧版本的 Harness 目录结构，需要迁移后才能使用。\n[迁移](command:harness.migrate)\n迁移前会自动备份到 .harness/.backup-v1/",
    "when": "workbenchState != empty && harness.needsMigration"
  },
  {
    "view": "harness.workspaces",
    "contents": "工作区用来组织设计模型、数据库结构和画布。不需要连接数据库，也可以直接开始设计。\n[新建工作区](command:harness.workspace.create)",
    "when": "workbenchState != empty && !harness.needsMigration"
  }
]
```

插件激活时设置 `harness.needsMigration` 这个上下文键。

**激活时机：** VS Code 1.74 以后，插件声明的视图和命令会自动成为激活条件。所以用户点开 Harness 侧边栏、或者点欢迎页里的按钮时，插件会自动激活，不需要项目里已经有 `.harness/`。`activationEvents` 里保留 `workspaceContains:.harness/harness.yml` 即可。

## 四、新建流程

所有新建流程都用 `showInputBox` 和 `showQuickPick` 实现，任何一步按 Esc 都会取消，不留下半成品文件。文件在最后一步统一写入。

### 4.1 新建工作区 `harness.workspace.create`

1. 输入名称，例如"订单系统"。
2. 输入 ID，默认值按 02 文档 2.1 节的规则生成，并实时校验格式和是否重复。
3. 如果还没有 `.harness/harness.yml`，先创建它（第一阶段的 `initWorkspace` 命令合并到这里）。
4. 创建 `workspace.yml`、`comparisons.json` 以及 `design/`、`db/`、`canvas/` 三个空目录。
5. 在树中展开并选中新工作区，右下角提示"接下来要做什么"：**新建设计模型** / **添加数据库** / **以后再说**。

### 4.2 新建设计数据源 `harness.design.create`

1. 输入名称和 ID。
2. 选择目标数据库类型：PostgreSQL、MySQL、MariaDB、SQLite、SQL Server、Oracle、其他。这个值写入 `schema.json` 的 `driver.name`。
3. 选择初始内容：
   - **空白**
   - **从数据库数据源复制**：列出工作区内所有已有快照的数据库数据源，复制它的最新快照作为初始设计。去掉函数和触发器，逻辑和第一阶段的 `designFromSnapshot` 相同。目标数据库类型自动取快照里的值，跳过第 2 步。
   - **从 tbls JSON 文件导入**：选择一个文件。先按 tbls 格式校验，通过后再复制。
4. 创建完成后询问：**在新画布中打开** / **添加到已有画布** / **不打开**。

不需要连接任何数据库，完成后立刻可以在画布里添加表。

### 4.3 添加数据库数据源 `harness.db.create`

1. 输入名称和 ID。
2. 选择连接方式：
   - **连接数据库**：输入连接串，输入框是密码模式。提示文字给出 tbls 连接串的格式示例，例如 `postgres://user:pass@host:5432/dbname?sslmode=disable`，并提示"建议使用只读账号"。连接串保存到系统凭据。
   - **暂不连接，导入 tbls 导出的 JSON 文件**：选择文件，作为第一份快照。`connection.kind` 写为 `none`。
3. 如果选择了连接数据库，询问"是否立即同步结构"，确认后执行同步，右下角显示进度。
4. 同步失败不会回滚数据源的创建。节点显示 `$(warning)` 图标，鼠标悬停显示已去掉密码的错误信息。

### 4.4 新建画布 `harness.canvas.create`

1. 输入名称和 ID。
2. 多选要加入的数据源，也可以一个都不选，之后在画布里再添加。
3. 如果选择了数据源，再选择加入方式：**加入全部表** / **稍后在画布里挑选表**。
4. 如果同时选择了一个设计源和一个数据库源，询问是否开启这一对的对比。
5. 创建画布文件并打开。

## 五、命令清单

| 命令 ID | 标题 | 出现位置 |
| :-- | :-- | :-- |
| `harness.workspace.create` | 新建工作区 | 视图标题栏、欢迎页、命令面板 |
| `harness.workspace.rename` | 重命名 | 工作区右键 |
| `harness.workspace.delete` | 删除工作区 | 工作区右键（需要二次确认，并列出将删除的内容） |
| `harness.workspace.add` | 新建… | 工作区行尾的 `+`：弹出选择"设计模型 / 数据库 / 画布" |
| `harness.design.create` | 新建设计模型 | 设计分组行尾的 `+`、工作区右键 |
| `harness.design.openRaw` | 打开 schema.json | 设计数据源右键、双击 |
| `harness.design.openExt` | 打开 ext.json | 设计数据源右键 |
| `harness.design.rename` / `delete` | 重命名 / 删除 | 设计数据源右键 |
| `harness.db.create` | 添加数据库 | 数据库分组行尾的 `+`、工作区右键 |
| `harness.db.sync` | 同步结构 | 数据库数据源行尾（仅 `db.connected`）、右键 |
| `harness.db.setConnection` | 设置连接… | 数据库数据源右键 |
| `harness.db.clearConnection` | 清除已保存的连接 | 数据库数据源右键（仅 `db.connected`） |
| `harness.db.importSnapshot` | 导入快照文件… | 数据库数据源右键 |
| `harness.db.openConfig` | 编辑配置（source.yml） | 数据库数据源右键 |
| `harness.db.openSnapshot` | 打开最新快照 | 数据库数据源右键、双击 |
| `harness.db.rename` / `delete` | 重命名 / 删除 | 数据库数据源右键 |
| `harness.canvas.create` | 新建画布 | 画布分组行尾的 `+`、工作区右键 |
| `harness.canvas.open` | 打开画布 | 画布节点单击 |
| `harness.canvas.rename` / `delete` | 重命名 / 删除 | 画布右键 |
| `harness.source.addToCanvas` | 添加到画布… | 设计源、数据库源、表右键 |
| `harness.table.revealInCanvas` | 在画布中定位 | 表右键、双击 |
| `harness.refresh` | 刷新 | 视图标题栏 |
| `harness.migrate` | 迁移旧版本目录结构 | 欢迎页、命令面板 |

删除的旧命令：`harness.initWorkspace`、`harness.setDsn`、`harness.syncDb`、`harness.importDesignFromDb`、`harness.openCanvas`、`harness.acceptDiff`。它们的功能分别由上表中的新命令，以及画布里的操作代替。

只在右键菜单里使用的命令（需要知道是对哪个节点操作），要在 `menus.commandPalette` 里设置 `"when": "false"`，从命令面板中隐藏。能在命令面板里直接用的命令（新建工作区、新建画布等），在没有选中节点时先弹出选择框，让用户选择工作区。

菜单写法示例：

```jsonc
"view/item/context": [
  { "command": "harness.db.sync", "when": "view == harness.workspaces && viewItem == db.connected", "group": "inline@1" },
  { "command": "harness.db.sync", "when": "view == harness.workspaces && viewItem == db.connected", "group": "1_sync@1" },
  { "command": "harness.db.setConnection", "when": "view == harness.workspaces && viewItem =~ /^db\\./", "group": "1_sync@2" },
  { "command": "harness.design.create", "when": "view == harness.workspaces && viewItem == group.design", "group": "inline" }
]
```

## 六、实现说明

- `src/views/workspaceTree.ts` 替换现在的 `schemaTree.ts`。节点对象里保存 `SourceRef`（见 02 文档第四节），命令的参数就是被点击的节点。
- 树视图只读取 `ModelStore` 的缓存。展开节点时不访问数据库，也不重新解析文件。
- `ModelStore.onDidChangeSource` 触发时，只刷新对应的节点（`onDidChangeTreeData.fire(node)`），不刷新整棵树。
- 表节点下的字段列表来自标准化后的模型，所以主键、外键标记和画布上一致。

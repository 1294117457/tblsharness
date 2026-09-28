# 06 实现记录

这份文档记录第二阶段实际实现时和 01 到 05 文档不一致的地方。以代码和这份文档为准。

## 一、和设计文档的差异

### 1.1 存放位置和迁移（影响 02、03、05 文档）

- 工作区不再放在项目的 `.harness/` 下，而是放在插件存储目录里（`globalStorageUri`，或者设置 `harness.storageDir` 指定的目录）。02 文档已经按这个决定重写。
- 没有项目级配置文件 `harness.yml`。tbls 的路径只用设置项 `harness.tblsPath`。
- 没有迁移功能：去掉了 `harness.migrate` 命令、`harness.needsMigration` 上下文键和对应的欢迎页，也没有 `migrate.ts`。
- 侧边栏不再按"项目文件夹"分层，也不需要先打开文件夹。欢迎页只有一条："新建工作区"。
- `activationEvents` 为空，依靠视图、命令、自定义编辑器的隐式激活。
- 没有 `SourceRef` 里的 `folder` 字段；凭据键名是 `harness.dsn:v2:<工作区ID>:<数据库ID>`。

### 1.2 ID 不可修改（影响 02、03 文档）

- 所有"重命名"命令只修改显示名称。输入 ID 的输入框里会提示"创建后不能修改"。
- 因此不需要在改 ID 时更新画布的 `ref`、`comparisons.json` 和凭据键名。

### 1.3 类的拆分（影响 02、05 文档）

05 文档里计划的 `project.ts`、`workspace.ts`、`designSource.ts`、`dbSource.ts` 合并成一个文件 `src/workspace/storage.ts`（`HarnessStorage`、`HarnessWorkspace`、`DesignSource`、`DbSource`）。同步数据库的逻辑在 `src/commands/db.ts` 里。

### 1.4 设计编辑的操作（影响 04 文档 5.2 节）

- 没有单独的 `key.setPrimary`、`key.setUnique` 操作，改为 `column.update` 的 `patch.primaryKey`、`patch.unique`。
- `applyDesignOps(doc, ops)` 一次执行一组操作，**不生成反向操作**。撤销使用修改前后的完整快照：撤销时写回修改前的设计文档，执行前先比较设计源的当前内容是否和"修改后"一致，不一致就拒绝撤销并提示。
- `table.add` 默认带 `id` 字段（`withId`，默认 `true`）。
- `fk` 关系要求父表字段是主键或唯一键的警告还没有做。

### 1.5 画布编辑的操作（影响 04 文档第八节）

- `CanvasEdit` 是一组操作 `CanvasOp[]`，一次用户动作对应一个 `CanvasEdit`，撤销时整体恢复。
- 操作名改为：`nodes.put`（新增或移动，代替 `nodes.add` 和 `nodes.move`）、`group.put`、`note.put`，新增 `source.update`（切换 `all` / `picked`、固定快照）。
- `applyCanvasEdit` 同样不生成反向操作，撤销时恢复修改前的整个画布状态。

### 1.6 消息协议（影响 04 文档第八节）

| 文档中的名字 | 实际的名字 |
| :-- | :-- |
| `canvas/changed` | `canvas` |
| `source/changed`、`source/error` | `source`（出错时 `SourceData.error` 有值，`schema` 为空） |
| `diff/changed` | `comparison`（带上 `tableMappings`，Webview 需要用它把设计表和数据库表对应起来） |
| `catalog/changed` | `catalog` |

Webview 发给插件的消息新增 `source/create`：数据源面板里的"新建设计模型…"、"添加数据库…"会调用对应的侧边栏命令。

### 1.7 保存和未保存标记（影响 04 文档 7.2 节）

- 设计编辑立即写入设计源文件，但仍然会登记到画布的撤销栈里。VS Code 的自定义编辑器只要登记了修改就会显示未保存标记，所以设计编辑之后画布也会显示为未保存，保存时只是写入画布文件本身。
- 视口位置的变化只在内存里记录，保存时一起写入，不会单独让画布变成未保存。

### 1.8 Delete 键和删除（按确认的决定实现）

- 在画布上按 Delete 或 Backspace：只从画布移除选中的表和便签。焦点在输入框里时不处理。
- 如果被移除的表属于 `tables: 'all'` 的数据源，这个数据源会自动切换为 `picked`，并把其余表的当前位置写入 `nodes`，这样其余的表不会消失，被移除的表也不会自动回来。
- 从设计模型中删除表：右键菜单"从设计模型中删除表…"，插件弹出模态确认框，说明涉及的关系会一起删除、其他画布中的这张表会显示为"缺失"、可以撤销。
- 选中关系时按 Delete 不会删除关系，只提示去属性面板里删除。

### 1.9 还没有做的

- 画布上的分组框（`groups` 字段和 `group.*` 操作已经定义，界面还没有做）。
- 把表从数据源面板拖到画布上（目前是勾选）；双击表头改表名；选中表后按 Enter 添加字段；Ctrl+F 搜索表。
- 属性面板里拖动调整字段顺序（目前是上移、下移按钮）。
- "复制差异描述"按钮。
- 自动布局放进 Web Worker；节点超过 100 个时自动切换为"仅键"显示（目前只开启了 `onlyRenderVisibleElements`）。
- 界面控件没有使用 `@vscode-elements/elements`，用的是原生控件加 VS Code 主题变量。

## 二、代码结构

```
src/
├─ extension.ts                 # 入口：存储目录、ModelStore、树视图、画布编辑器、命令、文件监听
├─ shared/                      # 插件和 Webview 共用，不依赖 vscode
│  ├─ workspace.ts              # 工作区、数据源的文件类型；ID 校验和生成
│  ├─ canvas.ts                 # 画布文件类型、CanvasOp、applyCanvasEdit、序列化
│  ├─ designOps.ts              # 设计编辑操作 applyDesignOps、序列化
│  ├─ protocol.ts               # 插件和 Webview 之间的消息
│  ├─ model.ts / tbls.ts        # 统一模型、tbls 格式
├─ workspace/
│  ├─ storage.ts                # 存储目录和各类数据源的读写
│  ├─ refactor.ts               # 跨文件的联动修改
│  └─ fsUtil.ts
├─ model/store.ts               # 模型缓存、对比结果、变化通知
├─ canvas/canvasEditor.ts       # 自定义编辑器：CanvasDocument、撤销重做、和 Webview 的会话
├─ views/workspaceTree.ts       # 侧边栏树视图
├─ commands/                    # workspace / design / db / canvas 各类命令
├─ webview/html.ts              # Webview HTML：生产模式读 dist/webview，开发模式指向 Vite
└─ tbls/runner.ts               # 调用 tbls、去掉 .tbls.yml 里的 dsn、遮盖密码
webview-ui/src/
├─ App.vue                      # 工具栏、三栏布局、键盘、右键菜单、拖线建关系
├─ store.ts / vscode.ts         # 状态和通信
├─ canvas/viewModel.ts          # 画布文件 + 数据源 + 对比结果 → 节点和连线
├─ canvas/layout.ts             # elkjs 布局
├─ components/                  # CanvasView、TableNode、NoteNode、SourcePanel、Inspector、DiffPanel、ContextMenu
└─ dev/                         # 浏览器调试模式：mockHost.ts、fixtures.ts（手写的示例数据）
test/                           # vitest 单元测试
```

## 三、运行和验证

需要 Node.js 22.12 以上：

```powershell
nvm use 22.14.0
npm install
npm run typecheck
npm test
npm run build
```

### 3.1 在 Cursor 里调试（带热更新）

1. 在 Cursor 里打开 `harness-cursor/`。
2. 在"运行和调试"里选择 **Run Extension (Webview HMR)**，按 F5。会先启动 esbuild 监听和 Vite 开发服务器（端口 5173），再打开扩展开发宿主窗口。
3. 修改 `webview-ui/src` 下的 `.vue`、`.ts`、`.css` 文件，打开着的画布会立即更新。
4. 修改插件主进程的代码（`src/`）后，esbuild 会自动重新构建，需要在扩展开发宿主窗口里执行 `Developer: Restart Extension Host`（或者 `Reload Window`）。

**Run Extension** 配置使用构建好的 `dist/webview`，不需要 Vite，用来检查生产模式。

### 3.2 在浏览器里调试 Webview

```powershell
npm run dev:webview
```

打开 `http://localhost:5173`。页面检测到不在 VS Code 里，会加载 `dev/mockHost.ts`：在内存里模拟插件主进程，带一个示例设计模型和一个有差异的示例数据库。设计编辑、对比、确认偏差都能用；同步数据库、打开原始文件这类需要插件主进程的操作只在控制台打印一条日志。

### 3.3 手动验收清单

- [ ] 侧边栏为空时显示"新建工作区"；新建工作区后出现"设计 / 数据库 / 画布"三个分组。
- [ ] 不连接数据库，新建一个空白设计模型，并在新画布中打开。
- [ ] 画布上双击空白处新建表；在右侧属性面板改表名、加字段、改类型、设主键。
- [ ] 从一个字段拖到另一张表的字段上，选择关系类型，连线出现。
- [ ] Ctrl+Z / Ctrl+Shift+Z 撤销、重做以上操作；焦点在输入框里时 Ctrl+Z 只撤销输入框的文字。
- [ ] 选中表按 Delete：只从画布移除，设计模型里还在（左侧数据源面板里取消勾选）。
- [ ] 右键"从设计模型中删除表…"：弹出确认框；确认后表被删除，撤销后恢复。
- [ ] 添加数据库数据源（连接数据库，或者导入 tbls JSON），加入画布，数据库表带锁形图标，属性面板只读。
- [ ] 工具栏开启对比，切换"合并显示 / 并排显示"；差异面板点击定位，确认、撤销确认。
- [ ] 在一个画布里改表名，另一个打开着的画布同步更新。
- [ ] 导入带 `dsn` 的 `.tbls.yml`：写入的文件里没有 `dsn`，并提示保存到凭据。

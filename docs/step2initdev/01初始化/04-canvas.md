# 04 画布

> 实现时有调整：操作对象和消息的名字、撤销的实现方式、未保存标记的规则，见 [06-implementation-notes.md](./06-implementation-notes.md) 第一节。

## 一、画布是什么

画布是用户自己编排的一张图。它**不保存模型数据**，只保存：

- 引用了哪些数据源（设计源、数据库源都可以，数量不限）；
- 从每个数据源里放了哪些表到画布上，每张表放在什么位置；
- 分组框、便签注释；
- 是否开启对比，以及用哪个设计源对比哪个数据库源。

表的字段、关系、注释等内容，每次打开画布时都从数据源实时读取。所以：

- 同一张表可以出现在多个画布里，比如"总览"和"下单流程"。在任何一个画布里修改设计表，其他画布会同步更新。
- 数据库同步出新的快照后，所有引用这个数据库源的画布都会更新。
- 删除画布不会影响任何数据源。

第一阶段固定的"设计模型 / 数据库 / 差异"三个页签，在第二阶段变成画布的不同用法：只放设计源就是设计视图，只放数据库源就是数据库视图，两者都放并开启对比就是差异视图。

## 二、画布文件格式

文件位置：`<存储根目录>/workspaces/<工作区ID>/canvas/<画布ID>.canvas.json`（存储根目录见 02 文档第二节）。类型定义放在 `src/shared/canvas.ts`。

```json
{
  "version": 1,
  "name": "下单流程",
  "description": "下单到支付涉及的表",
  "sources": [
    { "alias": "d", "kind": "design", "ref": "core", "tables": "picked" },
    { "alias": "b", "kind": "db", "ref": "dev-pg", "tables": "picked", "snapshot": null }
  ],
  "nodes": [
    { "source": "d", "table": "orders", "x": 120, "y": 80 },
    { "source": "d", "table": "order_items", "x": 480, "y": 80, "display": "keys" },
    { "source": "b", "table": "payments", "x": 120, "y": 420 }
  ],
  "comparison": { "design": "d", "db": "b", "mode": "overlay" },
  "groups": [
    { "id": "g1", "label": "支付", "color": "#4c8bf5", "x": 80, "y": 380, "width": 720, "height": 360 }
  ],
  "notes": [
    { "id": "n1", "text": "退款表二期再做", "x": 900, "y": 80, "width": 220 }
  ],
  "settings": { "columnDisplay": "all" }
}
```

```ts
interface CanvasFile {
  version: 1;
  name: string;
  description?: string;
  sources: CanvasSource[];
  nodes: CanvasNode[];
  comparison?: CanvasComparison;
  groups: CanvasGroup[];
  notes: CanvasNote[];
  settings: { columnDisplay: ColumnDisplay };
  viewport?: { x: number; y: number; zoom: number };
}

interface CanvasSource {
  /** 画布内部使用的短别名，节点通过它引用数据源。数据源改 ID 时只需要改 ref */
  alias: string;
  kind: 'design' | 'db';
  /** 同一个工作区内的数据源 ID */
  ref: string;
  /** all：自动显示该数据源的全部表，新增的表也会自动加入；picked：只显示 nodes 里列出的表 */
  tables: 'all' | 'picked';
  /** 只对 db 有效：固定使用某一份快照的文件名；null 表示始终使用最新快照 */
  snapshot?: string | null;
  /** 画布上表头的颜色，不填时按数据源类型使用默认颜色 */
  color?: string;
}

type ColumnDisplay = 'all' | 'keys' | 'none';   // 全部字段 / 只显示主键和外键 / 只显示表名

interface CanvasNode {
  source: string;       // CanvasSource.alias
  table: string;        // NTable.key
  x: number;
  y: number;
  display?: ColumnDisplay; // 覆盖画布的默认设置
}

interface CanvasComparison {
  design: string;       // 设计源的 alias
  db: string;           // 数据库源的 alias
  mode: 'overlay' | 'side-by-side';
}

interface CanvasGroup { id: string; label: string; color?: string; x: number; y: number; width: number; height: number }
interface CanvasNote  { id: string; text: string; x: number; y: number; width: number }
```

约定：

- 一个数据源在一个画布里只能出现一次，`alias` 在画布内唯一。
- 节点的身份是 `${alias}/${table}`，在 Vue Flow 里也用这个值作为节点 ID。
- `tables: 'all'` 的数据源，没有出现在 `nodes` 里的表没有保存过位置，打开画布时自动布局，放在已有节点的右侧。用户拖动之后才写入 `nodes`。
- `nodes` 里引用的表在数据源里已经不存在时（比如被删除，或者数据库同步后没有了），不自动删除这条记录，而是显示成灰色的"缺失"节点，由用户决定是否移除。这样可以避免同步了一个错误的数据库后，布局全部丢失。
- 保存时 `nodes` 按 `source`、`table` 排序，坐标取整，保证 Git diff 稳定。
- `viewport` 只在保存时写入最后的视口位置。视口变化不算修改，不会让文件变成未保存状态。

## 三、画布的界面

```
┌ 工具栏 ────────────────────────────────────────────────────────────────────┐
│ [+ 数据源] [+ 新建表] [自动布局] [字段: 全部▾] [对比: 开启 · 合并显示▾] [适应窗口] │
├──────────────┬──────────────────────────────────────────┬──────────────────┤
│ 数据源面板    │                                          │ 属性面板 / 差异面板 │
│              │                                          │                  │
│ ▾ 核心模型 (设计) │            画布区域                   │ 选中设计表：可编辑的 │
│   🔍 搜索表     │      （表节点、关系连线、分组框、便签）    │ 表单              │
│   ☑ orders     │                                          │ 选中数据库表：只读  │
│   ☐ users      │                                          │                  │
│ ▾ 开发库 (数据库) │                                        │ 差异页签：差异列表  │
│   ☑ payments   │                                          │                  │
└──────────────┴──────────────────────────────────────────┴──────────────────┘
```

- **数据源面板**：列出画布引用的数据源，以及每个数据源里的全部表。勾选表示放在画布上。支持搜索，也支持把表拖到画布上的指定位置。
- **表节点**：表头显示表名和数据源标签（比如"设计·核心模型"）。设计表和数据库表用不同的表头颜色；数据库表的表头有一个锁形图标，表示只读。
- **属性面板**：选中表、字段或关系时显示详情。设计源的内容可以直接编辑，数据库源的内容只读。
- **差异面板**：开启对比后才出现，见第六节。

## 四、编排操作（只影响画布文件）

| 操作 | 方式 |
| :-- | :-- |
| 添加数据源 | 工具栏"+ 数据源"，从本工作区的数据源中选择；选择"加入全部表"或"稍后挑选" |
| 移除数据源 | 数据源面板中该数据源的右键菜单。会同时移除它的所有节点，如果它参与了对比，对比也会关闭 |
| 添加表 | 在数据源面板勾选，或者拖到画布上 |
| 添加相关表 | 表节点右键"添加关联的表"：把与这张表有直接关系的表加到画布上，放在它的周围 |
| 从画布移除 | 选中后按 Delete，或者右键"从画布移除"。**只影响画布，不会删除设计表** |
| 移动 | 拖动节点，支持框选后一起拖动。拖动结束时才记录一次修改 |
| 自动布局 | 工具栏按钮，对全部节点或选中的节点使用 elkjs 重新排布 |
| 字段显示 | 画布默认设置，也可以在节点右键里单独设置 |
| 分组框 | 选中多张表后右键"创建分组"；拖动分组框时，框内的节点跟着移动 |
| 便签 | 在画布空白处右键"添加便签" |
| 定位 | 按 Ctrl+F 搜索表名，选中后居中显示 |

## 五、编辑设计表（修改设计数据源）

### 5.1 能编辑什么

只有设计数据源里的表可以编辑。所有修改都会写入对应设计源的 `schema.json` 和 `ext.json`，然后推送给所有打开着的、引用了这个设计源的画布。

| 操作 | 界面入口 |
| :-- | :-- |
| 新建表 | 工具栏"+ 新建表"，或者双击画布空白处。如果画布里有多个设计源，先选择加到哪个设计源 |
| 修改表名、表注释 | 属性面板；双击表头可以直接改表名 |
| 删除表 | 表节点右键"从设计模型中删除…"，二次确认时列出受影响的关系和其他画布 |
| 添加字段 | 属性面板"+ 字段"，或者选中表后按 Enter |
| 修改字段 | 属性面板：名称、类型、是否可空、默认值、注释、是否主键、是否唯一 |
| 调整字段顺序 | 属性面板中拖动 |
| 删除字段 | 属性面板，或者选中字段后按 Delete |
| 添加关系 | 从一个字段右侧的连接点，拖到同一个设计源中另一张表的字段上。松开后弹出小菜单，选择关系类型和基数 |
| 修改、删除关系 | 选中连线后在属性面板中操作 |

关系类型沿用第一阶段的定义：

| 类型 | 写入 `schema.json` 的方式 | 写入 `ext.json` 的方式 |
| :-- | :-- | :-- |
| 外键 `fk` | 在子表的 `constraints` 中加一条 `FOREIGN KEY` 约束；在 `relations` 中加一条 `virtual: false` 的关系 | 不写 |
| 逻辑关联 `logical` | 在 `relations` 中加一条 `virtual: true` 的关系 | 在 `relations` 中写入 `kind: logical` |
| JSON 数组 `json_array` | 同上 | `kind: json_array` |
| 多态 `polymorphic` | 同上 | `kind: polymorphic`，并填写区分字段 `discriminator` |
| 字典 `dictionary` | 同上 | `kind: dictionary` |

主键和唯一约束也按 tbls 的格式写入 `constraints` 和 `indexes`，因为 `normalize.ts` 就是从这两处推导出主键和唯一标记的。具体字段名以 `src/shared/tbls.ts` 为准。新建表时默认带一个 `id` 字段，类型根据 `driver.name` 选择（PostgreSQL 用 `bigint`，MySQL 用 `bigint`，SQLite 用 `integer`），并设为主键。

### 5.2 编辑操作的实现方式

所有修改都表示成**操作对象**，由一组纯函数执行。放在 `src/shared/designOps.ts`，不依赖 `vscode` 模块。插件主进程、浏览器调试模式的模拟主进程、单元测试都使用同一份代码。

```ts
type DesignOp =
  | { op: 'table.add'; table: string; comment?: string }
  | { op: 'table.rename'; from: string; to: string }
  | { op: 'table.update'; table: string; comment?: string }
  | { op: 'table.delete'; table: string }
  | { op: 'column.add'; table: string; column: ColumnInput; index?: number }
  | { op: 'column.update'; table: string; column: string; patch: Partial<ColumnInput> }  // 包括改名
  | { op: 'column.move'; table: string; column: string; toIndex: number }
  | { op: 'column.delete'; table: string; column: string }
  | { op: 'key.setPrimary'; table: string; columns: string[] }
  | { op: 'key.setUnique'; table: string; columns: string[]; unique: boolean }
  | { op: 'relation.add'; from: RelationEndInput; to: RelationEndInput; kind: RelationKind;
      cardinality?: TblsCardinality; parentCardinality?: TblsCardinality; discriminator?: string; note?: string }
  | { op: 'relation.update'; key: string; patch: { kind?: RelationKind; cardinality?: TblsCardinality;
      parentCardinality?: TblsCardinality; discriminator?: string; note?: string } }
  | { op: 'relation.delete'; key: string };

interface ColumnInput { name: string; type: string; nullable: boolean; default?: string | null; comment?: string }
interface RelationEndInput { table: string; columns: string[] }

interface DesignDoc { schema: TblsSchema; ext: DesignExt }

/** 返回新的文档和用于撤销的反向操作；校验失败时抛出 DesignOpError，其中带有给用户看的提示 */
function applyDesignOp(doc: DesignDoc, op: DesignOp): { doc: DesignDoc; inverse: DesignOp[] };
```

几点要求：

- **不修改传入的对象**，总是返回新对象，方便撤销和测试。
- **联动修改在函数内部完成**：字段改名时，同时更新引用它的约束、索引、关系、`ext.json` 里的关系 key；删除表时，同时删除涉及它的关系。
- **校验**：表名、字段名在所属范围内不能重复；类型不能为空；关系两端的字段数量必须一致；`fk` 关系要求父表的对应字段是主键或唯一键（不满足时只给出警告，不阻止）。
- 跨文件的联动（`comparisons.json` 里的表映射、其他画布里的节点）不在这里处理，由插件主进程在执行 `table.rename`、`table.delete` 之后，调用 `src/workspace/refactor.ts` 处理（见 02 文档第六节）。

### 5.3 写入冲突

- 如果用户在文本编辑器里打开了这个设计源的 `schema.json` 或 `ext.json`，并且有未保存的修改，插件拒绝执行画布上的编辑，提示"请先保存或放弃 schema.json 中的修改"。
- 如果文件在外部被修改（比如 `git pull`），`ModelStore` 重新加载，并推送给所有画布。
- 修改后的文件格式如何固定（排序、缩进），见 02 文档 3.3 节。

## 六、对比

### 6.1 开启对比

画布里至少有一个设计源和一个数据库源时，工具栏的"对比"按钮可以使用。开启时选择用哪个设计源对比哪个数据库源。本阶段每个画布同时只能有一组对比。

对比使用的表映射和已确认的偏差，来自工作区的 `comparisons.json`（见 02 文档 3.5 节）。所以在一个画布里确认的偏差，在另一个画布里也会显示为已确认。

差异计算沿用第一阶段的 `diffSchemas(design, db, pair)`，只是第三个参数从 `HarnessExt` 改为 `ComparisonPair`。

### 6.2 两种显示方式

| 方式 | 显示效果 | 适用场景 |
| :-- | :-- | :-- |
| 合并显示 `overlay` | 设计表和对应的数据库表合并成一个节点：字段后面用标记表示"数据库缺少"、"设计中没有"、"不一致"、"已确认"。只存在于数据库的表显示为单独的数据库节点，带红色边框。 | 日常检查"开发实现和设计是否一致" |
| 并排显示 `side-by-side` | 设计表和数据库表各自显示为一个节点，中间用虚线把对应的两张表连起来，两边分别用颜色标出差异 | 表结构差别大，或者需要对照查看两边的原始结构 |

合并显示时，设计表的位置就是合并节点的位置，对应的数据库节点不显示（它在 `nodes` 里的位置记录保留，切换回并排显示时使用）。

### 6.3 差异面板

- 列出这组对比的全部差异，可以切换为"只看画布上的表"。
- 按类型分组：表缺失、字段缺失、字段不一致、关系缺失。
- 点击一条差异，画布定位到对应的表和字段。
- 每条差异可以"确认为有意的偏差"或者"取消确认"，结果写入 `comparisons.json`。
- 预留"复制差异描述"按钮：把选中的差异整理成一段文本，方便粘贴给 AI 生成 SQL。第三阶段的 MCP 会提供同样的信息。

## 七、画布编辑器的实现方式

### 7.1 使用自定义编辑器

画布用 VS Code 的 **自定义编辑器**（`vscode.window.registerCustomEditorProvider`）实现，而不是第一阶段的单例 `WebviewPanel`：

```jsonc
"customEditors": [
  {
    "viewType": "harness.canvas",
    "displayName": "Harness 画布",
    "selector": [{ "filenamePattern": "*.canvas.json" }],
    "priority": "default"
  }
]
```

这样做的好处：

- 多个画布可以同时在不同的标签页中打开。
- 在资源管理器里双击 `.canvas.json` 文件就能打开画布；右键"重新打开编辑器的方式…"可以切换到文本编辑器查看原始 JSON。
- 重启编辑器后，打开着的画布会自动恢复。
- 撤销、重做、未保存标记、保存、自动保存都使用编辑器原生的机制。

使用 `CustomEditorProvider<CanvasDocument>`（自己管理文档），而不是 `CustomTextEditorProvider`。原因是撤销栈里既有画布布局的修改，也有设计数据源的修改，后者不在画布文件的文本里，文本编辑器的撤销栈管不了。

### 7.2 保存规则

| 修改的类型 | 何时写入磁盘 | 未保存标记 |
| :-- | :-- | :-- |
| 编排操作（第四节） | 按 Ctrl+S 或自动保存时写入画布文件 | 标签页显示未保存 |
| 设计编辑（第五节） | **立即**写入设计源文件，因为其他画布也在使用这些数据 | 不影响画布的未保存标记 |
| 确认偏差（第六节） | 立即写入 `comparisons.json` | 不影响 |

### 7.3 撤销和重做

每次修改都通过 `onDidChangeCustomDocument` 向编辑器登记一条记录，包含 `undo` 和 `redo` 两个回调：

- **编排操作**：回调里在内存中恢复或重新应用画布的修改，然后推送给 Webview。
- **设计编辑**：回调里对设计源执行 `inverse` 操作或原操作。执行前先检查设计源的当前内容和这条记录生成时是否一致（比较内容哈希）。如果在这之间设计源被其他画布或外部修改过，就拒绝撤销，并提示原因，避免覆盖别人的修改。
- 一个用户动作如果同时产生设计编辑和编排操作（比如"新建表"会同时新建设计表并在画布上放置节点），登记为**一条**记录，一次撤销全部恢复。

需要在开发时验证：焦点在属性面板的输入框中时，Ctrl+Z 应该撤销输入框里的文字，而不是触发画布的撤销。

## 八、消息协议

替换现在的 `src/shared/protocol.ts`。设计编辑需要知道结果（成功或者校验失败的原因），所以带上 `requestId`，由 Webview 端包装成 Promise。

**插件主进程 → Webview：**

```ts
type HostMessage =
  | { type: 'init'; canvas: CanvasFile; sources: SourceData[]; catalog: WorkspaceCatalog; diff?: DiffResult }
  | { type: 'canvas/changed'; canvas: CanvasFile }             // 撤销、重做、外部修改后推送完整的画布内容
  | { type: 'source/changed'; source: SourceData }             // 某个数据源的模型有变化
  | { type: 'source/error'; alias: string; message: string }   // 读取失败，比如 JSON 格式错误
  | { type: 'diff/changed'; diff?: DiffResult }
  | { type: 'catalog/changed'; catalog: WorkspaceCatalog }     // 工作区的数据源列表有变化
  | { type: 'reply'; requestId: string; ok: true } | { type: 'reply'; requestId: string; ok: false; error: string }
  | { type: 'focus'; alias: string; table: string; column?: string };

interface SourceData {
  alias: string;
  kind: 'design' | 'db';
  ref: string;
  name: string;
  schema: NormalizedSchema;
  snapshot?: { file: string; takenAt: string };   // 只对数据库源有效
  warnings: string[];
}

/** 本工作区内所有的数据源，用于"添加数据源"对话框 */
interface WorkspaceCatalog {
  design: { id: string; name: string; tableCount: number }[];
  db: { id: string; name: string; tableCount: number; hasSnapshot: boolean }[];
}
```

**Webview → 插件主进程：**

```ts
type WebviewMessage =
  | { type: 'ready' }
  | { type: 'canvas/edit'; label: string; edit: CanvasEdit }                    // 编排操作
  | { type: 'design/op'; requestId: string; alias: string; ops: DesignOp[]; label: string; canvasEdit?: CanvasEdit }
  | { type: 'diff/accept'; requestId: string; id: string; accepted: boolean }
  | { type: 'viewport'; viewport: { x: number; y: number; zoom: number } }      // 不登记撤销，不标记未保存
  | { type: 'db/sync'; alias: string }
  | { type: 'openRaw'; alias: string };

type CanvasEdit =
  | { op: 'source.add'; source: CanvasSource; nodes: CanvasNode[] }
  | { op: 'source.remove'; alias: string }
  | { op: 'nodes.add'; nodes: CanvasNode[] }
  | { op: 'nodes.remove'; ids: string[] }
  | { op: 'nodes.move'; moves: { id: string; x: number; y: number }[] }
  | { op: 'nodes.display'; ids: string[]; display?: ColumnDisplay }
  | { op: 'comparison.set'; comparison?: CanvasComparison }
  | { op: 'group.upsert'; group: CanvasGroup } | { op: 'group.remove'; id: string }
  | { op: 'note.upsert'; note: CanvasNote } | { op: 'note.remove'; id: string }
  | { op: 'settings.set'; settings: Partial<CanvasFile['settings']> };
```

`CanvasEdit` 同样用纯函数 `applyCanvasEdit(canvas, edit) → { canvas, inverse }` 执行，放在 `src/shared/canvas.ts`。

**数据流：**

```
Webview 用户拖动表                     插件主进程
  │ canvas/edit (nodes.move)  ───────▶ CanvasDocument.apply → 登记撤销记录 → 标记未保存
  │                                                     
Webview 修改字段类型                   
  │ design/op (column.update) ───────▶ DesignSource.apply → 写入 schema.json
  │                                     → ModelStore 更新缓存
  │ ◀─────── reply(ok)                  → 所有引用此设计源的画布：source/changed、diff/changed
```

编排操作在 Webview 里先更新界面，再发给插件主进程（拖动需要即时响应）。设计编辑要等插件主进程回复成功后再更新界面，因为校验逻辑在插件主进程里执行，本地文件读写很快，用户感觉不到延迟。

## 九、Webview 代码结构

```
webview-ui/src/
├─ main.ts
├─ App.vue                      # 画布编辑器的整体布局
├─ vscode.ts                    # 通信封装：post、request（带 requestId 的 Promise）、getState/setState
├─ store/canvasStore.ts         # 画布、数据源、差异的响应式状态；处理插件主进程发来的消息
├─ canvas/
│  ├─ viewModel.ts              # 由画布文件 + 数据源 + 差异生成 Vue Flow 的节点和连线（由第一阶段的 model.ts 扩展）
│  └─ layout.ts                 # elkjs 自动布局；增量放置新节点
├─ components/
│  ├─ Toolbar.vue
│  ├─ SourcePanel.vue           # 左侧数据源面板
│  ├─ TableNode.vue             # 表节点（沿用并扩展）
│  ├─ GroupNode.vue / NoteNode.vue
│  ├─ inspector/TableForm.vue / ColumnForm.vue / RelationForm.vue
│  ├─ DiffPanel.vue             # 由第一阶段的 DiffList.vue 扩展
│  └─ AddSourceDialog.vue / RelationKindMenu.vue
└─ dev/
   ├─ mockHost.ts               # 浏览器调试模式（见 01 文档第六节）
   └─ theme-fallback.css
```

界面控件建议使用 `@vscode-elements/elements`（替代已停止维护的 `@vscode/webview-ui-toolkit`），保证输入框、下拉框、按钮的外观和编辑器一致。

## 十、性能目标

- 200 张表、每张表平均 20 个字段的画布，打开时间在 2 秒以内，拖动不卡顿。
- 节点数量超过 100 时，默认把字段显示设为"只显示主键和外键"，并开启 Vue Flow 的 `onlyRenderVisibleElements`，只渲染可见区域内的节点。
- 自动布局放到 Web Worker 中执行（elkjs 自带 Worker 版本），避免界面卡住。

# 数据源看板「导出给 AI」方案

> **状态：方案设计（未实施）。** 本文只做设计，不改代码。下文路径除注明外均相对于代码根目录 `harness-cursor/`。
>
> 需求：把「设计画布」当前的设计情况导出成一个目录结构交给 AI。用户可以自由勾选导出哪些表和设计图，导出结果按画布分区组织。
>
> **本版是重构稿。** 上一版主张「单文件 Markdown 导出」，与实际需求不符 —— 用户要的是**以设计画布为单位、导出目录结构**。变更点与废弃的判断集中记在 §10。

---

## 0. 先说结论（推荐方案）

| 决策点 | 推荐 | 理由 |
| :-- | :-- | :-- |
| 导出单位 | **一个设计画布导出一个目录** | 画布是用户的心智单位，导出物应与画布一一对应 |
| 目录组织 | **按画布分区递归**，每层下分 `设计表/` `设计图/` `数据表/` | 画布上就是分区组织的，导出物保持一致，AI 读到的结构就是用户看到的结构 |
| 文件粒度 | **表一表一文件，设计图一图一文件** | 上下文可控、Git diff 干净、关系本来就必须集中（§3.3） |
| 每层一个 `README.md` | 有 | 它是「这一层的整体视图」：ER 图 + 表清单 + 指向单表文件的链接，也是 AI 的入口 |
| 交互 | **Webview 树形选择器**，默认勾选画布上的，但全部可改 | 复用 `SourcePanel.vue` 已有的搜索/勾选范式；原生 QuickPick 承载不了树 + 多选 + 路径输入 |
| 落盘位置 | 默认 `<globalStorage>/exports/<设计库>-<时间戳>/`，同时给「另存为…」 | 导出是快照，不污染项目；但 AI 工具一般只读项目内文件，所以必须能改路径 |
| 复用基础 | 复用 `copyForAI` 的规格说明 + `generateErDiagram` | `media/spec/mermaid-design.md` 和 ER 生成器已存在且经过验证，不要重写 |

**一句话方案**：新增 `harness.export.open` —— 面板按钮 → 树形选择弹窗 → 主进程按分区递归组装目录 → 写盘 + 「打开 / 复制给 AI / 打开目录」。

---

## 1. 现状盘点

### 1.1 左侧「数据源」看板

`webview-ui/src/components/SourcePanel.vue` 的标题栏：

```138:145:webview-ui/src/components/SourcePanel.vue
  <div class="panel-header">
      <span>数据源</span>
      <span class="header-actions">
        <button class="secondary small" @click="adding = !adding">+ 添加数据库</button>
        <button class="icon-btn" title="收起数据源面板" @click="emit('collapse')">«</button>
      </span>
    </div>
```

要点：

- 「+ 添加数据库」是 `.secondary.small`，收起是 `.icon-btn`。**导出按钮插在两者之间，样式对齐 `.secondary.small`**。
- 面板已有 `search` ref 和 `matches()` 过滤函数，导出弹窗可复用同一套交互。
- 面板没有引入 codicon（实测全仓库无 `@vscode/codicons`），图标全是纯文本字符（`＋` `⟳` `✕` `«`），所以导出按钮用 `⬇` 保持一致，不新增依赖。
- **面板的勾选语义不能直接复用**：面板里勾选 = "是否放在本层"，而导出里勾选 = "是否导出"。语义不同，需要独立的清单（§5.2）。

### 1.2 现成的「给 AI」能力

```146:163:harness-cursor/src/commands/diagram.ts
export async function copyForAI(h: Harness, workspace: string, design: string, diagram?: DiagramFile): Promise<void> {
  const spec = await readText(vscode.Uri.joinPath(h.context.extensionUri, 'media', 'spec', 'mermaid-design.md'));
  const loaded = await h.store.source(workspace, 'design', design);
  const driver = driverLabel(loaded.schema?.driver?.name) ?? '未指定';
  const parts = [spec.trim(), '', '---', '', `## 当前内容`, '', `设计库：${loaded.name}（目标数据库：${driver}）`];
  if (diagram) {
    parts.push(`设计图：${diagram.meta.name}（${diagramTypeLabel(diagram.meta.type)}）`, '', '```mermaid', diagram.code.trim(), '```');
```

`copyForAI()` 确立了两条本方案必须遵守的原则：

1. **只导模型内容，绝不含任何连接信息**（注释原文 `Never connection details`）。DSN 在 `SecretStorage`（`storage.ts` 的 `secretKey`）。
2. **复用 `generateErDiagram(schema, tables?)`** 渲染 ER 图，它已处理命名空间、注释转义、类型去空格等细节。

本方案基本就是把这个函数从「单图 + 剪贴板」扩成「整个画布 + 落盘 + 可选范围」。

### 1.3 画布分区的真实结构

分区（`CanvasPartition`）是**可嵌套**的，这是目录递归的依据：

```15:20:harness-cursor/src/shared/canvas.ts
export interface CanvasPartition {
  id: string;
  name: string;
  description?: string;
  parent?: string;
```

现成的树遍历工具全部已有，不用自己写：

| 函数 | 位置 | 用途 |
| :-- | :-- | :-- |
| `partitionPath(canvas, id)` | `canvas.ts:170` | 从最外层到 `id` 的路径（面包屑） |
| `partitionSubtree(canvas, id)` | `canvas.ts:163` | 该分区 + 所有嵌套其内的分区 |
| `partitionOf(canvas, ref)` | `canvas.ts:186` | 某个表/图/便签属于哪个分区 |
| `nodeId(source, table)` | `canvas.ts:129` | 表的节点 ID 是 `source/table` |

`source` 字段区分表的归属：`DESIGN_SOURCE = 'design'`（设计表）vs 数据库源 id（`db1`）：

```31:35:harness-cursor/src/shared/canvas.ts
export interface CanvasNode {
  /** `"design"` for the design's own tables, or a database source ID like `"db1"`. */
  source: string;
  table: string;
```

### 1.4 关键约束：表名有两套

`NTable` 同时有 `key` 和 `rawName`：

```47:52:harness-cursor/src/shared/model.ts
export interface NTable {
  /** Name with the default schema stripped, e.g. `users` or `pgmq.meta`. Used as the identity for mapping and diff. */
  key: string;
  rawName: string;
  schema?: string;
```

`key` 剥掉了**默认** schema，所以 `key === rawName` 只在「表就在默认 schema 里」时成立。非默认 schema 的表（如 `payment.orders`）两者相同；但设计库若把 `defaultSchema` 设成 `payment`，`orders` 的 `key` 就是 `orders` 而 `rawName` 是 `payment.orders`。

画布上显示的名字还要再剥一层命名空间（`shortName(ns, key)`，`namespace.ts:34`）。

**结论：产物里必须写 `rawName`，否则 AI 拿到的表名在库里查不到。** 详见 §1.6。

### 1.5 关系过滤与跨分区（最大坑）

`generateErDiagram` 只输出两端都在范围内的关系：

```262:264:harness-cursor/src/shared/mermaid/er.ts
  const included = keys.map((k) => byKey.get(k)).filter((t): t is NTable => !!t);
  const set = new Set(included.map((t) => t.key));
  const relations = schema.relations.filter((r) => set.has(r.from.table) && set.has(r.to.table));
```

按分区生成 ER 时这会**静默丢关系**。若 `orders` 在「交易」分区、`refunds` 在其内嵌的「支付」分区，为「支付」单独生成 ER 时传入的表只有 `refunds`，`orders` 不在集合里 → 这条关系消失；「交易」那层同样不含 `refunds` → 也消失。**两层 README 都没有，且无任何提示。**

解法是你们的 spec 已经支持的"引用桩"：

```48:48:harness-cursor/media/spec/mermaid-design.md
8. 只画和这次需求有关的表也可以。只写表名、不写 `{ }` 的表表示“只引用，不改字段”。
```

解析器也认这种空壳实体（`ErEntity.hasBody`，`er.ts:22`）：关系行本身就会创建两端实体。所以每层 ER 应该为跨层对端补一个只有表名的桩（§3.3）。

### 1.6 对上一版的两处事实修正

**修正一：`generateErDiagram` 用的是 `key`，不是 `rawName`。**

```270:270:harness-cursor/src/shared/mermaid/er.ts
    out.push(`  ${entityName(t.key)}${alias ? `["${alias}"]` : ''} {`);
```

上一版说"导出必须用 `rawName`"和现有代码直接冲突。按驱动拆开看实际影响：

| 场景 | `key` vs `rawName` | 是否需要额外处理 |
| :-- | :-- | :-- |
| PostgreSQL / Redshift，表在 `public` | 相等 | 否 |
| MySQL / SQLite（无 schema 语义） | 相等 | 否 |
| Oracle / SQL Server（`dbo`） | `Users` = `dbo.Users`，可解析 | 否 |
| 任意驱动，表在非默认 schema（`payment.orders`） | 相等 | 否 |
| **设计库 `defaultSchema` = `payment`，表 `orders`** | `orders` ≠ `payment.orders` | **是** |

因为 `key` 只剥掉**默认** schema，所以只有最后一行会出问题。但这正是"AI 拿短名去库里找不到表"的真实场景。

**处理**：ER 图继续用 `key`（保持和画布一致、保证可回灌），**每个表文件里显式写出 `rawName`**，两者都出现。这样风险消除且不改动共享代码。

**修正二：`dbName()` 确实会返回 `host:port/db`，上一版写反了。**

上一版说它返回用户昵称，这是错的。`store.ts` 的注释和实现都写得很清楚：

```55:67:harness-cursor/src/model/store.ts
  /**
   * UI name of a db source: `host:port/db` from the saved connection, else the name in source.yml.
   * Contains the host, so it is for the UI only; anything facing the AI must use the id.
   */
  async dbName(workspace: string, id: string): Promise<string> {
```

它优先从 `SecretStorage` 里解出连接串再调 `connectionLabel()`（`src/shared/connection.ts:271`，拼出 `host:port/db`），只有在没有 secret 时才退回 `source.yml` 的 `name`。

**这条注释本身就是导出必须遵守的约束**：`anything facing the AI must use the id`。所以：

- **绝不调用 `dbName()`**，也别把 `LoadedSource.name` 带进产物 —— 它可能带主机名、端口、库名，甚至用户名。
- 数据源在产物里**只用 source id**（`db1`）标识，章节标题写「数据源 db1」。
- `test/exportBuilder.test.ts` 里有一条断言专门锁住这点：manifest 的 db 条目只允许出现 `source` 字段，不给任何能藏主机名的位置。

---

## 2. 目标与非目标

### 目标

1. 左侧看板标题栏「+ 添加数据库」旁新增「⬇ 导出」按钮。
2. 点击后弹窗，用户能：
   - 在**树形选择器**里按画布分区勾选要导出的内容（设计表 / 设计图 / 数据表三类）；
   - 勾选状态**默认全选画布上可见的**，但可以自由增删 —— 包括勾选没上画布的、取消勾选已选的；
   - 选择导出路径（默认目录 + 另存为）。
3. 产物是**方便 AI 读取的目录**：按分区组织、每表一文件、每层有 README 入口、自带说明、不含连接信息。
4. 导出后有明确反馈：路径 + 「打开目录 / 复制给 AI / 打开入口文件」。

### 非目标（本期不做）

- **不做导入**（把导出物读回 Harness）。AI 产出的 Mermaid 已有现成通路，见 §3.5。
- 不做 PDF / 图片 / HTML。AI 读不了图片。
- 不做增量导出、历史版本管理。
- 不导出便签（`CanvasNote`）、坐标、视口 —— 纯布局信息，对 AI 无价值。
- 不导出数据库快照原文（`snapshots/*.json`）。那是 tbls 完整格式，含视图定义/函数/触发器，噪音大且可能含敏感结构。导出只走 `NormalizedSchema`。

---

## 3. 产物设计

### 3.1 目录结构

分区可嵌套，所以目录也递归。设计表的 `source` 是 `design`，数据表是 `db1` 之类，**两类必须分开放**，否则 AI 分不清哪个是可改的意图、哪个是只读的事实：

```
订单库/                          ← 根画布
  README.md                      ← 入口：全库概览 + 根层 ER + 目录索引
  manifest.json                  ← 机器可读清单
  设计表/
    users.md                     ← 一表一文件
    orders.md
  设计图/
    订单状态图.md                  ← 一图一文件，原样复制 Mermaid
  数据表/
    audit_logs.md                ← 数据源 db1
  交易/                          ← part1
    README.md                    ← 本层 ER（含跨层引用桩）
    设计表/
      payments.md
    数据表/
      settlements.md
    支付/                        ← part2，嵌在 part1 内
      README.md
      设计表/
        refunds.md
```

三类子目录固定用中文名 `设计表/` `设计图/` `数据表/`，不随用户内容变化 —— AI 靠这三个名字定位，不需要猜。

### 3.2 单个表文件

````markdown
# users

真实表名：`public.users`
说明：用户
来源：设计表 · 订单库

| 字段 | 类型 | 键 | 可空 | 默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| id | bigint | PK | 否 | | 主键 |
| email | varchar(128) | UK | 否 | | 登录邮箱 |
| created_at | timestamptz | | 否 | now() | 创建时间 |

## 关系

- `orders.user_id` → `users.id`（真实外键）

## 相关表

- `orders` — 订单（真实表名 `public.orders`）
- `audit_logs` — 审计日志（数据源 db1）
````

要点：

- **标题用 `key`**（画布上看到的短名，AI 改完粘回来能对上），下面一行显式给 `rawName`。
- **字段表格是主体**。Mermaid 装不下 `NColumn` 的大部分信息：

```33:46:harness-cursor/src/shared/model.ts
export interface NColumn {
  name: string;
  rawType: string;
  logicalType: LogicalType;
  length?: number;
  precision?: number;
  scale?: number;
  nullable: boolean;
  primaryKey: boolean;
  unique: boolean;
  autoIncrement: boolean;
  default?: string | null;
  comment?: string;
  enumValues?: string[];
```

  `nullable` / `default` / `autoIncrement` / `indexes` / `enumValues` / `length|precision|scale` 全部丢失。你们的 spec 也明说了不写这些：

```52:52:harness-cursor/media/spec/mermaid-design.md
9. 不要写默认值、索引、枚举值。这些我会在 Harness 里补，你写了也不会生效。
```

  所以**逐字段信息只能靠 Markdown 表格**，Mermaid 只负责关系。
- **「相关表」小节**让单表文件约 90% 自洽，AI 不用回 README 就能顺着找到邻表。数据从 `schema.relations` 生成，一行一个。

### 3.3 每层的 README.md

这是 AI 的入口，也是「这一层的整体视图」：

````markdown
# 交易

订单库 的一个分区。父级：订单库

## 本层 ER 图

```mermaid
erDiagram
  payments {
    bigint id PK
    bigint order_id FK
  }
  orders : "只引用"
  payments }o--|| orders : "order_id"
```

`orders` 只写表名不写字段，表示「只引用，不改字段」。

## 本层内容

**设计表（1）**
- [payments](../设计表/payments.md) — 支付单（6 字段）

**数据表（1）**
- [settlements](../数据表/settlements.md) — 结算单（4 字段）

**子分区（1）**
- [支付/](支付/) — 支付相关
````

三个必须处理的点：

**1. 跨分区关系要补引用桩。** 如 §1.5 所述，`orders` 不在本层集合里就会被丢掉。解法是关系行本身会创建实体（`er.ts:148-150`），所以只要**在表体之外单独写一行表名**，再写关系行，实体就会被建出来且 `hasBody: false`：

```147:150:harness-cursor/src/shared/mermaid/er.ts
    if (rel) {
      const left = unquote(rel[1]);
      const right = unquote(rel[5]);
      entity(left, no);
      entity(right, no);
```

生成规则：收集本层表在 `schema.relations` 里所有关系的对端，把不在本层的那些补成裸表名行。**关系一条都不能丢。**

**2. 跨源关系不能混。** 数据库表的关系引用的是库里的表名，和设计表的关系是两个独立集合，混着渲染会画出根本不存在的跨库外键。规则：

- 设计表 → 渲染设计库的 `schema.relations`
- 数据表 → **按 source 分块**，每个源单独渲染自己那套，标题写清是哪个源
- 某块没有关系 → 省略该节，不要输出空标题

**3. 别名要短。** `aliasOf` 有 40 字符和换行的限制：

```239:243:harness-cursor/src/shared/mermaid/er.ts
function aliasOf(t: NTable): string | undefined {
  const c = t.comment?.trim();
  if (!c || c.includes('\n') || c.length > 40 || /[\[\]"]/.test(c)) return undefined;
  return c;
}
```

导出时同理 —— 长注释只进表文件的「说明」行，不进 ER 的 `["..."]`。

### 3.4 manifest.json

放在导出根目录，机器可读，成本极低：

```json
{
  "version": 1,
  "generatedAt": "2026-10-05T01:30:00.000Z",
  "design": { "workspace": "ws1", "design": "design1", "name": "订单库", "driver": "postgresql" },
  "counts": { "designTables": 8, "dbTables": 4, "diagrams": 3, "partitions": 2 },
  "items": [
    { "kind": "design-table", "key": "users", "rawName": "public.users", "partition": "part1", "file": "设计表/users.md", "columns": 12 },
    { "kind": "db-table", "source": "db1", "key": "audit_logs", "rawName": "public.audit_logs", "partition": null, "file": "数据表/audit_logs.md", "columns": 6 },
    { "kind": "diagram", "id": "diagram1", "name": "订单状态图", "type": "state", "partition": "part1", "file": "设计图/订单状态图.md" }
  ]
}
```

**只有 source id（`db1`），没有数据库名/主机名** —— 与 §1.6 的结论一致。

### 3.5 回灌能力：分类型看，不是全有全无

| 内容 | 能否回灌 | 依据 |
| :-- | :-- | :-- |
| **ER 图** | ✅ 能，是主通路 | `parseErDiagram` + `computeErSync` 现成 |
| **状态/时序/流程/数据流图** | ❌ 不能 | 叶子文档，Harness 不解析它们 |
| **Markdown 表格** | ❌ 不能 | 没有解析器 |

只有 ER 图标记了 `syncable`：

```5:11:harness-cursor/src/shared/diagram.ts
export const DIAGRAM_TYPES: { type: DiagramType; label: string; header: string; syncable: boolean }[] = [
  { type: 'er', label: 'ER 图', header: 'erDiagram', syncable: true },
  { type: 'state', label: '状态图', header: 'stateDiagram-v2', syncable: false },
  { type: 'sequence', label: '时序图', header: 'sequenceDiagram', syncable: false },
  { type: 'flow', label: '流程图', header: 'flowchart TD', syncable: false },
  { type: 'dataflow', label: '数据流图', header: 'flowchart LR', syncable: false },
];
```

```124:124:harness-cursor/src/diagram/diagramService.ts
    if (file.meta.type !== 'er') throw new SyncError('只有 ER 图可以同步到表结构');
```

所以准确说法是：**产物整体是单向的，但每层 README 里的 ER 块可以被单独拎出来回灌。** 导出时只要保证 ER 块是合法的 ```mermaid fence、内容不被缩进或改写，通路就开着。

### 3.6 设计图文件：原样复制

设计图在磁盘上本来就是一图一文件：

```286:288:harness-cursor/src/workspace/storage.ts
  async diagramIds(): Promise<string[]> {
    const ids = (await listFiles(this.diagramsDir, DIAGRAM_SUFFIX)).map((f) => f.slice(0, -DIAGRAM_SUFFIX.length));
    return ids.filter((id) => DIAGRAM_ID.test(id)).sort((a, b) => Number(a.slice(7)) - Number(b.slice(7)));
  }
```

所以设计图**没有格式决策**，导出 = 取 `DiagramFile.code` 包进 fence。这里有个额外收获：导出的设计图文件如果连 frontmatter 一起带上，就是**合法的 Harness 设计图文件**，将来做导入时能直接识别。`serializeDiagram` 的格式是：

```113:126:harness-cursor/src/shared/diagram.ts
export function serializeDiagram(file: DiagramFile): string {
  const m = file.meta;
  const out: Record<string, unknown> = { type: m.type, name: m.name };
  if (m.description) out.description = m.description;
  out.refs = m.refs;
  if (m.bind) out.bind = m.bind;
  if (m.ignored.length) out.ignored = m.ignored;
  if (m.layout && Object.keys(m.layout).length) out.layout = m.layout;
  const yaml = stringifyYaml(out, { lineWidth: 0 });
```

**建议：设计图直接原样复制源文件内容**（frontmatter + mermaid 块），一个字节都不改。这样它既是给 AI 读的文档，也是合法的 Harness 文件。

---

## 4. 交互设计

### 4.1 入口

`SourcePanel.vue` 的 `.header-actions` 里，「+ 添加数据库」右侧插入：

```html
<button class="secondary small" title="把当前画布的设计导出成一份 AI 可以直接读取的目录" @click="emit('export')">⬇ 导出</button>
```

### 4.2 弹窗：树形选择器

新建 `webview-ui/src/components/ExportDialog.vue`：

```
┌─ 导出给 AI ──────────────────────────────────────────┐
│                                                      │
│  [搜索表名、图名或分区…]                    ☑ 全选    │
│                                                      │
│  ▾ 订单库（根）                          本层 5 项    │
│    ▾ 设计表                              ☑ 全选      │
│      ☑ users ····························· 12 字段  │
│      ☑ orders ···························· 8 字段  │
│      ☐ payments ·························· 6 字段  │
│    ▾ 设计图                                        │
│      ☑ 订单状态图 ························ ER      │
│    ▾ 数据表                                        │
│      ☑ audit_logs ························ db1     │
│                                                      │
│  ▾ 交易（part1）                        本层 2 项    │
│    ▾ 设计表                                        │
│      ☑ payments ·························· 6 字段  │
│    ▾ 支付（part2）                      本层 1 项    │
│      ▾ 设计表                                        │
│        ☑ refunds ························· 4 字段  │
│                                                      │
│  ▸ _未分组（不在画布上）                本层 12 项   │
│    ▾ 设计表                                        │
│      ☐ audit_trail ······················ 3 字段  │
│                                                      │
│  路径  ┌──────────────────────────────────────┐ 📁 │
│        │ D:\...\exports\订单库-20261005-0930  │   │
│        └──────────────────────────────────────┘   │
│                                                      │
│  已选：9 张表 · 1 张设计图 · 约 18 KB               │
│                                         [取消] [导出]│
└──────────────────────────────────────────────────────┘
```

设计说明：

- **树按画布分区组织**，层级和画布上的框一致。
- **默认勾选画布上可见的**（`onCanvas: true`），但每个勾都能手动改 —— 取消已选的、或勾上没在画布上的。
- **没上画布的项归到 `_未分组`**，且默认不勾，但**可以勾**。这一条很关键：无 layout 节点的表会被算成根层（§4.3），如果放任不管，用户勾了却不知道会落到哪去。
- **实时算体积**，避免误选几百张表。
- 搜索复用 `matches()` 思路。
- 路径用 `showOpenDialog({ canSelectFolders: true })` —— 原生保存对话框只能选文件/文件名，无法直接选目录，而这里要的是"导出到某个目录"。

### 4.3 两个必须显式处理的语义

**坑一：没摆上画布的表会全掉进根目录。** 因为无节点的项一律算根层：

```72:75:harness-cursor/src/shared/canvas.ts
/**
 * `layout.json` of a design: where everything sits on the root canvas and its partitions.
 * Design tables and diagrams without an entry are shown at the root.
 */
```

设计库有 100 张表、用户只摆了 20 张 → 剩下 80 张**静默全进根目录**。所以 `ExportItem` 必须带 `onCanvas` 字段，Webview 侧把没上画布的显示成灰的、默认不勾。

**坑二：跨分区关系会丢。** 见 §1.5 / §3.3，解法是补引用桩。

---

## 5. 实现方案

### 5.1 新增文件

| 文件 | 职责 |
| :-- | :-- |
| `src/export/builder.ts` | 纯函数：`(ExportItem[], 分区树) → ExportFile[]`。**无 vscode 依赖，可单测** |
| `src/export/collect.ts` | 从 `ModelStore` + `layout.json` 收集 `ExportItem[]`（有 vscode 依赖） |
| `src/export/run.ts` | 落盘：建目录、写文件、文件名 sanitize、失败清理、通知 |
| `src/commands/export.ts` | 命令 `harness.export.open` / `run` |
| `webview-ui/src/components/ExportDialog.vue` | 弹窗 UI |
| `test/exportBuilder.test.ts` | 单测（§7） |

`builder.ts` 和 `collect.ts` 分开是关键：前者纯函数、可单测，后者才碰 `vscode`。这与仓库现有风格一致（`shared/copyTables.ts` 是纯函数 + `test/copyTables.test.ts`）。

### 5.2 协议

```typescript
/** One thing that can be exported. */
export type ExportItem =
  | { kind: 'design-table'; key: string; rawName: string; comment?: string; partition?: string; onCanvas: boolean; columns: number }
  | { kind: 'db-table'; source: string; key: string; rawName: string; comment?: string; partition?: string; onCanvas: boolean; columns: number }
  | { kind: 'diagram'; id: string; name: string; type: DiagramType; partition?: string; onCanvas: boolean; hasBody?: boolean };

/** One level of the canvas; `parent` undefined = root. */
export interface ExportLevel {
  id: string | undefined;      // partition id; undefined = 根画布
  name: string;
  description?: string;
  parent?: string;
  depth: number;
}

/** Host→Web. Pushed before the dialog opens. */
export interface ExportRequest {
  items: ExportItem[];
  levels: ExportLevel[];
  suggestedPath: string;
  designName: string;
  driverLabel?: string;
}

export type HostMessage =
  | /* 现有 */
  | { type: 'export/items'; request: ExportRequest };

export type WebviewMessage =
  | /* 现有 */
  | { type: 'export/open'; requestId: string; partition?: string }
  | { type: 'export/pickPath'; requestId: string }
  | { type: 'export/run'; requestId: string; keys: string[]; path: string };
```

**回传用 `keys: string[]` 而不是整个 `ExportItem[]`** —— Webview 不可信，别让它能改 `rawName` / `source`。主进程按 key 反查自己那份清单。key 格式：设计表 `d:<key>`、数据表 `b:<source>:<key>`、图 `g:<id>`。

### 5.3 builder 的纯函数边界

```typescript
// src/export/builder.ts
export interface ExportFile {
  /** Path relative to the export root, always with `/` separators. */
  path: string;
  content: string;
}

export interface ExportInput {
  designName: string;
  driverLabel?: string;
  generatedAt: Date;
  levels: ExportLevel[];
  /** Selected tables, with full definitions. */
  tables: ExportTableInput[];
  /** Design relations; filtered per level by the builder. */
  designRelations: NRelation[];
  /** Relations per database source id. */
  dbRelations: Map<string, NRelation[]>;
  /** Selected diagrams, already read as raw file text. */
  diagrams: ExportDiagramInput[];
}

export interface ExportTableInput {
  item: Extract<ExportItem, { kind: 'design-table' | 'db-table' }>;
  table: NTable;
}

export interface ExportDiagramInput {
  item: Extract<ExportItem, { kind: 'diagram' }>;
  /** Raw source file text, frontmatter included; copied verbatim. */
  raw: string;
}

export function buildExport(input: ExportInput): ExportFile[];
```

职责划分：

- `builder.ts` 只做**渲染和分组**：分区递归、文件路径、转义、ER 生成、引用桩。
- **关系的过滤口径照抄 `generateErDiagram`**，不要自己另发明一套：

```262:264:harness-cursor/src/shared/mermaid/er.ts
  const included = keys.map((k) => byKey.get(k)).filter((t): t is NTable => !!t);
  const set = new Set(included.map((t) => t.key));
  const relations = schema.relations.filter((r) => set.has(r.from.table) && set.has(r.to.table));
```

- 引用桩在过滤**之后**补：先按上两行过滤，再把被丢弃关系的另一端补成裸表名。

### 5.4 收集 `ExportItem`

`collect.ts` 全部走 `ModelStore`，保证和画布看到的一致：

- `h.store.source(ws, 'design', id)` → 设计表 + 关系
- `h.store.source(ws, 'db', dbId)` → 每个数据库源
- `design.yml` 的 `sources` → 决定哪些库挂在这个设计上
- `readLayout()` → `layout.json`，用 `partitionOf` 把每张表/图映射到分区
- `h.diagrams.list(ws, design)` → 设计图；注意用 `h.diagrams.text(ref)` 而非 `read()`，因为 `text()` 优先读打开的编辑器（`diagramService.ts:73`），能拿到用户未保存的改动

### 5.5 落盘

```typescript
// src/export/run.ts
export async function writeExport(target: vscode.Uri, files: ExportFile[]): Promise<vscode.Uri>;
```

要点：

- `mkdirp` 逐级建目录（`fsUtil.ts:73` 现成；它就是 `createDirectory`，VS Code 会自动建父目录）。
- **文件名必须 sanitize**。分区名和表名都可能是 Windows 非法字符（`\ / : * ? " < > |`、开头点号、保留名 `CON`/`NUL` 等），中文没问题但要防控制字符。撞名加 `_2`、`_3` 后缀。
- **绝不覆盖已有目录**：目录名带时间戳，写入前 `exists` 检查。
- 失败时**删除半成品目录** —— `tbls/manager.ts` 修过这个问题（`mkdirp` 在 `try` 外，异常时残留空目录）。
- 写完通知带三个动作：

```typescript
vscode.window.showInformationMessage(
  `已导出 ${counts.tables} 张表、${counts.diagrams} 张设计图`,
  '打开 README', '复制给 AI', '打开目录',
);
```

- **「复制给 AI」复用刚生成的内容**，不要重新拼一遍 —— 避免"复制的和落盘的不一致"这个经典 bug。做法是把所有文件按 manifest 顺序拼成一份带目录导航的文本，格式参照 `copyForAI` 的组装（§1.2）。
- `exports/` 不在 `locate()` 管辖范围内（`storage.ts:109` 只认 `workspaces/` 下的路径），所以导出目录的写入**不会触发 `ModelStore.invalidate`**，不会引起画布抖动。这正好是我们要的。

### 5.6 目录树入口

同一个命令也挂到：

- 侧边栏树右键（`viewItem == design`），复用 `harness.design.copyForAI` 的挂法
- `package.json` 的 `contributes.commands`，标题「导出给 AI…」

这样命令面板（`Ctrl+Shift+P`）也能用，不依赖画布是否打开。

---

## 6. 安全与隐私

| 风险 | 处理 |
| :-- | :-- |
| **连接信息泄漏** | 产物里绝不出现 DSN、主机名、端口、库名、用户名、密码。数据源**只用 source id**（`db1`）标识。注意 `dbName()` 是用户昵称不是 DSN（§1.6），但昵称本身可能含 `prod-` 这类环境信息，所以仍不进产物 |
| **注释里的敏感信息** | 表/字段注释是用户自己写的，导出属显式操作，默认导出。但弹窗应提示「注释会一并导出」 |
| **路径穿越** | 目标目录来自 `showOpenDialog`（受控），但用户可手输。写入前 `path.resolve` 归一，**不做任何相对路径拼接**；文件名 sanitize 后若仍含 `..` 或分隔符，直接报错 |
| **覆盖已有文件** | 目录名带时间戳 + 写入前 `exists` 检查，绝不覆盖 |
| **默认目录被扫描** | `exports/` 在 `locate()` 管辖范围外，不触发 `ModelStore.invalidate` |

---

## 7. 测试计划

仓库现有 13 个测试文件（实测 `test/`），风格是 vitest + 纯函数。`builder.ts` 天然可测：

| 用例 | 断言 | 防的是什么 |
| :-- | :-- | :-- |
| 选中 0 张表 | 不抛错，产出只有 README/manifest | 空选择崩溃 |
| **关系两端只选了一张** | 该关系**不出现** | 半截关系误导 AI |
| **跨分区关系** | 两层 README **都**有这条关系，对端是裸表名桩 | 静默丢关系（§1.5，最关键） |
| 跨源（设计表 + 库表）都有 | 两组关系**分区块**输出，不混 | 生成不存在的跨库外键 |
| 表名有 schema 前缀 | 产出里出现 `rawName`（`public.audit_logs`）而非只有 `key` | AI 拿画布短名去库里找不到表 |
| 嵌套分区 | 目录层级正确，README 面包屑正确 | 目录结构错乱 |
| 未上画布的表被勾选 | 落在 `_未分组/`，不落根层 | 静默混进根目录（§4.3 坑一） |
| 分区名/表名含 `\ / : *` | sanitize 后文件名合法 | Windows 落盘失败 |
| 两个表 sanitize 后同名 | 加 `_2` 后缀，不互相覆盖 | 静默覆盖 |
| 注释含 `|` / 换行 | Markdown 表格不塌（转义 `\|`、`<br>`） | 表格错位 |
| 字段名/注释含 ``` | 不会提前闭合代码块 | 破坏整个文档结构 |
| 产物全文 | **不含** `host:port` 形态字符串（正则扫） | 连接信息泄漏（**最关键**） |
| 产物全文 | **不含** `dbName()` 的昵称 | 昵称含环境信息（§1.6） |
| 设计图 | 内容与源文件**逐字节相同** | 破坏了可回灌性 |
| 两次相同输入 | 输出**逐字节相同**（时间戳除外） | 不必要的 diff 噪音 |

「产物不含连接信息」写成断言具体字符串不存在，不要靠人看。

---

## 8. 实施顺序

**第 1 批（纯函数，先把产物钉死）**

1. `src/export/builder.ts` + `test/exportBuilder.test.ts` —— **先写测试**，它把数据结构和输出格式钉死
2. `shared/protocol.ts` 加 `ExportItem` / `ExportLevel` / `ExportRequest` / 三条消息

**第 2 批（能跑通）**

3. `src/export/collect.ts`（收集清单 + 分区映射）
4. `src/export/run.ts`（落盘 + sanitize + 通知 + 「复制给 AI」）
5. `src/commands/export.ts` + `extension.ts` 注册 + `package.json` 命令和菜单

**第 3 批（UI）**

6. `ExportDialog.vue`（树形选择器）+ `SourcePanel.vue` 按钮 + `App.vue` 接线
7. `webview-ui/src/dev/mockHost.ts` mock 新消息

**P2**

8. 导出结果预览（弹窗内显示 README 前 N 行）
9. 导出到项目内约定目录（如 `.harness/`）
10. **导入**：因为设计图是原样复制的，识别它们零成本（§3.6）；表结构则需要 tbls JSON 档（复用现成的 `parseTblsJson`）

**待确认**

- 目标 AI 是哪种（Cline / Cursor / Claude Code）？不同工具对「一个目录」vs「一个文件」的偏好不同，可能影响是否需要额外提供单文件合并版。
- 是否需要导出便签（`CanvasNote`）？AI 有时需要设计意图的散文说明，但便签语义可能和表注释重叠。

---

## 9. 影响范围

| 文件 | 改动 | 优先级 |
| :-- | :-- | :-- |
| `src/export/builder.ts`（新增） | 纯函数：分区递归 + 单表/单图/README 渲染 | P0 |
| `src/export/collect.ts`（新增） | 收集 `ExportItem[]` + 分区映射 | P0 |
| `src/export/run.ts`（新增） | 落盘、sanitize、失败清理、通知 | P0 |
| `src/commands/export.ts`（新增） | `harness.export.open` / `run` | P0 |
| `src/shared/protocol.ts` | `ExportItem` / `ExportLevel` / `ExportRequest` / 三条消息 | P0 |
| `webview-ui/src/components/ExportDialog.vue`（新增） | 树形选择器 | P0 |
| `webview-ui/src/components/SourcePanel.vue` | 标题栏加「⬇ 导出」+ `emit('export')` | P0 |
| `webview-ui/src/App.vue` | 接线弹窗、监听 host 消息 | P0 |
| `src/canvas/canvasEditor.ts` | `export/*` 分支 + 推送 `export/items` | P0 |
| `src/extension.ts` | 加 `registerExportCommands(h)`（第 51-56 行注册序列附近） | P0 |
| `package.json` | `contributes.commands` + 侧边栏 `menus` | P0 |
| `test/exportBuilder.test.ts`（新增） | 单测（§7） | P0 |
| `webview-ui/src/dev/mockHost.ts` | mock 新消息 | P1 |
| `src/commands/diagram.ts` | 抽 `readAiSpec()` 供「复制给 AI」复用 | P1 |
| `docs/当前实现文档/README.md` | §6 协议速查 + §7 命令一览 + §8 改什么去哪里 | P1 |

**注意**：`generateErDiagram` / `parseErDiagram` / `computeErSync` **一个字都不用改**。表名问题（§1.6）用「表文件里显式写 `rawName`」解决，不动共享代码，零回归风险。

---

## 10. 与上一版的差异

| 项 | 上一版 | 本版 | 原因 |
| :-- | :-- | :-- | :-- |
| 产物形态 | 单文件 `export.md` | **目录树**，按分区递归 | 用户实际需求是导出画布的组织结构 |
| 表的粒度 | 所有表挤一个文件 | **一表一文件** + 每层 README | 上下文可控、Git diff 干净、关系本来就必须集中 |
| 关系表达 | 自然语言列表 | **Mermaid ER + 引用桩** | 关系可视化，且 ER 可回灌 |
| 选择交互 | 两列勾选（表 / 图） | **树形 + 三态默认** | 要按分区组织，且要能选没上画布的项 |
| ZIP | 列为 P2 | **删除** | 目录结构已解决打包问题，AI 读目录比读压缩包顺 |
| tbls JSON 备份档 | 列为可选 C 档 | 移到 P2 的导入方向 | 本期不做导入，但 `parseTblsJson` 现成，未来几乎免费 |
| `dbName()` 描述 | 说它返回 `host:port/db` | **修正**：返回用户昵称，见 §1.6 | 事实修正，风险点从"代码泄漏主机名"变为"昵称含环境信息" |
| `rawName` 要求 | 说"必须用 `rawName`" | 修正为"`generateErDiagram` 用 `key`"，用表文件显式补 `rawName` | 见 §1.6，避免改动共享代码 |

废弃的判断：单文件导出、ZIP 打包、"导出即回灌"（实际只有 ER 图能回灌）。

---

## 11. 已核实的代码事实索引

| 事实 | 位置 |
| :-- | :-- |
| 面板标题栏 / 「+ 添加数据库」按钮 | `webview-ui/src/components/SourcePanel.vue` `.panel-header` |
| 面板无 codicon，全是文本字符图标 | 同上；全仓库无 `@vscode/codicons` |
| 面板已有 `search` + `matches()` 可复用 | 同上 |
| `copyForAI` 已有「只导模型、不含连接信息」原则 | `src/commands/diagram.ts` `copyForAI()` |
| `media/spec/mermaid-design.md` 是给 AI 的格式说明 | `media/spec/mermaid-design.md` |
| spec 第 8 条：只写表名 = 只引用 | `media/spec/mermaid-design.md:48` |
| spec 第 9 条：不写默认值/索引/枚举 | `media/spec/mermaid-design.md:52` |
| 分区可嵌套（`parent` 字段） | `src/shared/canvas.ts:15-20` |
| `partitionPath` / `partitionSubtree` / `partitionOf` 现成 | `src/shared/canvas.ts:170` / `:163` / `:186` |
| 无 layout 节点的表/图一律算根层 | `src/shared/canvas.ts:72-75` |
| `nodeId` = `source/table`；`DESIGN_SOURCE = 'design'` | `src/shared/canvas.ts:129` / `:90` |
| `NTable.key` 去掉默认 schema，`rawName` 才是真名 | `src/shared/model.ts:47-52` |
| `NColumn` 有 `nullable`/`default`/`indexes`/`enumValues` 等 Mermaid 装不下的字段 | `src/shared/model.ts:33-46` |
| `generateErDiagram` 用 `t.key`，不是 `rawName` | `src/shared/mermaid/er.ts:270` |
| 关系过滤口径：两端都选中才输出 | `src/shared/mermaid/er.ts:262-264` |
| 关系行会自动创建两端实体（引用桩可行） | `src/shared/mermaid/er.ts:147-150` |
| `ErEntity.hasBody` 区分「引用」和「描述字段」 | `src/shared/mermaid/er.ts:22` |
| `aliasOf` 限制 40 字符/无换行/无方括号 | `src/shared/mermaid/er.ts:239-243` |
| `mermaidType` 把空格换成 `_`（不可逆） | `src/shared/mermaid/er.ts:220-223` |
| 只有 `type: 'er'` 是 `syncable: true` | `src/shared/diagram.ts:5-11` |
| 只有 ER 图能同步到表结构 | `src/diagram/diagramService.ts:124` |
| `serializeDiagram` 的 frontmatter 格式 | `src/shared/diagram.ts:113-126` |
| `diagrams.text()` 优先读打开的编辑器（含未保存） | `src/diagram/diagramService.ts:73` |
| 设计图磁盘上就是一图一文件 | `src/workspace/storage.ts:286-288` |
| 磁盘结构 `design/<id>/{design.yml, schema.json, ...}` | `src/workspace/storage.ts:46` |
| `locate()` 只管辖 `workspaces/`，`exports/` 天然在外 | `src/workspace/storage.ts:109-129` |
| `dbName()` 读 `source.yml` 的昵称，不是 DSN | `src/model/store.ts:59` |
| DSN 在 `SecretStorage`，key 为 `harness.dsn:v2:<ws>:<db>` | `src/workspace/storage.ts` `DbSource.secretKey` |
| `shortName(ns, key)` 是画布显示名 | `src/shared/namespace.ts:34` |
| `mkdirp` / `writeText` / `exists` 现成 | `src/workspace/fsUtil.ts:73` / `:22` / `:7` |
| `register` 包装器自动吞 `Cancelled`、统一报错 | `src/commands/common.ts` |
| 纯函数 + 单测的既有范式 | `src/shared/copyTables.ts` + `test/copyTables.test.ts` |
| 现有 13 个测试文件 | `test/` |

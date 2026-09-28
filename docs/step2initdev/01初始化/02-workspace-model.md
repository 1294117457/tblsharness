# 02 工作区的目录结构与文件格式

## 一、和第一阶段的区别

| | 第一阶段 | 第二阶段 |
| :-- | :-- | :-- |
| 存放位置 | 项目目录下的 `.harness/` | **插件内部的存储目录**，不放进项目目录（见第二节） |
| 工作区数量 | 一个项目只有一个 | 可以有任意多个，自由添加，和打开的是哪个项目无关 |
| 设计模型 | 固定一份：`design/schema.json` | 多个设计数据源：`design/<数据源ID>/` |
| 数据库 | 固定一个连接，密钥按项目目录保存 | 多个数据库数据源：`db/<数据源ID>/`，每个数据源单独保存连接串 |
| 画板 | 固定三个页签：设计、数据库、差异 | 多个画布文件：`canvas/<画布ID>.canvas.json`，内容由用户自己编排 |
| 表映射、已确认的差异 | 放在 `design/ext.json` 里 | 移到工作区的 `comparisons.json`，按"设计源 + 数据库源"成对保存 |
| 排除规则、默认 schema | 放在 `.harness/harness.yml` | 移到每个数据库数据源自己的 `source.yml` |

第一阶段的数据只是测试数据，**不做迁移**。

## 二、存放位置

工作区放在插件自己的存储目录里：

| 情况 | 根目录 |
| :-- | :-- |
| 默认 | `context.globalStorageUri`。Windows 上一般是 `%APPDATA%\Cursor\User\globalStorage\<发布者>.harness-cursor\` |
| 设置了 `harness.storageDir` | 使用设置的目录。适合放到网盘或者一个单独的 Git 仓库里做备份、共享 |

- `harness.storageDir` 的作用域是 `machine`，只能在用户设置里配置，不能被项目的 `.vscode/settings.json` 覆盖。
- 修改这个设置后，插件会重新监听新目录并刷新侧边栏，旧目录里的文件不会被移动或删除。
- 侧边栏标题栏的"在资源管理器中打开存储目录"（`harness.openStorage`）可以直接打开根目录。

因为不在项目目录里，工作区和打开的是哪个项目无关：在任何窗口里都能看到全部工作区，没有打开文件夹也能使用。

## 三、目录结构

```
<根目录>/
└─ workspaces/
   └─ order-system/                    # 工作区（目录名就是工作区 ID）
      ├─ workspace.yml                 # 工作区名称、说明
      ├─ comparisons.json              # 设计源和数据库源的对比配置
      ├─ design/                       # 设计数据源（可编辑）
      │  └─ core/
      │     ├─ source.yml              # 数据源名称、说明
      │     ├─ schema.json             # 严格的 tbls 格式
      │     └─ ext.json                # tbls 表达不了的信息
      ├─ db/                           # 数据库数据源（只读）
      │  └─ dev-pg/
      │     ├─ source.yml              # 名称、排除规则、默认 schema、连接方式（不含连接串）
      │     ├─ .tbls.yml               # 可选，传给 tbls 的配置；禁止包含 dsn
      │     └─ snapshots/
      │        └─ 2026-09-28T10-50-00-000Z.json   # tbls out -t json 的原始结果
      └─ canvas/                       # 画布
         ├─ overview.canvas.json
         └─ order-flow.canvas.json
```

### 3.1 ID 的规则

- 工作区、数据源、画布的 ID 就是目录名或文件名，只允许使用 `a-z`、`0-9`、`-`、`_`，以字母或数字开头，长度 1 到 64。
- 显示名称单独存放在各自的 `.yml` 文件（画布是文件里的 `name` 字段），可以使用中文。
- 新建时，由显示名称自动生成 ID：英文名称转成小写并把空格换成 `-`；中文名称按顺序生成 `ws-1`、`design-1`、`db-1`、`canvas-1`。用户可以在输入框里修改。
- ID 在所属目录内必须唯一。
- **ID 创建后不能修改。**"重命名"只修改显示名称。这样画布里的 `ref`、`comparisons.json`、凭据键名都不需要跟着改。

### 3.2 快照保留数量

快照会不断增加，每个数据库数据源默认只保留最近 10 份，由 `source.yml` 的 `snapshotRetention` 控制。每次同步或导入后自动删除更早的快照。

## 四、文件格式

以下 TypeScript 类型对应 `src/shared/workspace.ts`。YAML 文件用 `yaml` 库解析，缺少的字段使用默认值。

### 4.1 `workspace.yml`

```yaml
version: 1
name: 订单系统
description: 订单、支付、售后相关的表
```

```ts
interface WorkspaceMeta {
  version: 1;
  name: string;
  description?: string;
}
```

### 4.2 设计数据源 `design/<ID>/`

`source.yml`：

```yaml
version: 1
name: 核心模型
description: 第一版设计，2026-09 评审通过
# 从哪里创建的，只用于显示
createdFrom: { kind: empty }        # 或 { kind: db, source: dev-pg, snapshot: 2026-09-28T10-50-00-000Z.json }
```

```ts
interface DesignSourceMeta {
  version: 1;
  name: string;
  description?: string;
  createdFrom?: { kind: 'empty' } | { kind: 'db'; source: string; snapshot: string } | { kind: 'file'; path: string };
}
```

`schema.json`：严格的 tbls 格式。补充两条约定：

- 新建空白设计源时，要求用户选择目标数据库类型，写入 `driver.name`，例如 `postgres`、`mysql`、`sqlite`。字段类型的解析（`parseColumnType`）和新建表时 `id` 字段的类型都依赖这个值。
- 保存时固定顺序：表按名称排序，字段保持用户调整后的顺序，关系按 `relationKey` 排序。输出使用两个空格缩进，末尾加换行。这样放进 Git 管理时 diff 清楚可读。

`ext.json` 升级为 `version: 2`，去掉 `tableMappings` 和 `acceptedDiffs`（它们是"设计源和某个数据库源之间"的信息，已经移到 `comparisons.json`）。读取时兼容第一阶段的 `groups` 字段，当作 `modules`。

```ts
interface DesignExt {
  version: 2;
  /** 关系的语义类型：logical、json_array、polymorphic、dictionary 等 */
  relations: RelationExt[];
  /** 业务模块划分，和画布上的分组框不是一回事：它表示模型本身的领域划分 */
  modules: GroupExt[];
}
```

### 4.3 数据库数据源 `db/<ID>/`

`source.yml`：

```yaml
version: 1
name: 开发库
description: 开发环境 PostgreSQL
connection:
  kind: secret          # secret：连接串保存在系统凭据中；none：不连接，只能导入快照文件
defaultSchema: public   # 不填时使用 tbls 输出中的 current_schema
exclude:                # 传给 tbls out --exclude，支持通配符
  - pg_stat_statements
  - pgmq.*
include: []             # 传给 tbls out --include，为空表示不限制
snapshotRetention: 10
```

```ts
interface DbSourceMeta {
  version: 1;
  name: string;
  description?: string;
  connection: { kind: 'secret' } | { kind: 'none' };
  defaultSchema?: string;
  exclude: string[];
  include: string[];
  snapshotRetention: number;
}
```

- 新建数据库数据源时，`exclude` 默认填入 `DEFAULT_DB_EXCLUDE`（常见扩展表、迁移工具表）。
- `connection.kind: none` 的数据源不需要连接数据库。用户可以把别处用 tbls 导出的 JSON 导入为快照，这样即使完全离线，也能做对比。
- 当前使用的快照默认是最新的一份。画布可以固定使用某一份历史快照（画布文件的 `sources[].snapshot`）。

### 4.4 `comparisons.json`

对比总是在一个设计源和一个数据库源之间进行。表名映射和"已确认的偏差"属于这一对，而不属于某一个画布，所以放在工作区级别，多个画布共享。

```json
{
  "version": 1,
  "pairs": [
    {
      "design": "core",
      "db": "dev-pg",
      "tableMappings": { "order": "orders" },
      "acceptedDiffs": ["column_mismatch:orders:amount"]
    }
  ]
}
```

```ts
interface ComparisonPair {
  design: string;                           // 设计数据源 ID
  db: string;                               // 数据库数据源 ID
  tableMappings: Record<string, string>;    // 设计表名 -> 数据库表名，只在名称不同时需要
  acceptedDiffs: string[];                  // DiffItem.id
}
```

某一对第一次确认偏差时，插件自动在 `pairs` 里添加一条记录。

### 4.5 画布文件

画布文件的格式见 [04-canvas.md](./04-canvas.md) 第二节。

## 五、插件内部的数据组织

| 类 / 模块 | 文件 | 职责 |
| :-- | :-- | :-- |
| `HarnessStorage` | `src/workspace/storage.ts` | 根目录（`globalStorageUri` 或 `harness.storageDir`）；列出和新建工作区；根据文件路径反查它属于哪个工作区、哪个数据源（`locate`） |
| `HarnessWorkspace` | 同上 | 一个工作区目录：列出数据源和画布；读写 `comparisons.json` |
| `DesignSource` | 同上 | 读写 `source.yml`、`schema.json`、`ext.json` |
| `DbSource` | 同上 | 读写 `source.yml`、快照；快照保留数量；凭据键名 |
| `ModelStore` | `src/model/store.ts` | 按数据源缓存标准化后的模型和设计文档；计算对比结果；文件变化时让对应缓存失效，发出 `onDidChange` |
| 联动修改 | `src/workspace/refactor.ts` | 设计表改名、删除数据源时，更新其他画布和 `comparisons.json` |
| 纯函数 | `src/shared/designOps.ts`、`src/shared/canvas.ts` | 设计编辑和画布编辑，不依赖 `vscode`，可以直接做单元测试 |

文件监听：`extension.ts` 监听 `<根目录>/workspaces/**`。回调中用 `HarnessStorage.locate` 解析出变化的是哪个数据源，只让这个数据源的缓存失效。插件自己写入文件时也会触发监听，`ModelStore` 记录"最近一次由自己写入的内容"，内容相同时忽略这次变化，避免画布收到重复更新。

## 六、连接串的安全要求

这是硬性要求，所有涉及数据库连接的代码都必须遵守：

1. **连接串只保存在 `context.secrets`（系统凭据管理）里**，键名为：

   ```
   harness.dsn:v2:<工作区ID>:<数据库数据源ID>
   ```

   ID 不可修改，所以键名不需要迁移。删除数据源或工作区时同时删除凭据。

2. **任何写入磁盘的文件都不能包含连接串**：`source.yml`、`.tbls.yml`、快照、画布、日志都一样。

3. **导入 `.tbls.yml` 时必须检查 `dsn` 字段。** `tbls out -t config` 生成的配置文件会带上明文的 `dsn`（里面有账号和密码）。导入时：
   - 如果发现 `dsn`，先把它从要写入的内容中删除（`stripDsnFromTblsConfig`，保留其他内容和注释）；
   - 询问用户是否把这个连接串保存到系统凭据中；
   - 同时提醒用户，原文件里有明文密码，不要提交到 Git。

4. 调用 tbls 时，连接串只通过命令行参数传递。所有错误信息都要经过 `maskDsn`/`maskSecret` 处理，去掉密码。

5. 建议用户使用只读的数据库账号。新建数据库数据源的输入框里给出这条提示。

6. 以后的 MCP 接口只提供结构和差异，永远不返回连接信息。

## 七、重命名、删除和引用关系

| 操作 | 需要同步更新的内容 |
| :-- | :-- |
| 重命名工作区、数据源、画布 | 只改显示名称，不需要更新任何引用 |
| 删除数据源 | 弹窗列出引用它的画布，确认后从这些画布中移除该数据源及其表节点；删除对应的对比记录；删除凭据 |
| 设计表改名 | 本设计源 `ext.json` 里相关关系的 `key`（在 `designOps` 内完成）；`comparisons.json` 里的 `tableMappings` 和 `acceptedDiffs`；所有画布里引用这张表的节点 |
| 删除设计表 | 本设计源里涉及它的关系和外键约束（在 `designOps` 内完成）。其他画布里的节点保留，显示为"缺失" |

跨文件的更新集中写在 `src/workspace/refactor.ts` 里。对打开着的画布：没有未保存修改的，在内存和磁盘上一起更新；有未保存修改的，只在内存里更新，等用户保存时一起写入，避免覆盖用户的修改。

表的身份目前靠表名（`NTable.key`）来识别，所以改名需要做上面这些同步。如果以后要做改名检测或跨版本追踪，再考虑在 `ext.json` 里给表加稳定 ID。本阶段不做。

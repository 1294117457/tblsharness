# 02 数据库连接页面

## 一、目标

用户点"添加数据库"后，在编辑区打开一个表单页面：

1. 选择数据库类型；
2. 填写主机、端口、库名、账号、密码等参数（不用写连接串）；
3. 可以先"测试连接"，看到"连接成功，发现 128 张表"；
4. 点"连接"：保存连接信息，读取表结构（用 tbls），创建数据库数据源。

**连接成功之前不创建任何文件。** 用户关掉页面或者连接失败，工作区里不会留下半成品。

## 二、界面

```
┌ 添加数据库 · 工作区 1 ─────────────────────────────────────────────┐
│                                                                    │
│  ( 连接数据库 )  ( 导入 tbls JSON 文件 )                            │
│                                                                    │
│  数据库类型   [PostgreSQL ▾]                                        │
│  主机         [localhost            ]  端口 [5432 ]                │
│  数据库       [orders               ]                              │
│  用户名       [reader               ]                              │
│  密码         [••••••••             ]  [显示]                       │
│  SSL          [disable ▾]                                          │
│                                                                    │
│  ▸ 高级选项                                                         │
│      默认 schema   [public]                                         │
│      附加参数      [application_name=harness]                       │
│      排除的表      [pg_stat_statements, pgmq.*, ...]  （每行一个）   │
│      只包含的表    [                    ]                           │
│                                                                    │
│  名称         [PostgreSQL · orders  ]   ← 随库名自动变化，改过就不再跟随 │
│                                                                    │
│  ⓘ 建议使用只读账号。连接信息只保存在系统凭据中，不会写入任何文件。       │
│                                                                    │
│  ✔ 连接成功：128 张表、96 条关系（用时 2.3 秒）                        │
│                                                                    │
│                               [测试连接]  [连接]  [取消]             │
└────────────────────────────────────────────────────────────────────┘
```

- 页面是一个普通的 `WebviewPanel`（不是自定义编辑器），标题"添加数据库 · <工作区名称>"。同一个工作区重复点击"添加数据库"时，切换到已经打开的页面，不再开第二个。
- "导入 tbls JSON 文件"页签：选择文件 → 显示文件里的表数量 → 填名称 → "导入"。等同于现在的离线导入流程。
- 测试、连接期间，按钮变成"正在连接…"并显示"取消"。取消会结束 tbls 进程。
- 字段校验在输入时进行：端口必须是 1 到 65535 的整数；主机、库名、用户名不能为空（SQLite 只要求文件路径）。
- 修改了任何连接参数后，之前的测试结果显示为灰色的"参数已修改，需要重新测试"。

## 三、支持的数据库和表单字段

只列出 tbls 能连接的数据库。**tbls 不支持 Oracle**：设计模型仍然可以选 Oracle 作为目标类型，但数据库数据源只能用"导入 JSON 文件"（需要用其他工具导出成 tbls 格式），或者以后通过 tbls 的外部驱动机制接入（见 03 文档 2.4 节）。

| 类型 | 连接串前缀 | 默认端口 | 表单字段 | 安全连接选项 |
| :-- | :-- | :-- | :-- | :-- |
| PostgreSQL | `postgres://` | 5432 | 主机、端口、数据库、用户名、密码、默认 schema | `sslmode`：disable / require / verify-ca / verify-full |
| MySQL | `mysql://` | 3306 | 主机、端口、数据库、用户名、密码 | `tls`：false / preferred / skip-verify / true |
| MariaDB | `mariadb://` | 3306 | 同 MySQL | 同 MySQL |
| SQL Server | `sqlserver://` | 1433 | 主机、端口、数据库、用户名、密码 | `encrypt`：disable / true；是否信任服务器证书 |
| SQLite | `sqlite://` | — | 数据库文件（"浏览…"按钮选择文件） | — |
| ClickHouse | `clickhouse://` | 9000 | 主机、端口、数据库、用户名、密码 | — |
| Amazon Redshift | `redshift://` | 5439 | 同 PostgreSQL | 同 PostgreSQL |
| 其他（自定义连接串） | — | — | 一个多行输入框，直接填写 tbls 连接串 | — |

"其他"用于 BigQuery、Cloud Spanner、Snowflake、Databricks、MongoDB、DynamoDB、Azure SQL 等。它们的认证方式各不相同（凭据文件、令牌、云厂商的默认凭据链），做成表单的收益不大。输入框下面给出每种数据库的连接串示例和 tbls 文档链接。整条连接串按密码对待，只存进系统凭据。

### 3.1 数据库类型选择

"数据库类型"是表单的第一个字段，下拉框，选项就是上表的 8 项，按上表的顺序排列，每项前面有对应的图标。

- **默认选中的类型**：上一次在任意工作区成功连接时使用的类型（保存在 `context.globalState`）；第一次使用时是 PostgreSQL。
- **切换类型时**：
  - 表单字段换成新类型的字段（比如切到 SQLite 只剩"数据库文件"，切到"其他"只剩连接串输入框）；
  - 端口：用户没改过时换成新类型的默认端口，改过就保留；
  - 主机、数据库、用户名、密码：两边都有的字段保留已填的值；
  - 安全连接选项换成新类型的选项，按 3.2 的默认值规则重新选择；
  - 名称：用户没改过时跟着变，例如从"PostgreSQL · orders"变成"MySQL · orders"；
  - 之前的测试结果作废，显示"参数已修改，需要重新测试"。
- **编辑已有连接时**（见第七节）也可以切换类型。保存后 `source.yml` 里的 `connection.driver` 跟着更新，树节点的图标随之变化。

### 3.2 附加说明

- **SQL Server** 需要 2017 或以上版本、数据库兼容级别 110 以上（tbls 的要求）。选择 SQL Server 时在表单里显示这条提示。
- **SSL 的默认值**：主机是 `localhost`、`127.0.0.1`、`::1` 时默认不加密；其他主机默认 PostgreSQL 用 `require`、MySQL 用 `preferred`，并提示"连接远程数据库建议开启加密"。
- **证书文件**（CA、客户端证书）：tbls 通过 `.tbls.yml` 的 `dsn.tls` 配置。本次不做成表单字段，需要的用户可以继续用"导入 tbls 配置"命令。以后再做。

## 四、连接串的拼接

新增纯函数，放在 `src/shared/connection.ts`，不依赖 `vscode`，用单元测试覆盖：

```ts
type ConnectionDriver = 'postgres' | 'mysql' | 'mariadb' | 'sqlserver' | 'sqlite' | 'clickhouse' | 'redshift' | 'custom';

interface ConnectionProfile {
  version: 1;
  driver: ConnectionDriver;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  /** SQLite 的文件路径 */
  file?: string;
  /** sslmode / tls / encrypt，取值按数据库类型 */
  security?: string;
  /** 用户在"附加参数"里填写的 key=value，原样拼到连接串后面 */
  params?: Record<string, string>;
  /** driver 为 custom 时的整条连接串 */
  dsn?: string;
}

function buildDsn(profile: ConnectionProfile): string;
function validateProfile(profile: ConnectionProfile): Record<string, string>; // 字段名 → 错误提示
function defaultPort(driver: ConnectionDriver): number | undefined;
function describeProfile(profile: ConnectionProfile): string;           // 给界面显示，不含密码，例如 reader@localhost:5432/orders
```

拼接规则：

- 用户名、密码、库名用 `encodeURIComponent` 编码。tbls 的文档专门提醒过：密码里有 `#`、`<` 等字符时必须编码。用户在表单里直接填原始密码即可。
- IPv6 地址加方括号：`postgres://u:p@[::1]:5432/db`。
- 查询参数的顺序固定：安全连接选项、连接超时、附加参数。
- 统一加上**连接超时**参数，避免主机不可达时长时间卡住。PostgreSQL 用 `connect_timeout=10`，MySQL / MariaDB 用 `timeout=10s`，SQL Server 用 `dial timeout=10`，ClickHouse 用 `dial_timeout=10s`。这几个参数名要在开发时逐个实测 tbls 是否认可。无论参数是否生效，插件都另外对 tbls 进程设置总超时（见第六节）。
- SQLite 在 Windows 上的路径写法（`sqlite:///C:/data/app.db` 还是其他形式）需要实测后确定，并写进单元测试。

## 五、连接信息保存在哪里

| 内容 | 位置 |
| :-- | :-- |
| 整个 `ConnectionProfile`（主机、端口、库名、用户名、密码、参数），序列化成 JSON | 系统凭据 `context.secrets`，键名不变：`harness.dsn:v2:<工作区ID>:<数据库ID>` |
| 数据库类型、显示名称、默认 schema、排除和包含规则 | `source.yml` |

`source.yml` 的 `connection` 字段改为：

```yaml
connection:
  kind: secret
  driver: postgres      # 只用于显示图标和"数据库类型"，不含任何地址信息
```

为什么主机和用户名也放进凭据：

- 之前的约定是"连接串不能出现在任何文件里"。主机地址、用户名虽然不是密码，但同样是连接信息。特别是公网 IP，泄露后会增加被扫描、暴力破解的风险。
- 存储目录可能被用户放到网盘或 Git 仓库里共享（`harness.storageDir`），文件里不应该有这些信息。
- 连接页面需要回填表单，所以按字段保存，而不是保存拼好的连接串。

兼容：第二阶段第一版保存的凭据是一整条连接串字符串。读取时，如果凭据内容不是以 `{` 开头的 JSON，就当作 `{ driver: 'custom', dsn: <原字符串> }` 处理。编辑时显示在"其他（自定义连接串）"里。

## 六、测试和连接的流程

### 6.1 tbls 没有单独的"测试连接"命令

tbls 1.96 的子命令只有 `doc`、`diff`、`lint`、`out`、`ls`、`coverage` 等，都会完整地分析整个数据库，没有只做连接的命令。所以：

- **测试连接 = 执行一次 `tbls out -t json`**，成功就说明能连上，同时拿到表和关系的数量。
- 这次的结果在插件主进程的内存里保留 5 分钟，以"连接参数 + 排除和包含规则"的哈希值为键。之后点"连接"时参数没变，就直接用这份结果写入第一份快照，不再读第二遍。大库分析一次可能要十几秒，这样可以省掉一次等待。
- 用户没点测试、直接点"连接"时，先执行分析，成功后再创建数据源。

### 6.2 连接成功之后

1. 分配 ID `db<N>`（见 01 文档第二节），创建目录和 `source.yml`。
2. 把 `ConnectionProfile` 存进系统凭据。
3. 把分析结果写成第一份快照。
4. 关闭连接页面，在树中展开并选中新的数据库节点。
5. 右下角显示一条不需要操作的提示："已连接 PostgreSQL · orders：128 张表。右键可以添加到画布"。

新建的数据库**不自动加入任何画布**，无论是从树视图还是从画布数据源面板发起的（见 01 文档 3.5 节）。要在画布上查看，在画布数据源面板的"+ 添加"里选择它，或者在数据库节点右键"添加到画布…"。

第 1 到 3 步中任何一步失败，就删掉已经创建的目录和凭据，页面上显示错误，用户可以修改后重试。

### 6.3 调用 tbls 的改动

| 改动 | 原因 |
| :-- | :-- |
| 连接串改用环境变量 `TBLS_DSN` 传给 tbls，不再用 `--dsn` 命令行参数 | 命令行参数会出现在系统的进程列表里，同一台机器上的其他用户和程序可以看到。tbls 官方文档说明它接受 `TBLS_DSN` 环境变量 |
| 给 tbls 进程设置总超时，默认 120 秒，可以用设置 `harness.tblsTimeoutSeconds` 修改 | 主机不可达或者数据库很大时，不能让界面一直停在"正在连接" |
| 支持取消 | 连接页面的"取消"按钮和同步时的进度通知都可以结束 tbls 进程 |

`src/tbls/runner.ts` 的 `tblsOutJson` 增加 `signal?: AbortSignal` 和 `timeoutMs` 参数，内部用 `execFile` 的 `signal`、`timeout` 选项实现。

### 6.4 常见错误的提示

tbls 的原始错误信息先经过 `maskSecret` 去掉密码，再按关键字转换成中文提示。原始信息放在可以展开的"详细信息"里：

| 原始信息中包含 | 提示 |
| :-- | :-- |
| `password authentication failed`、`Access denied for user`、`Login failed` | 用户名或密码错误。MySQL 还可能是这个账号不允许从当前机器登录 |
| `no such host`、`server misbehaving` | 找不到这个主机，请检查主机地址 |
| `connection refused` | 主机能访问，但端口没有开放。请检查端口，以及数据库是否已经启动 |
| `timeout`、`i/o timeout`、`deadline exceeded` | 连接超时。请检查网络、防火墙和数据库的访问白名单 |
| `does not exist`、`Unknown database` | 数据库不存在，请检查库名 |
| `SSL is not enabled`、`server does not support SSL`、`TLS requested but server does not support TLS` | 服务器没有开启加密连接，请把 SSL 选项改为不加密 |
| `pg_hba.conf` | 服务器拒绝了这个地址或这种加密方式的连接，请联系数据库管理员 |
| 找不到 tbls 可执行文件 | 显示"设置 tbls 路径"按钮，打开设置 `harness.tblsPath` |

没有匹配上的错误只显示原始信息。

## 七、编辑已有的连接

数据库节点右键"编辑连接…"（替换现在的"设置连接…"输入框），打开同一个页面，标题为"编辑连接 · <数据库名称>"：

- 表单用凭据里保存的内容回填，**密码除外**。密码框显示占位文字"已保存，不修改请留空"。插件主进程不会把已保存的密码发给页面。
- 按钮是"测试连接"和"保存"。保存成功后询问"现在同步吗？"。
- 可以修改数据库类型。修改后提示"已有快照来自原来的数据库，建议重新同步"。

## 八、页面的实现方式

### 8.1 和画布共用一套前端工程

- 连接页面和画布放在同一个 `webview-ui` 工程里，共用 Vite 开发服务器和热更新。
- `src/webview/html.ts` 的 `renderWebviewHtml` 增加一个 `view: 'canvas' | 'connection'` 参数，写到 `<body data-view="...">` 上。`main.ts` 根据它挂载 `App.vue` 或者 `ConnectionApp.vue`。
- 新增文件：

```
src/connection/connectionPanel.ts       # WebviewPanel：打开、复用、消息处理、调用 tbls、创建数据源
src/shared/connection.ts                # ConnectionProfile、buildDsn、validateProfile 等纯函数
src/shared/connectionProtocol.ts        # 连接页面的消息类型
webview-ui/src/connection/ConnectionApp.vue
webview-ui/src/connection/DriverFields.vue   # 按数据库类型显示不同的字段
webview-ui/src/dev/mockConnectionHost.ts     # 浏览器调试模式下模拟测试结果
```

### 8.2 消息协议

**页面 → 插件主进程：**

```ts
type ConnectionWebviewMessage =
  | { type: 'ready' }
  | { type: 'test'; requestId: string; profile: ConnectionProfile; filters: { exclude: string[]; include: string[] } }
  | { type: 'connect'; requestId: string; profile: ConnectionProfile; filters: {...}; name: string; defaultSchema?: string }
  | { type: 'importFile'; requestId: string; name: string }
  | { type: 'pickFile'; requestId: string; purpose: 'sqlite' | 'json' }
  | { type: 'cancel' };
```

**插件主进程 → 页面：**

```ts
type ConnectionHostMessage =
  | { type: 'init'; mode: 'create' | 'edit'; workspaceName: string; profile?: Omit<ConnectionProfile, 'password'>;
      hasSavedPassword: boolean; name?: string; defaultSchema?: string; filters: { exclude: string[]; include: string[] } }
  | { type: 'result'; requestId: string; ok: true; tables: number; relations: number; elapsedMs: number }
  | { type: 'result'; requestId: string; ok: false; message: string; detail?: string; action?: 'setTblsPath' }
  | { type: 'filePicked'; requestId: string; path?: string; tables?: number };
```

编辑模式下，页面发来的 `profile.password` 为空字符串时，插件主进程使用已保存的密码。

### 8.3 密码在页面里的处理

- 密码只存在于表单组件的状态里，**不写入 `vscode.setState`**。VS Code 会把 Webview 的 `setState` 内容持久化到磁盘，用来在重启后恢复页面。
- 页面关闭时丢弃所有状态，下次打开重新从插件主进程获取（不含密码）。
- 插件主进程收到密码后只用于拼接连接串和存入凭据，不写日志，报错时经过 `maskSecret` 处理。

## 九、安全要求（在原有要求上补充）

1. 连接信息（包括主机、端口、库名、用户名、密码）只保存在系统凭据中。任何文件里都不能出现，包括 `source.yml`、快照、画布、日志。
2. 连接串通过环境变量 `TBLS_DSN` 传给 tbls，不出现在命令行参数里。
3. 已保存的密码不会发送给页面。
4. 页面上始终显示"建议使用只读账号"。tbls 只读取结构信息，只读账号完全够用（见 03 文档）。
5. 数据库的默认名称不包含主机地址。

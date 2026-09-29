# Harness 设计图格式说明（给 AI）

你在帮我设计数据模型。请只输出 Mermaid 代码块，不要输出 JSON、SQL 或 DBML。
我会把你的 Mermaid 粘贴进 Harness 的设计图，然后自己确认哪些改动同步到表结构。

## 可用的图

| 图 | 第一行 | 用途 |
| --- | --- | --- |
| ER 图 | `erDiagram` | 表、字段、关系。**只有 ER 图会同步到表结构** |
| 状态图 | `stateDiagram-v2` | 某个状态字段的取值和流转 |
| 时序图 | `sequenceDiagram` | 接口、服务之间的调用顺序 |
| 流程图 | `flowchart TD` | 业务流程 |
| 数据流图 | `flowchart LR` | 数据从哪里来、写到哪些表 |

## ER 图写法

```mermaid
erDiagram
  users["用户"] {
    bigint id PK "主键"
    varchar(128) email UK "登录邮箱"
    timestamptz created_at "创建时间"
  }
  orders["订单"] {
    bigint id PK
    bigint user_id FK "下单人"
    numeric(10,2) amount "金额"
    jsonb coupon_ids "使用的优惠券"
  }
  coupons {
    bigint id PK
  }
  users ||--o{ orders : "user_id"
  coupons |o..o{ orders : "coupon_ids json_array"
```

规则：

1. 表名、字段名用英文 snake_case，就是数据库里真实的名字。中文放在 `表名["中文名"]` 和字段后面的 `"注释"` 里。
2. 字段一行一个：`类型 字段名 [PK|FK|UK] ["注释"]`。类型用目标数据库的真实类型，如 `varchar(64)`、`numeric(10,2)`、`timestamptz`。类型里不能有空格，`timestamp with time zone` 写成 `timestamp_with_time_zone`。
3. 每张表都要有主键，标 `PK`。外键字段标 `FK`，唯一字段标 `UK`，可以组合，如 `PK, FK`。
4. 关系写成 `父表 基数--基数 子表 : "子表里的外键字段"`：
   - `||` 正好一个，`|o` 零或一个（写在左边）；`o|`、`||` 写在右边。
   - `}o` / `o{` 零或多个，`}|` / `|{` 一或多个。
   - `--` 实线：数据库里真的建外键。`..` 虚线：不建外键，由代码维护。
5. 关系文字里写出子表的外键字段名（如 `"user_id"`）。字段名按 `父表单数_id` 命名时可以省略，但写上最稳妥。
6. 特殊关系在文字里加关键字：
   - `json_array`：字段里存的是 id 数组，如 `"tag_ids json_array"`。
   - `polymorphic`：多态关联，靠类型字段区分目标表。
   - `dictionary`：指向代码里的字典 / 枚举表。
7. 多对多请加中间表；或者用 `json_array` 表示 id 数组。
8. 只画和这次需求有关的表也可以。只写表名、不写 `{ }` 的表表示“只引用，不改字段”。
9. 不要写默认值、索引、枚举值。这些我会在 Harness 里补，你写了也不会生效。

## 其他图的写法

- 状态图：状态名用字段的真实取值，如 `pending --> paid : 支付成功`。
- 时序图、流程图、数据流图：节点里提到表时，用真实表名，如 `orders`。

## 修改已有设计时

我给你的 ER 图就是当前的表结构。请在它的基础上输出**完整的新 ER 图**，不要只输出改动的部分：
没有出现在图里的字段，我会当作“可能要删除”来提示。

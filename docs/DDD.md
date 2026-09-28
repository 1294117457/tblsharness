# DDD 架构规范

> 本文档只描述**架构分层原则**，与具体语言无关。
> 代码示例仅用于说明组织方式，不代表任何特定语言实现。

---

## 1. 分层总览

```
┌─────────────────┐
│   route (接口)   │  HTTP / RPC / 调度入口、请求响应 DTO
└────────┬────────┘
         ↓ 调
┌─────────────────┐
│  application     │  用例编排
│  (应用服务层)     │  事务、权限、缓存、幂等
└────────┬────────┘
         ↓ 调
┌─────────────────┐
│    domain        │  实体 / 值对象 / 仓储接口 / 领域服务
│   (领域层)        │  纯领域知识，无任何框架依赖
└────────┬────────┘
         ↑ 实现
┌─────────────────┐
│ infrastructure   │  持久化、外部 SDK 适配、配置、异常处理
└─────────────────┘
```

依赖方向**严格自上而下**：`route → application → domain ← infrastructure`。
`domain` 不依赖任何外层，外层实现 `domain` 定义的接口。

---

## 2. 各层职责与边界

### 2.1 domain（领域层）

领域层是**业务核心**，只表达"业务是什么"，不表达"怎么落到技术栈上"。

#### 内容组成

| 概念 | 定义 | 举例 |
|---|---|---|
| **entity** | 有唯一标识 + 有生命周期的领域对象。从持久层读入、承载核心业务规则 | `Kline`、`StockInfo`、`StockPool` |
| **vo**（value object） | 用值描述、没有身份的对象。可加校验、可传递、可组合 | `KlineBO`、`IndicatorValue`、`DateRange` |
| **repository（接口）** | 实体持久化的**抽象接口**。定义在 domain 层，**由 infrastructure 实现** | `KlineRepository`、`StockPoolRepository` |
| **service**（领域服务） | 一段领域逻辑**不适合放在任何一个 entity 上**时（跨多对象、通用算法），用领域服务承载 | `IndicatorCalculator` |

#### 领域服务的特点

- 只依赖 domain（entity / VO / repository 接口），**不依赖任何外部 SDK**
- 不调 HTTP、不发 MQ、不取系统时钟
- 可以读 repository 接口查数据，但**绝不持久化**（持久化由 ApplicationService 管事务）
- 通常**没有副作用**（无 IO、无状态变更）
- 可独立单测，不需要外部容器

#### entity 与领域服务的分工

| 谁 | 管什么 |
|---|---|
| **entity** | 只动自己的状态、判断、能力（"我"的事） |
| **领域服务** | 跨多对象、纯算法（"我与世界共同的事"，但不写） |
| **ApplicationService** | 动多 entity + 外部（"我与世界的协作"，含 IO 与调度） |

#### 反例

- ❌ 在 ApplicationService 里写 "RSI 怎么算" 这种算法 → 应放领域服务
- ❌ 在 entity 里调外部 SDK → 应通过 ApplicationService 编排
- ❌ 在 repository 接口里加业务规则 → repository 只做"读出来 / 存进去"

---

### 2.2 application（应用服务层）

#### 用途

**编排一个完整业务用例**——一个方法对应一个"用户意图"（开始采集、取消操作、查询面板）。

#### 特点

1. **管事务边界**
2. **管权限 / 日志 / 缓存 / 幂等**
3. **调外部端口**（HTTP / MQ / 调度 / 时钟 / 外部 SDK）
4. 一个方法对应一个"用户意图"

#### 子结构

| 目录 | 职责 |
|---|---|
| `service/` | AppService 实现，编排用例 |
| `port/` | 对外抽象接口（如 `CollectorPort`、`OperationDispatchPort`），由 infrastructure adapter 实现 |
| `dto/` | **不保留**——DTO 放在 `route/dto/`，见 §2.3 |

#### 反例

- ❌ 在 ApplicationService 里写 RSI 计算
- ❌ 让 AppService 跨层直接拿 ORM Session
- ❌ 让 AppService 同时是"查询器"和"采集器"（职责混在一起）

---

### 2.3 route（接口层）

#### 职责

- HTTP / RPC / 调度**入口**
- 请求解析、参数校验
- 响应序列化
- **不包含业务规则**

#### 子结构

```
route/
├── api/                 ← 路由文件（按版本/模块划分的 controller）
└── dto/                 ← 接口层 DTO（请求 / 响应）
    ├── request/         ← 入参 DTO，对应外部协议
    └── response/        ← 出参 DTO，含通用响应容器（如 Page<T>）
```

#### 为什么 DTO 放在 route 而非 application

- DTO 是**协议载体**（JSON / protobuf / message），与具体传输方式绑定
- ApplicationService 不应知道"外面长什么样"，它只接收语义化参数、返回语义化结果
- 同一应用服务可能被 HTTP、调度、MQ 共用，DTO 各端各自管理即可

#### 应用服务到 DTO 的转换在哪做

- 在 route 层的 controller / handler 里**手动转换**，或借助 assembler
- 不在 entity 上做（entity 不感知协议）
- 不在 application 层做（application 不知道协议）

---

### 2.4 infrastructure（基础设施层）

对**外**实现 `domain/repository` 接口，对**外**实现 `application/port` 接口。

| 目录 | 职责 |
|---|---|
| `adapter/` | 外部 SDK / 调度器的适配器（如 Tushare、AKShare、定时调度） |
| `persistence/` | `domain/repository` 的持久化实现（ORM、SQL、缓存） |
| `config/` | 环境配置、依赖注入 |
| `exception/` | 基础设施层异常（外部 IO、第三方 SDK 错误的**技术性**翻译） |

#### 异常分层

| 异常来源 | 归属 |
|---|---|
| 业务规则违反（对象不存在 / 状态非法） | **`domain` 层定义的领域异常**，由各聚合根或领域服务抛出 |
| 外部 IO / SDK 错误 | `infrastructure/exception/` |
| 跨用例的应用级错误（极少见） | `application/` 局部 |

**注意**：业务异常属于领域知识，应由 domain 层定义；infrastructure 只翻译技术错误。

---

### 2.5 shared（共享层）——可选

- 放**完全无业务语义**的工具（如时间格式化、UUID 生成）
- **禁止**把任何带业务规则的工具放进来

---

## 3. domain 层目录组织

### 3.1 整体结构：按"聚合根"分目录

```
domain/
├── entitys/                      ← 一个聚合根一个子目录（用 entitys 而非 entities）
│   ├── kline/
│   │   ├── entity.py
│   │   ├── repository.py         ← 仓储接口
│   │   └── vo.py                 ← 本聚合根专用 VO
│   ├── stock_info/
│   │   ├── entity.py
│   │   ├── repository.py
│   │   └── vo.py
│   └── ...（其他聚合根）
└── service/                      ← 跨聚合根的领域服务（纯算法）
    └── ...
```

### 3.2 设计原则

| 规则 | 说明 |
|---|---|
| **聚合根不单独建 `exceptions/` 子目录** | 例外只由 entity 自身抛出，不需要专门目录 |
| **聚合根内部不建 `service/` 子目录** | 聚合根内部的复杂算法直接放在 `entity.py` 中，作为实体的方法（"我自己的事我自己做"） |
| **VO 放在使用它的聚合根目录下** | `KlineBO` 放在 `kline/vo.py`；多个聚合根共用的 VO 放在最接近主语义的聚合根下 |
| **领域服务放 `domain/service/`** | 只有**跨多聚合根**的通用算法才放在这里；属于某一聚合根的逻辑就属于那个聚合根 |

### 3.3 决策流程图

```
一段领域逻辑 X 要写在哪里？
│
├─ X 只涉及一个聚合根自己的状态/规则？
│   └─ → 写在 entity 里（成为该 entity 的方法）
│
├─ X 涉及本聚合根内部多个实体的协作，但仍属"本聚合根的事"？
│   └─ → 仍放在 entity 内（如果是协作，加到主聚合根 entity 上）
│
├─ X 真的跨多个聚合根，但是纯算法无副作用？
│   └─ → domain/service/ 下新建领域服务
│
└─ X 跨多聚合 + 有副作用（持久化 / 调外部）？
    └─ → application/service 的 AppService
```

---

## 4. 依赖关系规则

| 上层 | 可以依赖 | 不可以依赖 |
|---|---|---|
| `route` | application、domain（仅使用其 VO 作为契约载体） | infrastructure |
| `application` | domain（含 repository 接口、port 接口）、infrastructure 的 port 实现（通过注入） | — 不可调 SDK 直接 — |
| `domain` | 仅自身（entity、vo、repository 接口、service） | **任何**外层 |
| `infrastructure` | domain（实现其接口）、application（实现其 port） | route |

**铁律**：

1. `domain` **零外部依赖**（不 import 任何 framework / SDK）
2. `domain` 的 `repository` 接口由 `infrastructure/persistence/` **实现并注入**
3. `application` 通过 `port` 接口使用外部能力，**不知道**具体 SDK

---

## 5. 关键反模式（不要做的事）

| 反模式 | 后果 |
|---|---|
| Anemic Domain Model（只有 setter/getter 的实体） | 领域逻辑泄到 service / controller |
| 在 ApplicationService 里算指标 | 业务规则散落，难以单测 |
| 让 entity 直接调 `db.query()` | 测试必须起数据库 |
| 让 controller 跨过 app 层直接调 repository | 事务、权限、缓存全部丢失 |
| 业务异常放在 `infrastructure/exception/` | infra 不知道业务规则 |
| VO 散落到各层（route 一份、app 一份、domain 一份） | 同一概念三种类型，转换繁琐 |

---

## 6. 一个用例：按本规范应该写在哪

用例：**"为某只股票计算 20 日 RSI 指标"**

| 步骤 | 层 | 位置 |
|---|---|---|
| 1. HTTP 接收 `KlineCollectRequest` | route | `route/api/kline.py`、`route/dto/request/kline.py` |
| 2. route 将参数翻译为 AppService 调用 | route | 同上文件 |
| 3. AppService 开事务、取 Kline 列表、调用领域服务、返回结果 | application | `application/service/kline_app_service.py` |
| 4. 领域服务计算 RSI（纯算法，跨 K线多时间点） | domain | `domain/service/rsi_calculator.py` |
| 5. repo 接口取 Kline 列表 | domain | `domain/entitys/kline/repository.py` |
| 6. repo 实现查 DB | infrastructure | `infrastructure/persistence/xxx_repository.py` |
| 7. AppService 把 `IndicatorValue` 返回给 route | application | 同 3 |
| 8. route 把 `IndicatorValue` 包成 `KlineIndicatorVO` JSON 响应 | route | `route/dto/response/kline.py` |

> 任何"指标如何计算"的细节都集中在 step 4，可以脱离数据库 / Spring / FastAPI 单测。

---

## 7. 与具体代码实现的对应

> 本节只用于让阅读者快速对照。**实现可随技术栈演进；分层原则不变。**

代码目录通常形态：

```
src/
├── route/
│   ├── api/                        ← 路由文件
│   └── dto/
│       ├── request/                ← 入参 DTO
│       └── response/               ← 出参 DTO（含 Page<T> 等通用响应）
│
├── application/                    ← 应用层
│   ├── service/                    ← AppService
│   └── port/                       ← 对外抽象接口
│
├── domain/                         ← 领域层（零外部依赖）
│   ├── entitys/                    ← 一个聚合根一个子目录
│   │   ├── <aggregate>/
│   │   │   ├── entity.py
│   │   │   ├── repository.py
│   │   │   └── vo.py
│   │   └── ...
│   └── service/                    ← 跨聚合根的领域服务
│
└── infrastructure/                 ← 基础设施层
    ├── adapter/                    ← 外部 SDK / 调度适配
    ├── persistence/                ← repository 实现
    ├── config/
    └── exception/
```

`shared/` 为可选，无业务语义的工具集。

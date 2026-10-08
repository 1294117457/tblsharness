# 看板去掉：把数据源能力并入 TreeView

> **状态**：开发文档（草案，待审）
> **创建**：2026-10-06
> **作者**：Cursor Agent
> **配套**：`docs/当前实现文档/README.md`（行号基准）

本目录描述 Harness 0.0.6 的一个**架构性**改动：

- 移除画布内左侧的 `SourcePanel.vue`（"数据源看板"，240px 宽）
- 把看板的核心能力（添加 db / 移除 db / 同步 / 显示-隐藏 / 导出）迁到 `harness.workspaces` 侧边栏
- TreeView 树结构由 `workspace / {设计, db}` 改为 `workspace / 设计 / {tables, diagrams, db, partitions}`（每个 design 看到自己引用的 db）
- "⬇ 导出"按钮移到 TreeView 设计画布项旁
- 看板的复选框语义改用 TreeView 行内的 `$(eye)` / `$(eye-closed)` inline 图标按钮替代

文档三件：

| 文件 | 作用 |
|:--|:--|
| [`01-目标与边界.md`](./01-目标与边界.md) | 这次改动的**意图**与**非目标**。读这份就能知道该不该做 |
| [`02-改动清单.md`](./02-改动清单.md) | 每个文件的精确改动、新增/移除的命令、协议、测试。实施时按这份走 |
| [`03-风险与决策记录.md`](./03-风险与决策记录.md) | 决策日志（ADR 风格）。读完这份能理解"为什么这么选而不是那样选" |

---

## TL;DR — 一句话总结

把 `SourcePanel.vue` 拆成四份能力，分别落到 `workspaceTree.ts`（结构 + inline 按钮）、`commands/canvas.ts`（新命令 `harness.db.showOnCanvas`）、`package.json`（菜单与命令清单）、`commands/export.ts`（已就位）。**不**引入新依赖，**不**重写 webview 协议，**不**改 builder / collect / run 三层导出纯函数。
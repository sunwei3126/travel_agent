# 旅行 Agent 后端重写为 .NET 10（pi.net）设计

日期：2026-10-29
状态：设计待批准
分支：`net-rewrite`

## 1. 意图与背景

这套东西现在能跑，但它有两个互不相干的问题：

- **维护**：团队熟悉 .NET，不熟悉 Node/TypeScript。后端没人能独立改。
- **依赖**：后端建在 `@earendil-works/pi-ai` / `pi-durable` 上，这两个包是实验性的，API 随版本变化。

所以目标是把 `apps/server` 从 TypeScript（pi/pi-durable 的 TS 版）换成一整套 .NET 10 + [pi.net](https://github.com/AIDotNet/pi.net)。pi.net 是同一套 pi 的 C# 移植，耐久会话、agent 循环、工具注册、事件流都是近乎 1:1 的对应物，所以这次不是"用别的东西重做一遍"，而是**换一个团队能接手的实现语言**。

前端（Next.js + CopilotKit）不动。它只通过 `/backend` 重写和 AG-UI SSE 与后端通信，对后端语言没有感知。

> 澄清一个前提：仓库里没有 Python 后端。被替换的是 `apps/server/` 下的 TypeScript 服务。仓库里仅有的 `.py` 文件在 `.superpowers/` 下，是调试脚本，不属于产品代码。

## 2. 目标

1. `apps/server` 在 `net-rewrite` 分支上只剩 .NET 版本，不再有 TypeScript 服务。
2. 对外契约不变：路径、方法、状态码、JSON 形状、SSE 事件。
3. 耐久行为不变：崩溃/重启后会话续跑，已完成的搜索抓取不重复执行、不重复计费。
4. 代码按 .NET 习惯组织，不追求与 TS 文件一一对应。
5. 真实端到端跑通设计文档 §10 的 A–H 全部场景，且结果符合预期。

## 3. 非目标

- 不改 `apps/web`，不改 `packages/shared` 的类型定义。
- 不迁移旧数据：`apps/server/data/pi.sqlite` 与 `trips.json` 不带过去，新服务从空库开始。
- 不加产品功能：不加工具、不加页面、不做多用户/鉴权/云端部署。
- 不修改 pi.net 本身。若发现阻塞性缺陷，记录并上报，不在本分支打补丁。
- 不做 TS → C# 的逐文件翻译。

## 4. 失败条件（即使跑通也算失败）

以下是推导出来的，不是用户原话，实现前应确认：

- 前端为了配合新后端需要改代码。
- 崩溃恢复后重复调用 DeepSeek（重复计费），或丢掉已完成的搜索/抓取。
- A–H 中只有 happy path 过。
- 代码是把 TS 直译成 C#：命名、分层、错误处理仍是 Node 的形状，团队接手仍然吃力。

## 5. 约束

- `.NET 10`（`net10.0`）。参考开发环境 Windows 11，CI 在 Ubuntu。
- NuGet 包：`Pi.Durable` / `Pi.Ai` / `Pi.Agent`，当前 **1.4.5**。
- **版本漂移要核对**：TS 侧钉的是 `pi-durable@1.3.0`，.NET 侧是 1.4.5（对应上游语义更新的分支）。提交、重放、watch、checkpoint 这几处的行为差异必须逐条确认，不能假定额相同。
- pi.net **没有 AG-UI 实现**。官方 `AGUI.Server` 围绕 `IChatClient` 设计，与本项目的"耐久事件流 → AG-UI"模型对不上，因此这一层手写。
- 单进程 Kestrel，只监听 `127.0.0.1:4000`；SQLite 同一时刻只允许一个进程打开。
- 模型走 magpie 网关（Anthropic Messages 兼容），研究走 DeepSeek Search/Fetch。

## 6. 已定的选择（用户决定）

- 开一个 `net-rewrite` 分支，里面只有 .NET 版本。
- 前端原样保留。
- 按 .NET 最佳实践组织，不做一对一翻译。
- 成功的判定：真实跑一遍 e2e，拿到预期结果；A–H 全部要跑。

## 7. 实现决策（我们的判断，实现者可调整细节）

### 7.1 仓库布局

`apps/server/` 原地替换为 .NET 解决方案，保持路径不变（README、`next.config` 的 `API_URL`、根脚本都指向它）。根 `package.json` 的 workspaces 去掉 `apps/server`，`dev:server` / `start:server` 改成调用 `dotnet` 的薄封装，开发命令对外不变。

### 7.2 项目划分

保持两个项目，够用且简单：

- `apps/server/src/PiTravel.Server/` — 全部产品代码，按领域分目录。
- `apps/server/tests/PiTravel.Server.Tests/` — xUnit 测试。

领域目录：

| 目录 | 职责 |
| --- | --- |
| `Hosting/` | Minimal API 端点、SSE、DI 装配、配置绑定、优雅关闭 |
| `Agent/` | 系统提示词、扩展与工具注册、thinking 等级 |
| `Harness/` | Harness 打开/恢复、会话与文档、事件流、行程索引 |
| `AgUi/` | 耐久事件 → AG-UI 事件映射、首帧快照 |
| `Research/` | DeepSeek 客户端、限流、查询缓存、时效与权威度规则、正文格式化 |
| `Artifacts/` | SVG 生成、校验与清洗、占位图 |
| `Planning/` | brief 完整性校验、日卡校验、预算汇总 |
| `Contracts/` | 与 `packages/shared/src/trip.ts` 对齐的 DTO 与 JSON 形状 |

如果实现中发现某个目录自然膨胀（例如 `Research`），再拆项目，不提前拆。

### 7.3 对外契约（必须逐字保持）

HTTP：

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| GET | `/health` | `{"ok":true}` |
| GET | `/api/trips` | 行程索引列表 |
| POST | `/api/trips` | 校验后创建，201 |
| GET | `/api/trips/:tripId` | `TripSnapshot`，未找到 404 |
| GET | `/api/trips/:tripId/transcript` | AG-UI 消息数组，未找到 404 |
| POST | `/api/trips/:tripId/messages` | 202 `{submissionId}`，空内容 400 |
| POST | `/agui?tripId=…` | SSE，AG-UI 运行流 |

DTO 以 `packages/shared/src/trip.ts` 为准（`TripBrief`、`Claim`、`DayBlock`、`DayCard`、`BudgetSummary`、`TripPlan`、`TripSource`、`TripSources`、`TripResearch`、`TripFault`、`TripState`、`TripSnapshot`、`TranscriptEntry`、`TripIndexEntry`）。JSON 用 camelCase，可空字段缺省时省略而不是写 `null`。

**上表是摘要，不是穷举。** 凡是表格没写到的请求校验与副作用，一律以现有 TS 源码为准，逐条搬运，包括但不限于：`/agui` 要求 `runId` 且最后一条 user 消息非空、`/messages` 要求 `requestId` 且同 `requestId` 重试幂等、创建行程时对日历日期的拒绝规则、创建时 `brief` 只写入种子字段而不要求完整。

环境变量沿用：`DEEPSEEK_API_KEY`（缺失即启动失败）、`DEEPSEEK_BASE_URL`、`DATA_DIR`、`MAGPIE_BASE_URL`、`MAGPIE_MODEL`、`MAGPIE_API_KEY`、`MAGPIE_MAX_TOKENS`、`PI_THINKING_LEVEL`。端口改用 ASP.NET Core 的标准配置（`ASPNETCORE_URLS` / `--urls`），默认仍是 `http://127.0.0.1:4000`。

耐久文档沿用同名：`trip.brief`、`trip.plan`、`trip.sources`、`trip.research`、`trip.search-cache`、`trip.faults`，另加 `LiveDoc` 判定 `running`。行程索引仍是 `DATA_DIR/trips.json`。

### 7.4 关键行为的落点

- **崩溃续跑**：`Harness.OpenAsync` 后立刻 `Resume()`，再接受请求。
- **不重复计费**：工具注册时保留 `Replay = "safe"`。语义与现在一致——attempt 计数**只记录已完成的调用**，与结果在同一个提交里落盘；"意图"由耐久任务图里的工具调用记录承担，不新增文档或字段。重启后只重试未完成的 attempt（at-most-once，在途请求最多重复一次）。`packages/shared` 的 `searchAttempts` / `fetchAttempts` 语义因此不变。
- **事件流**：`WatchAsync()` 的 `CommittedWatch<ConversationView>` 先给快照、再给增量批次，对应现有 `watchEvents()` 的用法；`/agui` 必须先挂上 watcher 再提交，避免漏掉 `run_start`。
- **运行终止信号**是耐久侧的 `run_end`（或映射出 `RUN_ERROR`），不是连接关闭。
- **thinking 等级**：启动时按模型能力 clamp，再在每趟会话首次提交前对齐到会话配置。

### 7.5 AG-UI 层

按 `@ag-ui/core` 的事件形状手写 record。规模与 `apps/server/src/agui/mapper.ts` 相当，但是纯函数，可完整单测。

**规范来源是 `agui/mapper.ts` 及其测试，不是上面这句概述。** 写 C# mapper 时必须逐条对照，尤其不能漏掉前端真正依赖的部分：

- `CUSTOM` 事件 `travel.tool_progress`（工具实时输出）与 `travel.task_failed`（故障横幅）；
- 工具结果与 transcript 消息上的 `travel.tool` 元数据；
- `STATE_SNAPSHOT` 的载荷形状（`TripState`：brief / plan / sources / research.running）；
- 提交后尚未落盘的合成 user 条目（`pending-user-<runId>`）；
- `/agui` 里的故障副作用：`run_start` 清空 faults、`task_failed` 记录 faults。

`STATE_DELTA` **不实现**——现有 TS mapper 只发 `STATE_SNAPSHOT`，照旧。

额外要求：形状测试的期望夹具从 TS mapper 的测试推导，而不是从这份文档的列表推导。把每条事件序列化成 JSON 后与夹具比对，防止前端以隐蔽方式坏掉。

### 7.6 配置与日志

`IOptions<T>` 绑定环境变量，启动时校验（缺 `DEEPSEEK_API_KEY` 直接失败，与现在一致）。日志用 `ILogger`，不引入额外框架。

### 7.7 验收工具

e2e 必须**真的把前端跑起来、用浏览器点一遍**，所以验收程序要能同时驱动三样东西：.NET 服务、Next.js、浏览器。

做一个 C# 控制台项目 `tools/PiTravel.Acceptance`，用 `Microsoft.Playwright` 驱动浏览器，全部自动化在 .NET 一侧完成：

- 自己起 .NET 服务与 Next.js（固定端口与独立 `DATA_DIR`），结束时清理。
- 用 Playwright 走真实界面：新建行程、发消息、等卡片出现、刷新页面看是否恢复、展开工具调用与思考块。
- 同时用 HTTP 读 `/api/trips/:id` 的快照做结构化断言，避免只靠像素判断。
- 崩溃场景由它自己 `SIGKILL` 服务进程再重启，校验续跑，不依赖 bash。
- 关键节点截图存档，作为人工复核的证据。

根 `npm run acceptance:*` 改成薄封装调用它，命令名不变。原有的 `scripts/acceptance-live.ts`（API 层冒烟）、`scripts/crash-resume.sh`、`scripts/probe-thinking.ts` 在手工调试时仍然有用，保留不动。

**E 的注入开关**：SVG 失败场景需要确定性地注入非法 SVG。在被测服务里加一个**默认关闭、仅由环境变量启用的测试开关**（例如 `PITRAVEL_TEST_SVG_MODE=invalid`），正常运行时完全惰性。这是验收的需要，不是产品功能。

**H 的判定**：内容覆盖是定性的（虹桥往返、住宿区域、徒步/索道、日出、美食、预算分项），不做关键词断言。验收程序输出可复核的证据（完整对话、三张卡片的 JSON、截图），由人对照清单打分。

### 7.8 CI

GitHub Actions 增加 `dotnet` 步骤（setup-dotnet 10、restore、build、test）；Web 侧的 `typecheck` / `test` / `build` 保持不变。

## 8. 验证

成功 = 真实环境跑通 A–H 且结果符合预期。全部场景都在**真实环境**里跑：真模型（magpie）、真 DeepSeek、真 Next.js、真浏览器。每一条都经由浏览器界面操作，配合快照做结构化断言。

| 场景 | 怎么跑 | 判据 |
| --- | --- | --- |
| A 完整 brief | 界面新建行程，发完整需求 | 3 张日卡出现，含 SVG、来源、费用分项；上限之和 ≤ 3000 |
| B 不完整 brief | 界面发缺字段的需求 | 先提问；补齐前没有任何 `plan_emit_day` 写入 |
| C 崩溃恢复 | 研究中途 `SIGKILL` 服务并重启，刷新界面 | 会话继续；已完成搜索/抓取不重复；在途最多重复一次 |
| D 刷新恢复 | 运行中刷新浏览器 / 断线重连 | 聊天与卡片从快照重建，内容不丢 |
| E SVG 失败 | 用测试开关注入非法 SVG | 重试一次后落占位图，卡片与界面仍可用 |
| F 局部修改 | 界面继续发"第三天轻松一点" | 只有 Day 3 的卡片变化 |
| G 引用 | 读 A 跑出来的三张卡 | 每条硬事实有来源 id；无来源的逐条标未核实 |
| H 内容 | 读 A 跑出来的方案全文 | 虹桥往返、住宿区域、徒步/索道、日出、美食、预算分项齐全（人工对照证据打分） |

这套 e2e 需要真实密钥、真实模型调用和浏览器，**不进 CI**：CI 只跑单元/集成测试、类型检查和构建。e2e 作为本地发布前门禁，由 `npm run acceptance:e2e` 手动触发。

单元/集成测试不依赖网络：模型用 pi.net 的 `Faux` provider，DeepSeek 用假实现，覆盖与现有 TS 测试同等的**行为清单**（不是逐条翻译）。

## 9. 风险

| 风险 | 处理 |
| --- | --- |
| pi.net 1.4.5 与 TS 1.3.0 语义漂移 | 实现前读 CHANGELOG 并逐条核对提交/重放/watch |
| pi.net "完全由 AI 驱动"，成熟度未知 | 先用 Faux provider 跑通主循环，再上真模型；发现问题记录上报 |
| 真模型 e2e 不稳定 | 验收脚本可重复、可重试；失败信息带完整事件流 |
| AG-UI 手写偏离前端预期 | 形状测试 + 前端零改动的实际验证 |
| 移植后 agent 行为漂移（提示词/工具描述微调导致结果不同） | 提示词与工具描述原样搬运，不"顺手优化" |

## 10. 留给实现者的决定

- 每个工具的参数 schema 与描述（以现有 `apps/server/src/agent/tools/*.ts` 为准，逐字搬运）。
- SVG 提示词与校验细节。
- DTO 的可空与序列化选项的具体写法。
- xUnit 的测试组织与夹具。
- 验收程序的进程管理细节。

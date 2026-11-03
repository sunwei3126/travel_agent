# Claude Agent SDK 探针记录

日期：2026-11-02　环境：Windows 10.0.26300 x64 / Node v22.22.1　网关：`http://127.0.0.1:3425`，实际使用 `MAGPIE_MODEL=workbuddy-ai/glm-5.3-flash`（默认的 `deepseek/deepseek-flash` 当前返回 402，见下方"网关现状"）

| # | 检查项 | 结果 | 证据（命令输出节选） |
| --- | --- | --- | --- |
| 1 | CLI 经网关可用 | 通过 | `{"subtype":"success","isError":false,"text":"done"}`；无 400/模型名/请求头错误 |
| 2 | 思考块与工具参数流式 | 通过 | `glm-5.3-flash`：`seen = {"thinkingDelta":8,"inputJsonDelta":29,"textDelta":1,"toolResult":1}`；`deepseek-v4.1-flash-sg` 无思考块（`thinkingDelta:0`，2048/8192 均如此） |
| 3 | zod 工具（可选数组、枚举、定长数组） | 通过 | `calls = [{"text":"hi","tags":["a","b"],"level":"low","pair":[1,2]}]`（恰好一项） |
| 4 | 工具中途被杀后 resume | 通过 | `killed the process tree mid-tool; session 993594d8-…` → `{"phase2Subtype":"success","text":"Done.","fastCalled":true}` |
| 5a | 运行时 + runner + 适配器 + Fastify | 失败 | `/info` 通过（列出 `travel`）；`run` 报 `Agent execution failed: TypeError: Cannot read properties of undefined (reading 'has')` at `@ag-ui/claude-agent-sdk/src/adapter.ts:169` |
| 5b | 断开 SSE 不终止 run | 通过（需 5a 的 clone 覆写补丁） | curl 5s 断开后服务端继续跑到 `MESSAGES_SNAPSHOT`，`agent_runs` 里 `r1` 有 69537 字节事件 |
| 5c | 并发 run 被拒绝 | 通过（需补丁；拒绝只体现在服务端日志） | 服务端：`Error running agent: Error: Thread already running` at `@copilotkit/sqlite-runner/src/sqlite-runner.ts:229`；客户端收到 `HTTP 200` + 空 body |
| 5d | 残留 is_running 锁死线程，清除后恢复 | 通过（需补丁） | 杀进程后 `run_state = {is_running:1,current_run_id:'r8'}`；重启后 `r9` 被拒（`Thread already running`）；`update run_state set is_running=0 where is_running=1` → `{changes:1}`；`r10` 正常跑完，`is_running` 回到 0 |
| 6 | better-sqlite3 预编译包 | 通过 | `better-sqlite3 ok { v: '3.53.2' }` |

## 最终可用的 Claude Code 环境变量集

`apps/server/probe/01-sdk-gateway.mts` 里这一组变量即为通过所需，未额外添加任何变量：

```
ANTHROPIC_BASE_URL=http://127.0.0.1:3425
ANTHROPIC_API_KEY=magpie
ANTHROPIC_MODEL=<model>
ANTHROPIC_DEFAULT_OPUS_MODEL=<model>
ANTHROPIC_DEFAULT_SONNET_MODEL=<model>
ANTHROPIC_DEFAULT_HAIKU_MODEL=<model>
CLAUDE_CONFIG_DIR=<data>/claude
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
```

（另需 `model` 选项本身传同一个模型名；`CLAUDE_CONFIG_DIR` 与 `cwd` 指向的 workspace 必须已存在。）

## 网关现状（2026-11-02 实测）

- `deepseek/deepseek-flash`（计划默认值）→ `402 {"error":{"message":"DeepSeek: Insufficient Balance (request_id: …)"}}`
- `deepseek/deepseek-v4-pro` → 同样 402
- `workbuddy-ai/deepseek-v4.1-flash-sg` → 可用，但**不产生思考块**
- `workbuddy-ai/glm-5.3-flash` → 可用，产生思考块（本记录全部 5a–5d 用它跑）

## connect 请求的确切 body

`{"threadId":"probe-thread"}` 会被拒：`{"error":"Invalid request body","details":"[…\"path\":[\"runId\"]…\"path\":[\"messages\"]…]"}`。
可用的命令（`runId` 与 `messages` 必填，`messages` 可为空数组，回放的是该 thread 的 `r1`）：

```bash
curl -N -X POST http://127.0.0.1:4300/api/copilotkit/agent/travel/connect \
  -H "content-type: application/json" \
  -d '{"threadId":"probe-thread","runId":"r1","messages":[]}'
```

## 5a 阻塞项：`ClaudeAgentAdapter@0.0.8` 的 `clone()` 丢字段

`@copilotkit/runtime@1.79.1` 的 `cloneAgentForRequest()` 对每个请求执行 `agents[agentId].clone()`；
`@ag-ui/client`（1.0.2 / 1.0.3 均同）的 `AbstractAgent.clone()` 是
`Object.create(Object.getPrototypeOf(this))` 再逐字段拷贝，**不会执行构造函数**，
因此 `ClaudeAgentAdapter` 的私有类字段 `bindings / admitted / activeQueries / sessions` 在克隆体上是 `undefined`，
`run()` 第一句 `this.admitted.has(threadId)` 即抛错。

已用下列覆写验证 5a–5d 全部可达成（仅诊断用，未提交）：

```ts
class PatchedAdapter extends ClaudeAgentAdapter {
  override clone(): this {
    const cloned = super.clone();
    Object.assign(cloned as object, {
      bindings: new Map(),
      admitted: new Set(),
      activeQueries: new Map(),
      sessions: new Map(),
    });
    return cloned;
  }
}
```

## 前端历史恢复（Task 10 第 1 步填写）

historyRestore: auto

`TravelChat` 指向 `/backend/api/copilotkit`（`agent="travel"`、`threadId=tripId`、`useSingleEndpoint={false}`）后，CopilotKit 自己就会重放历史：

- 挂载即 `GET /backend/api/copilotkit/info` → `POST /backend/api/copilotkit/agent/travel/connect`。
- 刷新后的资源列表（`performance.getEntriesByType("resource")` 过滤 `/api/copilotkit`）：
  `["http://localhost:3000/backend/api/copilotkit/info", "http://localhost:3000/backend/api/copilotkit/agent/travel/connect"]`
- 刷新后聊天里直接出现上一轮的用户消息、思考块与助手回复；同一时刻旧的 `GET /backend/api/trips/:id/transcript` 返回 404，`ChatPanel` 的历史 effect 无法贡献任何消息，因此恢复完全来自 `connect`。
- 因此 Step 3 走分支 A：删掉 `ChatPanel` 里的历史 effect 与 `lib/api.ts` 的 `getTranscript`，不加显式 `connectAgent`。

### Next 重写曾缓冲 SSE（已用 `compress: false` 修复）

浏览器里回复不是逐步出现，而是整轮结束后一次性出现。实测：

- 浏览器 fetch 包裹 `/backend/api/copilotkit/agent/travel/run`：`content-encoding: gzip`，整个响应只有 **1 个 chunk（37952 字节）**，在 `t=10390ms` 一次到达，`end=10429ms`。
- 同一个请求用 node 走 `http://localhost:3000/backend/...`（默认 `accept-encoding`）：`chunks 4`，全部落在 `t=22409ms`，即响应结束时刻。
- 同一个请求带 `accept-encoding: identity` 走 Next 重写：`chunks 303`，第一个 chunk 在 `t=128ms`，之后持续到达。
- 直连后端 `http://127.0.0.1:4000/api/copilotkit/agent/travel/run`：`chunks 382`，第一个 chunk 在 `t=104ms`。

即：后端是流式的，Next 的响应压缩（`compress` 默认开启）把 SSE 攒满才吐。浏览器永远带 gzip，所以走重写就看不到增量。

**修复与复测**：`apps/web/next.config.ts` 设 `compress: false` 后：

- node 走 `http://localhost:3000/backend/api/copilotkit/agent/travel/run`（默认 `accept-encoding`）：`content-encoding: null`，**203 个 chunk**（首包 496 字节，之后每 15s 一个 14 字节 keep-alive，正文 2522 字节起持续到达），不再攒包。
- 浏览器实测（`trip 8f3693f2`，完整 brief，运行中刷新过页面）：思考块字数按秒增长 `313 → 566 → 774`，随后逐条出现 `工具调用 · mcp__travel__trip_update_brief · 运行中 → 已完成`、`deepseek_search`、`plan_emit_day`，日卡逐天出现——确认增量流式。
- 运行中刷新：聊天恢复（用户消息 + `助手正在思考…` + `停止` 按钮），运行继续，最终右侧出现 3 张日卡（含「风景 / 美食 / 交通」小节、`预估 ¥600–¥750` 与来源链接），行程信息面板显示「信息已齐全。」。
- 同一 thread 的第二条消息（后端 `9e05684` 之后）：UI 发「确认，请只回一句话：收到。」→ 回复「收到。」，无 `工具任务已暂停`、无 `Original SDK session is unavailable`。

## 验收记录（Task 11）

### 已执行：无凭据冒烟（2026-11-03）

本机没有 `DEEPSEEK_API_KEY`，`acceptance:live` 与 `acceptance:crash` **未执行**（见下节）。改用一条只要求澄清、不会触发任何 DeepSeek 工具调用的 brief 做无凭据端到端冒烟：

```
DATA_DIR=./data/smoke11 PORT=4202 MAGPIE_MODEL=workbuddy-ai/glm-5.3-flash DEEPSEEK_API_KEY=smoke npm run start:server
```

- 建行程：`POST /api/trips` → `{"tripId":"2b447a29-081d-456a-ad20-a8d1ffd0b66a",…,"days":3}`；`GET /health` → `{"ok":true}`。
- 第 1 轮 `POST /api/copilotkit/agent/travel/run`（`threadId`=tripId，body 含 `state/tools/context/forwardedProps/messages`），用户消息「泰山玩三天」：SSE 里 `RUN_STARTED` ×1、`TEXT_MESSAGE_START/CONTENT/END` 各 ×1（`TEXT_MESSAGE_CONTENT` 191 条）、`RUN_FINISHED` ×1、`RUN_ERROR` 0 条。回复只提问：先复述「目的地=泰山、出发日期=2026-12-01、行程3天」，再问出发地/预算、同行与体力、兴趣偏好。随后 `GET /api/trips/:id` → `running:false`、`plan.days.length:0`、`research.searchCount:0`（补齐 brief 前没有 `plan_emit_day` 写入，与场景 B 的预期一致）。
- 第 2 轮同一 `threadId` 再发一条（「预算3000，从上海虹桥出发，一个人，体力一般，在意风景和美食。先别查资料，只说一句你记住的条件。」）：`RUN_STARTED`/`RUN_FINISHED` 各 ×1、`TEXT_MESSAGE_CONTENT` 43 条、无 `RUN_ERROR`；服务端日志出现 `[ClaudeAdapter] Applied forwarded_prop: resume = 9bae0f68-…`，回复「已记住：上海虹桥出发、1人、预算3000元、体力一般、重风景和美食，2026-12-01起泰山3天。」——同线程续跑成功，未出现 `Thread already running`。
- `connect` 回放：`POST /api/copilotkit/agent/travel/connect` body `{"threadId":"…","runId":"<uuid>","messages":[]}` → SSE 中两轮用户消息各出现（`泰山玩三天` ×2、`预算3000` ×4），`RUN_FINISHED` ×2。
- 结束后停服务并删除 `apps/server/data/smoke11`。

### 未执行

| 项目 | 原因 |
| --- | --- |
| `npm run acceptance:live`（场景 A、G） | 本机没有 `DEEPSEEK_API_KEY`，研究工具无法调用 |
| `npm run acceptance:crash`（场景 C） | 同上；脚本会跑真实研究并在中途杀进程 |
| 场景 E（SVG 失败卡片）、F（局部修改）、H（内容核对） | 均依赖一次真实研究 + 出图，缺 key |
| 场景 B 的界面部分（刷新恢复由 Task 10 的浏览器实测覆盖） | 本轮只做了 API 层验证 |


## 2026-11-03 真实验收（拿到 DEEPSEEK_API_KEY 之后）

模型用 `MAGPIE_MODEL=workbuddy-ai/glm-5.3-flash`（网关默认模型 402）。

### 场景 A / G：`acceptance:live` 的实质断言

一轮完整行程（trip `2cbe4020…`）在真实研究下跑完，逐项核对：

| 断言 | 结果 |
| --- | --- |
| 恰好 3 张日卡 | 3 |
| 每张卡 SVG 非 pending | `ok, ok, ok` |
| 每条 fact 有来源或标注未核实 | 22 条 fact，0 条无来源 |
| 至少一条 fact 由已抓取页面支撑 | 21 条 |
| 抓取页数 | 13（来源 32 条） |
| 预算 `withinBudget` 且 `high ≤ 3000` | `high 3000 / cap 3000 / withinBudget true` |
| 内容覆盖（虹桥往返、住宿区域、徒步+索道、日出、美食、预算分项） | 覆盖（`上海→泰安…` / `登顶泰山…` / `山顶日出…`） |

**唯一未过的是时间**：整轮实测约 35 分钟，脚本原来的 15 分钟上限不够。已按实测把 `acceptance:live` 的窗口改为 45 分钟，`acceptance:crash` 的"等研究开始"窗口改为 30 分钟、"等完成"窗口改为 45 分钟，README 同步。

### 场景 C：崩溃恢复

第一次真实杀进程验收暴露了**两个产品缺陷**，都已修复并各自有回归测试：

1. `AbstractAgent.runAgent` 会把 `input.threadId` 换成 `this.threadId`（未设置时是随机 UUID）。HTTP 路径由 CopilotKit 设置，恢复路径没有，于是恢复的 run 去查一个不存在的行程：`Trip not found: <random>`。修法：在恢复用的克隆上设置 `threadId = tripId`。
2. 同一个 `runAgent` 也会用 agent 自身的 `messages` 覆盖 `input.messages`，恢复的重放消息因此丢失：`The run input has no user message`。修法：在克隆上同时设置 `messages`。

修复后的实测证据（`data/diag`，杀进程后重启）：

```
Cleared 1 stale run flag(s) left by an unclean shutdown
[ClaudeAdapter] Applied forwarded_prop: resume = ede2a528-…
[ClaudeAdapter] Processing 2 messages for threadId=850c073a-…
[ClaudeAdapter] Captured session_id=ede2a528-… for thread=850c073a-…
```

以及 `connect` 回放同时包含原始 brief 与"服务已重启，请继续未完成的任务。"

**仍未完整观察到的**：恢复后的 run 跑完剩余两天（模型速度原因，未在本次时间预算内完成）。`acceptance:crash` 的端到端脚本因此只验证到"重启后正确续跑并写入历史"，尚未验证"续跑跑完 3 天且不重复计费"。

### 仍未执行

- 场景 E 的界面部分（SVG 失败卡片占位与重画按钮）——单元测试覆盖了生成与占位逻辑，界面未人工确认。
- 场景 F（局部修改只动 Day 3）——未单独跑一次真实修改。

## 2026-11-03 浏览器端到端（ego-browser，生产构建 + next start）

真实 UI 操作，模型 `workbuddy-ai/glm-5.3-flash`，数据目录 `apps/server/data/e2e`。

| 步骤 | 结果 |
| --- | --- |
| 新建行程（表单） | 通过；日期需用原生 setter 触发 input 事件（`fill()` 对 date 输入无效，属自动化工具差异，非产品缺陷） |
| 发送 brief | 通过；思考块、工具调用（参数/结果/状态）实时流式出现 |
| 刷新（run 进行中） | 通过；历史恢复、run 继续、按钮保持"停止" |
| brief 补全 | 通过；`trip_update_brief` 返回 `Brief is complete.`，左侧「信息已齐全」 |
| 研究 | 通过；6 次搜索 / 13 次抓取，计数实时增长 |
| 日卡 + SVG + 预算 | 通过；3 张卡片、3 张 SVG `ok`、预算 2630/3000 `withinBudget` |
| 校验回环 | 通过；`plan_emit_day` 因引用未抓取来源被拒，模型自行补抓后重写（界面可见说明） |
| 局部修改（场景 F） | 通过；Day 1/2 `updatedAt` 不变，只有 Day 3 从 `05:22:52` 变为 `05:53:18`，SVG 重新生成，预算重算 2630→2580 |

### 本轮发现的两个 UX 缺陷（未修）

1. **日志噪声**：每次 run 产生上千行 `[ag-ui][enforce] Removed unrecognised material at '/threadId'`（适配器在事件里带 `threadId`/`runId`，`@ag-ui/client` 的兼容层逐条告警）。真正的错误会被淹没。可用 `SUPPRESS_TRANSFORMATION_WARNINGS` 抑制，或在事件进入 runner 前剥掉这两个字段。
2. **失败工具的结果在界面上显示为 `{"error":true}`**：模型能看到真实的错误文本（它据此补抓并重写），但用户看不到原因。`toolResultText` 处理的是 `{type:"text",text}` 数组，说明适配器把 `isError` 结果转成了别的形状。

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

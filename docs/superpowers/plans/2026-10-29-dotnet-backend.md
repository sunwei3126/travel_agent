# .NET 10 旅行 Agent 后端 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 .NET 10 + pi.net 重写 `apps/server`，对外契约、耐久行为和前端表现与现有 TypeScript 后端完全一致。

**Architecture:** 单个 ASP.NET Core 项目按领域分目录（Contracts / Planning / Research / Artifacts / Harness / Agent / AgUi / Hosting），用 pi.net 的 `Pi.Durable` 承载会话、文档和事件流，手写一层 AG-UI 映射把耐久事件转成 CopilotKit 认识的事件。前端 Next.js 不动。

**Tech Stack:** .NET 10 (`net10.0`)、ASP.NET Core Minimal API、Pi.Ai / Pi.Agent / Pi.Durable 1.4.5、System.Text.Json、xUnit、Microsoft.Playwright（验收程序）。

**Spec:** `docs/superpowers/specs/2026-10-29-dotnet-backend-design.md`

## Global Constraints

- 目标框架 `net10.0`，不要多目标。
- pi.net 包版本统一 `1.4.5`（`Pi.Ai`、`Pi.Agent`、`Pi.Durable`）。
- 后端只监听 `127.0.0.1:4000`。
- 环境变量名沿用：`DEEPSEEK_API_KEY`（缺失即启动失败）、`DEEPSEEK_BASE_URL`、`DATA_DIR`、`MAGPIE_BASE_URL`、`MAGPIE_MODEL`、`MAGPIE_API_KEY`、`MAGPIE_MAX_TOKENS`、`PI_THINKING_LEVEL`。
- JSON 一律 camelCase，可空字段缺省时**省略**而不是写 `null`。
- 提示词、工具描述、工具参数 schema 从 `apps/server/src/agent/` 原文搬运，不做措辞优化。
- 现有 TypeScript 源码是行为规范：`docs/superpowers/specs/2026-10-29-dotnet-backend-design.md` §7.3 明确"表格是摘要不是穷举"。
- 每个任务结束都要 `dotnet test` 全绿再提交。

## Review Focus

按最可能伤到用户的顺序，每一条都要有对应测试落在拥有该代码的任务里：

1. **SSE 客户端中途断开**：`/agui` 的 handler 必须返回，耐久运行不能被杀掉，重新连接能拿到快照（Task 9）。
2. **同一 `requestId` 重试提交**：只能产生一次运行，不能重复调用模型（Task 6、Task 9）。
3. **进程在工具调用执行到一半时被杀**：重启后从 checkpoint 续跑，已完成的搜索/抓取不重发（Task 6、Task 10）。
4. **模型返回敌意 SVG**：`<script>`、`on*`、外部 `href`、超尺寸 viewBox 都不能进到前端（Task 5）。
5. **DeepSeek 返回 429 或 5xx**：按 `Retry-After` 退避重试，最终失败要抛出带状态码的错误而不是静默返回空结果（Task 4）。

---

### Task 1: 脚手架 + 验证 pi.net 能力面

先把"pi.net 到底能不能承接"这件事在真代码里证死，后面所有任务都建在这上面。

**Files:**
- Create: `apps/server/PiTravel.sln`
- Create: `apps/server/src/PiTravel.Server/PiTravel.Server.csproj`
- Create: `apps/server/tests/PiTravel.Server.Tests/PiTravel.Server.Tests.csproj`
- Test: `apps/server/tests/PiTravel.Server.Tests/HarnessSpikeTests.cs`
- Create: `docs/superpowers/notes/pi-net-api.md`

**Interfaces:**
- Produces: 一个能 `dotnet test` 的解决方案；`docs/superpowers/notes/pi-net-api.md` 记录后续任务要用到的确切签名。

- [ ] **Step 1: 建解决方案与两个项目**

```bash
cd apps/server
dotnet new sln -n PiTravel
dotnet new classlib -n PiTravel.Server -o src/PiTravel.Server -f net10.0
dotnet new xunit -n PiTravel.Server.Tests -o tests/PiTravel.Server.Tests -f net10.0
dotnet sln add src/PiTravel.Server tests/PiTravel.Server.Tests
dotnet add tests/PiTravel.Server.Tests reference src/PiTravel.Server
dotnet add src/PiTravel.Server package Pi.Ai --version 1.4.5
dotnet add src/PiTravel.Server package Pi.Agent --version 1.4.5
dotnet add src/PiTravel.Server package Pi.Durable --version 1.4.5
dotnet build
```

Expected: `Build succeeded`。删掉模板生成的 `Class1.cs` 与 `UnitTest1.cs`。

- [ ] **Step 2: 写 spike 测试**

`apps/server/tests/PiTravel.Server.Tests/HarnessSpikeTests.cs`，一个测试名字 `WritesADocSubmitsAInputStreamsRunEndAndSurvivesReopen`，断言顺序：
1. 用内存存储打开 harness；
2. `DefineDoc` 定义一个 `kind: "spike.note"`、`scope: conversation`、`history: latest`、`fork: initial`、初值 `{ "text": "" }` 的文档；
3. 创建会话，在 `Commit` 里把文档 `text` 写成 `"hello"`；
4. 挂 `Watch`，`Submit` 一条 input，直到收到 `run_end`；
5. 读文档快照，`text == "hello"`；
6. 关闭 harness，用同一存储重新打开并 `Resume()`，文档仍是 `"hello"`。

模型用 pi.net 的 `Faux` provider 脚本化回复，不联网。

- [ ] **Step 3: 跑到绿，把踩到的签名写进笔记**

Run: `dotnet test --filter FullyQualifiedName~HarnessSpikeTests -v n`

Expected: 1 passed。把实际可用的签名写进 `docs/superpowers/notes/pi-net-api.md`，至少覆盖：
`Harness.OpenAsync` 的参数形状、`DefineDoc<T>`、`ITx` 上取文档的方法（返回可变对象还是 `TxDoc`）、文档提交后读取快照的方法、`SubmitAsync` 的输入类型、`WatchAsync` 返回值的用法（快照/批次/停止）、`Resume()`、存储后端构造（内存与 SQLite）、扩展与工具的注册入口、`AgentChange`（model / instructions / thinkingLevel）、prompt section 注册。

- [ ] **Step 4: 核对 1.3.0 → 1.4.5 的 durable 语义差异**

读 Pi.Durable 的发布记录与 `src/Pi.Durable/Harness/` 下 `Submissions.cs`、`ToolTask.cs`、`ConversationView.cs`，把与提交、重放（`replay: "safe"`）、watch、checkpoint 有关的变化逐条记进同一份笔记，标出影响本项目的条目。没有影响就写"无"。

- [ ] **Step 5: Commit**

```bash
git add apps/server docs/superpowers/notes/pi-net-api.md
git commit -m "chore: scaffold the .NET solution and verify pi.net primitives"
```

---

### Task 2: 对外契约 DTO

**Files:**
- Create: `apps/server/src/PiTravel.Server/Contracts/TripModels.cs`
- Create: `apps/server/src/PiTravel.Server/Contracts/TripJson.cs`
- Test: `apps/server/tests/PiTravel.Server.Tests/Contracts/TripJsonTests.cs`

**Interfaces:**
- Produces: `record TripBrief`, `record Claim`, `record DayBlock`, `record DayCard`, `record BudgetSummary`, `record TripPlan`, `record TripSource`, `record TripFault`, `record TripResearch`, `record TripIndexEntry`, `record TripSnapshot`, `record TripState`, `record TranscriptEntry`, `record TranscriptToolCall`；`static class TripJson { static JsonSerializerOptions Options }`。字段名与 `packages/shared/src/trip.ts` 一一对应，数值区间用 `[low, high]` 数组承载。

- [ ] **Step 1: 写形状测试**

`TripJsonTests.SnapshotSerializesToTheSharedShape`：构造一个含 1 天、1 个 block、1 条 fact claim 的 `TripSnapshot`，`JsonSerializer.Serialize(snapshot, TripJson.Options)` 后与下面等价的结构比对（按键取值断言，不做字符串全等）：

```json
{
  "trip": {"tripId":"t1","conversationId":"t1","title":"泰山","destination":"泰安","startDate":"2026-10-26","days":3,"updatedAt":"2026-10-20T00:00:00.000Z","status":"active"},
  "brief": {"destination":"泰安"},
  "plan": {"days":[{"dayIndex":1,"date":"2026-10-26","title":"红门—中天门","blocks":[{"time":"08:00","title":"红门","detail":"开始登山","claims":[{"text":"门票115元","kind":"fact","sourceIds":["s1"]}]}],"scenery":[],"food":[],"transport":[],"estimatedCostCny":[100,200],"sources":["s1"],"svgStatus":"pending","updatedAt":"2026-10-20T00:00:00.000Z"}]},
  "sources": {},
  "research": {"searchCount":0,"fetchCount":0},
  "running": false
}
```

另外两条断言：`DayCard.EstimatedCostCny` 序列化成两元素数组；`TripPlan.Budget` 为 null 时输出里**没有** `budget` 键。

- [ ] **Step 2: 跑到失败**

Run: `dotnet test --filter FullyQualifiedName~TripJsonTests`
Expected: 编译失败，类型不存在。

- [ ] **Step 3: 实现 DTO 与 `TripJson.Options`**

`Options` 用 `JsonNamingPolicy.CamelCase` + `DefaultIgnoreCondition = WhenWritingNull`；所有可空引用类型按 `trip.ts` 的 `Optional` 标 `required` / 可空。

- [ ] **Step 4: 跑到通过**

Run: `dotnet test --filter FullyQualifiedName~TripJsonTests`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/PiTravel.Server/Contracts apps/server/tests/PiTravel.Server.Tests/Contracts
git commit -m "feat: add the shared trip contract DTOs"
```

---

### Task 3: 规划领域规则

**Files:**
- Create: `apps/server/src/PiTravel.Server/Planning/BriefRules.cs`
- Create: `apps/server/src/PiTravel.Server/Planning/BriefValidator.cs`
- Create: `apps/server/src/PiTravel.Server/Planning/DayCardValidator.cs`
- Create: `apps/server/src/PiTravel.Server/Planning/Budget.cs`
- Test: `apps/server/tests/PiTravel.Server.Tests/Planning/BriefRulesTests.cs`
- Test: `apps/server/tests/PiTravel.Server.Tests/Planning/DayCardValidatorTests.cs`
- Test: `apps/server/tests/PiTravel.Server.Tests/Planning/BudgetTests.cs`

**Interfaces:**
- Produces:
  - `static IReadOnlyList<string> BriefRules.MissingFields(TripBrief brief)`
  - `static bool BriefRules.IsComplete(TripBrief brief)`
  - `static IReadOnlyList<string> BriefValidator.Validate(TripBrief brief, DateTimeOffset now, bool requireComplete = true)`
  - `static bool BriefValidator.IsValidCalendarDate(string value)`
  - `static IReadOnlyList<string> DayCardValidator.Validate(DayCard card, IReadOnlyDictionary<string, TripSource> sources, TripBrief brief)`
  - `static BudgetSummary Budget.Finalize(TripPlan plan, double cap)`
- Consumes: Task 2 的 DTO。`DayCardValidator` 判定"来源已核实"时**内联**写 `source.FetchedAt is not null`；Task 4 会把它换成 `Freshness.IsVerifiedFact(source)`，行为不变。

- [ ] **Step 1: 写 BriefRules 测试**

`BriefRulesTests` 至少覆盖：
- `MissingFieldsOfEmptyBriefListsAllEight` → `["destination","origin","startDate","days","budgetCny","companions","fitness","interests"]`；
- `CompleteBriefHasNoMissingFields`；
- `StartDateMustMatchIsoPattern`（`"2026/10/26"` 视为缺失）；
- `InterestsMustBeNonEmpty`。

`BriefValidatorTests` 至少覆盖：
- `RejectsImpossibleCalendarDate`（`"2026-02-30"` → 一条 `startDate must be a real calendar date (YYYY-MM-DD)`）；
- `RejectsPastStartDate`（用固定 `now`）；
- `RejectsZeroOrFractionalDays`；
- `RequireCompleteFalseOnlyChecksDateAndDays`。

- [ ] **Step 2: 跑到失败**

Run: `dotnet test --filter FullyQualifiedName~Planning.Brief`
Expected: 编译失败。

- [ ] **Step 3: 实现 BriefRules 与 BriefValidator**

日期比较按 `yyyy-MM-dd` 字符串比较（与 TS 一致），不做时区换算。

- [ ] **Step 4: 跑到通过**

Run: `dotnet test --filter FullyQualifiedName~Planning.Brief`
Expected: PASS。

- [ ] **Step 5: 写 DayCardValidator 与 Budget 测试**

`DayCardValidatorTests` 至少覆盖：
- `RejectsIncompleteBrief`；
- `RejectsFactClaimWithoutSources`（`kind:fact`、`unverified:false`、`sourceIds` 空）；
- `RejectsUnknownSourceId`；
- `RejectsUnfetchedSourceAsFact`（source 无 `fetchedAt`）；
- `AllowsUnverifiedFactWithoutSources`；
- `RejectsCostRangeWhereLowExceedsHigh`；
- `IgnoresOpinionClaims`。

`BudgetTests.FinalizeSumsRangesAndComparesHighAgainstCap`：两天的 `[100,200]` 与 `[50,80]` → `{low:150, high:280, cap:300, withinBudget:true}`；cap 调到 200 时 `withinBudget:false`。

- [ ] **Step 6: 跑到失败，实现，跑到通过**

Run: `dotnet test --filter FullyQualifiedName~Planning`
Expected: 先 FAIL，实现后 PASS。

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/PiTravel.Server/Planning apps/server/tests/PiTravel.Server.Tests/Planning
git commit -m "feat: port trip brief and day card validation rules"
```

---

### Task 4: 研究领域（DeepSeek、来源、时效、格式化）

**Files:**
- Create: `apps/server/src/PiTravel.Server/Research/RateLimiter.cs`
- Create: `apps/server/src/PiTravel.Server/Research/DeepSeekClient.cs`
- Create: `apps/server/src/PiTravel.Server/Research/Sources.cs`
- Create: `apps/server/src/PiTravel.Server/Research/Freshness.cs`
- Create: `apps/server/src/PiTravel.Server/Research/Formatting.cs`
- Test: `apps/server/tests/PiTravel.Server.Tests/Research/*.cs`

**Interfaces:**
- Produces:
  - `sealed class RateLimiter { RateLimiter(int qps, Func<long> nowMs, Func<int, Task> delay); Task AcquireAsync(); }`
  - `sealed class DeepSeekClient { Task<IReadOnlyList<SearchHit>> SearchAsync(string query, SearchOptions? options, CancellationToken ct); Task<FetchResult> FetchAsync(string url, CancellationToken ct); }`
  - `record SearchHit(string Title, string Url, string Snippet, string? Summary, string? Content, string? Date, double? Authority, double? RerankScore, string? SiteName)`
  - `record FetchResult(string Title, string Url, string Content)`
  - `record SearchOptions(double? Count, string? OriQuestion, string? Localization, bool? NeedContent)`
  - `sealed class DeepSeekException : Exception { int Status { get; } }`
  - `static string SourceIds.ForUrl(string url)`、`static string Sources.NormalizeUrl(string value)`、`static TripSource? Sources.FindByUrl(IReadOnlyDictionary<string,TripSource> sources, string url)`
  - `static IReadOnlyList<string> Sources.AddSearch(IDictionary<string,TripSource> sources, string query, IReadOnlyList<SearchHit> hits)`
  - `static string Sources.AddFetch(IDictionary<string,TripSource> sources, FetchResult result, DateTimeOffset now)`
  - `static bool Freshness.IsVerifiedFact(TripSource source)`（本任务把 Task 3 里那一份收编到这里，签名不变）
  - `static string Freshness.Of(TripSource source, DateTimeOffset now)` → `"fresh" | "stale" | "unknown"`
  - `static IReadOnlyList<TripSource> Freshness.Rank(IEnumerable<TripSource> sources, DateTimeOffset now)`
  - `static class Formatting { static string SearchResults(...); static string FetchResult(...); }`，常量 `MaxSnippetChars=300`、`MaxContentChars=4000`、`MaxVerifiedExcerptChars=1000`

- [ ] **Step 1: 写测试（全部离线，用假 `HttpMessageHandler` 与假时钟）**

必测：
- `RateLimiterSpacesCallsByInterval`：qps=2、假时钟，三次 `AcquireAsync` 记录的等待为 `[0,500,500]`；
- `NormalizeUrlDropsFragmentAndTrailingSlash`，且非法 URL 原样返回 trim 后字符串；
- `SourceIdIsStableSha256PrefixOfNormalizedUrl`（同一 URL 加 `#x` 后 id 相同，长度 12）；
- `AddSearchKeepsHighestAuthorityAndRerankForDuplicateUrl`；
- `AddFetchMarksSourceAsFetchedAndChangesKind`；
- `FormattingTruncatesSnippetAt300Chars`（断言结尾是 `…[truncated]`）、`FormattingTruncatesFetchedContentAt1000Chars`；
- `SearchRetriesOn429HonoringRetryAfter`：首次 429 + `Retry-After: 1`，第二次 200 → 返回结果且记录了一次 1000ms 等待；
- `SearchThrowsDeepSeekExceptionWithStatusAfterRetries`：连续 429 → 抛出，`Status == 429`；
- `FetchDefaultsMissingUrlAndTitle`：响应只有 `{content}` 时 `Url` 为请求 URL、`Title` 等于 URL。

- [ ] **Step 2: 跑到失败**

Run: `dotnet test --filter FullyQualifiedName~Research`
Expected: 编译失败。

- [ ] **Step 3: 实现**

`DeepSeekClient` 用注入的 `HttpClient`；重试上限 3 次、基础退避 500ms、429 与 5xx 可重试，其余状态直接抛 `DeepSeekException`。

- [ ] **Step 4: 跑到通过，回归 Task 3**

Run: `dotnet test`
Expected: 全部 PASS（`DayCardValidator` 改为引用 `Freshness.IsVerifiedFact`）。

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/PiTravel.Server/Research apps/server/tests/PiTravel.Server.Tests/Research apps/server/src/PiTravel.Server/Planning
git commit -m "feat: port the DeepSeek research client and source store"
```

---

### Task 5: SVG 草图与清洗

**Files:**
- Create: `apps/server/src/PiTravel.Server/Artifacts/SvgValidator.cs`
- Create: `apps/server/src/PiTravel.Server/Artifacts/Placeholder.cs`
- Create: `apps/server/src/PiTravel.Server/Artifacts/SketchGenerator.cs`
- Create: `apps/server/src/PiTravel.Server/Artifacts/SketchResult.cs`
- Test: `apps/server/tests/PiTravel.Server.Tests/Artifacts/*.cs`

**Interfaces:**
- Produces:
  - `sealed record SvgCheck(bool Ok, string? Svg, string? Reason)`
  - `static string? SvgValidator.Extract(string raw)`
  - `static SvgCheck SvgValidator.ValidateAndSanitize(string raw)`
  - `static string Placeholder.Build(string title)`
  - `sealed record SketchResult(string Svg, string Status, string? Error)`，`Status` 为 `"ok"` 或 `"failed"`
  - `Task<SketchResult> SketchGenerator.GenerateAsync(DayCard day, Func<string, CancellationToken, Task<string>> generate, CancellationToken ct)`

- [ ] **Step 1: 写测试**

`SvgValidatorTests` 必测：
- `ExtractsFencedSvgBlock`、`ExtractsRawSvgWithXmlDeclaration`、`ReturnsNullWhenNoSvgPresent`；
- `RejectsMissingViewBox`；
- `RejectsViewBoxLargerThan1200x800`；
- `RejectsMalformedXml`；
- `RemovesScriptElements`（输出不含 `<script`）；
- `RemovesEventAttributes`（不含 `onclick=`）；
- `RemovesExternalHrefButKeepsFragmentHref`（`href="https://evil"` 被删，`href="#g1"` 保留）；
- `RemovesImageWithExternalHref`（整个 `<image>` 元素消失）；
- `RemovesForeignObject`。

`SketchGeneratorTests` 必测：
- `AcceptsValidSvgOnFirstTry`：generator 只被调用一次；
- `RetriesOnceThenFallsBackToPlaceholder`：两次都返回垃圾 → `Status=="failed"` 且 `Svg` 等于 `Placeholder.Build("Day 1 · 红门")`；
- `TreatsGeneratorExceptionAsFailedAttempt`：第一次抛异常、第二次返回合法 SVG → `Status=="ok"`，调用两次。

- [ ] **Step 2: 跑到失败**

Run: `dotnet test --filter FullyQualifiedName~Artifacts`
Expected: 编译失败。

- [ ] **Step 3: 实现**

用 `System.Xml.Linq` 解析与重建；解析失败即视为不合格（等价于 TS 端把"修复式解析的告警"当失败）。清洗规则照搬 `apps/server/src/svg/validate.ts` 的元素/属性名单，大小写不敏感。

- [ ] **Step 4: 跑到通过**

Run: `dotnet test --filter FullyQualifiedName~Artifacts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/PiTravel.Server/Artifacts apps/server/tests/PiTravel.Server.Tests/Artifacts
git commit -m "feat: port SVG generation, validation, and sanitization"
```

---

### Task 6: 耐久会话服务

**Files:**
- Create: `apps/server/src/PiTravel.Server/Harness/Docs.cs`
- Create: `apps/server/src/PiTravel.Server/Harness/TripIndexStore.cs`
- Create: `apps/server/src/PiTravel.Server/Harness/TranscriptBuilder.cs`
- Create: `apps/server/src/PiTravel.Server/Harness/TravelService.cs`
- Create: `apps/server/src/PiTravel.Server/Harness/TravelServiceOptions.cs`
- Test: `apps/server/tests/PiTravel.Server.Tests/Harness/*.cs`

**Interfaces:**
- Produces:
  - `static class Docs`：`TripBriefDoc`、`TripPlanDoc`、`TripSourcesDoc`、`TripResearchDoc`、`TripSearchCacheDoc`、`TripFaultsDoc`（kind 分别为 `trip.brief`/`trip.plan`/`trip.sources`/`trip.research`/`trip.search-cache`/`trip.faults`，`version: 1`）
  - `sealed class TripIndexStore { Task<IReadOnlyList<TripIndexEntry>> ListAsync(); Task<TripIndexEntry?> GetAsync(string tripId); Task UpsertAsync(TripIndexEntry entry); }`
  - `static IReadOnlyList<TranscriptEntry> TranscriptBuilder.FromEntries(...)`
  - `sealed class TravelService`：`static Task<TravelService> OpenAsync(TravelServiceOptions options, CancellationToken ct)`、`Task<TripIndexEntry> CreateTripAsync(CreateTripInput input, CancellationToken ct)`、`Task<IReadOnlyList<TripIndexEntry>> ListTripsAsync(CancellationToken ct)`、`Task<TripSnapshot> GetSnapshotAsync(string tripId, CancellationToken ct)`、`Task<string> SubmitMessageAsync(string tripId, string content, string requestId, CancellationToken ct)`、`Task<IReadOnlyList<TranscriptEntry>> GetTranscriptAsync(string tripId, CancellationToken ct)`、`IAsyncEnumerable<AgentEvent> WatchEventsAsync(string tripId, CancellationToken ct)`、`Task RecordFaultAsync(string tripId, TripFault fault, CancellationToken ct)`、`Task ClearFaultsAsync(string tripId, CancellationToken ct)`、`Task CloseAsync(CancellationToken ct)`
  - `record CreateTripInput(string Title, string Destination, string StartDate, int Days)`

- [ ] **Step 1: 写索引与 transcript 测试**

- `TripIndexStoreListsNewestFirst`、`TripIndexStoreUpsertsById`、`TripIndexStoreReturnsEmptyForMissingFile`；
- `TranscriptBuilderEmitsThinkingAsReasoningEntry`、`TranscriptBuilderEmitsToolResultWithError`、`TranscriptBuilderSkipsAssistantWithNoContentAndNoToolCalls`、`TranscriptBuilderSerializesToolCallArguments`。
transcript 测试用 Task 1 笔记里确认的 `EntryRecord` 形状构造输入。

- [ ] **Step 2: 跑到失败 → 实现 → 跑到通过**

Run: `dotnet test --filter FullyQualifiedName~Harness.Transcript`，再 `--filter FullyQualifiedName~TripIndexStore`
Expected: 先 FAIL，实现后 PASS。

- [ ] **Step 3: 写 TravelService 测试**

用内存存储 + Faux 模型：
- `CreateTripWritesSeedBriefWithoutRequiringCompleteness`：只写 destination/startDate/days，`GetSnapshotAsync` 里 `brief.origin` 为空、`plan.days` 为空；
- `CreateTripRejectsPastOrImpossibleDate`：抛错；
- `SubmitMessageIsIdempotentPerRequestId`：同一 `requestId` 提交两次，只产生一次运行（断言 transcript 中 user 条目只有一条）；
- `SnapshotReportsRunningWhileARunIsActive`；
- `RecordFaultAppendsAndCapsAtTen`；
- `WatchEventsStartsWithSnapshotThenBatches`；
- `ReopenResumesAPendingRun`：提交后关闭服务、用同一存储重新打开，`Resume` 后运行完成且文档可读。

- [ ] **Step 4: 跑到失败 → 实现 → 跑到通过**

Run: `dotnet test --filter FullyQualifiedName~Harness.TravelService`
Expected: 先 FAIL，实现后 PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/PiTravel.Server/Harness apps/server/tests/PiTravel.Server.Tests/Harness
git commit -m "feat: port the durable travel service"
```

---

### Task 7: Agent、提示词与六个工具

**Files:**
- Create: `apps/server/src/PiTravel.Server/Agent/Prompts.cs`
- Create: `apps/server/src/PiTravel.Server/Agent/TripContextSection.cs`
- Create: `apps/server/src/PiTravel.Server/Agent/TravelDeps.cs`
- Create: `apps/server/src/PiTravel.Server/Agent/ToolCaps.cs`
- Create: `apps/server/src/PiTravel.Server/Agent/Tools/UpdateBriefTool.cs`
- Create: `apps/server/src/PiTravel.Server/Agent/Tools/EmitDayTool.cs`
- Create: `apps/server/src/PiTravel.Server/Agent/Tools/FinalizeTool.cs`
- Create: `apps/server/src/PiTravel.Server/Agent/Tools/SearchTool.cs`
- Create: `apps/server/src/PiTravel.Server/Agent/Tools/FetchTool.cs`
- Create: `apps/server/src/PiTravel.Server/Agent/Tools/SketchDayTool.cs`
- Create: `apps/server/src/PiTravel.Server/Agent/TravelExtension.cs`
- Test: `apps/server/tests/PiTravel.Server.Tests/Agent/*.cs`

**Interfaces:**
- Produces:
  - `static class Prompts { const string PlannerInstructions }`（与 `apps/server/src/agent/prompts.ts` 逐字一致）
  - `static string? TripContextSection.Render(TripBrief? brief, TripPlan? plan, IReadOnlyDictionary<string,TripSource>? sources, DateTimeOffset now)`
  - `record TravelDeps(Func<DateTimeOffset> Now, DeepSeekClient DeepSeek, Func<DayCard, CancellationToken, Task<SketchResult>> GenerateSketch, int SearchCap, int FetchCap)`
  - `sealed class TravelExtension`，注册 6 个工具名：`trip_update_brief`、`plan_emit_day`、`plan_finalize`、`deepseek_search`、`deepseek_fetch`、`sketch_day`；每个工具的 `Replay` 都是 `"safe"`

- [ ] **Step 1: 纯函数测试**

- `SearchCacheKeyNormalizesWhitespaceAndIncludesOptions`（同 query 多空格 → 同 key；`needContent` 缺省记为 `false`）；
- `SelectFetchTargetsPrefersAuthorityAtLeastThreeThenSearchOrder`、`SelectFetchTargetsDeduplicatesByNormalizedUrl`；
- `ApplyDayEmitKeepsSvgWhenContentUnchanged`、`ApplyDayEmitResetsSvgStatusToPendingWhenContentChanged`、`ApplyDayEmitReplacesOnlyTheTargetedDay`；
- `RenderTripContextOmitsSectionWhenEmpty`、`RenderTripContextCapsBlocksAtEightAndSourcesAtForty`；
- `EnforceCapThrowsAtLimit`。

- [ ] **Step 2: 跑到失败 → 实现 → 跑到通过**

Run: `dotnet test --filter FullyQualifiedName~Agent`
Expected: 先 FAIL，实现后 PASS。

- [ ] **Step 3: 工具行为测试（Faux 模型 + 假 DeepSeek）**

- `EmitDayRefusesWhenBriefIncomplete`：抛错且 `trip.plan` 未变；
- `EmitDayRejectsUnfetchedSourceAsFact`；
- `SearchWritesSourcesCacheAndAttemptsInOneCommit`；
- `SearchServesRepeatedQueryFromCacheWithoutCallingDeepSeek`（第二次 DeepSeek 调用次数仍为 1）；
- `FetchRefusesUrlThatDidNotComeFromSearch`；
- `FetchReturnsCachedContentWhenAlreadyFetched`（DeepSeek 调用次数仍为 1）；
- `SearchStopsAtFortyCalls`；`FetchStopsAtThirtyCalls`；
- `FinalizeThrowsWhenBriefHasNoBudget`；`FinalizeStoresBudgetSummaryOnPlan`；
- `UpdateBriefMergesAndReportsMissingFields`。

- [ ] **Step 4: 跑到失败 → 实现 → 跑到通过**

Run: `dotnet test --filter FullyQualifiedName~Agent`
Expected: 先 FAIL，实现后 PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/PiTravel.Server/Agent apps/server/tests/PiTravel.Server.Tests/Agent
git commit -m "feat: port the planner prompt, context section, and six tools"
```

---

### Task 8: AG-UI 映射

规范来源是 `apps/server/src/agui/mapper.ts` 与 `mapper.test.ts`，不是本计划里的列表。

**Files:**
- Create: `apps/server/src/PiTravel.Server/AgUi/AgUiEvents.cs`
- Create: `apps/server/src/PiTravel.Server/AgUi/AgUiMessages.cs`
- Create: `apps/server/src/PiTravel.Server/AgUi/SnapshotBuilder.cs`
- Create: `apps/server/src/PiTravel.Server/AgUi/PiEventMapper.cs`
- Test: `apps/server/tests/PiTravel.Server.Tests/AgUi/*.cs`

**Interfaces:**
- Produces:
  - `abstract record AgUiEvent`（序列化成 `{ "type": "..." }` 形状；`CUSTOM` 带 `name`/`value`）
  - `static IReadOnlyList<AgUiMessage> AgUiMessages.FromTranscript(IEnumerable<TranscriptEntry> entries)`
  - `static IReadOnlyList<AgUiEvent> SnapshotBuilder.Build(string threadId, string runId, IReadOnlyList<TranscriptEntry> entries, TripState state)`
  - `sealed class PiEventMapper { IReadOnlyList<AgUiEvent> Map(AgentEvent batch); }`（每个 run 一个实例）

- [ ] **Step 1: 形状测试**

`AgUiShapeTests`：把每种事件序列化后与固定 JSON 比对，至少覆盖 `RUN_STARTED`、`RUN_FINISHED`、`RUN_ERROR`、`TEXT_MESSAGE_START/CONTENT/END`、`TOOL_CALL_START/ARGS/END`、`TOOL_CALL_RESULT`、`REASONING_START`、`REASONING_MESSAGE_START/CONTENT/END`、`REASONING_END`、`REASONING_ENCRYPTED_VALUE`、`CUSTOM travel.tool_progress`、`CUSTOM travel.task_failed`、`MESSAGES_SNAPSHOT`、`STATE_SNAPSHOT`。夹具从 TS mapper 的测试里抄，别自创。

- [ ] **Step 2: 跑到失败 → 实现 → 跑到通过**

Run: `dotnet test --filter FullyQualifiedName~AgUi`
Expected: 先 FAIL，实现后 PASS。

- [ ] **Step 3: 行为测试（逐条对齐 mapper.test.ts）**

至少覆盖：
- `ThinkingBlockBecomesReasoningContent`；
- `ToolCallBlockStartsOnceAndEndsAtExecution`；
- `ToolExecutionUpdateEmitsTravelToolProgressAndCapsOutputAt16KiB`；
- `ToolExecutionEndEmitsResultWithTravelToolMetadataIncludingDurationMs`；
- `GenerationTaskFailedEmitsCustomAndRunError`、`ToolTaskFailedEmitsCustomOnly`；
- `RunEndClosesOpenTextAndToolCalls`；
- `LateAttachSnapshotSeedsPartialGenerationWithoutDuplicateContent`；
- `MessageEndReplayDoesNotReemitAlreadyStreamedText`。

- [ ] **Step 4: 跑到失败 → 实现 → 跑到通过**

Run: `dotnet test --filter FullyQualifiedName~AgUi`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/PiTravel.Server/AgUi apps/server/tests/PiTravel.Server.Tests/AgUi
git commit -m "feat: port the AG-UI event mapper and snapshot"
```

---

### Task 9: HTTP 托管层

**Files:**
- Create: `apps/server/src/PiTravel.Server/Hosting/ServerConfig.cs`
- Create: `apps/server/src/PiTravel.Server/Hosting/Program.cs`
- Create: `apps/server/src/PiTravel.Server/Hosting/Endpoints/TripsEndpoints.cs`
- Create: `apps/server/src/PiTravel.Server/Hosting/Endpoints/AguiEndpoints.cs`
- Create: `apps/server/src/PiTravel.Server/Hosting/ServiceCollectionExtensions.cs`
- Create: `apps/server/src/PiTravel.Server/PiTravel.Server.csproj`（改为 `Microsoft.NET.Sdk.Web`，`OutputType=Exe`）
- Test: `apps/server/tests/PiTravel.Server.Tests/Hosting/*.cs`

**Interfaces:**
- Produces:
  - `record ServerConfig { string DeepSeekApiKey; string DeepSeekBaseUrl; string DataDir; string MagpieBaseUrl; string MagpieModelId; string MagpieApiKey; int MagpieMaxTokens; string ThinkingLevel; }`，`static ServerConfig FromEnvironment(IDictionary<string,string?> env)`
  - `static void TripsEndpoints.Map(IEndpointRouteBuilder app)`
  - `static void AguiEndpoints.Map(IEndpointRouteBuilder app)`
  - `static WebApplication BuildApp(ServerConfig config, TravelService service)`
- Consumes: Task 6 的 `TravelService`、Task 8 的 mapper/snapshot、Task 7 的扩展注册。

- [ ] **Step 1: 配置测试**

- `MissingDeepSeekKeyThrowsAtStartup`；
- `DefaultsMatchTheDocumentedValues`：`DataDir="./data"`、`MagpieBaseUrl="http://127.0.0.1:3425"`、`MagpieModelId="deepseek/deepseek-flash"`、`MagpieApiKey="magpie"`、`MagpieMaxTokens=393216`、`ThinkingLevel="low"`；
- `PortComesFromUrlsNotPortEnvVar`。

- [ ] **Step 2: 端点测试（`WebApplicationFactory` + 假服务）**

照 `apps/server/src/http/app.test.ts` 的用例逐条搬：
- `HealthReturnsOk`；
- `CreateTripRejectsMissingFieldsWith400`、`CreateTripRejectsImpossibleDateWith400`、`CreateTripReturns201WithIndexEntry`；
- `GetSnapshotReturns404ForUnknownTrip`；
- `TranscriptReturnsAguiMessages`；
- `MessagesRequiresRequestId`、`MessagesRejectsEmptyContentWith400`、`MessagesReturns202WithSubmissionId`；
- `AguiRequiresTripIdAndRunId`；
- `AguiStreamsRunStartedSnapshotThenFinishes`：读 SSE 行，断言首帧 `RUN_STARTED`、随后 `MESSAGES_SNAPSHOT` 与 `STATE_SNAPSHOT`、末帧 `RUN_FINISHED`；
- `AguiReturnsWhenClientDisconnects`：取消请求 token 后 handler 结束，且向服务发出过一次 abort（Review Focus 第 1 条）。

- [ ] **Step 3: 跑到失败 → 实现 → 跑到通过**

Run: `dotnet test --filter FullyQualifiedName~Hosting`
Expected: 先 FAIL，实现后 PASS。

- [ ] **Step 4: 手动冒烟**

```bash
cd apps/server && DEEPSEEK_API_KEY=dummy dotnet run --project src/PiTravel.Server --urls http://127.0.0.1:4000 &
curl -s http://127.0.0.1:4000/health     # {"ok":true}
curl -s http://127.0.0.1:4000/api/trips  # []
```

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/PiTravel.Server apps/server/tests/PiTravel.Server.Tests/Hosting
git commit -m "feat: expose the trips and AG-UI HTTP surface"
```

---

### Task 10: 验收程序（Playwright，A–H）

**Files:**
- Create: `tools/PiTravel.Acceptance/PiTravel.Acceptance.csproj`
- Create: `tools/PiTravel.Acceptance/Program.cs`
- Create: `tools/PiTravel.Acceptance/Scenarios/*.cs`
- Create: `tools/PiTravel.Acceptance/Infrastructure/{ServerHost,WebHost,Browser,ApiClient,Evidence}.cs`
- Modify: `apps/server/src/PiTravel.Server/Artifacts/SketchGenerator.cs`（增加 `PITRAVEL_TEST_SVG_MODE` 开关）

**Interfaces:**
- Produces: `dotnet run --project tools/PiTravel.Acceptance -- --scenario A|B|C|D|E|F|G|H|all`；退出码 0 表示通过；证据写到 `artifacts/acceptance/<timestamp>/`。

- [ ] **Step 1: 加 E 的注入开关（先写测试）**

`SketchGeneratorTests.InvalidModeAlwaysReturnsPlaceholder`：环境变量 `PITRAVEL_TEST_SVG_MODE=invalid` 时，即使生成器返回合法 SVG 也落占位图、`Status=="failed"`。默认未设置时行为不变（回归上一条 `AcceptsValidSvgOnFirstTry`）。

- [ ] **Step 2: 跑到通过**

Run: `dotnet test --filter FullyQualifiedName~SketchGeneratorTests`
Expected: PASS。

- [ ] **Step 3: 搭验收骨架**

`ServerHost` 起 .NET 服务（随机空闲端口 + 临时 `DATA_DIR`）、`WebHost` 起 `npm run start:web`（`API_URL`/`AGENT_URL` 指向该端口）、`Browser` 用 `Microsoft.Playwright` 启动 Chromium、`ApiClient` 读快照、`Evidence` 存截图与 JSON。

Run: `dotnet run --project tools/PiTravel.Acceptance -- --scenario A`
Expected: 停在"界面打不开"的失败信息上，说明三个 host 都起来了。

- [ ] **Step 4: 场景 A —— 完整 brief 走完界面**

`Scenarios/CompleteBrief.cs`：界面新建行程 → 输入泰山三日需求 → 等 3 张日卡渲染完成 → 断言每张卡片都有 SVG、有来源 chips、有费用区间 → 读快照断言 `plan.budget.high <= 3000` 且 `withinBudget == true`。

Run: `dotnet run --project tools/PiTravel.Acceptance -- --scenario A`
Expected: 退出码 0，证据目录里有三张截图与快照 JSON。

- [ ] **Step 5: 场景 B 与 F —— 澄清与局部修改**

`Scenarios/IncompleteBrief.cs`：发缺字段需求 → 断言助手先提问、快照里 `plan.days` 为空。`Scenarios/TargetedEdit.cs`：接着 A 的行程发"第三天轻松一点" → 断言只有 `dayIndex==3` 的卡片 `updatedAt` 变化，第 1、2 天的卡片 JSON 逐字段不变。

Run: `--scenario B` 与 `--scenario F`
Expected: 均退出码 0。

- [ ] **Step 6: 场景 C 与 D —— 崩溃与刷新**

`Scenarios/CrashResume.cs`：研究进行中 `Process.Kill(entireProcessTree:true)` → 用同一 `DATA_DIR` 重启 → 刷新页面 → 断言会话继续、`research.searchAttempts`/`fetchAttempts` 的键数不减少且已完成计数不增加。`Scenarios/RefreshRecovery.cs`：运行中 `page.ReloadAsync()` → 断言行数与卡片数与刷新前一致。

Run: `--scenario C` 与 `--scenario D`
Expected: 均退出码 0。

- [ ] **Step 7: 场景 E、G、H —— SVG 失败、引用、内容**

`Scenarios/SvgFallback.cs` 带 `PITRAVEL_TEST_SVG_MODE=invalid` 起服务 → 断言卡片显示占位图且"重画"入口可用。`Scenarios/Citations.cs` 读 A 的快照 → 断言每条 `kind=="fact"` 且未标 `unverified` 的 claim 都有存在的 `sourceIds`。`Scenarios/ContentCoverage.cs` 落证据：完整对话、三张卡片 JSON、截图，控制台打印虹桥往返 / 住宿区域 / 徒步索道 / 日出 / 美食 / 预算分项六项人工核对清单。

Run: `--scenario E`、`--scenario G`、`--scenario H`
Expected: E、G 退出码 0；H 打印证据路径与清单。

- [ ] **Step 8: 全量跑一次**

```bash
dotnet run --project tools/PiTravel.Acceptance -- --scenario all
```

Expected: A–G 全部退出码 0；H 输出证据路径与清单。失败时打印该场景的完整事件流。

- [ ] **Step 9: Commit**

```bash
git add tools/PiTravel.Acceptance apps/server/src/PiTravel.Server/Artifacts
git commit -m "test: add the browser-driven acceptance runner"
```

---

### Task 11: 收尾（移除旧实现、文档、CI、脚本）

**Files:**
- Delete: `apps/server/package.json`、`apps/server/tsconfig.json`、`apps/server/vitest.config.ts`，以及 `apps/server/src/` 下的 TypeScript 目录与入口（`agent/`、`agui/`、`deepseek/`、`harness/`、`http/`、`model/`、`plan/`、`research/`、`svg/`、`trips/`、`main.ts`）。**保留 `apps/server/src/PiTravel.Server/`。**
- Modify: `package.json`（workspaces 去掉 `apps/server`；`dev:server`/`start:server`/`test:server`/`acceptance:*` 改调 `dotnet`）
- Modify: `.github/workflows/ci.yml`（加 setup-dotnet 10 + `dotnet test`）
- Modify: `README.md`（架构图、Requirements、Quick start、Scripts、Project structure、Limitations）
- Modify: `.env.example`、`.gitignore`（忽略 `apps/server/data/`、`artifacts/`、`bin/`、`obj/`）

- [ ] **Step 1: 删旧实现并保证构建**

```bash
git rm -r apps/server/src/agent apps/server/src/agui apps/server/src/deepseek \
  apps/server/src/harness apps/server/src/http apps/server/src/model \
  apps/server/src/plan apps/server/src/research apps/server/src/svg \
  apps/server/src/trips apps/server/src/main.ts \
  apps/server/package.json apps/server/tsconfig.json apps/server/vitest.config.ts
cd apps/server && dotnet build
cd ../.. && npm install
```

Expected: 两边都成功。若 `apps/web` 因 `@pi-demo/shared` 解析失败，检查 workspaces 只保留 `apps/web` 与 `packages/shared`。

- [ ] **Step 2: 改根脚本**

`dev:server` → `dotnet watch --project apps/server/src/PiTravel.Server run`；`start:server` → `dotnet run --project apps/server/src/PiTravel.Server`；`test:server` → `dotnet test apps/server`；`acceptance:e2e` → `dotnet run --project tools/PiTravel.Acceptance -- --scenario all`。`acceptance:live`、`acceptance:crash`、`probe:thinking` 保留原样指向 `scripts/`。

Run: `npm run test:server`
Expected: 全部 PASS。

- [ ] **Step 3: 更新 CI**

在现有 workflow 里加 `actions/setup-dotnet@v4`（`dotnet-version: 10.0.x`）与 `dotnet test apps/server`，排在 `npm ci` 之后。e2e 不进 CI。

- [ ] **Step 4: 更新 README 与 .env.example**

README 的架构图把 `Fastify :4000` 换成 `ASP.NET Core :4000`，Requirements 增加 .NET 10 SDK，Scripts 表补 `dotnet test` / `acceptance:e2e`，Project structure 表换成新目录。`.env.example` 增加 `PITRAVEL_TEST_SVG_MODE`（标注"仅验收用"）。

- [ ] **Step 5: 全量回归 + 提交**

```bash
npm run typecheck && npm test && npm run build
dotnet test apps/server
git add -A
git commit -m "chore: retire the TypeScript backend and document the .NET one"
```

Expected: 三条 npm 命令与 dotnet 测试全部通过。

---

## Self-Review

- **Spec 覆盖**：§7.1 布局（Task 1、11）、§7.2 项目划分（Task 1）、§7.3 契约（Task 2、9）、§7.4 关键行为（Task 6）、§7.5 AG-UI（Task 8）、§7.6 配置与日志（Task 9）、§7.7 验收工具（Task 10）、§7.8 CI（Task 11）、§8 A–H（Task 10）、§9 风险（Task 1 Step 4 落实版本核对）。
- **名字一致性**：`TravelService` 在 Task 6 定义、Task 9 消费；`SketchResult` 在 Task 5 定义、Task 7 的 `TravelDeps` 引用；`TripState` 在 Task 2 定义、Task 8 消费。
- **Review Focus**：5 条分别落在 Task 9（断开）、Task 6 与 9（重复 requestId）、Task 6 与 10（崩溃续跑）、Task 5（敌意 SVG）、Task 4（429 退避）。

# pi.net API 笔记（Pi.Ai / Pi.Agent / Pi.Durable 1.4.5）

本文记录的是**在真实 NuGet 包 1.4.5 上编译并跑通**的签名，不是从文档猜的。
验证用例：`apps/server/tests/PiTravel.Server.Tests/HarnessSpikeTests.cs`
（`WritesADocSubmitsAInputStreamsRunEndAndSurvivesReopen`，`dotnet test --filter FullyQualifiedName~HarnessSpikeTests`）。
NuGet 包的 `repository commit` 是 `bf514a97a5fdbcfa271ab80e355991e020dbcd1f`；本文引用的
`Pi.Durable` / `Pi.Chord` / `Pi.Ai` 源文件在该 commit 与 `main` 逐字节相同（已 diff）。

后续任务直接照本文抄签名；与 TS `pi-durable@1.3.0` 的语义差异见最后一节。

## 0. 命名空间速查

| 类型 | 命名空间 |
| --- | --- |
| `Harness`（静态门面）/ `HarnessOptions` / `AgentChange` / `ModelRef` / `SubmissionDraft` / `Events` / `Registry` / `IExtension` / `IToolRegistration` / `IPromptSection` / `PromptInput` / `Define` | `Pi.Durable.Harness` |
| `DocToken<T>` / `DocDefinition<T>` / `DocumentSemantics` / `ConversationFork` / `ConversationOwnership` / `ConversationId` / `SubmissionId` / `IDocumentReader` / `IDocumentObserver` / `IDocumentWatch<T>` | `Pi.Durable.Types` |
| `DurableDocuments` | `Pi.Durable` |
| `MemoryStorage` / `SqliteStorage` / `SqliteStorageOptions` / `IStorage` | `Pi.Durable.Storage` |
| `CommittedWatch<T>` | `Pi.Durable.Session` |
| `Context` / `ContextKey<T>` | `Pi.Chord.Context` |
| `Path` / `Seg` / `DeltaOp` / `Tracker<T>` | `Pi.Chord.Delta` |
| `WatchEnd` / `IWatchHandle<T>` | `Pi.Chord.Services` |
| `Models` / `ModelSpec` | `Pi.Ai.Models` |
| `Faux` | `Pi.Ai.Providers` |
| `TextContent` / `ContentBlock` / `ThinkingLevel` / `Usage` | `Pi.Ai.Types` |

## 1. 打开 / 关闭 Harness

```csharp
using DurableHarness = Pi.Durable.Harness.Harness; // 与 Pi.Durable.Session 里的同名类型区分

var registry = Registry.CreateRegistry();   // 没有公开构造函数；必须用它，内建任务才齐
var models = new Models();                  // 公开无参构造
models.SetProvider(faux.Provider);

var harness = await DurableHarness.OpenAsync(storage, new HarnessOptions
{
    Models = models,                        // required
    Registry = registry,                    // required
    Settings = new HarnessSettings(),       // 可选；SettingsSource 优先
    SettingsSource = () => settings,        // Func<HarnessSettings?>
    Now = () => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), // Func<long>
    OnReport = (Exception error, ReportInfo info) => { },       // 1.4.0 起两参
}, Context.Background);

harness.Resume();                           // void，幂等；启用任务调度
...
await harness.CloseAsync(Context.Background());
```

- 返回类型是 `HarnessImpl`（实现 `IHarness : ISession`）。
- `HarnessOptions.Registry` 只要求 `IRegistryReader`；安装扩展需要 `IRegistry`（`Registry.CreateRegistry()` 的返回类型）。
- `OpenAsync` 会校验内建任务（generation / tool / compaction）存在，缺失直接抛 `InvalidOperationException`。
- `Context.Background` 等价 TS `BACKGROUND_CONTEXT`；带取消的上下文用
  `ContextSignals.WithAbortSignal(token, Context.Background)`（`Pi.Chord.Context.ContextSignals`）。

## 2. 定义文档

```csharp
private sealed class SpikeNote : Dictionary<string, object?>;   // 任意 class + IReadOnlyDictionary<string, object?>

private static readonly DocToken<SpikeNote> NoteDoc = DurableDocuments.DefineDoc(new DocDefinition<SpikeNote>
{
    Kind = "spike.note",
    Version = 1,
    Initial = () => new SpikeNote { ["text"] = "" },            // required Func<T>
    Semantics = new DocumentSemantics.LatestConversationScope(ConversationFork.Initial),
    // 其它语义：SessionScope / RewindableConversationScope(Fork) / TaskScope
    // 可选：Migrate = (old, fromVersion) => ...; CheckpointWhen = (value, ops, info) => ...
});
```

要点：

- `DefineDoc<T>` 约束 `T : class, IReadOnlyDictionary<string, object?>`。**T 只是初值工厂的类型标记**，
  读写时一律是擦除后的 `IReadOnlyDictionary<string, object?>`，没有强类型 POCO / 可变代理。
- `history: "latest"` ↔ `LatestConversationScope`，`history: "rewindable"` ↔ `RewindableConversationScope`；
  `fork: "initial"` ↔ `ConversationFork.Initial`（另有 `Current` / `AsOf`）。
- 族文档用 `DurableDocuments.DefineDocFamily<T, TSeed>(...)`。

## 3. 事务里读写文档（`ITx`）

```csharp
await conversation.CommitAsync(async tx =>
{
    Tracker<IReadOnlyDictionary<string, object?>>.Change note =
        await tx.DocAsync(NoteDoc, conversation.Id);
    note.Set(new DeltaPath([Seg.Key("text")]), "hello");   // 显式动词，不是属性赋值
    return true;                                           // IConversation.CommitAsync 只有泛型重载
}, Context.Background);
```

- `ITx.DocAsync<T>(token, conversationId)` → `Task<Tracker<IReadOnlyDictionary<string, object?>>.Change>`；
  文档不存在时**以定义初值创建**并纳入本事务。
- `Change` 的 API：`Draft`（当前草稿）、`Set(Path, object?)`、`Delete(Path)`、`Append(Path, string)`、
  `Truncate(Path, long)`、`Splice(Path, long, long, IReadOnlyList<object?>)`、`Move(Path, IReadOnlyList<long>)`、
  `Replace(T)`（整值替换，必须是唯一 op）、`Prepare()` / `Abort()`。
- `Path` 在 `Pi.Chord.Delta`，与 `System.IO.Path` 冲突：`using DeltaPath = Pi.Chord.Delta.Path;`。
  `Seg.Key(string)` / `Seg.Index(long)`，空路径是根。
- `ISession.CommitAsync` 有 `Func<ITx, Task>` 重载；**`IConversation.CommitAsync` 只有 `Func<ITx, Task<T>>`**，
  无返回值场景写 `return true;`。
- 会话级/任务级文档：`tx.DocAsync(token)` / `tx.DocAsync(token, taskId)`。

## 4. 提交后读快照

```csharp
IReadOnlyDictionary<string, object?>? snapshot =
    await harness.SnapshotAsync(NoteDoc, conversation.Id, Context.Background);
Assert.Equal("hello", snapshot!["text"]);
```

- 定义在 `IDocumentReader`：`SnapshotAsync<T>(token, [conversationId|taskId], context)`，
  另有 `SnapshotAsOfAsync<T>(token, conversationId, entryId, context)`（仅 rewindable）。
- 未创建过该文档时返回 `null`。
- 值树类型：`null` / `bool` / `double` / `string` / `IReadOnlyList<object?>` / `IReadOnlyDictionary<string, object?>`。

## 5. 提交用户输入

```csharp
ISubmission submission = await conversation.SubmitAsync(new SubmissionDraft.Input
{
    Content = [new TextContent("hello")],   // IReadOnlyList<ContentBlock>，required
    RequestId = "req-1",                    // 可选：对话作用域去重键
    WhenBusy = "steer",                     // 可选："steer" / "followUp" / "reject"
}, Context.Background);
```

- 返回 `ISubmission`：`Id`（`SubmissionId`，`readonly record struct(long Value)`）、
  `StatusAsync(ctx)`、`WaitAsync(ctx)`（→ `SettledSubmissionRecord`）、`AbortAsync(ctx)`。
- 被动条目写入用 `SubmissionDraft.Write { Entry = new EntryDraft { ... } }`。
- `IConversation.SubmitAsync` 接受抽象基类 `SubmissionDraft`；`IConversationHandle.SubmitAsync`（工具/任务内）只接受 `SubmissionDraft.Input`。

## 6. 事件流（Watch）

```csharp
var stream = await Events.WatchEventsAsync(harness, conversation.Id, Context.Background);
AgentEvent.Snapshot snapshot = stream.Snapshot;      // 挂载时快照
stream.Start((IReadOnlyList<AgentEvent> batch, Context ctx) =>
{
    if (batch.OfType<AgentEvent.RunEnd>().Any()) { /* run 结束 */ }
    return Task.CompletedTask;
});
...
await stream.StopAsync();                             // 或 await stream.Closed
```

- 事件是**按提交分批**投递的（`IReadOnlyList<AgentEvent>`），不是逐条。
- `AgentEvent` 是抽象 record 判别联合，`Type` 是 wire 字符串：`snapshot` / `run_start` / `run_end` /
  `turn_start` / `turn_end` / `message_start` / `message_update` / `message_end` / `tool_execution_start` / ...
- `run_end` 是 `AgentEvent.RunEnd { Inputs }`，一次运行结束在某一批里出现。
- 流在 Harness 关闭时以 `WatchEnd.Ended` 结束；`StopAsync()` 返回 `WatchEnd.Stopped`。
- 上下文被取消 → `WatchEnd.Cancelled`；监听器抛错 → `WatchEnd.ListenerError`；存储失败 → `WatchEnd.Failed`。

### 6.1 文档 / 对话视图 watch

```csharp
// 文档精确帧
IDocumentWatch<SpikeNote>? docWatch = await harness.WatchDocAsync(NoteDoc, conversation.Id, ctx);
IReadOnlyDictionary<string, object?>? value = docWatch?.Value;    // 取得时的值
docWatch?.Start((v, ops, c) => Task.CompletedTask);
await docWatch!.Stop();

// 对话结构视图
CommittedWatch<ConversationView> view = await conversation.WatchAsync(ctx);
view.Value.Conversation; view.Value.Entries; view.Value.Docs;      // Docs 按 kind 索引内建文档
view.Start((v, ops, c) => Task.CompletedTask);
await view.Stop();
```

- `IDocumentWatch<T> : IWatchHandle<IReadOnlyDictionary<string, object?>?>`（`Value` / `Start` / `Stop` / `Closed`）。
- 文档不存在（从未创建）时 `WatchDocAsync` 返回 `null`。
- `CommittedWatch<T>` 是串行精确帧 watch，待发帧上限 100；`Value` 是**取得时**的修订，`Start` 之后随提交推进。

## 7. 会话（`IConversation`）

```csharp
var conversation = await harness.CreateConversationAsync(new ConversationCreateOptions
{
    Ownership = new ConversationOwnership.Ownerless(),   // required
    Agent = new AgentChange { Model = new ModelRef("faux", "faux-1") },
    Init = async (ITx tx, ConversationId id) => { ... }, // 可选，运行在创建提交内
}, ctx);
```

- 其它入口：`harness.RootAsync(ctx, agent, init)`、`harness.ConversationAsync(id, ctx)`（→ `IConversation?`）。
- 成员：`Id`、`AgentAsync`、`ConfigureAsync(AgentChange, ctx)`、`SubmitAsync`、`ResetAsync(handoff, ctx)`、
  `CompactAsync(instructions, ctx)`、`CommitAsync<T>`、`ContextAsync`、`EntriesAsync`、`ForkAsync`、
  `AbortAsync`、`WaitForIdleAsync`、`WatchAsync`。
- **ID 坑**：`ConversationId` 是 `readonly record struct(long Value)`。`ToString()` 是 record 格式
  （`ConversationId { Value = 5 }`），不是 `"5"`；转字符串用 `conversation.Id.Value.ToString()`。

## 8. `AgentChange`（模型 / 指令 / 思考档位）

```csharp
new AgentChange
{
    Model = new ModelRef("deepseek", "deepseek-chat"),   // ModelRef(string Provider, string ModelId)
    Instructions = "你是旅行规划师",                       // string?
    ThinkingLevel = Pi.Ai.Types.ThinkingLevel.Off,        // 枚举：Off/Minimal/Low/Medium/High/XHigh/Max
    Extensions = new AgentChange.ExtensionChange { Exact = [...], Add = [...], Remove = [...] },
    Tools = new AgentChange.ToolChange { Exact = [...], Remove = [...] },
    Cwd = "/path",
    // Clear* 布尔用于显式清空对应字段（ClearModel / ClearThinkingLevel / ClearExtensions /
    // ClearTools / ClearInstructions / ClearCwd）
}
```

- `ConfigureAsync(change, ctx)` 应用增量；`AgentChange` 无「只设置指令」的便捷构造，直接赋值即可。
- 解析后的 `Agent`：`Model`、`ThinkingLevel`、`Extensions`、`Tools`、`Sections`、`Instructions`、`Cwd`。

## 9. 扩展 / 工具 / 提示段的注册入口

```csharp
// 扩展：IExtension { Name; Tools?; Sections?; Hooks?; Wraps?; Tasks? }
var extension = Define.Extension(new MyExtension());
registry.Install(extension);          // IRegistry.Install(IExtension)，按 Name 覆盖安装
registry.Uninstall(extension);

// 工具：IToolRegistration { Name; Description; ToolSchema Parameters; string? Replay;
//   ToolExecutionMode? ExecutionMode; ToolOutputLimits? OutputLimits;
//   object? PrepareArguments(object args);
//   Task<ToolExecutionResult> ExecuteAsync(object args, IToolExecutionApi api, Context ctx); }
var tool = Define.Tool(registration); // 恒等包装，仅为类型提示

// 提示段
IPromptSection section = Define.Section(
    "trip-context",
    (PromptInput input, Context ctx) => Task.FromResult<string?>("..."),
    tag: true);                       // tag 缺省 true，渲染为 <trip-context>…</trip-context>

// 其它：Define.Hook(taskName, handlers)、Define.WrapTool(tool, wrapper)、Define.WrapSection(key, wrapper)
```

- 段键必须匹配 `^[a-z][a-z0-9_-]*$`，且不能是保留的 `instructions`；同名段在扩展内不得重复。
- `PromptInput`：`ConversationId`、`Agent`（本次请求的解析，含 `Tools`）、`Env`、`Shown`（已生效段）、`Read`（已提交文档读取）。
- 工具名在同一扩展内必须唯一；`Replay` 缺省 `"unsafe"`，`"safe"` 才允许中断后重跑。

## 10. 存储后端

```csharp
// 内存（单进程；Reopen() 是「关闭后重开同一文件」的进程内等价物）
IStorage memory = new MemoryStorage();
var reopenedStorage = ((MemoryStorage)memory).Reopen();

// SQLite（服务真正使用的后端）
IStorage sqlite = await SqliteStorage.OpenAsync(
    path, new SqliteStorageOptions { BusyTimeoutMs = 5_000, WalAutoCheckpointPages = 1_000 });
await sqlite.CloseAsync();            // IStorage.CloseAsync()
```

- `SqliteStorage` 实现 `IAsyncDisposable`；`IStorage` 只有 `CloseAsync()`。
- 自定义存储实现要注意 1.4.0 的 `CommitAsync(writes, Action<Seq> adopt, signal)`：持久化后必须同步调用一次 `adopt`。

## 11. Faux 模型（测试不联网）

```csharp
var faux = Faux.CreateProvider();                        // provider id "faux"，默认模型 "faux-1"
faux.SetResponses([Faux.Response.Text("ok")]);           // 依次回放的脚本
// 工具调用：Faux.Response.ToolUse(Faux.ToolCall("search", new Dictionary<string, object?> { ["q"] = "..." }))
var model = faux.GetModel(null)!;                        // ModelSpec
var models = new Models();
models.SetProvider(faux.Provider);
var modelRef = new ModelRef(model.Provider, model.Id);   // ("faux", "faux-1")
```

- 脚本耗尽后 provider 返回 `StopReason.Error`（"No more faux responses queued"），不是静默结束。
- `FauxProviderOptions` 可自定义 `Provider` / `Models` / `TokenSize` / `TokensPerSecond` / `Deferred`。

## 12. 1.3.0 → 1.4.5 durable 语义差异

对照物：仓库内 `@earendil-works/pi-durable@1.3.0`（`node_modules/@earendil-works/pi-durable/dist/`）
与 pi.net 的发布记录（`CHANGELOG.md`）及 `docs/upstream-1.4.0-delta.md`。

| # | 变化 | 1.3.0 | 1.4.5 / pi.net | 对本项目 |
| --- | --- | --- | --- | --- |
| 1 | 观察面收敛 | `documentState()` / `viewState()` / `taskGraph()` 仍在（`harness/types.d.ts:634,673`）；`watchDoc()` / `watch()` / `watchEvents()` 同时已存在 | 旧接口全部移除，只保留 `watchDoc()` / `watch()` / `watchTaskGraph()`；`WatchEnd`/`WatchHandle` 迁到 `Pi.Chord.Services`（`docs/upstream-1.4.0-delta.md:165-167,200`） | **有影响**。TS 后端 `harness/service.ts:233` 用 `conversation.viewState()` 读 transcript；Task 8 必须改用 `WatchAsync()`（`CommittedWatch<ConversationView>`）或 `ContextAsync()` |
| 2 | Watch 终止词表 | `WatchEnd.reason` 取 `"session_closed"` / `"session_failed"`（`types.d.ts:772-782`） | `WatchEnd.Ended` / `WatchEnd.Failed`，wire 为 `"ended"` / `"failed"`；新增 `Retired` | **有影响**（小）。映射流终止原因时不要照抄旧字符串 |
| 3 | 存储提交 | `Storage.commit(writes, context)` | 新增同步 `adopt(seq)` 回调（1.4.0 破坏性变更） | 无（只用内置存储） |
| 4 | 持久睡眠 | 无 | `runtime.sleepUntil()`、`{status:"sleeping"}`、`Harness.Wake()` / `HarnessOptions.OnWake` / `SetTimer`、`ToolExecutionApi.now()`、SQLite schema v2 | 无（本项目不让任务睡眠）；`OnWake` 字段存在但可不设 |
| 5 | crash-loop guard | 无 | `TaskRecord.restarts` / `abortReason` / `abandonOnRestart`、`settings.restartLimit`、parked 任务 + `RetryTaskAsync()`、task graph `blocked` 原因、close 写回 `pending` | **有影响**（Task 10）：进程反复被杀后任务会停在 blocked，恢复脚本需要 `RetryTaskAsync()` |
| 6 | 文档保留 | 无 | `settings.documentRetentionMs`，按使用量驱逐文档缓存、冷加载 | 无（正确性不变，只是缓存） |
| 7 | `onReport` | `(error: unknown) => void`（`harness/types.d.ts:537`） | `(Exception, ReportInfo) => void` | 无（签名适配即可） |
| 8 | 身份 | 无 | `Harness.DefaultIdentity`、`HarnessOptions.Identity` | 无 |
| 9 | `afterFailedRun` 设置 | 无 | 1.4.0 新增 | 无 |
| 10 | 目标框架 | — | 1.4.5 多目标 `net9.0;net10.0` | 无（本项目只 `net10.0`） |

### 12.1 提交 / 重放 / checkpoint 逐条核对（无差异）

- **提交去重**：1.3.0 `submissions.js:129-133` 与 1.4.5 `Submissions.cs:149-157` 都是
  `requestId` 对话作用域查重，类型不一致才抛错；相同类型直接复用已有提交。
- **忙碌语义**：1.3.0 `submissions.js:148-167` 与 1.4.5 `Submissions.cs:166-199` 都是
  `whenBusy: "reject"` 抛 `ConversationBusy`，否则 `steer` / `followUp` 入 `pi.inbox`。
  → Review Focus #2（同 `requestId` 重试只产生一次运行）在 1.4.5 上成立。
- **工具重放（`replay: "safe"`）**：1.3.0 `tool.js:95,102-105` 与 1.4.5 `ToolTask.cs:171-192` 都是
  `execute` checkpoint 记录 `{ phase, arguments, replay }`，恢复时仅当**存储的意图**与**当前工具声明**
  都是 `"safe"` 才重跑，否则以 failed "interrupted" 结算。
  → Review Focus #3（工具调用中途被杀后从 checkpoint 续跑、已完成的搜索不重发）在 1.4.5 上成立。
- **`watchEvents`**：1.3.0 `harness/events.d.ts:184` 与 1.4.5 `Events.WatchEventsAsync` 同形
  （挂载快照 + 每提交一批 + `closed` 终止），无破坏性变化。

结论：**提交、重放、watch、checkpoint 的语义没有漂移**；有影响的是观察面 API 的改名/迁移（第 1、2 条）
与 crash-loop guard（第 5 条）。

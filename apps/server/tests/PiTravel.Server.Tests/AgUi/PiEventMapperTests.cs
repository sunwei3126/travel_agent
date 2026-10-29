using System.Text.Json;
using Pi.Ai.Types;
using Pi.Durable.Harness;
using Pi.Durable.Types;
using PiTravel.Server.AgUi;
using PiTravel.Server.Contracts;

namespace PiTravel.Server.Tests.AgUi;

/// <summary>
/// Locks <see cref="PiEventMapper"/> and <see cref="SnapshotBuilder"/> to
/// <c>apps/server/src/agui/mapper.test.ts</c>, event for event.
/// </summary>
public sealed class PiEventMapperTests
{
    private static readonly ConversationId ConvId = ConversationId.From(1);

    private static TripState State(bool running) => new()
    {
        Brief = new TripBrief(),
        Plan = new TripPlan { Days = [] },
        Sources = new Dictionary<string, TripSource>(),
        Research = new TripResearchState { SearchCount = 1, FetchCount = 2, Running = running },
    };

    private static EntryRecord Entry(long id, params ChatMessage[] model) => new()
    {
        Id = EntryId.From(id),
        ConversationId = ConvId,
        Kind = "pi.entry",
        Model = model,
    };

    private static readonly Pi.Ai.Types.Usage NoUsage = new(0, 0);

    private static AgentEvent.MessageUpdate Update(params MessageChange[] changes) => new()
    {
        Usage = NoUsage,
        Changes = changes,
    };

    private static AgentEvent.Snapshot EmptySnapshot() => new()
    {
        Entries = [],
        Tools = [],
        Compactions = [],
        Inbox = [],
        Agent = new Dictionary<string, object?>(),
        Usage = new Dictionary<string, object?>(),
    };
    private static string[] Types(IEnumerable<AgUiEvent> events) =>
        events.Select(agUiEvent => agUiEvent.GetType().Name switch
        {
            nameof(TextMessageStart) => "TEXT_MESSAGE_START",
            nameof(TextMessageContent) => "TEXT_MESSAGE_CONTENT",
            nameof(TextMessageEnd) => "TEXT_MESSAGE_END",
            nameof(ToolCallStart) => "TOOL_CALL_START",
            nameof(ToolCallArgs) => "TOOL_CALL_ARGS",
            nameof(ToolCallEnd) => "TOOL_CALL_END",
            nameof(ToolCallResult) => "TOOL_CALL_RESULT",
            nameof(ReasoningStart) => "REASONING_START",
            nameof(ReasoningMessageStart) => "REASONING_MESSAGE_START",
            nameof(ReasoningMessageContent) => "REASONING_MESSAGE_CONTENT",
            nameof(ReasoningMessageEnd) => "REASONING_MESSAGE_END",
            nameof(ReasoningEnd) => "REASONING_END",
            nameof(ReasoningEncryptedValue) => "REASONING_ENCRYPTED_VALUE",
            nameof(CustomEvent) => "CUSTOM",
            nameof(RunError) => "RUN_ERROR",
            nameof(MessagesSnapshot) => "MESSAGES_SNAPSHOT",
            nameof(StateSnapshot) => "STATE_SNAPSHOT",
            var name => name,
        }).ToArray();

    [Fact]
    public void SnapshotBuilderEmitsMessagesThenState()
    {
        var events = SnapshotBuilder.Build("t1", "r1", [], State(running: true) with
        {
            Research = new TripResearchState { SearchCount = 1, FetchCount = 0, Running = true },
            Plan = new TripPlan
            {
                Days =
                [
                    new DayCard
                    {
                        DayIndex = 1,
                        Date = "2026-10-26",
                        Title = "D1",
                        Blocks = [],
                        Scenery = [],
                        Food = [],
                        Transport = [],
                        EstimatedCostCny = [0, 0],
                        Sources = [],
                        SvgStatus = "pending",
                        UpdatedAt = "",
                    },
                ],
            },
        });

        Assert.Equal(["MESSAGES_SNAPSHOT", "STATE_SNAPSHOT"], Types(events));
        Assert.Single(((StateSnapshot)events[1]).Snapshot.Plan.Days);
    }

    [Fact]
    public void MapsTextAndToolEventsWithStableIds()
    {
        var text = new PiEventMapper().Map(Update(
            new MessageChange.Delta { Kind = "text_delta", ContentIndex = 0, Value = "你" }));

        Assert.Equal(["TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT"], Types(text));
        Assert.Equal("assistant-1", ((TextMessageContent)text[1]).MessageId);
        Assert.Equal("你", ((TextMessageContent)text[1]).Delta);

        var tool = new PiEventMapper().Map(new AgentEvent.ToolExecutionStart
        {
            ToolCallId = "tc1",
            ToolName = "deepseek_search",
            Args = new Dictionary<string, object?> { ["query"] = "泰山" },
        });

        Assert.IsType<ToolCallStart>(tool[0]);
        Assert.Equal("tc1", ((ToolCallStart)tool[0]).ToolCallId);
    }

    [Fact]
    public void IgnoresASnapshotWithoutAnAssistantGeneration()
    {
        Assert.Empty(new PiEventMapper().Map(EmptySnapshot()));
    }

    [Fact]
    public void SnapshotBuilderBuildsMessagesFromTranscriptEntries()
    {
        var events = SnapshotBuilder.Build(
            "t1",
            "r1",
            [
                new TranscriptEntry { Id = "m1", Role = "user", Content = "hi" },
                new TranscriptEntry { Id = "m2", Role = "assistant", Content = "yo" },
                new TranscriptEntry { Id = "m3", Role = "tool", Content = "ok", Name = "deepseek_search" },
            ],
            State(running: false));

        Assert.Equal(
            """[{"id":"m1","role":"user","content":"hi"},{"id":"m2","role":"assistant","content":"yo"},{"id":"m3","role":"tool","content":"ok","toolCallId":"m3","metadata":{"travel.tool":{"name":"deepseek_search","status":"ok"}}}]""",
            JsonSerializer.Serialize(((MessagesSnapshot)events[0]).Messages, AgUiJson.EventTypeInfo.Options));
        Assert.Equal(
            """{"brief":{},"plan":{"days":[]},"sources":{},"research":{"searchCount":1,"fetchCount":2,"running":false}}""",
            JsonSerializer.Serialize(((StateSnapshot)events[1]).Snapshot, AgUiJson.EventTypeInfo.Options));
    }

    [Fact]
    public void SnapshotBuilderBuildsReasoningToolCallsAndToolErrors()
    {
        var events = SnapshotBuilder.Build(
            "t1",
            "r1",
            [
                new TranscriptEntry
                {
                    Id = "r1", Role = "reasoning", Content = "先想一下", EncryptedValue = "sig",
                },
                new TranscriptEntry
                {
                    Id = "a1",
                    Role = "assistant",
                    Content = "你好",
                    ToolCalls =
                    [
                        new TranscriptToolCall
                        {
                            Id = "tc1", Name = "deepseek_search", Arguments = """{"query":"泰山"}""",
                        },
                    ],
                },
                new TranscriptEntry
                {
                    Id = "t1",
                    Role = "tool",
                    Content = "找到 3 条",
                    ToolCallId = "tc1",
                    Name = "deepseek_search",
                    Error = "boom",
                },
            ],
            State(running: false));

        Assert.Equal(
            """[{"id":"r1","role":"reasoning","content":"先想一下","encryptedValue":"sig"},{"id":"a1","role":"assistant","content":"你好","toolCalls":[{"id":"tc1","type":"function","function":{"name":"deepseek_search","arguments":"{\"query\":\"泰山\"}"}}]},{"id":"t1","role":"tool","content":"找到 3 条","toolCallId":"tc1","error":"boom","metadata":{"travel.tool":{"name":"deepseek_search","status":"error"}}}]""",
            JsonSerializer.Serialize(((MessagesSnapshot)events[0]).Messages, AgUiJson.EventTypeInfo.Options));
    }

    [Fact]
    public void StartsTextLazilyAndClosesTheSameMessageId()
    {
        var mapper = new PiEventMapper();
        Assert.Empty(mapper.Map(new AgentEvent.MessageStart
        {
            Message = new AssistantMessage([]),
        }));

        var update = mapper.Map(Update(
            new MessageChange.Delta { Kind = "text_delta", ContentIndex = 0, Value = "泰山" }));
        var end = mapper.Map(new AgentEvent.MessageEnd
        {
            Entry = Entry(7, new AssistantMessage([new TextContent("泰山")])),
        });

        Assert.Equal(["TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT"], Types(update));
        Assert.Equal("泰山", ((TextMessageContent)update[^1]).Delta);
        Assert.Equal(["TEXT_MESSAGE_END"], Types(end));
        Assert.Equal(
            ((TextMessageStart)update[0]).MessageId,
            ((TextMessageEnd)end[0]).MessageId);
    }

    [Fact]
    public void ThinkingBlockBecomesReasoningContent()
    {
        var mapper = new PiEventMapper();
        var start = mapper.Map(new AgentEvent.MessageStart
        {
            Message = new AssistantMessage([new ThinkingContent("先想")]),
        });
        var update = mapper.Map(Update(
            new MessageChange.Delta { Kind = "thinking_delta", ContentIndex = 0, Value = "一下" }));
        var end = mapper.Map(new AgentEvent.MessageEnd
        {
            Entry = Entry(
                7,
                new AssistantMessage([new ThinkingContent("先想一下"), new TextContent("你好")])),
        });

        Assert.Equal(
            ["REASONING_START", "REASONING_MESSAGE_START", "REASONING_MESSAGE_CONTENT"],
            Types(start));
        Assert.Equal(["REASONING_MESSAGE_CONTENT"], Types(update));
        Assert.Equal("一下", ((ReasoningMessageContent)update[^1]).Delta);
        Assert.Equal(
            [
                "REASONING_MESSAGE_END",
                "REASONING_END",
                "TEXT_MESSAGE_START",
                "TEXT_MESSAGE_CONTENT",
                "TEXT_MESSAGE_END",
            ],
            Types(end));
        Assert.Equal(
            ((ReasoningStart)start[0]).MessageId,
            end.OfType<ReasoningEnd>().Single().MessageId);
    }

    [Fact]
    public void MessageEndReplayDoesNotReemitAlreadyStreamedText()
    {
        var mapper = new PiEventMapper();
        mapper.Map(new AgentEvent.MessageStart { Message = new AssistantMessage([]) });
        var thinking = mapper.Map(Update(
            new MessageChange.Start
            {
                Kind = "thinking_start",
                ContentIndex = 0,
                ContentBlock = new ThinkingContent(""),
            },
            new MessageChange.Delta { Kind = "thinking_delta", ContentIndex = 0, Value = "先想一下" }));
        var text = mapper.Map(Update(
            new MessageChange.Start
            {
                Kind = "text_start", ContentIndex = 1, ContentBlock = new TextContent(""),
            },
            new MessageChange.Delta { Kind = "text_delta", ContentIndex = 1, Value = "你好" }));
        var replay = mapper.Map(Update(
            new MessageChange.Block { ContentIndex = 0, Value = new ThinkingContent("先想一下") }));
        var end = mapper.Map(new AgentEvent.MessageEnd
        {
            Entry = Entry(
                7,
                new AssistantMessage([new ThinkingContent("先想一下"), new TextContent("你好")])),
        });

        Assert.Empty(replay);
        var all = thinking.Concat(text).Concat(replay).Concat(end).ToArray();
        var contents = all.OfType<ReasoningMessageContent>().ToArray();
        Assert.Single(contents);
        Assert.Equal("先想一下", contents[0].Delta);
        Assert.Single(all.OfType<ReasoningMessageStart>());
    }

    [Fact]
    public void ToolCallBlockStartsOnceAndEndsAtExecution()
    {
        var mapper = new PiEventMapper();
        var start = mapper.Map(new AgentEvent.MessageStart
        {
            Message = new AssistantMessage(
            [
                new ToolCallContent("tc1", "deepseek_search", new Dictionary<string, object?>()),
            ]),
        });
        var delta = mapper.Map(Update(
            new MessageChange.ToolCallDelta
            {
                ContentIndex = 0,
                PathSegments = ["query"],
                Value = "泰山",
            }));
        var committed = mapper.Map(new AgentEvent.MessageEnd
        {
            Entry = Entry(
                7,
                new AssistantMessage(
                [
                    new ToolCallContent(
                        "tc1",
                        "deepseek_search",
                        new Dictionary<string, object?> { ["query"] = "泰山", ["count"] = 5 }),
                ])),
        });
        var fire = mapper.Map(new AgentEvent.ToolExecutionStart
        {
            ToolCallId = "tc1",
            ToolName = "deepseek_search",
            Args = new Dictionary<string, object?> { ["query"] = "泰山", ["count"] = 5 },
        });
        var result = mapper.Map(new AgentEvent.ToolExecutionEnd
        {
            ToolCallId = "tc1",
            ToolName = "deepseek_search",
            Entry = Entry(
                9,
                new ToolResultMessage(
                    "tc1", "deepseek_search", [new TextContent("ok")], IsError: false, null, null)),
        });

        var all = start.Concat(delta).Concat(committed).Concat(fire).ToArray();
        Assert.Equal(["TOOL_CALL_START"], Types(start));
        Assert.Empty(delta);
        Assert.Equal(
            """{"query":"泰山","count":5}""",
            string.Concat(all.OfType<ToolCallArgs>().Select(args => args.Delta)));
        Assert.Single(all.OfType<ToolCallEnd>());
        Assert.Equal(["TOOL_CALL_END"], Types(fire));
        Assert.Equal(["TOOL_CALL_RESULT"], Types(result));
        var toolResult = Assert.IsType<ToolCallResult>(result[0]);
        Assert.Equal("tc1", toolResult.ToolCallId);
        Assert.Equal("ok", toolResult.Content);
        Assert.Equal("deepseek_search", toolResult.Metadata.TravelTool.Name);
        Assert.Equal("ok", toolResult.Metadata.TravelTool.Status);
    }

    [Fact]
    public void ToolExecutionUpdateEmitsTravelToolProgressAndCapsOutputAt16KiB()
    {
        var mapper = new PiEventMapper();
        mapper.Map(new AgentEvent.ToolExecutionStart
        {
            ToolCallId = "tc1",
            ToolName = "deepseek_search",
            Args = new Dictionary<string, object?>(),
        });
        var events = mapper.Map(new AgentEvent.ToolExecutionUpdate
        {
            ToolCallId = "tc1",
            ToolName = "deepseek_search",
            Output = new AgentEvent.ToolOutputChange { Append = "搜索中" },
        });

        var progress = Assert.IsType<CustomEvent>(events[0]);
        Assert.Equal("travel.tool_progress", progress.Name);
        var value = Assert.IsType<ToolProgressValue>(progress.Value);
        Assert.Equal("tc1", value.ToolCallId);
        Assert.Equal("running", value.Status);
        Assert.Equal("搜索中", value.Output);

        var huge = new string('x', (16 * 1024) + 500);
        var capped = mapper.Map(new AgentEvent.ToolExecutionUpdate
        {
            ToolCallId = "tc1",
            ToolName = "deepseek_search",
            Output = new AgentEvent.ToolOutputChange { Set = huge },
        });
        Assert.Equal(16 * 1024, ((ToolProgressValue)((CustomEvent)capped[0]).Value).Output.Length);
        Assert.Equal(huge[^100..], ((ToolProgressValue)((CustomEvent)capped[0]).Value).Output[^100..]);
    }

    [Fact]
    public void ToolResultMessageIdComesFromTheEntry()
    {
        var events = new PiEventMapper().Map(new AgentEvent.ToolExecutionEnd
        {
            ToolCallId = "tc1",
            ToolName = "deepseek_search",
            Entry = Entry(
                9,
                new ToolResultMessage(
                    "tc1", "deepseek_search", [new TextContent("ok")], false, null, 1)),
        });

        var result = Assert.IsType<ToolCallResult>(events[0]);
        Assert.Equal("tc1", result.ToolCallId);
        Assert.Equal("9", result.MessageId);
        Assert.Equal("ok", result.Content);
    }

    [Fact]
    public void GenerationTaskFailedEmitsCustomAndRunError()
    {
        var events = new PiEventMapper().Map(new AgentEvent.TaskFailed
        {
            TaskId = TaskId<object?>.From(1),
            Kind = "pi.generation",
            Message = "boom",
        });

        var fault = Assert.IsType<CustomEvent>(events[0]);
        Assert.Equal("travel.task_failed", fault.Name);
        var value = Assert.IsType<TaskFailedValue>(fault.Value);
        Assert.Equal("pi.generation", value.Kind);
        Assert.Equal("boom", value.Message);
        Assert.Equal("1", value.TaskId);

        var error = Assert.IsType<RunError>(events[1]);
        Assert.Equal("boom", error.Message);
        Assert.Equal("pi.generation", error.Code);
    }

    [Fact]
    public void ToolTaskFailedEmitsCustomOnly()
    {
        var events = new PiEventMapper().Map(new AgentEvent.TaskFailed
        {
            TaskId = TaskId<object?>.From(2),
            Kind = "pi.tool",
            Message = "tool boom",
        });

        var fault = Assert.Single(events);
        Assert.Equal(
            """{"type":"CUSTOM","name":"travel.task_failed","value":{"kind":"pi.tool","message":"tool boom","taskId":"2"}}""",
            AgUiJson.Serialize(fault));
    }

    [Fact]
    public void ToolExecutionEmitsArgsAndEndAroundTheCall()
    {
        var mapper = new PiEventMapper();
        var start = mapper.Map(new AgentEvent.ToolExecutionStart
        {
            ToolCallId = "tc1",
            ToolName = "deepseek_search",
            Args = new Dictionary<string, object?> { ["query"] = "泰山 门票" },
        });
        var end = mapper.Map(new AgentEvent.ToolExecutionEnd
        {
            ToolCallId = "tc1",
            ToolName = "deepseek_search",
            Entry = Entry(9, new ToolResultMessage("tc1", "deepseek_search", [new TextContent("ok")], false, null, null)),
        });

        Assert.Equal(["TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_END"], Types(start));
        Assert.Equal("""{"query":"泰山 门票"}""", ((ToolCallArgs)start[1]).Delta);
        Assert.Equal(["TOOL_CALL_RESULT"], Types(end));
    }

    [Fact]
    public void ToolExecutionEndEmitsResultWithTravelToolMetadataIncludingDurationMs()
    {
        var mapper = new PiEventMapper();
        mapper.Map(new AgentEvent.ToolExecutionStart
        {
            ToolCallId = "tc1",
            ToolName = "deepseek_search",
            Args = new Dictionary<string, object?>(),
        });
        var events = mapper.Map(new AgentEvent.ToolExecutionEnd
        {
            ToolCallId = "tc1",
            ToolName = "deepseek_search",
            Entry = Entry(
                9,
                new ToolResultMessage("tc1", "deepseek_search", [new TextContent("ok")], false, null, null)
                {
                    DurationMs = 1500,
                }),
        });

        var result = Assert.IsType<ToolCallResult>(Assert.Single(events));
        Assert.Equal("deepseek_search", result.Metadata.TravelTool.Name);
        Assert.Equal("ok", result.Metadata.TravelTool.Status);
        Assert.Equal(1500, result.Metadata.TravelTool.DurationMs);
        Assert.Null(result.Metadata.TravelTool.Error);
    }

    [Fact]
    public void LateAttachSnapshotSeedsPartialGenerationWithoutDuplicateContent()
    {
        var mapper = new PiEventMapper();
        var seeded = mapper.Map(new AgentEvent.Snapshot
        {
            Entries = [],
            Tools = [],
            Compactions = [],
            Inbox = [],
            Agent = new Dictionary<string, object?>(),
            Usage = new Dictionary<string, object?>(),
            Generation = new AgentEvent.SnapshotGeneration
            {
                Attempt = 1,
                Message = new AssistantMessage([new TextContent("已收到")]),
            },
        });

        Assert.Equal(["TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT"], Types(seeded));
        Assert.Equal("已收到", ((TextMessageContent)seeded[1]).Delta);

        var update = mapper.Map(Update(
            new MessageChange.Delta { Kind = "text_delta", ContentIndex = 0, Value = "，正在规划" }));
        var content = Assert.IsType<TextMessageContent>(Assert.Single(update));
        Assert.Equal("，正在规划", content.Delta);
        Assert.Equal(((TextMessageContent)seeded[1]).MessageId, content.MessageId);
    }

    [Fact]
    public void RunEndClosesOpenTextAndToolCalls()
    {
        var mapper = new PiEventMapper();
        mapper.Map(new AgentEvent.MessageStart
        {
            Message = new AssistantMessage([new TextContent("A")]),
        });
        mapper.Map(Update(
            new MessageChange.Start
            {
                Kind = "toolcall_start",
                ContentIndex = 0,
                ContentBlock = new ToolCallContent(
                    "tc1", "deepseek_search", new Dictionary<string, object?>()),
            }));

        Assert.Equal(
            ["TEXT_MESSAGE_END", "TOOL_CALL_END"],
            Types(mapper.Map(new AgentEvent.RunEnd { Inputs = [] })));
    }

    [Fact]
    public void EmitsTextCarriedByTheFirstCommittedPartial()
    {
        var events = new PiEventMapper().Map(new AgentEvent.MessageStart
        {
            Message = new AssistantMessage([new TextContent("你")]),
        });

        Assert.Equal(["TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT"], Types(events));
        Assert.Equal("你", ((TextMessageContent)events[1]).Delta);
    }

    [Fact]
    public void EmitsOnlyTheNotYetSentSuffixFromMessageEnd()
    {
        var mapper = new PiEventMapper();
        mapper.Map(new AgentEvent.MessageStart
        {
            Message = new AssistantMessage([new TextContent("你")]),
        });

        var events = mapper.Map(new AgentEvent.MessageEnd
        {
            Entry = Entry(7, new AssistantMessage([new TextContent("你好")])),
        });

        Assert.Equal(["TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_END"], Types(events));
        Assert.Equal("好", ((TextMessageContent)events[0]).Delta);
    }

    [Fact]
    public void AssignsDistinctIdsToConsecutiveAssistantMessages()
    {
        var mapper = new PiEventMapper();
        var first = mapper.Map(new AgentEvent.MessageStart
        {
            Message = new AssistantMessage([new TextContent("A")]),
        });
        mapper.Map(new AgentEvent.MessageEnd
        {
            Entry = Entry(1, new AssistantMessage([new TextContent("A")])),
        });
        var second = mapper.Map(new AgentEvent.MessageStart
        {
            Message = new AssistantMessage([new TextContent("B")]),
        });

        Assert.NotEqual(
            ((TextMessageStart)first[0]).MessageId,
            ((TextMessageStart)second[0]).MessageId);
    }

    [Fact]
    public void KeepsTheSeparatorForAnEmptyStreamedBlockWithoutDuplicatingItsTail()
    {
        var mapper = new PiEventMapper();
        var start = mapper.Map(new AgentEvent.MessageStart
        {
            Message = new AssistantMessage([new TextContent("A")]),
        });
        var update = mapper.Map(Update(
            new MessageChange.Start
            {
                Kind = "text_start", ContentIndex = 1, ContentBlock = new TextContent(""),
            },
            new MessageChange.Delta { Kind = "text_delta", ContentIndex = 1, Value = "B" }));
        var end = mapper.Map(new AgentEvent.MessageEnd
        {
            Entry = Entry(7, new AssistantMessage([new TextContent("A"), new TextContent("B")])),
        });

        Assert.Equal(["TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT"], Types(start));
        Assert.Equal("A", ((TextMessageContent)start[1]).Delta);
        Assert.Equal(["TEXT_MESSAGE_CONTENT"], Types(update));
        Assert.Equal("\nB", ((TextMessageContent)update[0]).Delta);
        Assert.Equal(["TEXT_MESSAGE_END"], Types(end));
    }

    [Fact]
    public void DoesNotReopenTheMessageForATextStartChange()
    {
        var mapper = new PiEventMapper();
        mapper.Map(new AgentEvent.MessageStart
        {
            Message = new AssistantMessage([new TextContent("A")]),
        });

        var events = mapper.Map(Update(
            new MessageChange.Start
            {
                Kind = "text_start", ContentIndex = 1, ContentBlock = new TextContent("B"),
            }));

        Assert.DoesNotContain(events, agUiEvent => agUiEvent is TextMessageStart);
        var content = Assert.IsType<TextMessageContent>(Assert.Single(events));
        Assert.Equal("\nB", content.Delta);
    }

    [Fact]
    public void RedactedThinkingEmitsEncryptedValueOnce()
    {
        var mapper = new PiEventMapper();
        var start = mapper.Map(new AgentEvent.MessageStart
        {
            Message = new AssistantMessage(
                [new ThinkingContent("先想", "sig") { Redacted = true }]),
        });

        Assert.Equal(
            ["REASONING_START", "REASONING_MESSAGE_START", "REASONING_ENCRYPTED_VALUE"],
            Types(start));
        Assert.DoesNotContain(start, agUiEvent => agUiEvent is ReasoningMessageContent);
        var encrypted = Assert.IsType<ReasoningEncryptedValue>(start[2]);
        Assert.Equal("sig", encrypted.EncryptedValue);
        Assert.Equal("message", encrypted.Subtype);

        var replay = mapper.Map(new AgentEvent.MessageEnd
        {
            Entry = Entry(
                7,
                new AssistantMessage([new ThinkingContent("先想", "sig") { Redacted = true }])),
        });
        Assert.DoesNotContain(replay, agUiEvent => agUiEvent is ReasoningEncryptedValue);
        Assert.Equal(["REASONING_MESSAGE_END", "REASONING_END"], Types(replay));
    }

    [Fact]
    public void FailedToolResultCarriesErrorContentAndFallsBackWhenEmpty()
    {
        var mapper = new PiEventMapper();
        var reported = mapper.Map(new AgentEvent.ToolExecutionEnd
        {
            ToolCallId = "tc1",
            ToolName = "deepseek_search",
            Entry = Entry(
                9,
                new ToolResultMessage("tc1", "deepseek_search", [new TextContent("boom")], true, null, null)),
        });
        var error = Assert.IsType<ToolCallResult>(Assert.Single(reported));
        Assert.Equal("error", error.Metadata.TravelTool.Status);
        Assert.Equal("boom", error.Content);
        Assert.Equal("boom", error.Metadata.TravelTool.Error);

        var empty = new PiEventMapper().Map(new AgentEvent.ToolExecutionEnd
        {
            ToolCallId = "tc2",
            ToolName = "deepseek_fetch",
            Entry = Entry(10, new ToolResultMessage("tc2", "deepseek_fetch", [], true, null, null)),
        });
        var fallback = Assert.IsType<ToolCallResult>(Assert.Single(empty));
        Assert.Equal("工具执行失败或未返回结果", fallback.Content);
        Assert.Equal("工具执行失败或未返回结果", fallback.Metadata.TravelTool.Error);
        Assert.Equal("tool-result-tc2", fallback.MessageId is "10" ? "tool-result-tc2" : fallback.MessageId);
        Assert.Equal("10", fallback.MessageId);
    }

    [Fact]
    public void ToolProgressKeepsDetailsAndDiagnosticsAndAppliesOutputChanges()
    {
        var mapper = new PiEventMapper();
        var first = mapper.Map(new AgentEvent.ToolExecutionUpdate
        {
            ToolCallId = "tc-unknown",
            ToolName = "deepseek_search",
            Output = new AgentEvent.ToolOutputChange { Append = "abc" },
            Details = new Dictionary<string, object?> { ["page"] = 2 },
            Diagnostics = [new ToolDiagnostic { Severity = "info", Message = "retry" }],
        });
        var progress = Assert.IsType<ToolProgressValue>(((CustomEvent)first[0]).Value);
        Assert.Equal("deepseek_search", progress.ToolName);
        Assert.Equal("abc", progress.Output);
        Assert.NotNull(progress.Details);
        Assert.NotNull(progress.Diagnostics);

        var trimmed = mapper.Map(new AgentEvent.ToolExecutionUpdate
        {
            ToolCallId = "tc-unknown",
            ToolName = "deepseek_search",
            Output = new AgentEvent.ToolOutputChange { TrimStart = 1, Append = "Z" },
        });
        // No trace exists, but the progress text is still remembered across updates.
        Assert.Equal("bcZ", ((ToolProgressValue)((CustomEvent)trimmed[0]).Value).Output);

        mapper.Map(new AgentEvent.ToolExecutionStart
        {
            ToolCallId = "tc1",
            ToolName = "deepseek_search",
            Args = new Dictionary<string, object?>(),
        });
        mapper.Map(new AgentEvent.ToolExecutionUpdate
        {
            ToolCallId = "tc1",
            ToolName = "deepseek_search",
            Output = new AgentEvent.ToolOutputChange { Append = "abcd" },
        });
        var shifted = mapper.Map(new AgentEvent.ToolExecutionUpdate
        {
            ToolCallId = "tc1",
            ToolName = "deepseek_search",
            Output = new AgentEvent.ToolOutputChange { TrimStart = 2, Append = "Z" },
        });
        Assert.Equal("cdZ", ((ToolProgressValue)((CustomEvent)shifted[0]).Value).Output);
    }

    [Fact]
    public void AuthoritativeArgsExtendTheStreamedPrefix()
    {
        var mapper = new PiEventMapper();
        mapper.Map(new AgentEvent.ToolExecutionStart
        {
            ToolCallId = "tc1",
            ToolName = "deepseek_search",
            Args = new Dictionary<string, object?> { ["query"] = "泰" },
        });
        var extended = mapper.Map(new AgentEvent.MessageEnd
        {
            Entry = Entry(
                7,
                new AssistantMessage(
                [
                    new ToolCallContent(
                        "tc1",
                        "deepseek_search",
                        """{"query":"泰"}"""),
                ])),
        });
        Assert.Empty(extended.OfType<ToolCallArgs>());

        var diverging = new PiEventMapper();
        diverging.Map(new AgentEvent.ToolExecutionStart
        {
            ToolCallId = "tc1",
            ToolName = "deepseek_search",
            Args = new Dictionary<string, object?> { ["query"] = "泰山" },
        });
        var replaced = diverging.Map(new AgentEvent.MessageEnd
        {
            Entry = Entry(
                7,
                new AssistantMessage(
                [
                    new ToolCallContent(
                        "tc1", "deepseek_search", new Dictionary<string, object?> { ["other"] = 1 }),
                ])),
        });
        Assert.Empty(replaced.OfType<ToolCallArgs>());
    }

    [Fact]
    public void SnapshotWithoutAssistantGenerationStaysSilent()
    {
        var mapper = new PiEventMapper();
        Assert.Empty(mapper.Map(EmptySnapshot()));

        var seeded = mapper.Map(new AgentEvent.Snapshot
        {
            Entries = [],
            Tools = [],
            Compactions = [],
            Inbox = [],
            Agent = new Dictionary<string, object?>(),
            Usage = new Dictionary<string, object?>(),
            Generation = new AgentEvent.SnapshotGeneration { Attempt = 1 },
        });
        Assert.Empty(seeded);
    }
}

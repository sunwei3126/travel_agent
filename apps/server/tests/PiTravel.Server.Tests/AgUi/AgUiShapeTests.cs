using PiTravel.Server.AgUi;
using PiTravel.Server.Contracts;

namespace PiTravel.Server.Tests.AgUi;

/// <summary>
/// Locks the AG-UI wire shape to the fixtures in
/// <c>apps/server/src/agui/mapper.test.ts</c>: camelCase keys, optional fields omitted,
/// and the exact payloads the frontend consumes.
/// </summary>
public sealed class AgUiShapeTests
{
    private static string Json(AgUiEvent agUiEvent) => AgUiJson.Serialize(agUiEvent);

    [Fact]
    public void RunStartedSerializesToTheSharedShape()
    {
        var json = Json(new RunStarted("t1", "r1"));

        Assert.Equal(
            """{"type":"RUN_STARTED","threadId":"t1","runId":"r1"}""",
            json);
    }

    [Fact]
    public void RunFinishedSerializesToTheSharedShape()
    {
        var json = Json(new RunFinished("t1", "r1"));

        Assert.Equal(
            """{"type":"RUN_FINISHED","threadId":"t1","runId":"r1"}""",
            json);
    }

    [Fact]
    public void RunErrorOmitsCodeWhenAbsent()
    {
        Assert.Equal(
            """{"type":"RUN_ERROR","message":"boom"}""",
            Json(new RunError("boom")));
        Assert.Equal(
            """{"type":"RUN_ERROR","message":"boom","code":"pi.generation"}""",
            Json(new RunError("boom", "pi.generation")));
    }

    [Fact]
    public void TextMessageEventsSerializeToTheSharedShape()
    {
        Assert.Equal(
            """{"type":"TEXT_MESSAGE_START","messageId":"m1"}""",
            Json(new TextMessageStart("m1")));
        Assert.Equal(
            """{"type":"TEXT_MESSAGE_CONTENT","messageId":"m1","delta":"你"}""",
            Json(new TextMessageContent("m1", "你")));
        Assert.Equal(
            """{"type":"TEXT_MESSAGE_END","messageId":"m1"}""",
            Json(new TextMessageEnd("m1")));
    }

    [Fact]
    public void ToolCallEventsSerializeToTheSharedShape()
    {
        Assert.Equal(
            """{"type":"TOOL_CALL_START","toolCallId":"tc1","toolCallName":"deepseek_search"}""",
            Json(new ToolCallStart("tc1", "deepseek_search")));
        Assert.Equal(
            """{"type":"TOOL_CALL_START","toolCallId":"tc1","toolCallName":"deepseek_search","parentMessageId":"m1"}""",
            Json(new ToolCallStart("tc1", "deepseek_search", "m1")));
        Assert.Equal(
            """{"type":"TOOL_CALL_ARGS","toolCallId":"tc1","delta":"{\"query\":\"泰山 门票\"}"}""",
            Json(new ToolCallArgs("tc1", """{"query":"泰山 门票"}""")));
        Assert.Equal(
            """{"type":"TOOL_CALL_END","toolCallId":"tc1"}""",
            Json(new ToolCallEnd("tc1")));
    }

    [Fact]
    public void ToolCallResultCarriesTravelToolMetadata()
    {
        var json = Json(new ToolCallResult(
            "9",
            "tc1",
            "ok",
            new AgUiMetadata(new TravelToolMetadata("deepseek_search", "ok"))));

        Assert.Equal(
            """{"type":"TOOL_CALL_RESULT","messageId":"9","toolCallId":"tc1","content":"ok","metadata":{"travel.tool":{"name":"deepseek_search","status":"ok"}}}""",
            json);
    }

    [Fact]
    public void ToolCallResultCarriesErrorTaskAndDuration()
    {
        var json = Json(new ToolCallResult(
            "9",
            "tc1",
            "工具执行失败或未返回结果",
            new AgUiMetadata(new TravelToolMetadata(
                "deepseek_search",
                "error",
                "工具执行失败或未返回结果",
                "42",
                "parent-1",
                1500))));

        Assert.Equal(
            """{"type":"TOOL_CALL_RESULT","messageId":"9","toolCallId":"tc1","content":"工具执行失败或未返回结果","metadata":{"travel.tool":{"name":"deepseek_search","status":"error","error":"工具执行失败或未返回结果","taskId":"42","parentToolCallId":"parent-1","durationMs":1500}}}""",
            json);
    }

    [Fact]
    public void ReasoningEventsSerializeToTheSharedShape()
    {
        Assert.Equal(
            """{"type":"REASONING_START","messageId":"assistant-1-thinking-0-span"}""",
            Json(new ReasoningStart("assistant-1-thinking-0-span")));
        Assert.Equal(
            """{"type":"REASONING_MESSAGE_START","messageId":"assistant-1-thinking-0","role":"reasoning"}""",
            Json(new ReasoningMessageStart("assistant-1-thinking-0")));
        Assert.Equal(
            """{"type":"REASONING_MESSAGE_CONTENT","messageId":"assistant-1-thinking-0","delta":"先想"}""",
            Json(new ReasoningMessageContent("assistant-1-thinking-0", "先想")));
        Assert.Equal(
            """{"type":"REASONING_MESSAGE_END","messageId":"assistant-1-thinking-0"}""",
            Json(new ReasoningMessageEnd("assistant-1-thinking-0")));
        Assert.Equal(
            """{"type":"REASONING_END","messageId":"assistant-1-thinking-0-span"}""",
            Json(new ReasoningEnd("assistant-1-thinking-0-span")));
    }

    [Fact]
    public void ReasoningEncryptedValueSerializesToTheSharedShape()
    {
        var json = Json(new ReasoningEncryptedValue("assistant-1-thinking-0", "sig"));

        Assert.Equal(
            """{"type":"REASONING_ENCRYPTED_VALUE","subtype":"message","entityId":"assistant-1-thinking-0","encryptedValue":"sig"}""",
            json);
    }

    [Fact]
    public void TravelToolProgressSerializesToTheSharedShape()
    {
        var json = Json(new CustomEvent(
            "travel.tool_progress",
            new ToolProgressValue("tc1", "deepseek_search", "running", "搜索中")));

        Assert.Equal(
            """{"type":"CUSTOM","name":"travel.tool_progress","value":{"toolCallId":"tc1","toolName":"deepseek_search","status":"running","output":"搜索中"}}""",
            json);
    }

    [Fact]
    public void TravelToolProgressKeepsDetailsAndDiagnostics()
    {
        var json = Json(new CustomEvent(
            "travel.tool_progress",
            new ToolProgressValue(
                "tc1",
                "deepseek_search",
                "running",
                "搜索中",
                new { page = 2 },
                new[] { new { severity = "info", message = "retry" } })));

        Assert.Equal(
            """{"type":"CUSTOM","name":"travel.tool_progress","value":{"toolCallId":"tc1","toolName":"deepseek_search","status":"running","output":"搜索中","details":{"page":2},"diagnostics":[{"severity":"info","message":"retry"}]}}""",
            json);
    }

    [Fact]
    public void TravelTaskFailedSerializesToTheSharedShape()
    {
        var json = Json(new CustomEvent(
            "travel.task_failed",
            new TaskFailedValue("pi.generation", "boom", "1")));

        Assert.Equal(
            """{"type":"CUSTOM","name":"travel.task_failed","value":{"kind":"pi.generation","message":"boom","taskId":"1"}}""",
            json);
    }

    [Fact]
    public void TravelTaskFailedOmitsTaskIdWhenAbsent()
    {
        var json = Json(new CustomEvent(
            "travel.task_failed",
            new TaskFailedValue("unknown", "Task failed")));

        Assert.Equal(
            """{"type":"CUSTOM","name":"travel.task_failed","value":{"kind":"unknown","message":"Task failed"}}""",
            json);
    }

    [Fact]
    public void MessagesSnapshotSerializesTranscriptEntries()
    {
        var json = Json(new MessagesSnapshot(
        [
            new AgUiMessage("m1", "user", "hi"),
            new AgUiMessage("m2", "assistant", "yo"),
            new AgUiMessage(
                "m3",
                "tool",
                "ok",
                ToolCallId: "m3",
                Metadata: new AgUiMetadata(new TravelToolMetadata("deepseek_search", "ok"))),
        ]));

        Assert.Equal(
            """{"type":"MESSAGES_SNAPSHOT","messages":[{"id":"m1","role":"user","content":"hi"},{"id":"m2","role":"assistant","content":"yo"},{"id":"m3","role":"tool","content":"ok","toolCallId":"m3","metadata":{"travel.tool":{"name":"deepseek_search","status":"ok"}}}]}""",
            json);
    }

    [Fact]
    public void MessagesSnapshotCarriesReasoningToolCallsAndToolErrors()
    {
        var json = Json(new MessagesSnapshot(
        [
            new AgUiMessage("r1", "reasoning", "先想一下", EncryptedValue: "sig"),
            new AgUiMessage(
                "a1",
                "assistant",
                "你好",
                ToolCalls:
                [
                    new AgUiToolCall(
                        "tc1",
                        new AgUiFunctionCall("deepseek_search", """{"query":"泰山"}""")),
                ]),
            new AgUiMessage(
                "t1",
                "tool",
                "找到 3 条",
                ToolCallId: "tc1",
                Error: "boom",
                Metadata: new AgUiMetadata(new TravelToolMetadata("deepseek_search", "error"))),
        ]));

        Assert.Equal(
            """{"type":"MESSAGES_SNAPSHOT","messages":[{"id":"r1","role":"reasoning","content":"先想一下","encryptedValue":"sig"},{"id":"a1","role":"assistant","content":"你好","toolCalls":[{"id":"tc1","type":"function","function":{"name":"deepseek_search","arguments":"{\"query\":\"泰山\"}"}}]},{"id":"t1","role":"tool","content":"找到 3 条","toolCallId":"tc1","error":"boom","metadata":{"travel.tool":{"name":"deepseek_search","status":"error"}}}]}""",
            json);
    }

    [Fact]
    public void MessagesSnapshotOmitsEmptyAssistantContent()
    {
        var json = Json(new MessagesSnapshot([new AgUiMessage("a1", "assistant", "")]));

        Assert.Equal(
            """{"type":"MESSAGES_SNAPSHOT","messages":[{"id":"a1","role":"assistant"}]}""",
            json);
    }

    [Fact]
    public void StateSnapshotNestsRunningInsideResearch()
    {
        var json = Json(new StateSnapshot(new TripState
        {
            Brief = new TripBrief(),
            Plan = new TripPlan { Days = [] },
            Sources = new Dictionary<string, TripSource>(),
            Research = new TripResearchState
            {
                SearchCount = 1,
                FetchCount = 2,
                Running = false,
            },
        }));

        Assert.Equal(
            """{"type":"STATE_SNAPSHOT","snapshot":{"brief":{},"plan":{"days":[]},"sources":{},"research":{"searchCount":1,"fetchCount":2,"running":false}}}""",
            json);
    }
}

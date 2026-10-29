using Pi.Ai.Types;
using Pi.Durable.Types;
using PiTravel.Server.Harness;

namespace PiTravel.Server.Tests.Harness;

/// <summary>
/// Locks <see cref="TranscriptBuilder"/> to <c>apps/server/src/harness/transcript.ts</c>:
/// thinking blocks become reasoning entries, tool results surface error text, empty
/// assistant messages are skipped, and tool-call arguments are JSON-serialized.
/// </summary>
public sealed class TranscriptBuilderTests
{
    private static readonly ConversationId ConvId = ConversationId.From(1);

    [Fact]
    public void TranscriptBuilderEmitsThinkingAsReasoningEntry()
    {
        var entries = new[]
        {
            new EntryRecord
            {
                Id = EntryId.From(1),
                ConversationId = ConvId,
                Kind = "pi.assistant",
                Model =
                [
                    new AssistantMessage(
                    [
                        new ThinkingContent("先想一下", "sig-redacted") { Redacted = true },
                        new ThinkingContent("再想一下", "sig-plain"),
                        new TextContent("你好"),
                    ]),
                ],
            },
        };

        var transcript = TranscriptBuilder.FromEntries(entries);

        Assert.Equal(3, transcript.Count);
        Assert.Equal("1-thinking-0", transcript[0].Id);
        Assert.Equal("reasoning", transcript[0].Role);
        Assert.Equal("先想一下", transcript[0].Content);
        Assert.Equal("sig-redacted", transcript[0].EncryptedValue);

        Assert.Equal("1-thinking-1", transcript[1].Id);
        Assert.Equal("reasoning", transcript[1].Role);
        Assert.Equal("再想一下", transcript[1].Content);
        Assert.Null(transcript[1].EncryptedValue);

        Assert.Equal("1", transcript[2].Id);
        Assert.Equal("assistant", transcript[2].Role);
        Assert.Equal("你好", transcript[2].Content);
    }

    [Fact]
    public void TranscriptBuilderEmitsToolResultWithError()
    {
        var entries = new[]
        {
            new EntryRecord
            {
                Id = EntryId.From(2),
                ConversationId = ConvId,
                Kind = "pi.tool-result",
                Model =
                [
                    new ToolResultMessage(
                        "tc1",
                        "deepseek_search",
                        [new TextContent("找到 3 条")],
                        IsError: true,
                        Details: null,
                        Timestamp: null),
                ],
            },
            new EntryRecord
            {
                Id = EntryId.From(3),
                ConversationId = ConvId,
                Kind = "pi.tool-result",
                Model =
                [
                    new ToolResultMessage(
                        "tc2",
                        "deepseek_fetch",
                        [],
                        IsError: true,
                        Details: null,
                        Timestamp: null),
                ],
            },
        };

        var transcript = TranscriptBuilder.FromEntries(entries);

        Assert.Equal(2, transcript.Count);
        Assert.Equal("2", transcript[0].Id);
        Assert.Equal("tool", transcript[0].Role);
        Assert.Equal("tc1", transcript[0].ToolCallId);
        Assert.Equal("deepseek_search", transcript[0].Name);
        Assert.Equal("找到 3 条", transcript[0].Content);
        Assert.Equal("找到 3 条", transcript[0].Error);

        Assert.Equal("3", transcript[1].Id);
        Assert.Equal("tool", transcript[1].Role);
        Assert.Equal("tc2", transcript[1].ToolCallId);
        Assert.Equal("deepseek_fetch", transcript[1].Name);
        Assert.Equal("", transcript[1].Content);
        Assert.Equal("工具执行失败", transcript[1].Error);
    }

    [Fact]
    public void TranscriptBuilderSkipsAssistantWithNoContentAndNoToolCalls()
    {
        var entries = new[]
        {
            new EntryRecord
            {
                Id = EntryId.From(1),
                ConversationId = ConvId,
                Kind = "pi.user",
                Model = [Messages.UserText("泰山三日游")],
            },
            new EntryRecord
            {
                Id = EntryId.From(2),
                ConversationId = ConvId,
                Kind = "pi.assistant",
                Model =
                [
                    new AssistantMessage([new ThinkingContent("仅思考无正文", null)]),
                ],
            },
        };

        var transcript = TranscriptBuilder.FromEntries(entries);

        Assert.Equal(2, transcript.Count);
        Assert.Equal("user", transcript[0].Role);
        Assert.Equal("泰山三日游", transcript[0].Content);
        Assert.Equal("reasoning", transcript[1].Role);
        Assert.DoesNotContain(transcript, entry => entry.Role == "assistant");
    }

    [Fact]
    public void TranscriptBuilderSerializesToolCallArguments()
    {
        var entries = new[]
        {
            new EntryRecord
            {
                Id = EntryId.From(1),
                ConversationId = ConvId,
                Kind = "pi.assistant",
                Model =
                [
                    new AssistantMessage(
                    [
                        new ToolCallContent(
                            "tc1",
                            "deepseek_search",
                            new Dictionary<string, object?> { ["query"] = "泰山" }),
                    ]),
                ],
            },
        };

        var transcript = TranscriptBuilder.FromEntries(entries);

        var assistant = Assert.Single(transcript);
        Assert.Equal("1", assistant.Id);
        Assert.Equal("assistant", assistant.Role);
        Assert.Equal("", assistant.Content);
        var call = Assert.Single(assistant.ToolCalls!);
        Assert.Equal("tc1", call.Id);
        Assert.Equal("deepseek_search", call.Name);
        Assert.Equal("""{"query":"泰山"}""", call.Arguments);
    }
}

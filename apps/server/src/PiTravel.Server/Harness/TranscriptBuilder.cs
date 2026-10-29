using System.Globalization;
using System.Text.Encodings.Web;
using System.Text.Json;
using Pi.Ai.Types;
using Pi.Ai.Utils;
using Pi.Durable.Types;
using PiTravel.Server.Contracts;

namespace PiTravel.Server.Harness;

/// <summary>
/// Converts committed conversation entries into the shared UI-facing transcript shape,
/// mirroring <c>apps/server/src/harness/transcript.ts</c>.
/// </summary>
public static class TranscriptBuilder
{
    private static readonly JsonSerializerOptions ArgumentsJsonOptions = new(TripJson.Options)
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    public static IReadOnlyList<TranscriptEntry> FromEntries(IEnumerable<EntryRecord> entries)
    {
        var result = new List<TranscriptEntry>();

        foreach (var entry in entries)
        {
            if (entry.Model is not { Count: > 0 } model || model[0] is not { } message)
            {
                continue;
            }

            var id = entry.Id.Value.ToString(CultureInfo.InvariantCulture);

            switch (message)
            {
                case UserMessage user:
                    result.Add(new TranscriptEntry
                    {
                        Id = id,
                        Role = "user",
                        Content = Text.ContentText(user.Content),
                    });
                    break;

                case ToolResultMessage toolResult:
                {
                    var content = Text.ContentText(toolResult.Content);
                    result.Add(new TranscriptEntry
                    {
                        Id = id,
                        Role = "tool",
                        Content = content,
                        ToolCallId = string.IsNullOrEmpty(toolResult.ToolCallId) ? id : toolResult.ToolCallId,
                        Name = string.IsNullOrEmpty(toolResult.ToolName) ? null : toolResult.ToolName,
                        Error = toolResult.IsError
                            ? (content.Length > 0 ? content : "工具执行失败")
                            : null,
                    });
                    break;
                }

                case AssistantMessage assistant:
                {
                    var blocks = assistant.Content ?? [];
                    var toolCalls = new List<TranscriptToolCall>();

                    for (var index = 0; index < blocks.Count; index++)
                    {
                        switch (blocks[index])
                        {
                            case ThinkingContent { Thinking: { } thinking } thinkingBlock:
                                result.Add(new TranscriptEntry
                                {
                                    Id = $"{id}-thinking-{index}",
                                    Role = "reasoning",
                                    Content = thinking,
                                    EncryptedValue = thinkingBlock.Redacted == true &&
                                                     thinkingBlock.Signature is { } signature
                                        ? signature
                                        : null,
                                });
                                break;

                            case ToolCallContent { Id: { } toolCallId, Name: { } name } toolCall:
                                toolCalls.Add(new TranscriptToolCall
                                {
                                    Id = toolCallId,
                                    Name = name,
                                    Arguments = SerializeArguments(toolCall.Arguments),
                                });
                                break;
                        }
                    }

                    var content = Text.ContentText(blocks);
                    if (content.Length > 0 || toolCalls.Count > 0)
                    {
                        result.Add(new TranscriptEntry
                        {
                            Id = id,
                            Role = "assistant",
                            Content = content,
                            ToolCalls = toolCalls.Count > 0 ? toolCalls : null,
                        });
                    }

                    break;
                }
            }
        }

        return result;
    }

    private static string SerializeArguments(object? arguments) => arguments switch
    {
        null => "{}",
        string raw => raw,
        _ => JsonSerializer.Serialize(arguments, ArgumentsJsonOptions),
    };
}

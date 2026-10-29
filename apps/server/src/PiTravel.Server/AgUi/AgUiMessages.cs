using PiTravel.Server.Contracts;

namespace PiTravel.Server.AgUi;

/// <summary>
/// Converts shared transcript entries into the AG-UI message shape, mirroring
/// <c>toAguiMessages</c> in <c>apps/server/src/agui/mapper.ts</c>.
/// </summary>
public static class AgUiMessages
{
    public static IReadOnlyList<AgUiMessage> FromTranscript(IEnumerable<TranscriptEntry> entries)
    {
        var messages = new List<AgUiMessage>();
        foreach (var entry in entries)
        {
            messages.Add(entry.Role switch
            {
                "reasoning" => new AgUiMessage(
                    entry.Id,
                    "reasoning",
                    entry.Content,
                    EncryptedValue: entry.EncryptedValue),
                "tool" => new AgUiMessage(
                    entry.Id,
                    "tool",
                    entry.Content,
                    ToolCallId: entry.ToolCallId ?? entry.Id,
                    Error: entry.Error,
                    Metadata: entry.Name is null
                        ? null
                        : new AgUiMetadata(new TravelToolMetadata(
                            entry.Name,
                            entry.Error is null ? "ok" : "error"))),
                "user" => new AgUiMessage(entry.Id, "user", entry.Content),
                _ => new AgUiMessage(
                    entry.Id,
                    "assistant",
                    entry.Content,
                    ToolCalls: entry.ToolCalls is { Count: > 0 } toolCalls
                        ? toolCalls
                            .Select(toolCall => new AgUiToolCall(
                                toolCall.Id,
                                new AgUiFunctionCall(toolCall.Name, toolCall.Arguments)))
                            .ToArray()
                        : null),
            });
        }

        return messages;
    }
}

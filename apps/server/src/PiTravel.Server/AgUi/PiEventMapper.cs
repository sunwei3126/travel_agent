using System.Globalization;
using System.Text.Encodings.Web;
using System.Text.Json;
using Pi.Ai.Types;
using Pi.Ai.Utils;
using Pi.Durable.Harness;

namespace PiTravel.Server.AgUi;

/// <summary>
/// Stateful mapper for one AG-UI run, mirroring <c>createPiEventMapper</c> in
/// <c>apps/server/src/agui/mapper.ts</c>. Create one per run.
/// </summary>
public sealed class PiEventMapper
{
    private const int ProgressCap = 16 * 1024;

    private static readonly JsonSerializerOptions ArgumentsJson = new(Contracts.TripJson.Options)
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    private MessageState? _current;
    private int _sequence;
    private readonly HashSet<string> _activeTools = [];
    private readonly Dictionary<string, ToolTrace> _tools = [];

    public IReadOnlyList<AgUiEvent> Map(AgentEvent agentEvent)
    {
        var mapped = new List<AgUiEvent>();
        switch (agentEvent)
        {
            case AgentEvent.Snapshot snapshot:
                MapSnapshot(snapshot, mapped);
                break;
            case AgentEvent.MessageStart messageStart:
                MapMessageStart(messageStart, mapped);
                break;
            case AgentEvent.MessageUpdate messageUpdate:
                MapMessageUpdate(messageUpdate, mapped);
                break;
            case AgentEvent.MessageEnd messageEnd:
                MapMessageEnd(messageEnd, mapped);
                break;
            case AgentEvent.ToolExecutionStart toolStart:
                MapToolExecutionStart(toolStart, mapped);
                break;
            case AgentEvent.ToolExecutionUpdate toolUpdate:
                MapToolExecutionUpdate(toolUpdate, mapped);
                break;
            case AgentEvent.ToolExecutionEnd toolEnd:
                MapToolExecutionEnd(toolEnd, mapped);
                break;
            case AgentEvent.TaskFailed taskFailed:
                MapTaskFailed(taskFailed, mapped);
                break;
            case AgentEvent.RunEnd:
                CloseOpenEntities(mapped);
                break;
        }

        return mapped;
    }

    private void MapSnapshot(AgentEvent.Snapshot snapshot, List<AgUiEvent> mapped)
    {
        // Late attach: the durable snapshot may already carry an in-flight
        // generation partial. Seed it so later deltas are never content without
        // a preceding start.
        var message = snapshot.Generation?.Message;
        if (message is not AssistantMessage assistant) return;

        var target = _current ?? NewMessage(null);
        AppendMessageContent(target, assistant.Content, mapped, final: false);
    }

    private void MapMessageStart(AgentEvent.MessageStart messageStart, List<AgUiEvent> mapped)
    {
        if (messageStart.Message is not AssistantMessage assistant) return;

        var message = NewMessage(null);
        AppendMessageContent(message, assistant.Content, mapped, final: false);
    }

    private void MapMessageUpdate(AgentEvent.MessageUpdate messageUpdate, List<AgUiEvent> mapped)
    {
        var message = _current ?? NewMessage(null);
        foreach (var change in messageUpdate.Changes)
        {
            switch (change)
            {
                case MessageChange.Start { Kind: "thinking_start", ContentBlock: { } block } start:
                    if (!ReasoningCovered(message, start.ContentIndex, block))
                    {
                        AppendReasoningBlock(EnsureReasoning(message, start.ContentIndex, mapped), block, mapped);
                    }

                    break;

                case MessageChange.Delta { Kind: "thinking_delta" } thinkingDelta:
                    AppendReasoningDelta(
                        EnsureReasoning(message, thinkingDelta.ContentIndex, mapped),
                        thinkingDelta.Value,
                        mapped);
                    break;

                case MessageChange.Start { Kind: "toolcall_start", ContentBlock: ToolCallContent toolCall } toolStart:
                    CloseReasoning(message, mapped);
                    StartToolCallBlock(message, toolCall, mapped);
                    break;

                case MessageChange.ToolCallDelta:
                    // pi-durable sends value fragments, not JSON. Keep the call open
                    // and send the authoritative JSON at message_end or
                    // tool_execution_start instead of corrupting the argument stream.
                    break;

                case MessageChange.Start { Kind: "text_start", ContentBlock: { } block } textStart:
                    MapBlock(message, textStart.ContentIndex, block, mapped);
                    break;

                case MessageChange.Block replay:
                    MapBlock(message, replay.ContentIndex, replay.Value, mapped);
                    break;

                case MessageChange.Delta { Kind: "text_delta" } textDelta:
                    CloseReasoning(message, mapped);
                    var previous = message.Blocks.GetValueOrDefault(textDelta.ContentIndex) ?? "";
                    AppendBlockText(message, textDelta.ContentIndex, previous + textDelta.Value, mapped);
                    break;

                case MessageChange.Whole { Value: { } whole }:
                    AppendMessageContent(message, whole.Content, mapped, final: false);
                    break;
            }
        }
    }

    private void MapBlock(MessageState message, int index, ContentBlock block, List<AgUiEvent> mapped)
    {
        switch (block)
        {
            case ThinkingContent thinking when !ReasoningCovered(message, index, thinking):
                AppendReasoningBlock(EnsureReasoning(message, index, mapped), thinking, mapped);
                break;
            case TextContent text:
                CloseReasoning(message, mapped);
                AppendBlockText(message, index, text.Text, mapped);
                break;
            case ToolCallContent toolCall:
                CloseReasoning(message, mapped);
                StartToolCallBlock(message, toolCall, mapped);
                break;
        }
    }

    private void MapMessageEnd(AgentEvent.MessageEnd messageEnd, List<AgUiEvent> mapped)
    {
        if (messageEnd.Entry.Model is not [AssistantMessage assistant, ..]) return;

        var message = _current ?? NewMessage(null);
        AppendMessageContent(message, assistant.Content, mapped, final: true);
        CloseReasoning(message, mapped);
        if (message.Open)
        {
            mapped.Add(new TextMessageEnd(message.Id));
            message.Open = false;
        }

        _current = null;
    }

    private void MapToolExecutionStart(AgentEvent.ToolExecutionStart toolStart, List<AgUiEvent> mapped)
    {
        var trace = StartTool(toolStart.ToolCallId, toolStart.ToolName, null, mapped);
        AppendToolArgs(trace, JsonSerializer.Serialize(toolStart.Args, ArgumentsJson), mapped);
        EndTool(trace, mapped);
    }

    private void MapToolExecutionUpdate(AgentEvent.ToolExecutionUpdate toolUpdate, List<AgUiEvent> mapped)
    {
        // A late attach sees progress for a call that is already running, so no
        // trace exists. Compute each update from empty and discard it, matching the
        // TS mapper, which only writes the result back when a trace already exists.
        _tools.TryGetValue(toolUpdate.ToolCallId, out var trace);
        var text = trace?.Output ?? "";
        var output = toolUpdate.Output;
        if (output?.Set is { } set)
        {
            text = set;
        }
        else if (output is not null)
        {
            var trimStart = (int)Math.Clamp(output.TrimStart ?? 0, 0, int.MaxValue);
            if (trimStart > 0) text = text[Math.Min(trimStart, text.Length)..];
            if (output.Append is { } append) text += append;
        }

        if (text.Length > ProgressCap) text = text[^ProgressCap..];
        if (trace is not null) trace.Output = text;

        mapped.Add(new CustomEvent(
            "travel.tool_progress",
            new ToolProgressValue(
                toolUpdate.ToolCallId,
                trace?.Name ?? toolUpdate.ToolName,
                "running",
                text,
                toolUpdate.Details,
                toolUpdate.Diagnostics)));
    }

    private void MapToolExecutionEnd(AgentEvent.ToolExecutionEnd toolEnd, List<AgUiEvent> mapped)
    {
        if (_tools.TryGetValue(toolEnd.ToolCallId, out var trace)) EndTool(trace, mapped);

        var result = ToolResult(toolEnd);
        var isError = result?.IsError == true;
        var content = result is null ? "" : Text.ContentText(result.Content);
        if (content.Length == 0 && isError) content = "工具执行失败或未返回结果";
        var name = trace?.Name ?? toolEnd.ToolName;
        // The fallback keys off the entry id alone, not off whether the entry carries
        // a tool result. EntryId is a struct, so a missing id arrives as 0.
        var entryId = toolEnd.Entry?.Id.Value;

        mapped.Add(new ToolCallResult(
            entryId is > 0
                ? entryId.Value.ToString(CultureInfo.InvariantCulture)
                : $"tool-result-{toolEnd.ToolCallId}",
            toolEnd.ToolCallId,
            content,
            new AgUiMetadata(new TravelToolMetadata(
                name,
                isError ? "error" : "ok",
                isError ? content : null,
                DurationMs: result?.DurationMs))));
    }

    private static ToolResultMessage? ToolResult(AgentEvent.ToolExecutionEnd toolEnd) =>
        toolEnd.Entry?.Model is [ToolResultMessage result, ..] ? result : null;

    private void MapTaskFailed(AgentEvent.TaskFailed taskFailed, List<AgUiEvent> mapped)
    {
        var code = taskFailed.Kind;
        var message = string.IsNullOrEmpty(taskFailed.Message) ? "Task failed" : taskFailed.Message;
        // A generation task owns the run, so its fault also ends the run; a failed
        // tool task does not, and the model may retry the tool.
        mapped.Add(new CustomEvent(
            "travel.task_failed",
            new TaskFailedValue(
                string.IsNullOrEmpty(code) ? "unknown" : code,
                message,
                taskFailed.TaskId.Value.ToString(CultureInfo.InvariantCulture))));
        if (code is not (null or "" or "pi.generation")) return;

        mapped.Add(new RunError(message, string.IsNullOrEmpty(code) ? null : code));
    }

    private MessageState NewMessage(string? explicitId)
    {
        _sequence += 1;
        var message = new MessageState(explicitId ?? $"assistant-{_sequence}");
        _current = message;
        return message;
    }

    /// <summary>Emits TEXT_MESSAGE_START once, before any content or end for a message.</summary>
    private static void StartMessage(MessageState message, List<AgUiEvent> mapped)
    {
        if (message.Open) return;
        message.Open = true;
        mapped.Add(new TextMessageStart(message.Id));
    }

    /// <summary>Closes entities left open when a run ends, so RUN_FINISHED can be accepted.</summary>
    private void CloseOpenEntities(List<AgUiEvent> mapped)
    {
        if (_current is { } current)
        {
            CloseReasoning(current, mapped);
            if (current.Open)
            {
                mapped.Add(new TextMessageEnd(current.Id));
                current.Open = false;
            }
        }

        foreach (var toolCallId in _activeTools)
        {
            mapped.Add(new ToolCallEnd(toolCallId));
        }

        _activeTools.Clear();
        _current = null;
    }

    /// <summary>Emits the part of a text block that has not been sent yet.</summary>
    private static void AppendBlockText(MessageState message, int index, string fullText, List<AgUiEvent> mapped)
    {
        var previous = message.Blocks.GetValueOrDefault(index) ?? "";
        if (fullText.Length <= previous.Length)
        {
            message.Blocks[index] = fullText;
            return;
        }

        var delta = fullText[previous.Length..];
        message.Blocks[index] = fullText;
        // An empty block has not started yet, so its first text still needs the
        // separator that contentText puts between text blocks.
        var separator = previous.Length == 0 && message.Emitted.Length > 0 ? "\n" : "";
        AppendText(message, separator + delta, mapped);
    }

    /// <summary>Emits the not-yet-sent part of a whole assistant message.</summary>
    private void AppendMessageContent(
        MessageState message,
        IReadOnlyList<ContentBlock>? content,
        List<AgUiEvent> mapped,
        bool final)
    {
        if (content is null) return;

        for (var index = 0; index < content.Count; index++)
        {
            switch (content[index])
            {
                case ThinkingContent thinking:
                    // message_end replays blocks that already streamed. Do not open a
                    // new reasoning span for text that was fully emitted before the replay.
                    if (ReasoningCovered(message, index, thinking)) continue;
                    AppendReasoningBlock(EnsureReasoning(message, index, mapped), thinking, mapped);
                    break;
                case TextContent text:
                    CloseReasoning(message, mapped);
                    AppendBlockText(message, index, text.Text, mapped);
                    break;
                case ToolCallContent toolCall:
                    CloseReasoning(message, mapped);
                    if (final)
                    {
                        FinishToolCallBlock(message, toolCall, mapped);
                    }
                    else
                    {
                        StartToolCallBlock(message, toolCall, mapped);
                    }

                    break;
            }
        }
    }

    /// <summary>Whether a thinking block replayed at message_end was already emitted.</summary>
    private static bool ReasoningCovered(MessageState message, int index, ContentBlock block)
    {
        if (!message.Reasoning.TryGetValue(index, out var existing)) return false;
        if (block is ThinkingContent { Redacted: true })
        {
            return existing.EncryptedSent || existing.Emitted.Length > 0;
        }

        var text = block is ThinkingContent { Thinking: { } thinking } ? thinking : "";
        return text.Length <= existing.Emitted.Length;
    }

    private static void AppendText(MessageState message, string delta, List<AgUiEvent> mapped)
    {
        if (delta.Length == 0) return;
        message.Emitted += delta;
        StartMessage(message, mapped);
        mapped.Add(new TextMessageContent(message.Id, delta));
    }

    /// <summary>Ensures a reasoning message/span exists and is open, emitting its starts.</summary>
    private static ReasoningState EnsureReasoning(MessageState message, int index, List<AgUiEvent> mapped)
    {
        if (message.Reasoning.TryGetValue(index, out var existing) && existing.Open) return existing;

        var suffix = existing is null ? index.ToString(CultureInfo.InvariantCulture) : $"{index}-{message.Reasoning.Count}";
        var messageId = $"{message.Id}-thinking-{suffix}";
        var reasoning = new ReasoningState(messageId, $"{messageId}-span")
        {
            // Carry emitted text so a reopened span only sends the new suffix.
            Emitted = existing?.Emitted ?? "",
            EncryptedSent = existing?.EncryptedSent ?? false,
        };
        message.Reasoning[index] = reasoning;
        mapped.Add(new ReasoningStart(reasoning.SpanId));
        mapped.Add(new ReasoningMessageStart(reasoning.MessageId));
        return reasoning;
    }

    private static void AppendReasoningBlock(ReasoningState reasoning, ContentBlock block, List<AgUiEvent> mapped)
    {
        if (block is not ThinkingContent thinking) return;
        if (thinking.Redacted == true)
        {
            if (thinking.Signature is { } signature && !reasoning.EncryptedSent)
            {
                reasoning.EncryptedSent = true;
                mapped.Add(new ReasoningEncryptedValue(reasoning.MessageId, signature));
            }

            return;
        }

        if (thinking.Thinking is { } text) AppendReasoningText(reasoning, text, mapped);
    }

    private static void AppendReasoningText(ReasoningState reasoning, string fullText, List<AgUiEvent> mapped)
    {
        if (fullText.Length <= reasoning.Emitted.Length) return;
        var delta = fullText[reasoning.Emitted.Length..];
        reasoning.Emitted = fullText;
        mapped.Add(new ReasoningMessageContent(reasoning.MessageId, delta));
    }

    private static void AppendReasoningDelta(ReasoningState reasoning, string delta, List<AgUiEvent> mapped)
    {
        if (delta.Length == 0) return;
        reasoning.Emitted += delta;
        mapped.Add(new ReasoningMessageContent(reasoning.MessageId, delta));
    }

    /// <summary>Closes every open reasoning message/span for a message.</summary>
    private static void CloseReasoning(MessageState message, List<AgUiEvent> mapped)
    {
        foreach (var reasoning in message.Reasoning.Values)
        {
            if (!reasoning.Open) continue;
            reasoning.Open = false;
            mapped.Add(new ReasoningMessageEnd(reasoning.MessageId));
            mapped.Add(new ReasoningEnd(reasoning.SpanId));
        }
    }

    /// <summary>Starts a tool call from a streamed toolCall block, without arguments.</summary>
    private void StartToolCallBlock(MessageState message, ToolCallContent block, List<AgUiEvent> mapped)
    {
        if (string.IsNullOrEmpty(block.Id) || string.IsNullOrEmpty(block.Name)) return;
        StartTool(block.Id, block.Name, message.Id, mapped);
    }

    /// <summary>Starts a tool call from a complete block and sends its full arguments.</summary>
    private void FinishToolCallBlock(MessageState message, ToolCallContent block, List<AgUiEvent> mapped)
    {
        if (string.IsNullOrEmpty(block.Id) || string.IsNullOrEmpty(block.Name)) return;
        var trace = StartTool(block.Id, block.Name, message.Id, mapped);
        AppendToolArgs(trace, JsonSerializer.Serialize(block.Arguments ?? new { }, ArgumentsJson), mapped);
        // The call stays active until tool_execution_start (or run_end) ends it.
    }

    private ToolTrace StartTool(string id, string name, string? parentMessageId, List<AgUiEvent> mapped)
    {
        if (!_tools.TryGetValue(id, out var trace))
        {
            trace = new ToolTrace(id, name);
            _tools[id] = trace;
        }

        if (!trace.Started)
        {
            trace.Started = true;
            _activeTools.Add(id);
            mapped.Add(new ToolCallStart(id, name, parentMessageId));
        }

        return trace;
    }

    private static void AppendToolArgs(ToolTrace trace, string fullJson, List<AgUiEvent> mapped)
    {
        if (fullJson.Length == 0) return;
        if (trace.ArgsSent.Length == 0)
        {
            trace.ArgsSent = fullJson;
            mapped.Add(new ToolCallArgs(trace.Id, fullJson));
            return;
        }

        if (!fullJson.StartsWith(trace.ArgsSent, StringComparison.Ordinal)) return;

        // If the authoritative JSON is not an extension of what was streamed, keep
        // the streamed arguments rather than corrupting them.
        var delta = fullJson[trace.ArgsSent.Length..];
        if (delta.Length == 0) return;
        trace.ArgsSent = fullJson;
        mapped.Add(new ToolCallArgs(trace.Id, delta));
    }

    private void EndTool(ToolTrace trace, List<AgUiEvent> mapped)
    {
        if (trace.Ended) return;
        trace.Ended = true;
        _activeTools.Remove(trace.Id);
        mapped.Add(new ToolCallEnd(trace.Id));
    }

    private sealed class MessageState(string id)
    {
        public string Id { get; } = id;

        /// <summary>Text already sent for this message, in the order it was sent.</summary>
        public string Emitted { get; set; } = "";

        /// <summary>Text already sent for each assistant-message content index.</summary>
        public Dictionary<int, string> Blocks { get; } = [];

        public Dictionary<int, ReasoningState> Reasoning { get; } = [];

        /// <summary>Whether TEXT_MESSAGE_START was emitted and TEXT_MESSAGE_END is still due.</summary>
        public bool Open { get; set; }
    }

    private sealed class ReasoningState(string messageId, string spanId)
    {
        public string MessageId { get; } = messageId;

        public string SpanId { get; } = spanId;

        public string Emitted { get; set; } = "";

        public bool Open { get; set; } = true;

        public bool EncryptedSent { get; set; }
    }

    private sealed class ToolTrace(string id, string name)
    {
        public string Id { get; } = id;

        public string Name { get; } = name;

        public string ArgsSent { get; set; } = "";

        public bool Started { get; set; }

        public bool Ended { get; set; }

        public string Output { get; set; } = "";
    }
}

using System.Text.Encodings.Web;
using System.Text.Json.Serialization;
using System.Text.Json.Serialization.Metadata;

namespace PiTravel.Server.AgUi;

/// <summary>
/// One AG-UI event. Serializes to the <c>@ag-ui/core</c> shape
/// <c>{ "type": "..." }</c> through <see cref="Contracts.TripJson"/>.
/// </summary>
[JsonPolymorphic(TypeDiscriminatorPropertyName = "type")]
[JsonDerivedType(typeof(RunStarted), "RUN_STARTED")]
[JsonDerivedType(typeof(RunFinished), "RUN_FINISHED")]
[JsonDerivedType(typeof(RunError), "RUN_ERROR")]
[JsonDerivedType(typeof(TextMessageStart), "TEXT_MESSAGE_START")]
[JsonDerivedType(typeof(TextMessageContent), "TEXT_MESSAGE_CONTENT")]
[JsonDerivedType(typeof(TextMessageEnd), "TEXT_MESSAGE_END")]
[JsonDerivedType(typeof(ToolCallStart), "TOOL_CALL_START")]
[JsonDerivedType(typeof(ToolCallArgs), "TOOL_CALL_ARGS")]
[JsonDerivedType(typeof(ToolCallEnd), "TOOL_CALL_END")]
[JsonDerivedType(typeof(ToolCallResult), "TOOL_CALL_RESULT")]
[JsonDerivedType(typeof(ReasoningStart), "REASONING_START")]
[JsonDerivedType(typeof(ReasoningMessageStart), "REASONING_MESSAGE_START")]
[JsonDerivedType(typeof(ReasoningMessageContent), "REASONING_MESSAGE_CONTENT")]
[JsonDerivedType(typeof(ReasoningMessageEnd), "REASONING_MESSAGE_END")]
[JsonDerivedType(typeof(ReasoningEnd), "REASONING_END")]
[JsonDerivedType(typeof(ReasoningEncryptedValue), "REASONING_ENCRYPTED_VALUE")]
[JsonDerivedType(typeof(CustomEvent), "CUSTOM")]
[JsonDerivedType(typeof(MessagesSnapshot), "MESSAGES_SNAPSHOT")]
[JsonDerivedType(typeof(StateSnapshot), "STATE_SNAPSHOT")]
public abstract record AgUiEvent;

/// <summary>Marks the start of an AG-UI run for one trip thread.</summary>
public sealed record RunStarted(string ThreadId, string RunId) : AgUiEvent;

/// <summary>Marks a run that ended without a fault.</summary>
public sealed record RunFinished(string ThreadId, string RunId) : AgUiEvent;

/// <summary>Ends a run with a fault; <paramref name="Code"/> is omitted when absent.</summary>
public sealed record RunError(string Message, string? Code = null) : AgUiEvent;

/// <summary>Opens an assistant text message before its first content delta.</summary>
public sealed record TextMessageStart(string MessageId) : AgUiEvent;

/// <summary>Appends text to an open assistant message.</summary>
public sealed record TextMessageContent(string MessageId, string Delta) : AgUiEvent;

/// <summary>Closes an assistant text message.</summary>
public sealed record TextMessageEnd(string MessageId) : AgUiEvent;

/// <summary>
/// Opens a tool call. <paramref name="ParentMessageId"/> is set when the call was
/// streamed inside an assistant message and omitted when execution starts it.
/// </summary>
public sealed record ToolCallStart(
    string ToolCallId,
    string ToolCallName,
    string? ParentMessageId = null) : AgUiEvent;

/// <summary>Appends a JSON fragment to a tool call's arguments.</summary>
public sealed record ToolCallArgs(string ToolCallId, string Delta) : AgUiEvent;

/// <summary>Closes a tool call so the runtime accepts the result.</summary>
public sealed record ToolCallEnd(string ToolCallId) : AgUiEvent;

/// <summary>The settled result of a tool call, carrying <c>travel.tool</c> metadata.</summary>
public sealed record ToolCallResult(
    string MessageId,
    string ToolCallId,
    string Content,
    AgUiMetadata Metadata) : AgUiEvent;

/// <summary>Opens a reasoning span; <paramref name="MessageId"/> is the span id.</summary>
public sealed record ReasoningStart(string MessageId) : AgUiEvent;

/// <summary>Opens the reasoning message inside a span.</summary>
public sealed record ReasoningMessageStart(string MessageId) : AgUiEvent
{
    public string Role => "reasoning";
}

/// <summary>Appends text to an open reasoning message.</summary>
public sealed record ReasoningMessageContent(string MessageId, string Delta) : AgUiEvent;

/// <summary>Closes a reasoning message.</summary>
public sealed record ReasoningMessageEnd(string MessageId) : AgUiEvent;

/// <summary>Closes a reasoning span; <paramref name="MessageId"/> is the span id.</summary>
public sealed record ReasoningEnd(string MessageId) : AgUiEvent;

/// <summary>The encrypted signature of a redacted thinking block.</summary>
public sealed record ReasoningEncryptedValue(
    string Subtype,
    string EntityId,
    string EncryptedValue) : AgUiEvent
{
    public ReasoningEncryptedValue(string entityId, string encryptedValue)
        : this("message", entityId, encryptedValue)
    {
    }
}

/// <summary>
/// An AG-UI custom event. <paramref name="Value"/> is a plain object so each
/// <paramref name="Name"/> keeps its own payload shape.
/// </summary>
public sealed record CustomEvent(string Name, object Value) : AgUiEvent;

/// <summary>The <c>travel.tool_progress</c> payload: live output of a running tool.</summary>
public sealed record ToolProgressValue(
    string ToolCallId,
    string ToolName,
    string Status,
    string Output,
    object? Details = null,
    object? Diagnostics = null);

/// <summary>The <c>travel.task_failed</c> payload surfaced as the fault banner.</summary>
public sealed record TaskFailedValue(string Kind, string Message, string? TaskId = null);

/// <summary>The whole conversation the runtime starts a run from.</summary>
public sealed record MessagesSnapshot(IReadOnlyList<AgUiMessage> Messages) : AgUiEvent;

/// <summary>
/// The trip state the runtime starts a run from. <see cref="Contracts.TripState"/>
/// already nests <c>running</c> inside <c>research</c>, so it serializes as-is.
/// </summary>
public sealed record StateSnapshot(Contracts.TripState Snapshot) : AgUiEvent;

/// <summary>The <c>travel.tool</c> metadata attached to tool messages and results.</summary>
public sealed record TravelToolMetadata(
    string Name,
    string Status,
    string? Error = null,
    string? TaskId = null,
    string? ParentToolCallId = null,
    long? DurationMs = null);

/// <summary>Message metadata keyed by <c>travel.tool</c>.</summary>
public sealed record AgUiMetadata(
    [property: JsonPropertyName("travel.tool")] TravelToolMetadata TravelTool);

/// <summary>One function call inside an assistant message.</summary>
public sealed record AgUiFunctionCall(string Name, string Arguments);

/// <summary>A tool call carried by an assistant snapshot message.</summary>
public sealed record AgUiToolCall(string Id, string Type, AgUiFunctionCall Function)
{
    public AgUiToolCall(string id, AgUiFunctionCall function)
        : this(id, "function", function)
    {
    }
}

/// <summary>
/// One AG-UI message. Optional members are omitted when null, and an assistant
/// message with no text omits <c>content</c> entirely, matching the TS mapper.
/// The stored text stays readable; <see cref="AgUiJson"/> drops it on the wire.
/// </summary>
public sealed record AgUiMessage(
    string Id,
    string Role,
    string? Content,
    string? ToolCallId = null,
    IReadOnlyList<AgUiToolCall>? ToolCalls = null,
    string? Error = null,
    string? EncryptedValue = null,
    AgUiMetadata? Metadata = null);

/// <summary>
/// Serialization tweaks the shared <see cref="Contracts.TripJson"/> options cannot
/// express: an assistant message omits an empty <c>content</c>.
/// </summary>
public static class AgUiJson
{
    public static JsonTypeInfo<AgUiEvent> EventTypeInfo { get; } =
        (JsonTypeInfo<AgUiEvent>)CreateOptions().GetTypeInfo(typeof(AgUiEvent));

    public static string Serialize(AgUiEvent agUiEvent) =>
        System.Text.Json.JsonSerializer.Serialize(agUiEvent, EventTypeInfo);

    private static System.Text.Json.JsonSerializerOptions CreateOptions()
    {
        var options = new System.Text.Json.JsonSerializerOptions(Contracts.TripJson.Options)
        {
            // JSON.stringify keeps non-ASCII text literal; the shared options escape it.
            Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        };
        options.TypeInfoResolver = new DefaultJsonTypeInfoResolver
        {
            Modifiers = { OmitEmptyAssistantContent, OrderStateSnapshot },
        };
        return options;
    }

    /// <summary>
    /// <see cref="Contracts.TripResearchState"/> declares <c>running</c> itself while it
    /// inherits the counters, so reflection lists it first. The TS snapshot spreads the
    /// counters first and adds <c>running</c> last.
    /// </summary>
    private static void OrderStateSnapshot(JsonTypeInfo typeInfo)
    {
        if (typeInfo.Type != typeof(Contracts.TripResearchState)) return;

        foreach (var property in typeInfo.Properties)
        {
            property.Order = property.Name == "running" ? 1 : 0;
        }
    }

    private static void OmitEmptyAssistantContent(JsonTypeInfo typeInfo)
    {
        if (typeInfo.Type != typeof(AgUiMessage)) return;

        foreach (var property in typeInfo.Properties)
        {
            if (property.Name != "content") continue;
            property.ShouldSerialize = static (obj, _) =>
                obj is not AgUiMessage { Role: "assistant", Content: not { Length: > 0 } };
        }
    }
}

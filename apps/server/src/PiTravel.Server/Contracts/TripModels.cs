namespace PiTravel.Server.Contracts;

/// <summary>
/// The trip facts collected from the traveler. Mirrors <c>TripBriefSchema</c> in
/// <c>packages/shared/src/trip.ts</c>; every field is optional.
/// </summary>
public sealed record TripBrief
{
    public string? Destination { get; init; }
    public string? Origin { get; init; }
    public string? StartDate { get; init; }
    public double? Days { get; init; }
    public double? BudgetCny { get; init; }
    public string? Companions { get; init; }
    public string? Fitness { get; init; }
    public IReadOnlyList<string>? Interests { get; init; }
    public IReadOnlyList<string>? Constraints { get; init; }
    public IReadOnlyList<string>? Assumptions { get; init; }
}

/// <summary>A single assertion inside a day card; <see cref="Kind"/> is fact or opinion.</summary>
public sealed record Claim
{
    public required string Text { get; init; }
    public required string Kind { get; init; }
    public required IReadOnlyList<string> SourceIds { get; init; }
    public bool? Unverified { get; init; }
}

/// <summary>A scheduled stop within a day; <see cref="CostCny"/> is a [low, high] pair.</summary>
public sealed record DayBlock
{
    public required string Time { get; init; }
    public required string Title { get; init; }
    public required string Detail { get; init; }
    public required IReadOnlyList<Claim> Claims { get; init; }
    public IReadOnlyList<double>? CostCny { get; init; }
}

/// <summary>One day of the plan; <see cref="EstimatedCostCny"/> is a [low, high] pair.</summary>
public sealed record DayCard
{
    public required int DayIndex { get; init; }
    public required string Date { get; init; }
    public required string Title { get; init; }
    public required IReadOnlyList<DayBlock> Blocks { get; init; }
    public required IReadOnlyList<Claim> Scenery { get; init; }
    public required IReadOnlyList<Claim> Food { get; init; }
    public required IReadOnlyList<Claim> Transport { get; init; }
    public required IReadOnlyList<double> EstimatedCostCny { get; init; }
    public required IReadOnlyList<string> Sources { get; init; }
    public string? Svg { get; init; }
    public required string SvgStatus { get; init; }
    public required string UpdatedAt { get; init; }
}

/// <summary>The summed cost ranges compared against the traveler's budget cap.</summary>
public sealed record BudgetSummary
{
    public required double Low { get; init; }
    public required double High { get; init; }
    public required double Cap { get; init; }
    public required bool WithinBudget { get; init; }
}

/// <summary>The plan document; <see cref="Summary"/> and <see cref="Budget"/> are optional.</summary>
public sealed record TripPlan
{
    public required IReadOnlyList<DayCard> Days { get; init; }
    public string? Summary { get; init; }
    public BudgetSummary? Budget { get; init; }
}

/// <summary>A research source; <see cref="Kind"/> is search or fetch.</summary>
public sealed record TripSource
{
    public required string Id { get; init; }
    public required string Query { get; init; }
    public required string Title { get; init; }
    public required string Url { get; init; }
    public required string Snippet { get; init; }
    public string? Summary { get; init; }
    public string? Content { get; init; }
    public string? Date { get; init; }
    public double? Authority { get; init; }
    public double? RerankScore { get; init; }
    public string? FetchedAt { get; init; }
    public required string Kind { get; init; }
}

/// <summary>A tool call carried by a transcript entry; arguments stay JSON-encoded.</summary>
public sealed record TranscriptToolCall
{
    public required string Id { get; init; }
    public required string Name { get; init; }
    public required string Arguments { get; init; }
}

/// <summary>One UI-facing transcript entry; <see cref="Role"/> is user, assistant, tool, or reasoning.</summary>
public sealed record TranscriptEntry
{
    public required string Id { get; init; }
    public required string Role { get; init; }
    public required string Content { get; init; }
    public string? Name { get; init; }
    public string? ToolCallId { get; init; }
    public IReadOnlyList<TranscriptToolCall>? ToolCalls { get; init; }
    public string? Error { get; init; }
    public string? EncryptedValue { get; init; }
}

/// <summary>One row of the persisted trip index; <see cref="Status"/> is active or completed.</summary>
public sealed record TripIndexEntry
{
    public required string TripId { get; init; }
    public required string ConversationId { get; init; }
    public required string Title { get; init; }
    public required string Destination { get; init; }
    public required string StartDate { get; init; }
    public required int Days { get; init; }
    public required string UpdatedAt { get; init; }
    public required string Status { get; init; }
}

/// <summary>
/// Completed API call counts. The attempt maps are keyed by normalized search cache
/// key / fetched URL and are only written once a call has been committed.
/// </summary>
public record TripResearch
{
    public required int SearchCount { get; init; }
    public required int FetchCount { get; init; }
    public IReadOnlyDictionary<string, int>? SearchAttempts { get; init; }
    public IReadOnlyDictionary<string, int>? FetchAttempts { get; init; }
}

/// <summary>
/// <see cref="TripResearch"/> plus the live run flag. This is the <c>research</c>
/// object of the AG-UI state snapshot, so <c>running</c> serializes inside it.
/// </summary>
public sealed record TripResearchState : TripResearch
{
    public required bool Running { get; init; }
}

/// <summary>A parked or faulted background task surfaced to the user.</summary>
public sealed record TripFault
{
    public required string Kind { get; init; }
    public required string Message { get; init; }
    public string? TaskId { get; init; }
    public required string At { get; init; }
}

/// <summary>
/// The AG-UI state snapshot payload; <see cref="Research"/> carries the live run
/// flag, so the type serializes to the shared <c>TripState</c> shape directly.
/// </summary>
public sealed record TripState
{
    public required TripBrief Brief { get; init; }
    public required TripPlan Plan { get; init; }
    public required IReadOnlyDictionary<string, TripSource> Sources { get; init; }
    public required TripResearchState Research { get; init; }
}

/// <summary>The full trip snapshot served to the UI; <see cref="Faults"/> is optional.</summary>
public sealed record TripSnapshot
{
    public required TripIndexEntry Trip { get; init; }
    public required TripBrief Brief { get; init; }
    public required TripPlan Plan { get; init; }
    public required IReadOnlyDictionary<string, TripSource> Sources { get; init; }
    public required TripResearch Research { get; init; }
    public required bool Running { get; init; }
    public IReadOnlyList<TripFault>? Faults { get; init; }
}

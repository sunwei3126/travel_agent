using System.Text.RegularExpressions;
using PiTravel.Server.Contracts;

namespace PiTravel.Server.Planning;

/// <summary>
/// Completeness rules for the trip brief, mirroring <c>missingBriefFields</c> in
/// <c>packages/shared/src/trip.ts</c>.
/// </summary>
public static class BriefRules
{
    private static readonly Regex IsoDatePattern =
        new("^[0-9]{4}-[0-9]{2}-[0-9]{2}$", RegexOptions.CultureInvariant);

    private static readonly (string Field, Func<TripBrief, bool> IsPresent)[] RequiredFields =
    [
        ("destination", brief => IsNonEmpty(brief.Destination)),
        ("origin", brief => IsNonEmpty(brief.Origin)),
        ("startDate", brief => brief.StartDate is not null && IsoDatePattern.IsMatch(brief.StartDate)),
        ("days", brief => brief.Days is double days && double.IsFinite(days) && days >= 1),
        ("budgetCny", brief => brief.BudgetCny is double budget && double.IsFinite(budget) && budget > 0),
        ("companions", brief => IsNonEmpty(brief.Companions)),
        ("fitness", brief => brief.Fitness is "low" or "average" or "high"),
        ("interests", brief => brief.Interests is { Count: > 0 }),
    ];

    /// <summary>Required fields the brief still lacks, in the shared contract's order.</summary>
    public static IReadOnlyList<string> MissingFields(TripBrief brief) =>
        RequiredFields
            .Where(field => !field.IsPresent(brief))
            .Select(field => field.Field)
            .ToList();

    public static bool IsComplete(TripBrief brief) => MissingFields(brief).Count == 0;

    private static bool IsNonEmpty(string? value) => value is not null && value.Trim().Length > 0;
}

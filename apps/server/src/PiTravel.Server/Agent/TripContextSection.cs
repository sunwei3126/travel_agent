using System.Globalization;
using Pi.Durable.Harness;
using PiTravel.Server.Contracts;
using PiTravel.Server.Harness;
using PiTravel.Server.Research;

namespace PiTravel.Server.Agent;

/// <summary>
/// Renders the durable trip state as a compact system-prompt section body,
/// mirroring <c>apps/server/src/agent/section.ts</c>.
/// </summary>
public static class TripContextSection
{
    public const int MaxBlocksPerDay = 8;
    public const int MaxSources = 40;

    public static string? Render(
        TripBrief? brief,
        TripPlan? plan,
        IReadOnlyDictionary<string, TripSource>? sources,
        DateTimeOffset now)
    {
        var sourceCount = sources?.Count ?? 0;
        var hasBrief = HasAnyField(brief);
        var hasPlan = plan is not null &&
                      (plan.Days.Count > 0 || plan.Summary is not null || plan.Budget is not null);
        if (!hasBrief && !hasPlan && sourceCount == 0)
        {
            return null;
        }

        var lines = new List<string>();
        if (hasBrief && brief is not null)
        {
            var parts = new List<string>();
            if (brief.Destination is not null) parts.Add($"destination={brief.Destination}");
            if (brief.Origin is not null) parts.Add($"origin={brief.Origin}");
            if (brief.StartDate is not null) parts.Add($"start={brief.StartDate}");
            if (brief.Days is { } days) parts.Add($"days={FormatNumber(days)}");
            if (brief.BudgetCny is { } budgetCny) parts.Add($"budget={FormatNumber(budgetCny)} CNY");
            if (brief.Companions is not null) parts.Add($"companions={brief.Companions}");
            if (brief.Fitness is not null) parts.Add($"fitness={brief.Fitness}");
            if (brief.Interests is { Count: > 0 } interests)
            {
                parts.Add($"interests={string.Join(", ", interests)}");
            }

            if (brief.Constraints is { Count: > 0 } constraints)
            {
                parts.Add($"constraints={string.Join(", ", constraints)}");
            }

            lines.Add($"Brief: {(parts.Count > 0 ? string.Join("; ", parts) : "recorded")}");
        }

        if (hasPlan && plan is not null)
        {
            foreach (var day in plan.Days.OrderBy(d => d.DayIndex))
            {
                lines.Add($"Plan {RenderDay(day)}");
            }

            if (plan.Summary is not null)
            {
                lines.Add($"Plan summary: {plan.Summary}");
            }

            if (plan.Budget is { } budget)
            {
                var status = budget.WithinBudget ? "within budget" : "over budget";
                lines.Add(
                    $"Budget: {FormatNumber(budget.Low)}-{FormatNumber(budget.High)} CNY of {FormatNumber(budget.Cap)} CNY ({status})");
            }
        }

        lines.Add($"Sources: {sourceCount}");
        if (sources is not null && sourceCount > 0)
        {
            var ranked = Freshness.Rank(sources.Values, now).Take(MaxSources);
            foreach (var source in ranked)
            {
                var title = string.IsNullOrEmpty(source.Title) ? "(untitled)" : source.Title;
                var date = source.Date ?? "unknown";
                var freshness = Freshness.Of(source, now);
                var authority = source.Authority is { } auth ? FormatNumber(auth) : "unknown";
                var fetched = Freshness.IsVerifiedFact(source) ? "yes" : "no";
                lines.Add(
                    $"[{source.Id}] {title} — {source.Url}; date={date} ({freshness}); authority={authority}; fetched={fetched}; kind={source.Kind}");
            }

            if (sourceCount > MaxSources)
            {
                lines.Add($"+{sourceCount - MaxSources} more sources");
            }
        }

        return string.Join("\n", lines);
    }

    public static IPromptSection Create(Func<DateTimeOffset>? now = null)
    {
        var clock = now ?? (static () => DateTimeOffset.UtcNow);
        return Define.Section(
            "trip",
            async (input, context) =>
            {
                var briefDict = await input.Read.SnapshotAsync(
                    Docs.TripBriefDoc,
                    input.ConversationId,
                    context);
                var planDict = await input.Read.SnapshotAsync(
                    Docs.TripPlanDoc,
                    input.ConversationId,
                    context);
                var sourcesDict = await input.Read.SnapshotAsync(
                    Docs.TripSourcesDoc,
                    input.ConversationId,
                    context);

                var brief = briefDict is null || briefDict.Count == 0
                    ? null
                    : Docs.ReadBrief(briefDict);
                var plan = planDict is null ? null : Docs.ReadPlan(planDict);
                var sources = sourcesDict is null || sourcesDict.Count == 0
                    ? null
                    : Docs.ReadSources(sourcesDict);

                return Render(brief, plan, sources, clock());
            });
    }

    private static string RenderDay(DayCard day)
    {
        var blocks = day.Blocks
            .Take(MaxBlocksPerDay)
            .Select(block =>
            {
                var cost = block.CostCny is null
                    ? ""
                    : $" (¥{FormatNumber(block.CostCny[0])}–¥{FormatNumber(block.CostCny[1])})";
                return $"{block.Time} {block.Title}{cost}";
            })
            .ToList();

        if (day.Blocks.Count > MaxBlocksPerDay)
        {
            blocks.Add($"+{day.Blocks.Count - MaxBlocksPerDay} more blocks");
        }

        var svg = day.SvgStatus == "ok" ? "svg=ok" : $"svg={day.SvgStatus}";
        var parts = new List<string>
        {
            $"D{day.DayIndex} {day.Date} {day.Title} [{svg}]",
        };
        if (blocks.Count > 0)
        {
            parts.Add($"blocks: {string.Join(" | ", blocks)}");
        }

        parts.Add(
            $"cost: ¥{FormatNumber(day.EstimatedCostCny[0])}–¥{FormatNumber(day.EstimatedCostCny[1])}");
        if (day.Sources.Count > 0)
        {
            parts.Add($"sources: {string.Join(", ", day.Sources)}");
        }

        return string.Join("; ", parts);
    }

    private static bool HasAnyField(TripBrief? brief) =>
        brief is not null &&
        (brief.Destination is not null ||
         brief.Origin is not null ||
         brief.StartDate is not null ||
         brief.Days is not null ||
         brief.BudgetCny is not null ||
         brief.Companions is not null ||
         brief.Fitness is not null ||
         brief.Interests is not null ||
         brief.Constraints is not null ||
         brief.Assumptions is not null);

    private static string FormatNumber(double value) =>
        value.ToString(CultureInfo.InvariantCulture);
}

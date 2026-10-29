using PiTravel.Server.Contracts;
using PiTravel.Server.Research;

namespace PiTravel.Server.Planning;

/// <summary>
/// Day-card rules, mirroring <c>validateDayCard</c> in
/// <c>apps/server/src/plan/validate.ts</c>.
/// </summary>
public static class DayCardValidator
{
    public static IReadOnlyList<string> Validate(
        DayCard card,
        IReadOnlyDictionary<string, TripSource> sources,
        TripBrief brief)
    {
        var errors = new List<string>();

        if (!BriefRules.IsComplete(brief))
        {
            errors.Add("brief is incomplete");
        }

        if (card.DayIndex < 1)
        {
            errors.Add("dayIndex must be at least 1");
        }

        if (card.Date.Trim().Length == 0)
        {
            errors.Add("date is required");
        }

        AddCostErrors(errors, card.EstimatedCostCny, "estimatedCostCny");
        for (var index = 0; index < card.Blocks.Count; index++)
        {
            var cost = card.Blocks[index].CostCny;
            if (cost is not null)
            {
                AddCostErrors(errors, cost, $"blocks[{index}].costCny");
            }
        }

        foreach (var block in card.Blocks)
        {
            AddClaimErrors(errors, block.Claims, sources);
        }
        AddClaimErrors(errors, card.Scenery, sources);
        AddClaimErrors(errors, card.Food, sources);
        AddClaimErrors(errors, card.Transport, sources);

        return errors;
    }

    private static void AddClaimErrors(
        List<string> errors,
        IReadOnlyList<Claim> claims,
        IReadOnlyDictionary<string, TripSource> sources)
    {
        foreach (var claim in claims)
        {
            if (claim.Kind != "fact" || claim.Unverified is true) continue;

            if (claim.SourceIds.Count == 0)
            {
                errors.Add($"claim has no source: {claim.Text}");
                continue;
            }

            foreach (var id in claim.SourceIds)
            {
                if (!sources.TryGetValue(id, out var source))
                {
                    errors.Add($"claim references unknown source: {id}");
                }
                else if (!Freshness.IsVerifiedFact(source))
                {
                    // A search snippet is only a lead. Hard facts require the fetched page.
                    errors.Add(
                        $"claim cites an unfetched source (fetch the page before treating it as a fact): {id}");
                }
            }
        }
    }

    private static void AddCostErrors(
        List<string> errors,
        IReadOnlyList<double> cost,
        string label)
    {
        var low = cost[0];
        var high = cost[1];
        if (!double.IsFinite(low) || !double.IsFinite(high))
        {
            errors.Add($"{label} must be finite numbers");
            return;
        }
        if (low < 0 || high < 0)
        {
            errors.Add($"{label} costs must be non-negative");
        }
        if (low > high)
        {
            errors.Add($"{label} cost low must not exceed high");
        }
    }
}

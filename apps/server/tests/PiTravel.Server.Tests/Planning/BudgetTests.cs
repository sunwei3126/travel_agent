using PiTravel.Server.Contracts;
using PiTravel.Server.Planning;

namespace PiTravel.Server.Tests.Planning;

/// <summary>
/// Locks <c>finalizeBudget</c> in <c>apps/server/src/plan/budget.ts</c>: sum the
/// low and high bounds and compare the high bound against the cap.
/// </summary>
public sealed class BudgetTests
{
    [Fact]
    public void FinalizeSumsRangesAndComparesHighAgainstCap()
    {
        var plan = new TripPlan { Days = [Day(100, 200), Day(50, 80)] };

        Assert.Equal(
            new BudgetSummary { Low = 150, High = 280, Cap = 300, WithinBudget = true },
            Budget.Finalize(plan, 300));
        Assert.Equal(
            new BudgetSummary { Low = 150, High = 280, Cap = 200, WithinBudget = false },
            Budget.Finalize(plan, 200));
    }

    private static DayCard Day(double low, double high) => new()
    {
        DayIndex = 1,
        Date = "2026-10-26",
        Title = "D1",
        Blocks = [],
        Scenery = [],
        Food = [],
        Transport = [],
        EstimatedCostCny = [low, high],
        Sources = [],
        SvgStatus = "pending",
        UpdatedAt = "",
    };
}

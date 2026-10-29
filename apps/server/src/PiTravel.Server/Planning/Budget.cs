using PiTravel.Server.Contracts;

namespace PiTravel.Server.Planning;

/// <summary>
/// Budget totals, mirroring <c>finalizeBudget</c> in
/// <c>apps/server/src/plan/budget.ts</c>.
/// </summary>
public static class Budget
{
    public static BudgetSummary Finalize(TripPlan plan, double cap)
    {
        var low = 0d;
        var high = 0d;
        foreach (var day in plan.Days)
        {
            low += day.EstimatedCostCny[0];
            high += day.EstimatedCostCny[1];
        }
        return new BudgetSummary
        {
            Low = low,
            High = high,
            Cap = cap,
            WithinBudget = high <= cap,
        };
    }
}

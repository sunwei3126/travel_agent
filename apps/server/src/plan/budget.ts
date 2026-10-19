import type { BudgetSummary, TripPlan } from "@pi-demo/shared";

export function finalizeBudget(plan: TripPlan, cap: number): BudgetSummary {
  let low = 0;
  let high = 0;
  for (const day of plan.days) {
    low += day.estimatedCostCny[0];
    high += day.estimatedCostCny[1];
  }
  return { low, high, cap, withinBudget: high <= cap };
}

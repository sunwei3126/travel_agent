import { expect, it } from "vitest";
import { finalizeBudget } from "./budget";

it("sums upper bounds and compares with the cap", () => {
  const plan = { days: [
    { estimatedCostCny: [100, 1200] }, { estimatedCostCny: [200, 1300] }, { estimatedCostCny: [300, 600] },
  ] } as any;
  expect(finalizeBudget(plan, 3000)).toEqual({ low: 600, high: 3100, cap: 3000, withinBudget: false });
});

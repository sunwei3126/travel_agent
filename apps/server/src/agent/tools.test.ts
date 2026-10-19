import { describe, expect, it } from "vitest";
import { mergeBrief, upsertDayCard } from "../trips/docs";
import { finalizeBudget } from "../plan/budget";

const card = { dayIndex: 1, date: "2026-10-26", title: "旧", blocks: [], scenery: [], food: [], transport: [], estimatedCostCny: [100, 200], sources: [], svgStatus: "pending", updatedAt: "" } as any;

it("merges brief patches and replaces a day card by index", () => {
  expect(mergeBrief({}, { destination: "泰山" })).toMatchObject({ destination: "泰山" });
  const plan = upsertDayCard({ days: [] }, card);
  expect(plan.days).toHaveLength(1);
  const updated = upsertDayCard(plan, { ...card, title: "新" });
  expect(updated.days).toHaveLength(1);
  expect(updated.days[0].title).toBe("新");
});

it("finalizes the 3100 upper bound as over budget", () => {
  expect(finalizeBudget({ days: [{ estimatedCostCny: [100, 1200] }, { estimatedCostCny: [200, 1300] }, { estimatedCostCny: [300, 600] }] } as any, 3000).withinBudget).toBe(false);
});

import { describe, expect, it, vi } from "vitest";
import type { DayCard, TripPlan } from "@pi-demo/shared";
import { mergeBrief, upsertDayCard } from "../trips/docs";
import { finalizeBudget } from "../plan/budget";
import type { TravelDeps } from "./deps";
import { applyDayEmit, createEmitDayTool, type EmitDayArgs } from "./tools/emit-day";

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

describe("plan_emit_day", () => {
  const deps = {
    now: () => new Date("2026-10-19T00:00:00Z"),
    deepseek: { search: vi.fn(), fetch: vi.fn() },
    generateSketch: async () => ({ svg: "<svg />", status: "ok" as const }),
    caps: { search: 40, fetch: 30 },
  } as unknown as TravelDeps;

  it("uses an array schema (not a tuple) for both cost pairs", () => {
    const schema = createEmitDayTool(deps).parameters as any;
    const cost = schema.properties.estimatedCostCny;
    const blockCost = schema.properties.blocks.items.properties.costCny;

    expect(cost).toMatchObject({
      type: "array",
      items: { type: "number" },
      minItems: 2,
      maxItems: 2,
    });
    expect(Array.isArray(cost.items)).toBe(false);
    expect(blockCost).toMatchObject({
      type: "array",
      items: { type: "number" },
      minItems: 2,
      maxItems: 2,
    });
    expect(Array.isArray(blockCost.items)).toBe(false);
  });

  const day = (dayIndex: number, title: string, svg: string): DayCard => ({
    dayIndex,
    date: `2026-10-${25 + dayIndex}`,
    title,
    blocks: [],
    scenery: [],
    food: [],
    transport: [],
    estimatedCostCny: [100, 200],
    sources: [],
    svg,
    svgStatus: "ok",
    updatedAt: "2026-10-19T00:00:00.000Z",
  });

  const emit = (dayIndex: number, title: string): EmitDayArgs => ({
    dayIndex,
    date: `2026-10-${25 + dayIndex}`,
    title,
    blocks: [],
    scenery: [],
    food: [],
    transport: [],
    estimatedCostCny: [120, 220],
    sources: [],
  });

  it("changes only the targeted day and preserves an unchanged sketch", () => {
    const plan: TripPlan = {
      days: [day(1, "第一天", "<svg>1</svg>"), day(2, "第二天", "<svg>2</svg>")],
    };
    const firstBefore = JSON.parse(JSON.stringify(plan.days[0]));

    const changed = applyDayEmit(plan, emit(2, "第二天改"), new Date("2026-10-20T00:00:00Z"));
    expect(changed.days[0]).toEqual(firstBefore);
    expect(changed.days).toHaveLength(2);
    expect(changed.days[1].title).toBe("第二天改");
    expect(changed.days[1].svg).toBeUndefined();
    expect(changed.days[1].svgStatus).toBe("pending");

    const sketched = {
      ...changed,
      days: [{ ...changed.days[0] }, { ...changed.days[1], svg: "<svg>2b</svg>", svgStatus: "ok" as const }],
    };
    const unchanged = applyDayEmit(
      sketched,
      emit(2, "第二天改"),
      new Date("2026-10-21T00:00:00Z"),
    );
    expect(unchanged.days[0]).toEqual(firstBefore);
    expect(unchanged.days[1].svg).toBe("<svg>2b</svg>");
    expect(unchanged.days[1].svgStatus).toBe("ok");
  });

  it("maps array costs back to tuples and rejects a wrong pair length", () => {
    const plan = applyDayEmit(
      { days: [] },
      { ...emit(1, "第一天"), estimatedCostCny: [10, 20] },
      new Date("2026-10-20T00:00:00Z"),
    );
    expect(plan.days[0].estimatedCostCny).toEqual([10, 20]);

    expect(() =>
      applyDayEmit(
        { days: [] },
        { ...emit(1, "第一天"), estimatedCostCny: [10] },
        new Date("2026-10-20T00:00:00Z"),
      ),
    ).toThrow("exactly two numbers");
  });
});

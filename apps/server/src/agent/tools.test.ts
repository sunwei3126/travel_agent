import type { DayCard, TripPlan } from "@pi-demo/shared";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { finalizeBudget } from "../plan/budget";
import { mergeBrief, upsertDayCard } from "../trips/docs";
import { applyDayEmit, createEmitDayTool, emitDayShape, type EmitDayArgs } from "./tools/emit-day";
import { createFinalizeTool } from "./tools/finalize";
import { createSketchDayTool } from "./tools/sketch-day";
import { TRIP_ID, completeBrief, invoke, makeContext, textOf } from "./tools/test-support";

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

it("merges brief patches and replaces a day card by index", () => {
  expect(mergeBrief({}, { destination: "泰山" })).toMatchObject({ destination: "泰山" });
  const plan = upsertDayCard({ days: [] }, day(1, "旧", ""));
  expect(plan.days).toHaveLength(1);
  const updated = upsertDayCard(plan, day(1, "新", ""));
  expect(updated.days).toHaveLength(1);
  expect(updated.days[0].title).toBe("新");
});

it("finalizes the 3100 upper bound as over budget", () => {
  const plan: TripPlan = {
    days: [
      { ...day(1, "a", ""), estimatedCostCny: [100, 1200] },
      { ...day(2, "b", ""), estimatedCostCny: [200, 1300] },
      { ...day(3, "c", ""), estimatedCostCny: [300, 600] },
    ],
  };
  expect(finalizeBudget(plan, 3000).withinBudget).toBe(false);
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

describe("plan_emit_day", () => {
  it("uses an array schema (not a tuple) for both cost pairs", () => {
    type JsonSchemaPair = { type: string; items: unknown; minItems?: number; maxItems?: number };
    type EmitDayJsonSchema = {
      properties: {
        estimatedCostCny: JsonSchemaPair;
        blocks: { items: { properties: { costCny: JsonSchemaPair } } };
      };
    };
    // `z.toJSONSchema` returns a loose record; this names only the paths asserted below.
    const schema = z.toJSONSchema(z.object(emitDayShape)) as unknown as EmitDayJsonSchema;
    const cost = schema.properties.estimatedCostCny;
    const blockCost = schema.properties.blocks.items.properties.costCny;

    for (const pair of [cost, blockCost]) {
      expect(pair).toMatchObject({ type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 });
      expect(Array.isArray(pair.items)).toBe(false);
    }
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
    const unchanged = applyDayEmit(sketched, emit(2, "第二天改"), new Date("2026-10-21T00:00:00Z"));
    expect(unchanged.days[0]).toEqual(firstBefore);
    expect(unchanged.days[1].svg).toBe("<svg>2b</svg>");
    expect(unchanged.days[1].svgStatus).toBe("ok");
  });

  it("maps array costs back to tuples and rejects a wrong pair length", () => {
    const plan = applyDayEmit({ days: [] }, { ...emit(1, "第一天"), estimatedCostCny: [10, 20] }, new Date("2026-10-20T00:00:00Z"));
    expect(plan.days[0].estimatedCostCny).toEqual([10, 20]);

    expect(() =>
      applyDayEmit({ days: [] }, { ...emit(1, "第一天"), estimatedCostCny: [10] }, new Date("2026-10-20T00:00:00Z")),
    ).toThrow("exactly two numbers");
  });

  it("writes a valid day to the stored plan", async () => {
    const ctx = makeContext();
    ctx.store.setDoc(TRIP_ID, "brief", completeBrief);
    const result = await invoke(createEmitDayTool(ctx), emit(1, "第一天"));
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toBe("Day 1 written.");
    expect(ctx.store.getDoc(TRIP_ID, "plan").days.map((d) => d.title)).toEqual(["第一天"]);
  });

  it("refuses to write while the brief is incomplete", async () => {
    const ctx = makeContext();
    ctx.store.setDoc(TRIP_ID, "brief", { destination: "泰山" });
    const result = await invoke(createEmitDayTool(ctx), emit(1, "第一天"));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("trip brief is incomplete");
    expect(ctx.store.getDoc(TRIP_ID, "plan").days).toEqual([]);
  });

  it("rejects an inverted cost range and leaves the plan untouched", async () => {
    const ctx = makeContext();
    ctx.store.setDoc(TRIP_ID, "brief", completeBrief);
    const result = await invoke(createEmitDayTool(ctx), { ...emit(1, "第一天"), estimatedCostCny: [300, 100] });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("cost low must not exceed high");
    expect(ctx.store.getDoc(TRIP_ID, "plan").days).toEqual([]);
  });
});

describe("plan_finalize", () => {
  it("stores the budget summary and reports whether it is within budget", async () => {
    const ctx = makeContext();
    ctx.store.setDoc(TRIP_ID, "brief", completeBrief);
    ctx.store.setDoc(TRIP_ID, "plan", {
      days: [
        { ...day(1, "a", ""), estimatedCostCny: [100, 1200] },
        { ...day(2, "b", ""), estimatedCostCny: [200, 1300] },
        { ...day(3, "c", ""), estimatedCostCny: [300, 600] },
      ],
    });
    const result = await invoke(createFinalizeTool(ctx), {});
    expect(textOf(result)).toBe("Estimated 600-3100 CNY against a 3000 CNY budget: over budget.");
    const plan = ctx.store.getDoc(TRIP_ID, "plan");
    expect(plan.budget).toEqual({ low: 600, high: 3100, cap: 3000, withinBudget: false });
    expect(plan.days).toHaveLength(3);
  });

  it("fails when the brief has no budget", async () => {
    const ctx = makeContext();
    const result = await invoke(createFinalizeTool(ctx), {});
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("Cannot finalize: trip brief has no budgetCny");
  });
});

describe("sketch_day", () => {
  it("stores the generated sketch on the targeted card only", async () => {
    const ctx = makeContext({ generateSketch: async () => ({ svg: "<svg>new</svg>", status: "ok" }) });
    ctx.store.setDoc(TRIP_ID, "plan", { days: [day(1, "a", "<svg>1</svg>"), day(2, "b", "<svg>2</svg>")] });
    const result = await invoke(createSketchDayTool(ctx), { dayIndex: 2 });
    expect(textOf(result)).toBe("Sketch for day 2 is ok.");
    const plan = ctx.store.getDoc(TRIP_ID, "plan");
    expect(plan.days[0].svg).toBe("<svg>1</svg>");
    expect(plan.days[1].svg).toBe("<svg>new</svg>");
  });

  it("records a failed sketch with its placeholder", async () => {
    const ctx = makeContext({ generateSketch: async () => ({ svg: "<svg>placeholder</svg>", status: "failed" }) });
    ctx.store.setDoc(TRIP_ID, "plan", { days: [{ ...day(1, "a", ""), svgStatus: "pending" }] });
    await invoke(createSketchDayTool(ctx), { dayIndex: 1 });
    expect(ctx.store.getDoc(TRIP_ID, "plan").days[0]).toMatchObject({ svg: "<svg>placeholder</svg>", svgStatus: "failed" });
  });

  it("fails for a day that has no card", async () => {
    const ctx = makeContext();
    const result = await invoke(createSketchDayTool(ctx), { dayIndex: 9 });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("Cannot sketch day 9: no day card with that dayIndex");
  });
});

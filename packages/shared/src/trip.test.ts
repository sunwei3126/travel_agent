import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { DayCardSchema, TripBriefSchema, isBriefComplete, missingBriefFields } from "./index";

const brief = {
  destination: "泰山", origin: "上海虹桥", startDate: "2026-10-26", days: 3,
  budgetCny: 3000, companions: "独自", fitness: "average" as const,
  interests: ["风景", "美食"], constraints: [], assumptions: [],
};

describe("trip schemas", () => {
  it("accepts the Tai Shan brief and reports it complete", () => {
    expect(Value.Check(TripBriefSchema, brief)).toBe(true);
    expect(isBriefComplete(brief)).toBe(true);
    expect(missingBriefFields({})).toEqual([
      "destination", "origin", "startDate", "days", "budgetCny", "companions", "fitness", "interests",
    ]);
  });
  it("accepts a 30-day card and rejects a card without cost", () => {
    const card = {
      dayIndex: 30, date: "2026-11-24", title: "第 30 天", blocks: [],
      scenery: [], food: [], transport: [], estimatedCostCny: [100, 200],
      sources: [], svgStatus: "pending" as const, updatedAt: "2026-10-19T00:00:00.000Z",
    };
    expect(Value.Check(DayCardSchema, card)).toBe(true);
    expect(Value.Check(DayCardSchema, { ...card, estimatedCostCny: undefined })).toBe(false);
  });
});

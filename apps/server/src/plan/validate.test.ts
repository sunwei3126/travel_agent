import { describe, expect, it } from "vitest";
import { isValidCalendarDate, validateBrief, validateDayCard } from "./validate";

const brief = { destination: "泰山", origin: "上海虹桥", startDate: "2026-10-26", days: 3, budgetCny: 3000, companions: "独自", fitness: "average", interests: ["风景"], constraints: [], assumptions: [] } as any;
const sources = { s1: { id: "s1", query: "q", title: "t", url: "u", snippet: "", kind: "fetch", fetchedAt: "2026-10-19" } } as any;

it("rejects a past date and a zero-day trip", () => {
  expect(validateBrief({ ...brief, startDate: "2020-01-01" }, new Date("2026-10-19"))).toContain("startDate must not be in the past");
  expect(validateBrief({ ...brief, days: 0 }, new Date("2026-10-19"))).toContain("days must be at least 1");
});

it("rejects impossible calendar dates rather than only matching the shape", () => {
  expect(isValidCalendarDate("2026-02-30")).toBe(false);
  expect(isValidCalendarDate("2026-13-01")).toBe(false);
  expect(isValidCalendarDate("2028-02-29")).toBe(true);
  expect(
    validateBrief({ ...brief, startDate: "2026-02-30" }, new Date("2026-10-19")),
  ).toContain("startDate must be a real calendar date (YYYY-MM-DD)");
});

it("allows an incomplete brief during incremental updates", () => {
  expect(
    validateBrief({ startDate: "2026-10-26" }, new Date("2026-10-19"), {
      requireComplete: false,
    }),
  ).toEqual([]);
});

it("requires a fetched page for non-unverified hard facts", () => {
  const snippetOnly = {
    id: "s2",
    query: "q",
    title: "t",
    url: "https://example.com/snippet",
    snippet: "门票 115 元",
    kind: "search" as const,
  };
  const fact = { text: "门票 115 元", kind: "fact" as const, sourceIds: ["s2"] };
  const card = {
    dayIndex: 1,
    date: "2026-10-26",
    title: "D1",
    blocks: [{ time: "09:00", title: "红门", detail: "", claims: [fact] }],
    scenery: [],
    food: [],
    transport: [],
    estimatedCostCny: [100, 200],
    sources: ["s2"],
    svgStatus: "pending",
    updatedAt: "",
  } as any;

  expect(
    validateDayCard(card, { s2: snippetOnly }, brief).some((error) =>
      error.includes("unfetched source"),
    ),
  ).toBe(true);

  expect(
    validateDayCard(
      card,
      { s2: { ...snippetOnly, fetchedAt: "2026-10-19T00:00:00.000Z" } },
      brief,
    ),
  ).toEqual([]);
});

it("requires claim-level sources for hard facts and allows unverified claims", () => {
  const fact = { text: "门票 115 元", kind: "fact", sourceIds: ["missing"] };
  const card = { dayIndex: 1, date: "2026-10-26", title: "D1", blocks: [{ time: "09:00", title: "红门", detail: "", claims: [fact] }], scenery: [], food: [], transport: [], estimatedCostCny: [100, 200], sources: [], svgStatus: "pending", updatedAt: "" } as any;
  expect(validateDayCard(card, sources, brief)).toContain("claim references unknown source: missing");
  const unverified = { ...fact, sourceIds: [], unverified: true };
  expect(validateDayCard({ ...card, blocks: [{ ...card.blocks[0], claims: [unverified] }] }, sources, brief)).toEqual([]);
});

it("refuses a day card while the brief is incomplete", () => {
  const card = { dayIndex: 1, date: "2026-10-26", title: "D1", blocks: [], scenery: [], food: [], transport: [], estimatedCostCny: [0, 0], sources: [], svgStatus: "pending", updatedAt: "" } as any;
  expect(validateDayCard(card, sources, {})).toContain("brief is incomplete");
});

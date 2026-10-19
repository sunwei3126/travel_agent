import { describe, expect, it, vi } from "vitest";
import { generateDaySketch } from "./generate";

const day = { dayIndex: 1, date: "2026-10-26", title: "抵达与老城", blocks: [{ time: "14:00", title: "岱庙", detail: "", claims: [] }], scenery: [], food: [], transport: [], estimatedCostCny: [0, 0], sources: [], svgStatus: "pending", updatedAt: "" } as any;

it("retries once when the first SVG is invalid", async () => {
  const generate = vi.fn()
    .mockResolvedValueOnce("not svg")
    .mockResolvedValueOnce('<svg viewBox="0 0 100 100"><rect width="10" height="10"/></svg>');
  const result = await generateDaySketch({ day, generate });
  expect(result.status).toBe("ok");
  expect(generate).toHaveBeenCalledTimes(2);
  expect(generate.mock.calls[1][0]).toContain("not svg");
});

it("falls back to a placeholder after two failures", async () => {
  const result = await generateDaySketch({ day, generate: async () => "still not svg" });
  expect(result.status).toBe("failed");
  expect(result.svg).toContain("Day 1");
  expect(result.error).toBeTruthy();
});

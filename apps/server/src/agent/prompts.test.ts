import { describe, expect, it } from "vitest";
import { PLANNER_INSTRUCTIONS } from "./prompts";

describe("PLANNER_INSTRUCTIONS", () => {
  it("contains the review-mandated planning rules", () => {
    expect(PLANNER_INSTRUCTIONS).toContain("at most 3 key questions");
    expect(PLANNER_INSTRUCTIONS).toContain("No research before the brief is complete");
    expect(PLANNER_INSTRUCTIONS).toContain("A search snippet is only a lead");
    expect(PLANNER_INSTRUCTIONS).toContain("last 90 days");
    expect(PLANNER_INSTRUCTIONS).toContain("official sources");
    expect(PLANNER_INSTRUCTIONS).toContain("12306");
    expect(PLANNER_INSTRUCTIONS).toContain("Targeted edits and cascades");
    expect(PLANNER_INSTRUCTIONS).toContain("changes only that day");
  });
});

import { describe, expect, it } from "vitest";
import { PLANNER_INSTRUCTIONS } from "./prompts";
import { buildSystemPrompt } from "./system-prompt";
import { TRIP_ID, completeBrief, makeContext } from "./tools/test-support";

describe("buildSystemPrompt", () => {
  it("is just the planner instructions for a trip with no state", () => {
    const { store } = makeContext();
    expect(buildSystemPrompt(store, TRIP_ID, new Date("2026-10-19T00:00:00Z"))).toBe(PLANNER_INSTRUCTIONS);
  });

  it("appends the current trip state once there is any", () => {
    const { store } = makeContext();
    store.setDoc(TRIP_ID, "brief", completeBrief);
    const prompt = buildSystemPrompt(store, TRIP_ID, new Date("2026-10-19T00:00:00Z"));
    expect(prompt.startsWith(PLANNER_INSTRUCTIONS)).toBe(true);
    expect(prompt).toContain("## Current trip state");
    expect(prompt).toContain("泰山");
  });
});

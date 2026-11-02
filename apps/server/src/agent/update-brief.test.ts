import { describe, expect, it } from "vitest";
import { createUpdateBriefTool } from "./tools/update-brief";
import { TRIP_ID, completeBrief, invoke, makeContext, textOf } from "./tools/test-support";

describe("trip_update_brief", () => {
  it("merges the patch and reports the fields that are still missing", async () => {
    const ctx = makeContext();
    const result = await invoke(createUpdateBriefTool(ctx), { destination: "泰山", days: 3 });
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toBe(
      "Missing brief fields: origin, startDate, budgetCny, companions, fitness, interests",
    );
    expect(ctx.store.getDoc(TRIP_ID, "brief")).toEqual({ destination: "泰山", days: 3 });
  });

  it("accepts an incremental update that leaves the brief incomplete", async () => {
    const ctx = makeContext();
    const result = await invoke(createUpdateBriefTool(ctx), { fitness: "low" });
    expect(result.isError).toBeUndefined();
    expect(ctx.store.getDoc(TRIP_ID, "brief")).toEqual({ fitness: "low" });
  });

  it("says the brief is complete once every required field is present", async () => {
    const ctx = makeContext();
    ctx.store.setDoc(TRIP_ID, "brief", { ...completeBrief, interests: undefined });
    const result = await invoke(createUpdateBriefTool(ctx), { interests: ["风景"] });
    expect(textOf(result)).toBe("Brief is complete.");
  });

  it("validates the merged brief before committing", async () => {
    const ctx = makeContext();
    ctx.store.setDoc(TRIP_ID, "brief", { destination: "泰山" });
    const impossibleDate = await invoke(createUpdateBriefTool(ctx), { startDate: "2026-02-30" });
    expect(impossibleDate.isError).toBe(true);
    expect(textOf(impossibleDate)).toContain("Invalid trip brief");
    const noDays = await invoke(createUpdateBriefTool(ctx), { days: 0 });
    expect(noDays.isError).toBe(true);
    expect(ctx.store.getDoc(TRIP_ID, "brief")).toEqual({ destination: "泰山" });
  });
});

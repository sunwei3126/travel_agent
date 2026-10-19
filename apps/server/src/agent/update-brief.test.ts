import type { TripBrief } from "@pi-demo/shared";
import { describe, expect, it, vi } from "vitest";
import { TripBriefDoc } from "../trips/docs";
import type { TravelDeps } from "./deps";
import { createUpdateBriefTool } from "./tools/update-brief";

function tool() {
  const deps = {
    now: () => new Date("2026-10-19T00:00:00Z"),
    deepseek: { search: vi.fn(), fetch: vi.fn() },
    generateSketch: async () => ({ svg: "", status: "ok" as const }),
    caps: { search: 40, fetch: 30 },
  } as unknown as TravelDeps;
  return createUpdateBriefTool(deps);
}

function apiFor(brief: TripBrief) {
  return {
    conversationId: 1,
    commit: async <T>(
      change: (tx: { doc: (token: unknown) => Promise<unknown> }) => T | Promise<T>,
    ): Promise<T> =>
      change({
        doc: async (token: unknown) => {
          if (token !== TripBriefDoc) throw new Error("unexpected doc");
          return brief;
        },
      }),
  };
}

describe("trip_update_brief", () => {
  it("validates the merged brief before committing", async () => {
    const brief: TripBrief = { destination: "泰山" };
    await expect(
      tool().execute(
        { startDate: "2026-02-30" },
        apiFor(brief) as never,
        {} as never,
      ),
    ).rejects.toThrow("real calendar date");
    expect(brief.startDate).toBeUndefined();
  });

  it("accepts an incremental update that leaves the brief incomplete", async () => {
    const brief: TripBrief = { destination: "泰山" };
    const result = await tool().execute(
      { origin: "上海虹桥" },
      apiFor(brief) as never,
      {} as never,
    );
    expect(brief.origin).toBe("上海虹桥");
    expect(result.structuredOutput).toMatchObject({ missing: expect.any(Array) });
  });
});

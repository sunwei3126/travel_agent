import { EventType, type BaseEvent } from "@ag-ui/core";
import { verifyEvents } from "@ag-ui/client";
import { lastValueFrom, of } from "rxjs";
import { describe, expect, it } from "vitest";
import { buildSnapshot, createPiEventMapper } from "./mapper";

/**
 * Runs the mapped events through the real @ag-ui/client verifier, which is the
 * component that rejected the old stream for leaving tool calls active.
 */
describe("AG-UI protocol conformance", () => {
  it("accepts a mapped tool call lifecycle and RUN_FINISHED", async () => {
    const mapper = createPiEventMapper();
    const snapshot = buildSnapshot({
      threadId: "t1",
      runId: "r1",
      entries: [],
      brief: {},
      plan: { days: [] },
      sources: {},
      research: { searchCount: 0, fetchCount: 0 },
      running: true,
    });
    const start = mapper.map({
      type: "tool_execution_start",
      toolCallId: "tc1",
      toolName: "deepseek_search",
      args: { query: "泰山 门票" },
    } as never);
    const end = mapper.map({
      type: "tool_execution_end",
      toolCallId: "tc1",
      toolName: "deepseek_search",
      entry: {
        id: 9,
        model: [
          {
            role: "toolResult",
            toolCallId: "tc1",
            toolName: "deepseek_search",
            content: [{ type: "text", text: "ok" }],
            isError: false,
            timestamp: 1,
          },
        ],
      },
    } as never);

    const events = [
      { type: EventType.RUN_STARTED, threadId: "t1", runId: "r1" },
      ...snapshot,
      ...start,
      ...end,
      { type: EventType.RUN_FINISHED, threadId: "t1", runId: "r1" },
    ] as BaseEvent[];

    await expect(
      lastValueFrom(of(...events).pipe(verifyEvents())),
    ).resolves.toMatchObject({ type: EventType.RUN_FINISHED });
  });
});

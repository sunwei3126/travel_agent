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

  it("accepts a reasoning lifecycle and RUN_FINISHED", async () => {
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
      type: "message_start",
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "先想" }],
      },
    } as never);
    const delta = mapper.map({
      type: "message_update",
      changes: [{ type: "thinking_delta", contentIndex: 0, delta: "一下" }],
    } as never);
    const end = mapper.map({
      type: "message_end",
      entry: {
        id: 7,
        model: [
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "先想一下" },
              { type: "text", text: "你好" },
            ],
          },
        ],
      },
    } as never);
    const runEnd = mapper.map({ type: "run_end", inputs: [] } as never);

    const events = [
      { type: EventType.RUN_STARTED, threadId: "t1", runId: "r1" },
      ...snapshot,
      ...start,
      ...delta,
      ...end,
      ...runEnd,
      { type: EventType.RUN_FINISHED, threadId: "t1", runId: "r1" },
    ] as BaseEvent[];

    await expect(
      lastValueFrom(of(...events).pipe(verifyEvents())),
    ).resolves.toMatchObject({ type: EventType.RUN_FINISHED });
  });

  it("accepts a partial tool call streamed to completion", async () => {
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
      type: "message_start",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "tc1", name: "deepseek_search", arguments: {} }],
      },
    } as never);
    const delta = mapper.map({
      type: "message_update",
      changes: [
        { type: "toolcall_delta", contentIndex: 0, path: ["query"], delta: "泰山" },
      ],
    } as never);
    const committed = mapper.map({
      type: "message_end",
      entry: {
        id: 7,
        model: [
          {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "tc1",
                name: "deepseek_search",
                arguments: { query: "泰山", count: 5 },
              },
            ],
          },
        ],
      },
    } as never);
    const fire = mapper.map({
      type: "tool_execution_start",
      toolCallId: "tc1",
      toolName: "deepseek_search",
      args: { query: "泰山", count: 5 },
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
    const runEnd = mapper.map({ type: "run_end", inputs: [] } as never);

    const events = [
      { type: EventType.RUN_STARTED, threadId: "t1", runId: "r1" },
      ...snapshot,
      ...start,
      ...delta,
      ...committed,
      ...fire,
      ...end,
      ...runEnd,
      { type: EventType.RUN_FINISHED, threadId: "t1", runId: "r1" },
    ] as BaseEvent[];

    await expect(
      lastValueFrom(of(...events).pipe(verifyEvents())),
    ).resolves.toMatchObject({ type: EventType.RUN_FINISHED });
  });

  it("rejects RUN_FINISHED while a reasoning message is still open", async () => {
    const events = [
      { type: EventType.RUN_STARTED, threadId: "t1", runId: "r1" },
      {
        type: EventType.REASONING_MESSAGE_START,
        messageId: "r-open",
        role: "reasoning",
      },
      { type: EventType.RUN_FINISHED, threadId: "t1", runId: "r1" },
    ] as BaseEvent[];

    await expect(
      lastValueFrom(of(...events).pipe(verifyEvents())),
    ).rejects.toThrow();
  });
});

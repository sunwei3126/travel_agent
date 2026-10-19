import { describe, expect, it } from "vitest";
import { buildSnapshot, mapPiEvents } from "./mapper";

const card = { dayIndex: 1, date: "2026-10-26", title: "D1", blocks: [], scenery: [], food: [], transport: [], estimatedCostCny: [0, 0], sources: [], svgStatus: "pending", updatedAt: "" } as any;

it("builds a messages snapshot and a state snapshot", () => {
  const events = buildSnapshot({ threadId: "t1", runId: "r1", entries: [], brief: {}, plan: { days: [card] }, sources: {}, research: { searchCount: 1, fetchCount: 0 }, running: true });
  expect(events.map((e) => e.type)).toEqual(["MESSAGES_SNAPSHOT", "STATE_SNAPSHOT"]);
  expect((events[1] as any).snapshot.plan.days).toHaveLength(1);
});

it("maps text and tool events with stable ids", () => {
  expect(mapPiEvents([{ type: "message_update", messageId: "m1", delta: "你" } as any])[0]).toMatchObject({ type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "你" });
  expect(mapPiEvents([{ type: "tool_execution_start", toolCallId: "tc1", toolName: "deepseek_search" } as any])[0]).toMatchObject({ type: "TOOL_CALL_START", toolCallId: "tc1" });
});

describe("AG-UI event mapper", () => {
  it("ignores the pi-durable snapshot event and accepts a single event", () => {
    expect(mapPiEvents({ type: "snapshot" } as any)).toEqual([]);
  });

  it("builds snapshot messages from transcript entries", () => {
    const events = buildSnapshot({
      threadId: "t1",
      runId: "r1",
      entries: [
        { id: "m1", role: "user", content: "hi" },
        { id: "m2", role: "assistant", content: "yo" },
        { id: "m3", role: "tool", content: "ok", name: "deepseek_search" },
      ],
      brief: {},
      plan: { days: [] },
      sources: {},
      research: { searchCount: 1, fetchCount: 2 },
      running: false,
    });

    expect((events[0] as any).messages).toEqual([
      { id: "m1", role: "user", content: "hi" },
      { id: "m2", role: "assistant", content: "yo" },
      { id: "m3", role: "tool", content: "ok", toolCallId: "m3" },
    ]);
    expect((events[1] as any).snapshot).toEqual({
      brief: {},
      plan: { days: [] },
      sources: {},
      research: { searchCount: 1, fetchCount: 2, running: false },
    });
  });

  it("maps the real pi-durable assistant text lifecycle with one message id", () => {
    const start = mapPiEvents({
      type: "message_start",
      message: { role: "assistant", timestamp: 1, content: [] },
    } as any);
    const update = mapPiEvents({
      type: "message_update",
      usage: {},
      changes: [{ type: "text_delta", contentIndex: 0, delta: "泰山" }],
    } as any);
    const end = mapPiEvents({
      type: "message_end",
      entry: { id: 7, model: [{ role: "assistant", timestamp: 1, content: [] }] },
    } as any);

    expect(start.map((event) => event.type)).toEqual(["TEXT_MESSAGE_START"]);
    expect(update).toMatchObject([{ type: "TEXT_MESSAGE_CONTENT", delta: "泰山" }]);
    expect(end.map((event) => event.type)).toEqual(["TEXT_MESSAGE_END"]);

    const ids = [start[0], update[0], end[0]].map((event) => (event as any).messageId);
    expect(new Set(ids).size).toBe(1);
  });

  it("maps a tool result from the tool result entry", () => {
    const events = mapPiEvents({
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
    } as any);

    expect(events[0]).toMatchObject({
      type: "TOOL_CALL_RESULT",
      toolCallId: "tc1",
      messageId: "9",
      content: "ok",
    });
  });

  it("maps a failed pi task to RUN_ERROR", () => {
    expect(
      mapPiEvents({
        type: "task_failed",
        taskId: 1,
        kind: "pi.generation",
        message: "boom",
      } as any)[0],
    ).toMatchObject({ type: "RUN_ERROR", message: "boom", code: "pi.generation" });
  });

  it("does not end the run when only a tool task fails", () => {
    expect(
      mapPiEvents({
        type: "task_failed",
        taskId: 2,
        kind: "pi.tool",
        message: "tool boom",
      } as any),
    ).toEqual([]);
  });
});

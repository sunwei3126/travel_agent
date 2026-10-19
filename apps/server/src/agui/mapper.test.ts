import { describe, expect, it } from "vitest";
import { buildSnapshot, createPiEventMapper, mapPiEvents } from "./mapper";

const card = { dayIndex: 1, date: "2026-10-26", title: "D1", blocks: [], scenery: [], food: [], transport: [], estimatedCostCny: [0, 0], sources: [], svgStatus: "pending", updatedAt: "" } as any;

it("builds a messages snapshot and a state snapshot", () => {
  const events = buildSnapshot({ threadId: "t1", runId: "r1", entries: [], brief: {}, plan: { days: [card] }, sources: {}, research: { searchCount: 1, fetchCount: 0 }, running: true });
  expect(events.map((e) => e.type)).toEqual(["MESSAGES_SNAPSHOT", "STATE_SNAPSHOT"]);
  expect((events[1] as any).snapshot.plan.days).toHaveLength(1);
});

it("maps text and tool events with stable ids", () => {
  expect(
    mapPiEvents([{ type: "message_update", messageId: "m1", delta: "你" } as any]),
  ).toMatchObject([
    { type: "TEXT_MESSAGE_START", messageId: "m1" },
    { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "你" },
  ]);
  expect(
    mapPiEvents([
      {
        type: "tool_execution_start",
        toolCallId: "tc1",
        toolName: "deepseek_search",
        args: { query: "泰山" },
      } as any,
    ])[0],
  ).toMatchObject({ type: "TOOL_CALL_START", toolCallId: "tc1" });
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
      {
        id: "m3",
        role: "tool",
        content: "ok",
        toolCallId: "m3",
        metadata: { "travel.tool": { name: "deepseek_search", status: "ok" } },
      },
    ]);
    expect((events[1] as any).snapshot).toEqual({
      brief: {},
      plan: { days: [] },
      sources: {},
      research: { searchCount: 1, fetchCount: 2, running: false },
    });
  });

  it("builds reasoning, assistant tool calls, and tool errors into the snapshot", () => {
    const events = buildSnapshot({
      threadId: "t1",
      runId: "r1",
      entries: [
        { id: "r1", role: "reasoning", content: "先想一下", encryptedValue: "sig" },
        {
          id: "a1",
          role: "assistant",
          content: "你好",
          toolCalls: [
            { id: "tc1", name: "deepseek_search", arguments: '{"query":"泰山"}' },
          ],
        },
        {
          id: "t1",
          role: "tool",
          content: "找到 3 条",
          toolCallId: "tc1",
          name: "deepseek_search",
          error: "boom",
        },
      ] as any,
      brief: {},
      plan: { days: [] },
      sources: {},
      research: { searchCount: 1, fetchCount: 2 },
      running: false,
    });

    expect((events[0] as any).messages).toEqual([
      { id: "r1", role: "reasoning", content: "先想一下", encryptedValue: "sig" },
      {
        id: "a1",
        role: "assistant",
        content: "你好",
        toolCalls: [
          {
            id: "tc1",
            type: "function",
            function: { name: "deepseek_search", arguments: '{"query":"泰山"}' },
          },
        ],
      },
      {
        id: "t1",
        role: "tool",
        content: "找到 3 条",
        toolCallId: "tc1",
        error: "boom",
        metadata: { "travel.tool": { name: "deepseek_search", status: "error" } },
      },
    ]);
  });

  it("starts text lazily and closes the same message id", () => {
    const mapper = createPiEventMapper();
    const start = mapper.map({
      type: "message_start",
      message: { role: "assistant", timestamp: 1, content: [] },
    } as any);
    const update = mapper.map({
      type: "message_update",
      usage: {},
      changes: [{ type: "text_delta", contentIndex: 0, delta: "泰山" }],
    } as any);
    const end = mapper.map({
      type: "message_end",
      entry: {
        id: 7,
        model: [{ role: "assistant", timestamp: 1, content: [{ type: "text", text: "泰山" }] }],
      },
    } as any);

    expect(start).toEqual([]);
    expect(update.map((event) => event.type)).toEqual([
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
    ]);
    expect(update.at(-1)).toMatchObject({ type: "TEXT_MESSAGE_CONTENT", delta: "泰山" });
    expect(end.map((event) => event.type)).toEqual(["TEXT_MESSAGE_END"]);

    const ids = [update[0], end[0]].map((event) => (event as any).messageId);
    expect(new Set(ids).size).toBe(1);
  });

  it("maps thinking to reasoning events and closes them at message end", () => {
    const mapper = createPiEventMapper();
    const start = mapper.map({
      type: "message_start",
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "先想" }],
      },
    } as any);
    const update = mapper.map({
      type: "message_update",
      changes: [{ type: "thinking_delta", contentIndex: 0, delta: "一下" }],
    } as any);
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
    } as any);

    expect(start.map((event) => event.type)).toEqual([
      "REASONING_START",
      "REASONING_MESSAGE_START",
      "REASONING_MESSAGE_CONTENT",
    ]);
    expect(update.map((event) => event.type)).toEqual(["REASONING_MESSAGE_CONTENT"]);
    expect(update.at(-1)).toMatchObject({ type: "REASONING_MESSAGE_CONTENT", delta: "一下" });
    expect(end.map((event) => event.type)).toEqual([
      "REASONING_MESSAGE_END",
      "REASONING_END",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
    ]);
    expect(end.find((event) => event.type === "REASONING_END")).toMatchObject({
      type: "REASONING_END",
      messageId: (start[0] as any).messageId,
    });
  });

  it("maps streamed tool calls and dedupes the execution start", () => {
    const mapper = createPiEventMapper();
    const start = mapper.map({
      type: "message_start",
      message: { role: "assistant", content: [] },
    } as any);
    const stream = mapper.map({
      type: "message_update",
      changes: [
        {
          type: "toolcall_start",
          contentIndex: 0,
          block: { type: "toolCall", id: "tc1", name: "deepseek_search", arguments: {} },
        },
        {
          type: "toolcall_delta",
          contentIndex: 0,
          path: ["query"],
          delta: '{"query":"泰山"}',
        },
      ],
    } as any);
    const fire = mapper.map({
      type: "tool_execution_start",
      toolCallId: "tc1",
      toolName: "deepseek_search",
      args: { query: "泰山" },
    } as any);
    const result = mapper.map({
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
          },
        ],
      },
    } as any);

    expect(start).toEqual([]);
    expect(stream.map((event) => event.type)).toEqual([
      "TOOL_CALL_START",
      "TOOL_CALL_ARGS",
    ]);
    expect(fire.filter((event) => event.type === "TOOL_CALL_START")).toHaveLength(0);
    expect(fire.map((event) => event.type)).toEqual(["TOOL_CALL_END"]);
    expect(result.map((event) => event.type)).toEqual(["TOOL_CALL_RESULT"]);
    expect(result[0]).toMatchObject({
      type: "TOOL_CALL_RESULT",
      toolCallId: "tc1",
      content: "ok",
      metadata: { "travel.tool": { name: "deepseek_search", status: "ok" } },
    });
  });

  it("maps tool progress to a custom event", () => {
    const mapper = createPiEventMapper();
    mapper.map({
      type: "tool_execution_start",
      toolCallId: "tc1",
      toolName: "deepseek_search",
      args: {},
    } as any);
    const events = mapper.map({
      type: "tool_execution_update",
      toolCallId: "tc1",
      toolName: "deepseek_search",
      output: { append: "搜索中" },
    } as any);

    expect(events[0]).toMatchObject({
      type: "CUSTOM",
      name: "travel.tool_progress",
      value: { toolCallId: "tc1", status: "running", output: "搜索中" },
    });
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

  it("maps a failed generation task to a distinct fault and RUN_ERROR", () => {
    const events = mapPiEvents({
      type: "task_failed",
      taskId: 1,
      kind: "pi.generation",
      message: "boom",
    } as any);
    expect(events[0]).toMatchObject({
      type: "CUSTOM",
      name: "travel.task_failed",
      value: { kind: "pi.generation", message: "boom", taskId: "1" },
    });
    expect(events[1]).toMatchObject({
      type: "RUN_ERROR",
      message: "boom",
      code: "pi.generation",
    });
  });

  it("surfaces a tool task fault without ending the run", () => {
    expect(
      mapPiEvents({
        type: "task_failed",
        taskId: 2,
        kind: "pi.tool",
        message: "tool boom",
      } as any),
    ).toEqual([
      {
        type: "CUSTOM",
        name: "travel.task_failed",
        value: { kind: "pi.tool", message: "tool boom", taskId: "2" },
      },
    ]);
  });

  it("emits TOOL_CALL_ARGS and TOOL_CALL_END around a tool call", () => {
    const mapper = createPiEventMapper();
    const start = mapper.map({
      type: "tool_execution_start",
      toolCallId: "tc1",
      toolName: "deepseek_search",
      args: { query: "泰山 门票" },
    } as any);
    const end = mapper.map({
      type: "tool_execution_end",
      toolCallId: "tc1",
      toolName: "deepseek_search",
      entry: { id: 9, model: [{ role: "toolResult", content: "ok" }] },
    } as any);

    expect(start).toMatchObject([
      { type: "TOOL_CALL_START", toolCallId: "tc1" },
      { type: "TOOL_CALL_ARGS", toolCallId: "tc1" },
      { type: "TOOL_CALL_END", toolCallId: "tc1" },
    ]);
    expect(JSON.parse((start[1] as any).delta)).toEqual({ query: "泰山 门票" });
    expect(end.map((event) => event.type)).toEqual(["TOOL_CALL_RESULT"]);
  });

  it("seeds an in-flight generation partial from the watch snapshot", () => {
    const mapper = createPiEventMapper();
    const seeded = mapper.map({
      type: "snapshot",
      generation: {
        attempt: 1,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "已收到" }],
        },
      },
    } as any);

    expect(seeded).toMatchObject([
      { type: "TEXT_MESSAGE_START" },
      { type: "TEXT_MESSAGE_CONTENT", delta: "已收到" },
    ]);

    const update = mapper.map({
      type: "message_update",
      changes: [{ type: "text_delta", contentIndex: 0, delta: "，正在规划" }],
    } as any);
    expect(update).toMatchObject([
      { type: "TEXT_MESSAGE_CONTENT", delta: "，正在规划" },
    ]);
    expect((update[0] as any).messageId).toBe((seeded[1] as any).messageId);
  });

  it("closes an open message and tool call when the durable run ends", () => {
    const mapper = createPiEventMapper();
    mapper.map({
      type: "message_start",
      message: { role: "assistant", content: [{ type: "text", text: "A" }] },
    } as any);
    mapper.map({
      type: "message_update",
      changes: [
        {
          type: "toolcall_start",
          contentIndex: 0,
          block: {
            type: "toolCall",
            id: "tc1",
            name: "deepseek_search",
            arguments: {},
          },
        },
      ],
    } as any);

    expect(
      mapper.map({ type: "run_end", inputs: [] } as any).map(
        (event) => event.type,
      ),
    ).toEqual(["TEXT_MESSAGE_END", "TOOL_CALL_END"]);
  });

  it("emits text carried by the first committed partial", () => {
    const mapper = createPiEventMapper();
    const events = mapper.map({
      type: "message_start",
      message: { role: "assistant", timestamp: 1, content: [{ type: "text", text: "你" }] },
    } as any);

    expect(events).toMatchObject([
      { type: "TEXT_MESSAGE_START" },
      { type: "TEXT_MESSAGE_CONTENT", delta: "你" },
    ]);
  });

  it("emits only the not-yet-sent suffix from message_end", () => {
    const mapper = createPiEventMapper();
    mapper.map({
      type: "message_start",
      message: { role: "assistant", timestamp: 1, content: [{ type: "text", text: "你" }] },
    } as any);

    const events = mapper.map({
      type: "message_end",
      entry: { id: 7, model: [{ role: "assistant", content: [{ type: "text", text: "你好" }] }] },
    } as any);

    expect(events).toMatchObject([
      { type: "TEXT_MESSAGE_CONTENT", delta: "好" },
      { type: "TEXT_MESSAGE_END" },
    ]);
  });

  it("assigns distinct ids to consecutive assistant messages", () => {
    const mapper = createPiEventMapper();
    const first = mapper.map({
      type: "message_start",
      message: { role: "assistant", timestamp: 1, content: [{ type: "text", text: "A" }] },
    } as any);
    mapper.map({
      type: "message_end",
      entry: { id: 1, model: [{ role: "assistant", content: [{ type: "text", text: "A" }] }] },
    } as any);
    const second = mapper.map({
      type: "message_start",
      message: { role: "assistant", timestamp: 2, content: [{ type: "text", text: "B" }] },
    } as any);

    const firstId = (first[0] as any).messageId;
    const secondId = (second[0] as any).messageId;
    expect(firstId).not.toBe(secondId);
  });

  it("keeps the separator for a streamed block that starts empty and does not duplicate its tail", () => {
    const mapper = createPiEventMapper();
    const start = mapper.map({
      type: "message_start",
      message: { role: "assistant", timestamp: 1, content: [{ type: "text", text: "A" }] },
    } as any);
    const update = mapper.map({
      type: "message_update",
      usage: {},
      changes: [
        { type: "text_start", contentIndex: 1, block: { type: "text", text: "" } },
        { type: "text_delta", contentIndex: 1, delta: "B" },
      ],
    } as any);
    const end = mapper.map({
      type: "message_end",
      entry: {
        id: 7,
        model: [
          {
            role: "assistant",
            content: [{ type: "text", text: "A" }, { type: "text", text: "B" }],
          },
        ],
      },
    } as any);

    expect(start).toMatchObject([
      { type: "TEXT_MESSAGE_START" },
      { type: "TEXT_MESSAGE_CONTENT", delta: "A" },
    ]);
    expect(update).toMatchObject([{ type: "TEXT_MESSAGE_CONTENT", delta: "\nB" }]);
    expect(end.map((event) => event.type)).toEqual(["TEXT_MESSAGE_END"]);
  });

  it("does not reopen the message for a text_start change", () => {
    const mapper = createPiEventMapper();
    mapper.map({
      type: "message_start",
      message: { role: "assistant", timestamp: 1, content: [{ type: "text", text: "A" }] },
    } as any);

    const events = mapper.map({
      type: "message_update",
      usage: {},
      changes: [{ type: "text_start", contentIndex: 1, block: { type: "text", text: "B" } }],
    } as any);

    expect(events.some((event) => event.type === "TEXT_MESSAGE_START")).toBe(false);
    expect(events).toMatchObject([{ type: "TEXT_MESSAGE_CONTENT", delta: "\nB" }]);
  });
});

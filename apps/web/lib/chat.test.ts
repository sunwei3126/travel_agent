import type { Message, ToolCall, ToolMessage } from "@ag-ui/core";
import { describe, expect, it } from "vitest";
import {
  buildChatSegments,
  prettyJson,
  toolLabel,
  toolStatus,
} from "./chat";

const call = {
  id: "tc1",
  type: "function",
  function: { name: "deepseek_search", arguments: '{"query":"泰山"}' },
} as ToolCall;
const assistant = {
  id: "a1",
  role: "assistant",
  content: "你好",
  toolCalls: [call],
} as Message;
const result = {
  id: "t1",
  role: "tool",
  toolCallId: "tc1",
  content: "找到 3 条",
} as ToolMessage;
const orphan = {
  id: "t2",
  role: "tool",
  toolCallId: "tc2",
  content: "孤立结果",
} as ToolMessage;

describe("buildChatSegments", () => {
  it("groups a tool call with its result and keeps orphan results separate", () => {
    const segments = buildChatSegments([assistant, result, orphan]);
    expect(segments.map((segment) => segment.kind)).toEqual([
      "assistant",
      "orphan-tool",
    ]);
    const first = segments[0];
    if (first.kind !== "assistant") throw new Error("expected assistant");
    expect(first.tools).toHaveLength(1);
    expect(first.tools[0].result?.content).toBe("找到 3 条");
  });

  it("attaches live progress by tool call id", () => {
    const progress = new Map([
      ["tc1", { output: "搜索中" }],
    ]);
    const segments = buildChatSegments([assistant], progress);
    const first = segments[0];
    if (first.kind !== "assistant") throw new Error("expected assistant");
    expect(first.tools[0].progress?.output).toBe("搜索中");
  });

  it("drops live progress once the tool result arrives", () => {
    const progress = new Map([
      ["tc1", { output: "搜索中" }],
    ]);
    const segments = buildChatSegments([assistant, result], progress);
    const first = segments[0];
    if (first.kind !== "assistant") throw new Error("expected assistant");
    expect(first.tools[0].progress).toBeUndefined();
  });
});

describe("toolStatus", () => {
  it("derives running, ok, error, and unfinished states", () => {
    expect(toolStatus({ call }, false)).toBe("unfinished");
    expect(toolStatus({ call, progress: { output: "x" } }, false)).toBe("running");
    expect(toolStatus({ call, result }, false)).toBe("ok");
    expect(
      toolStatus({ call, result: { ...result, error: "boom" } }, false),
    ).toBe("error");
  });
});

describe("chat helpers", () => {
  it("pretty prints JSON and keeps malformed input", () => {
    expect(prettyJson('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(prettyJson("not json")).toBe("not json");
  });

  it("maps known tools to Chinese labels", () => {
    expect(toolLabel("deepseek_search")).toBe("搜索资料");
    expect(toolLabel("deepseek_fetch")).toBe("读取网页");
    expect(toolLabel("unknown_tool")).toBe("unknown_tool");
  });
});

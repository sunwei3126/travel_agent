import { describe, expect, it } from "vitest";
import { toTranscriptEntries } from "./transcript";

describe("toTranscriptEntries", () => {
  it("maps assistant thinking, tool calls, and tool results", () => {
    const entries = [
      {
        id: 1,
        model: [
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "先想一下" },
              { type: "text", text: "你好" },
              {
                type: "toolCall",
                id: "tc1",
                name: "deepseek_search",
                arguments: { query: "泰山" },
              },
            ],
          },
        ],
      },
      {
        id: 2,
        model: [
          {
            role: "toolResult",
            toolCallId: "tc1",
            toolName: "deepseek_search",
            content: [{ type: "text", text: "找到 3 条" }],
            isError: true,
          },
        ],
      },
    ] as any;

    expect(toTranscriptEntries(entries)).toEqual([
      { id: "1-thinking-0", role: "reasoning", content: "先想一下" },
      {
        id: "1",
        role: "assistant",
        content: "你好",
        toolCalls: [
          { id: "tc1", name: "deepseek_search", arguments: '{"query":"泰山"}' },
        ],
      },
      {
        id: "2",
        role: "tool",
        content: "找到 3 条",
        name: "deepseek_search",
        toolCallId: "tc1",
        error: "找到 3 条",
      },
    ]);
  });
});

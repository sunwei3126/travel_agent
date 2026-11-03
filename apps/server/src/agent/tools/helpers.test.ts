import { describe, expect, it } from "vitest";
import { errorResult, textResult } from "./helpers";

describe("tool results", () => {
  it("keeps a thrown error's message", () => {
    expect(errorResult(new Error("search cap reached"))).toEqual({
      content: [{ type: "text", text: "search cap reached" }],
      isError: true,
    });
  });

  it("names the error when the message is empty", () => {
    class DeepSeekError extends Error {
      constructor() {
        super("");
        this.name = "DeepSeekError";
      }
    }
    expect(errorResult(new DeepSeekError()).content).toEqual([
      { type: "text", text: "DeepSeekError without a message" },
    ]);
    expect(errorResult(new Error("")).content).toEqual([
      { type: "text", text: "Tool failed without a message" },
    ]);
  });

  it("falls back for a non-error throw", () => {
    expect(errorResult("plain string").content).toEqual([
      { type: "text", text: "plain string" },
    ]);
    expect(errorResult(undefined).content).toEqual([
      { type: "text", text: "Tool failed" },
    ]);
  });

  it("wraps plain text results without an error flag", () => {
    expect(textResult("Day 1 written.")).toEqual({
      content: [{ type: "text", text: "Day 1 written." }],
    });
  });
});

import type { query } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config";
import { createSketchGenerator } from "./sketch-model";

const config = loadConfig({ DEEPSEEK_API_KEY: "k", DATA_DIR: "./data-test", MAGPIE_MODEL: "m1" });

function fakeQuery(messages: unknown[]) {
  const calls: Array<{ prompt: string; options: Record<string, any> }> = [];
  const run = vi.fn((params: { prompt: string; options: Record<string, any> }) => {
    calls.push(params);
    return (async function* () {
      for (const message of messages) yield message;
    })();
  });
  return { run: run as unknown as typeof query, calls };
}

describe("createSketchGenerator", () => {
  it("returns the text of the final result", async () => {
    const { run } = fakeQuery([
      { type: "system", subtype: "init" },
      { type: "result", subtype: "success", is_error: false, result: "<svg/>" },
    ]);
    await expect(createSketchGenerator(config, run)("draw")).resolves.toBe("<svg/>");
  });

  it("runs one tool-less turn on the configured model", async () => {
    const { run, calls } = fakeQuery([{ type: "result", subtype: "success", is_error: false, result: "<svg/>" }]);
    await createSketchGenerator(config, run)("draw a mountain");
    expect(calls[0].prompt).toBe("draw a mountain");
    expect(calls[0].options).toMatchObject({
      model: "m1",
      tools: [],
      maxTurns: 1,
      permissionMode: "dontAsk",
      settingSources: [],
      thinking: { type: "disabled" },
    });
    expect(calls[0].options.cwd).toMatch(/sketch-workspace$/);
  });

  it("fails when the result is an error", async () => {
    const { run } = fakeQuery([{ type: "result", subtype: "error_max_turns", is_error: true }]);
    await expect(createSketchGenerator(config, run)("draw")).rejects.toThrow("Sketch generation failed (error_max_turns)");
  });

  it("fails when no result arrives", async () => {
    const { run } = fakeQuery([{ type: "system", subtype: "init" }]);
    await expect(createSketchGenerator(config, run)("draw")).rejects.toThrow("produced no result");
  });
});

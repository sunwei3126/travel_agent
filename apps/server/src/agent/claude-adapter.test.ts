import type { ClaudeAgentAdapter } from "@ag-ui/claude-agent-sdk";
import type { RunAgentInput } from "@ag-ui/client";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../config";
import { createClaudeAdapterFactory } from "./claude-adapter";
import { makeContext } from "./tools/test-support";

const runInput: RunAgentInput = {
  threadId: "trip-1",
  runId: "r1",
  state: {},
  tools: [],
  context: [],
  forwardedProps: {},
  messages: [{ id: "m1", role: "user", content: "hi" }],
};

describe("createClaudeAdapterFactory", () => {
  const config = loadConfig({
    DEEPSEEK_API_KEY: "k",
    DATA_DIR: join(process.cwd(), "data-test"),
    MAGPIE_BASE_URL: "http://gw",
    MAGPIE_MODEL: "m1",
    PI_THINKING_LEVEL: "medium",
  });

  function options() {
    const { store, deps } = makeContext();
    const adapter = createClaudeAdapterFactory({ config, store, deps })({
      tripId: "trip-1",
      systemPrompt: "SYSTEM",
    }) as ClaudeAgentAdapter;
    return adapter.buildOptions(runInput) as Record<string, any>;
  }

  it("disables built-in tools and grants only the travel tools", () => {
    const built = options();
    expect(built.tools).toEqual([]);
    expect(built.permissionMode).toBe("dontAsk");
    expect(built.settingSources).toEqual([]);
    expect(built.allowedTools).toEqual(
      expect.arrayContaining([
        "mcp__travel__trip_update_brief",
        "mcp__travel__plan_emit_day",
        "mcp__travel__plan_finalize",
        "mcp__travel__deepseek_search",
        "mcp__travel__deepseek_fetch",
        "mcp__travel__sketch_day",
      ]),
    );
    expect(Object.keys(built.mcpServers)).toEqual(["travel"]);
  });

  it("uses the configured model, thinking budget and trip prompt", () => {
    const built = options();
    expect(built.model).toBe("m1");
    expect(built.thinking).toEqual({ type: "enabled", budgetTokens: 8192 });
    expect(built.systemPrompt).toContain("SYSTEM");
    expect(built.includePartialMessages).toBe(true);
  });

  it("keeps Claude state under DATA_DIR and points at the gateway", () => {
    const built = options();
    expect(built.cwd).toBe(join(process.cwd(), "data-test", "claude", "workspace"));
    expect(built.env.CLAUDE_CONFIG_DIR).toBe(join(process.cwd(), "data-test", "claude"));
    expect(built.env.ANTHROPIC_BASE_URL).toBe("http://gw");
  });
});

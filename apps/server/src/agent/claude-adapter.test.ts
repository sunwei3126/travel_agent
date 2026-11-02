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

  const TRAVEL_TOOLS = [
    "mcp__travel__trip_update_brief",
    "mcp__travel__plan_emit_day",
    "mcp__travel__plan_finalize",
    "mcp__travel__deepseek_search",
    "mcp__travel__deepseek_fetch",
    "mcp__travel__sketch_day",
  ];

  function buildAdapter() {
    const { store, deps } = makeContext();
    return createClaudeAdapterFactory({ config, store, deps })({
      tripId: "trip-1",
      systemPrompt: "SYSTEM",
    }) as ClaudeAgentAdapter;
  }

  function options(input: RunAgentInput = runInput) {
    return buildAdapter().buildOptions(input) as Record<string, any>;
  }

  it("disables built-in tools and grants only the travel tools", () => {
    const built = options();
    expect(built.tools).toEqual([]);
    expect(built.permissionMode).toBe("dontAsk");
    expect(built.settingSources).toEqual([]);
    expect(built.allowedTools).toEqual(TRAVEL_TOOLS);
    expect(Object.keys(built.mcpServers)).toEqual(["travel"]);
  });

  it("strips frontend tools and shared state so only the travel tools survive", () => {
    const built = options({
      ...runInput,
      state: { plan: { days: [] } },
      tools: [
        { name: "render_card", description: "Render a card", parameters: { type: "object", properties: {} } },
      ],
    });
    expect(built.allowedTools).toEqual(TRAVEL_TOOLS);
    expect(Object.keys(built.mcpServers)).toEqual(["travel"]);
    expect(built.systemPrompt).toEqual("SYSTEM");
  });

  it("re-creates the SDK session bookkeeping on a clone so run() can admit a thread", () => {
    const clone = buildAdapter().clone() as unknown as Record<string, unknown>;
    expect(clone.bindings).toBeInstanceOf(Map);
    expect(clone.admitted).toBeInstanceOf(Set);
    expect(clone.activeQueries).toBeInstanceOf(Map);
    expect(clone.sessions).toBeInstanceOf(Map);
  });

  it("uses the configured model, thinking budget and trip prompt", () => {
    const built = options();
    expect(built.model).toBe("m1");
    expect(built.thinking).toEqual({ type: "enabled", budgetTokens: 8192 });
    expect(built.systemPrompt).toEqual("SYSTEM");
    expect(built.includePartialMessages).toBe(true);
  });

  it("keeps Claude state under DATA_DIR and points at the gateway", () => {
    const built = options();
    expect(built.cwd).toBe(join(process.cwd(), "data-test", "claude", "workspace"));
    expect(built.env.CLAUDE_CONFIG_DIR).toBe(join(process.cwd(), "data-test", "claude"));
    expect(built.env.ANTHROPIC_BASE_URL).toBe("http://gw");
  });
});

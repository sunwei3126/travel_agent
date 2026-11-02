import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const baseUrl = process.env.MAGPIE_BASE_URL ?? "http://127.0.0.1:3425";
const model = process.env.MAGPIE_MODEL ?? "deepseek/deepseek-flash";
const apiKey = process.env.MAGPIE_API_KEY ?? "magpie";
const configDir = join(import.meta.dirname, "..", "data", "probe", "claude");
const workspace = join(configDir, "workspace");
mkdirSync(workspace, { recursive: true });

const calls: unknown[] = [];
const echo = tool(
  "probe_echo",
  "Echo the arguments back. Call this exactly once with every field filled in.",
  {
    text: z.string(),
    tags: z.array(z.string()).optional(),
    level: z.enum(["low", "average", "high"]).optional(),
    pair: z.array(z.number()).length(2),
  },
  async (args) => {
    calls.push(args);
    return { content: [{ type: "text", text: `echoed ${JSON.stringify(args)}` }] };
  },
);
const server = createSdkMcpServer({ name: "probe", version: "1.0.0", tools: [echo] });

const seen = { thinkingDelta: 0, inputJsonDelta: 0, textDelta: 0, toolResult: 0 };
let sessionId: string | undefined;
let result: { subtype?: string; is_error?: boolean; result?: string } | undefined;

for await (const message of query({
  prompt:
    "Call probe_echo once with text 'hi', tags ['a','b'], level 'low' and pair [1,2]. Then reply with the single word done.",
  options: {
    model,
    tools: [],
    mcpServers: { probe: server },
    allowedTools: ["mcp__probe__probe_echo"],
    permissionMode: "dontAsk",
    settingSources: [],
    cwd: workspace,
    includePartialMessages: true,
    thinking: { type: "enabled", budgetTokens: 2048 },
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_API_KEY: apiKey,
      ANTHROPIC_MODEL: model,
      ANTHROPIC_DEFAULT_OPUS_MODEL: model,
      ANTHROPIC_DEFAULT_SONNET_MODEL: model,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
      CLAUDE_CONFIG_DIR: configDir,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    },
  },
})) {
  if (message.type === "system" && message.subtype === "init") sessionId = message.session_id;
  if (message.type === "user") seen.toolResult += 1;
  if (message.type === "stream_event") {
    const event = message.event as { type: string; delta?: { type?: string } };
    if (event.type === "content_block_delta") {
      if (event.delta?.type === "thinking_delta") seen.thinkingDelta += 1;
      if (event.delta?.type === "input_json_delta") seen.inputJsonDelta += 1;
      if (event.delta?.type === "text_delta") seen.textDelta += 1;
    }
  }
  if (message.type === "result") result = message as never;
}

console.log(JSON.stringify({ sessionId, seen, calls, subtype: result?.subtype, isError: result?.is_error, text: result?.result }, null, 2));

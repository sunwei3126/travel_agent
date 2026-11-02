import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ClaudeAgentAdapter } from "@ag-ui/claude-agent-sdk";
import { CopilotRuntime, createCopilotRuntimeHandler } from "@copilotkit/runtime/v2";
import { createCopilotNodeHandler } from "@copilotkit/runtime/v2/node";
import { SqliteAgentRunner } from "@copilotkit/sqlite-runner";
import Fastify from "fastify";

const baseUrl = process.env.MAGPIE_BASE_URL ?? "http://127.0.0.1:3425";
const model = process.env.MAGPIE_MODEL ?? "deepseek/deepseek-flash";
const apiKey = process.env.MAGPIE_API_KEY ?? "magpie";
const dataDir = join(import.meta.dirname, "..", "data", "probe-runtime");
const configDir = join(dataDir, "claude");
const workspace = join(configDir, "workspace");
mkdirSync(workspace, { recursive: true });

const adapter = new ClaudeAgentAdapter({
  agentId: "travel",
  model,
  systemPrompt: "You are terse.",
  tools: [],
  permissionMode: "dontAsk",
  settingSources: [],
  cwd: workspace,
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
});

const runner = new SqliteAgentRunner({ dbPath: join(dataDir, "threads.db") });
const runtime = new CopilotRuntime({ agents: { travel: adapter }, runner });
const handle = createCopilotNodeHandler(createCopilotRuntimeHandler({ runtime, basePath: "/api/copilotkit" }));

const app = Fastify();
app.addHook("onRequest", async (request) => {
  console.log(new Date().toISOString(), request.method, request.url);
});
await app.register(async (scope) => {
  scope.removeAllContentTypeParsers();
  scope.addContentTypeParser("*", (_request, _payload, done) => done(null));
  const route = async (request: { raw: never }, reply: { hijack: () => void; raw: never }) => {
    reply.hijack();
    await handle(request.raw, reply.raw);
  };
  scope.all("/api/copilotkit", route as never);
  scope.all("/api/copilotkit/*", route as never);
});
await app.listen({ host: "127.0.0.1", port: 4300 });
console.log("probe runtime on http://127.0.0.1:4300");

import { execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const baseUrl = process.env.MAGPIE_BASE_URL ?? "http://127.0.0.1:3425";
const model = process.env.MAGPIE_MODEL ?? "deepseek/deepseek-flash";
const apiKey = process.env.MAGPIE_API_KEY ?? "magpie";
const dataDir = join(import.meta.dirname, "..", "data", "probe-resume");
const configDir = join(dataDir, "claude");
const workspace = join(configDir, "workspace");
const marker = join(dataDir, "tool-started");

function buildQuery(prompt: string, resume: string | undefined, slow: boolean) {
  const tools = [
    tool("probe_slow", "A slow tool. Call it exactly once.", { note: z.string() }, async () => {
      writeFileSync(marker, "started");
      await new Promise((resolve) => setTimeout(resolve, 120_000));
      return { content: [{ type: "text" as const, text: "slow done" }] };
    }),
    tool("probe_fast", "A fast tool. Call it exactly once.", { note: z.string() }, async () => {
      writeFileSync(join(dataDir, "fast-called"), "yes");
      return { content: [{ type: "text" as const, text: "fast done" }] };
    }),
  ];
  return query({
    prompt,
    options: {
      model,
      tools: [],
      mcpServers: { probe: createSdkMcpServer({ name: "probe", version: "1.0.0", tools }) },
      allowedTools: ["mcp__probe__probe_slow", "mcp__probe__probe_fast"],
      permissionMode: "dontAsk",
      settingSources: [],
      cwd: workspace,
      ...(resume === undefined ? {} : { resume }),
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
  });
}

function killTree(pid: number): void {
  if (process.platform === "win32") execSync(`taskkill /pid ${pid} /T /F`, { stdio: "ignore" });
  else process.kill(pid, "SIGKILL");
}

async function phase1(): Promise<void> {
  for await (const message of buildQuery("Call probe_slow once with note 'x'. Then say done.", undefined, true)) {
    if (message.type === "system" && message.subtype === "init") console.log(`SESSION ${message.session_id}`);
  }
}

async function phase2(sessionId: string): Promise<void> {
  let subtype: string | undefined;
  let text: string | undefined;
  for await (const message of buildQuery("The previous tool call was interrupted by a restart. Call probe_fast once with note 'y', then say done.", sessionId, false)) {
    if (message.type === "result") {
      subtype = message.subtype;
      text = (message as { result?: string }).result;
    }
  }
  console.log(JSON.stringify({ phase2Subtype: subtype, text, fastCalled: existsSync(join(dataDir, "fast-called")) }, null, 2));
}

if (process.argv[2] === "phase1") {
  await phase1();
} else {
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(workspace, { recursive: true });
  const child = spawn(process.execPath, [...process.execArgv, import.meta.filename, "phase1"], { stdio: ["ignore", "pipe", "inherit"] });
  let sessionId: string | undefined;
  child.stdout.on("data", (chunk: Buffer) => {
    const match = /SESSION (\S+)/.exec(chunk.toString());
    if (match) sessionId = match[1];
  });
  const deadline = Date.now() + 180_000;
  while (!existsSync(marker) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 500));
  if (!existsSync(marker) || sessionId === undefined) throw new Error("the slow tool never started");
  killTree(child.pid!);
  console.log(`killed the process tree mid-tool; session ${sessionId}`);
  await phase2(sessionId);
}

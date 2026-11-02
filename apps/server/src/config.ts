import { join, resolve } from "node:path";

export type ThinkingLevel = "off" | "low" | "medium" | "high";

export type ThinkingOption =
  | { type: "disabled" }
  | { type: "enabled"; budgetTokens: number };

export type ServerConfig = {
  port: number;
  dataDir: string;
  deepseekApiKey: string;
  deepseekBaseUrl: string | undefined;
  model: {
    baseUrl: string;
    apiKey: string;
    modelId: string;
    maxOutputTokens: number;
    thinkingLevel: ThinkingLevel;
  };
};

const DEFAULT_MAX_OUTPUT_TOKENS = 393216;
const THINKING_BUDGETS = { low: 2048, medium: 8192, high: 24576 } as const;

function parseThinkingLevel(value: string | undefined): ThinkingLevel {
  const level = value ?? "low";
  if (level === "off" || level === "low" || level === "medium" || level === "high") return level;
  throw new Error(`PI_THINKING_LEVEL must be off, low, medium, or high (got "${level}")`);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const deepseekApiKey = env.DEEPSEEK_API_KEY;
  if (deepseekApiKey === undefined || deepseekApiKey.length === 0) {
    throw new Error("DEEPSEEK_API_KEY is required");
  }
  const maxTokens = Number(env.MAGPIE_MAX_TOKENS ?? DEFAULT_MAX_OUTPUT_TOKENS);
  return {
    port: Number(env.PORT ?? 4000),
    dataDir: env.DATA_DIR ?? "./data",
    deepseekApiKey,
    deepseekBaseUrl: env.DEEPSEEK_BASE_URL,
    model: {
      baseUrl: env.MAGPIE_BASE_URL ?? "http://127.0.0.1:3425",
      apiKey: env.MAGPIE_API_KEY ?? "magpie",
      modelId: env.MAGPIE_MODEL ?? "deepseek/deepseek-flash",
      maxOutputTokens:
        Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : DEFAULT_MAX_OUTPUT_TOKENS,
      thinkingLevel: parseThinkingLevel(env.PI_THINKING_LEVEL),
    },
  };
}

export function thinkingOption(level: ThinkingLevel): ThinkingOption {
  if (level === "off") return { type: "disabled" };
  return { type: "enabled", budgetTokens: THINKING_BUDGETS[level] };
}

export type DataPaths = {
  root: string;
  claudeConfigDir: string;
  workspace: string;
  sketchWorkspace: string;
  travelDb: string;
  threadsDb: string;
};

export function dataPaths(config: ServerConfig): DataPaths {
  const root = resolve(config.dataDir);
  const claudeConfigDir = join(root, "claude");
  return {
    root,
    claudeConfigDir,
    workspace: join(claudeConfigDir, "workspace"),
    sketchWorkspace: join(claudeConfigDir, "sketch-workspace"),
    travelDb: join(root, "travel.sqlite"),
    threadsDb: join(root, "threads.db"),
  };
}

/** Environment for the Claude Code subprocess: gateway, model aliases, state under DATA_DIR. */
export function claudeEnv(
  config: ServerConfig,
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string | undefined> {
  const { model } = config;
  return {
    ...base,
    ANTHROPIC_AUTH_TOKEN: undefined,
    ANTHROPIC_BASE_URL: model.baseUrl,
    ANTHROPIC_API_KEY: model.apiKey,
    ANTHROPIC_MODEL: model.modelId,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model.modelId,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model.modelId,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model.modelId,
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(model.maxOutputTokens),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CONFIG_DIR: dataPaths(config).claudeConfigDir,
  };
}

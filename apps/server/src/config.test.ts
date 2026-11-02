import { isAbsolute, join } from "node:path";
import { describe, expect, it } from "vitest";
import { claudeEnv, dataPaths, loadConfig, thinkingOption } from "./config";

const base = { DEEPSEEK_API_KEY: "key" };

describe("loadConfig", () => {
  it("applies the documented defaults", () => {
    const config = loadConfig(base);
    expect(config.port).toBe(4000);
    expect(config.dataDir).toBe("./data");
    expect(config.deepseekApiKey).toBe("key");
    expect(config.model).toEqual({
      baseUrl: "http://127.0.0.1:3425",
      apiKey: "magpie",
      modelId: "deepseek/deepseek-flash",
      maxOutputTokens: 393216,
      thinkingLevel: "low",
    });
  });

  it("requires DEEPSEEK_API_KEY", () => {
    expect(() => loadConfig({})).toThrow("DEEPSEEK_API_KEY is required");
    expect(() => loadConfig({ DEEPSEEK_API_KEY: "" })).toThrow("DEEPSEEK_API_KEY is required");
  });

  it("reads overrides", () => {
    const config = loadConfig({
      ...base,
      PORT: "4100",
      DATA_DIR: "/tmp/x",
      DEEPSEEK_BASE_URL: "https://ds.example",
      MAGPIE_BASE_URL: "https://remote.example/anthropic",
      MAGPIE_MODEL: "m",
      MAGPIE_API_KEY: "secret",
      MAGPIE_MAX_TOKENS: "8000",
      PI_THINKING_LEVEL: "high",
    });
    expect(config.port).toBe(4100);
    expect(config.dataDir).toBe("/tmp/x");
    expect(config.deepseekBaseUrl).toBe("https://ds.example");
    expect(config.model).toMatchObject({
      baseUrl: "https://remote.example/anthropic",
      modelId: "m",
      apiKey: "secret",
      maxOutputTokens: 8000,
      thinkingLevel: "high",
    });
  });

  it("falls back to the default when MAGPIE_MAX_TOKENS is not a positive number", () => {
    expect(loadConfig({ ...base, MAGPIE_MAX_TOKENS: "abc" }).model.maxOutputTokens).toBe(393216);
    expect(loadConfig({ ...base, MAGPIE_MAX_TOKENS: "0" }).model.maxOutputTokens).toBe(393216);
  });

  it("rejects an unknown thinking level", () => {
    expect(() => loadConfig({ ...base, PI_THINKING_LEVEL: "max" })).toThrow(
      'PI_THINKING_LEVEL must be off, low, medium, or high (got "max")',
    );
  });
});

describe("thinkingOption", () => {
  it("maps levels to the SDK thinking option", () => {
    expect(thinkingOption("off")).toEqual({ type: "disabled" });
    expect(thinkingOption("low")).toEqual({ type: "enabled", budgetTokens: 2048 });
    expect(thinkingOption("medium")).toEqual({ type: "enabled", budgetTokens: 8192 });
    expect(thinkingOption("high")).toEqual({ type: "enabled", budgetTokens: 24576 });
  });
});

describe("dataPaths", () => {
  it("resolves every path under DATA_DIR as an absolute path", () => {
    const paths = dataPaths(loadConfig({ ...base, DATA_DIR: "./data-x" }));
    for (const value of Object.values(paths)) expect(isAbsolute(value)).toBe(true);
    expect(paths.travelDb).toBe(join(paths.root, "travel.sqlite"));
    expect(paths.threadsDb).toBe(join(paths.root, "threads.db"));
    expect(paths.claudeConfigDir).toBe(join(paths.root, "claude"));
    expect(paths.workspace).toBe(join(paths.claudeConfigDir, "workspace"));
    expect(paths.sketchWorkspace).toBe(join(paths.claudeConfigDir, "sketch-workspace"));
  });
});

describe("claudeEnv", () => {
  it("maps MAGPIE_* settings onto the variables Claude Code reads", () => {
    const config = loadConfig({
      ...base,
      MAGPIE_BASE_URL: "http://gw",
      MAGPIE_API_KEY: "k",
      MAGPIE_MODEL: "m1",
      MAGPIE_MAX_TOKENS: "9000",
    });
    const env = claudeEnv(config, { PATH: "/bin", ANTHROPIC_AUTH_TOKEN: "stale" });
    expect(env).toMatchObject({
      PATH: "/bin",
      ANTHROPIC_BASE_URL: "http://gw",
      ANTHROPIC_API_KEY: "k",
      ANTHROPIC_MODEL: "m1",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "m1",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "m1",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "m1",
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: "9000",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CONFIG_DIR: dataPaths(config).claudeConfigDir,
    });
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });
});

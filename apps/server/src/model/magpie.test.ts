import { contentText } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createMagpieModels, resolveMagpieModel } from "./magpie";

it("registers the magpie Anthropic-compatible provider", () => {
  const models = createMagpieModels({});
  const model = resolveMagpieModel(models, {});
  expect(model.provider).toBe("magpie");
  expect(model.api).toBe("anthropic-messages");
  expect(model.baseUrl).toBe("http://127.0.0.1:3425");
  expect(model.id).toBe("deepseek/deepseek-flash");
});

it("resolves a non-empty credential for the magpie model", async () => {
  const models = createMagpieModels({});
  const model = resolveMagpieModel(models, {});
  expect(model.headers?.["x-api-key"]).toBe("magpie");

  const auth = await models.getAuth(model);
  expect(auth?.auth.headers?.["x-api-key"]).toBe("magpie");
});

it("supports a remote Anthropic-compatible endpoint with its own key", () => {
  const env = {
    MAGPIE_BASE_URL: "https://api.deepseek.com/anthropic",
    MAGPIE_MODEL: "deepseek-chat",
    MAGPIE_API_KEY: "test-key",
    MAGPIE_MAX_TOKENS: "8192",
  };
  const models = createMagpieModels(env);
  const model = resolveMagpieModel(models, env);
  expect(model.baseUrl).toBe("https://api.deepseek.com/anthropic");
  expect(model.id).toBe("deepseek-chat");
  expect(model.headers?.["x-api-key"]).toBe("test-key");
  expect(model.maxTokens).toBe(8192);
});

describe.skipIf(process.env.MAGPIE_LIVE !== "1")("magpie live", () => {
  it(
    "completes a simple prompt",
    async () => {
      const models = createMagpieModels();
      const model = resolveMagpieModel(models);
      const response = await models.completeSimple(model, {
        messages: [{ role: "user", content: "回复 OK", timestamp: Date.now() }],
      });
      expect(contentText(response.content).trim().length).toBeGreaterThan(0);
    },
    60_000,
  );
});

import { contentText } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createMagpieModels, resolveMagpieModel } from "./magpie";

it("registers the magpie Anthropic-compatible provider", () => {
  const models = createMagpieModels({});
  const model = resolveMagpieModel(models, {});
  expect(model.provider).toBe("magpie");
  expect(model.api).toBe("anthropic-messages");
  expect(model.baseUrl).toBe("http://127.0.0.1:3425");
  expect(model.id).toBe("openrouter/deepseek/deepseek-v4.1-flash-1017");
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

import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { probeThinkingSupport } from "./thinking-probe";

function testEnv(responses: ReturnType<typeof fauxAssistantMessage>[]) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(responses);
  return { models, model: faux.getModel()! };
}

describe("probeThinkingSupport", () => {
  it("reports support when the model returns a thinking block", async () => {
    const env = testEnv([
      fauxAssistantMessage([fauxThinking("先想一下"), fauxText("好")]),
    ]);
    await expect(
      probeThinkingSupport(env.models, env.model, "low"),
    ).resolves.toMatchObject({ supported: true, hasThinking: true });
  });

  it("reports no thinking for a text-only response", async () => {
    const env = testEnv([fauxAssistantMessage([fauxText("好")])]);
    await expect(
      probeThinkingSupport(env.models, env.model, "low"),
    ).resolves.toMatchObject({ supported: true, hasThinking: false });
  });
});

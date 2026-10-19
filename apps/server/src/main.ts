import type { DayCard } from "@pi-demo/shared";
import { contentText, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { clampThinkingLevel } from "@earendil-works/pi-ai/models";
import { createRegistry } from "@earendil-works/pi-durable";
import { createTravelExtension } from "./agent/extension";
import { DeepSeekClient } from "./deepseek/client";
import { TravelService } from "./harness/service";
import { buildServer } from "./http/app";
import { createMagpieModels, resolveMagpieModel } from "./model/magpie";
import { generateDaySketch } from "./svg/generate";

const apiKey = process.env.DEEPSEEK_API_KEY;
if (apiKey === undefined || apiKey.length === 0) {
  throw new Error("DEEPSEEK_API_KEY is required");
}

const models = createMagpieModels(process.env);
const model = resolveMagpieModel(models, process.env);
const deepseek = new DeepSeekClient({
  apiKey,
  baseUrl: process.env.DEEPSEEK_BASE_URL,
});

const generate = async (prompt: string): Promise<string> => {
  const message = await models.completeSimple(model, {
    messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
  });
  return contentText(message.content);
};

const generateSketch = (day: DayCard) => generateDaySketch({ day, generate });

const registry = createRegistry();
registry.install(
  createTravelExtension({
    now: () => new Date(),
    deepseek,
    generateSketch,
    caps: { search: 40, fetch: 30 },
  }),
);

const requestedThinkingLevel =
  (process.env.PI_THINKING_LEVEL ?? "low") as ModelThinkingLevel;
const thinkingLevel = clampThinkingLevel(model, requestedThinkingLevel);

const service = await TravelService.open({
  dataDir: process.env.DATA_DIR ?? "./data",
  models,
  registry,
  defaultModel: model,
  thinkingLevel,
});

const app = buildServer({ service });
await app.listen({
  host: "127.0.0.1",
  port: Number(process.env.PORT ?? 4000),
});

let shuttingDown = false;
const shutdown = async (): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  await app.close();
  await service.close();
};

process.once("SIGINT", () => {
  void shutdown();
});
process.once("SIGTERM", () => {
  void shutdown();
});

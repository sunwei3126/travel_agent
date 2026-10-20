import {
  createModels,
  createProvider,
  type Api,
  type Model,
  type Models,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";

const DEFAULT_BASE_URL = "http://127.0.0.1:3425";
const DEFAULT_MODEL_ID = "deepseek/deepseek-flash";

function magpieModel(
  baseUrl: string,
  modelId: string,
  apiKey: string,
  maxTokens: number,
): Model<"anthropic-messages"> {
  return {
    id: modelId,
    name: modelId,
    api: "anthropic-messages",
    provider: "magpie",
    baseUrl,
    reasoning: true,
    // Magpie accepts any local key; a remote Anthropic-compatible endpoint
    // (for example DeepSeek's /anthropic API) needs the real key here.
    headers: { "x-api-key": apiKey },
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000000,
    maxTokens,
  };
}

/** Builds a Models collection containing the local magpie gateway provider. */
export function createMagpieModels(env: NodeJS.ProcessEnv = process.env): Models {
  const baseUrl = env.MAGPIE_BASE_URL ?? DEFAULT_BASE_URL;
  const modelId = env.MAGPIE_MODEL ?? DEFAULT_MODEL_ID;
  const apiKey = env.MAGPIE_API_KEY ?? "magpie";
  const configuredMaxTokens = Number(env.MAGPIE_MAX_TOKENS ?? 393216);
  const maxTokens =
    Number.isFinite(configuredMaxTokens) && configuredMaxTokens > 0
      ? configuredMaxTokens
      : 393216;

  const provider = createProvider({
    id: "magpie",
    name: "Magpie",
    baseUrl,
    // Magpie accepts any local key; an empty auth is enough to mark the provider configured.
    auth: { apiKey: { name: "Magpie", resolve: async () => ({ auth: {} }) } },
    models: [magpieModel(baseUrl, modelId, apiKey, maxTokens)],
    api: anthropicMessagesApi(),
  });

  const models = createModels();
  models.setProvider(provider);
  return models;
}

/** Returns the configured magpie model, or throws when it is not registered. */
export function resolveMagpieModel(
  models: Models,
  env: NodeJS.ProcessEnv = process.env,
): Model<Api> {
  const modelId = env.MAGPIE_MODEL ?? DEFAULT_MODEL_ID;
  const model = models.getModel("magpie", modelId);
  if (!model) {
    throw new Error(
      `Magpie model "${modelId}" is not registered on provider "magpie". Check MAGPIE_MODEL.`,
    );
  }
  return model;
}

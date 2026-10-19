import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { createMagpieModels, resolveMagpieModel } from "../apps/server/src/model/magpie";
import { probeThinkingSupport } from "../apps/server/src/model/thinking-probe";

const level = (process.env.PI_THINKING_LEVEL ?? "low") as ModelThinkingLevel;
const models = createMagpieModels(process.env);
const model = resolveMagpieModel(models, process.env);
const result = await probeThinkingSupport(models, model, level);

console.log(JSON.stringify({ model: model.id, level, ...result }, null, 2));
process.exitCode = result.hasThinking ? 0 : 2;

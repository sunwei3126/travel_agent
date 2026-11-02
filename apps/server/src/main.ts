import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import type { DayCard } from "@pi-demo/shared";
import { createClaudeAdapterFactory } from "./agent/claude-adapter";
import type { TravelDeps } from "./agent/deps";
import { buildSystemPrompt } from "./agent/system-prompt";
import { TravelAgent } from "./agent/travel-agent";
import { dataPaths, loadConfig } from "./config";
import { DeepSeekClient } from "./deepseek/client";
import { buildServer } from "./http/app";
import { clearStaleRunState, recoverInterruptedRuns } from "./recovery";
import { createTravelRuntime } from "./runtime";
import { TripStore } from "./store/trip-store";
import { generateDaySketch } from "./svg/generate";
import { createSketchGenerator } from "./svg/sketch-model";
import { TripService } from "./trips/service";

const config = loadConfig();
const paths = dataPaths(config);
for (const dir of [paths.root, paths.workspace, paths.sketchWorkspace]) {
  mkdirSync(dir, { recursive: true });
}

const store = TripStore.open(paths.travelDb);

// Must happen before the runner opens its database: an unclean shutdown leaves
// `is_running` set, and the runner refuses to run a flagged thread.
const cleared = clearStaleRunState(paths.threadsDb);
if (cleared > 0) console.warn(`Cleared ${cleared} stale run flag(s) left by an unclean shutdown`);

const deepseek = new DeepSeekClient({
  apiKey: config.deepseekApiKey,
  baseUrl: config.deepseekBaseUrl,
});
const generate = createSketchGenerator(config);
const deps: TravelDeps = {
  now: () => new Date(),
  deepseek,
  generateSketch: (day: DayCard) => generateDaySketch({ day, generate }),
  caps: { search: 40, fetch: 30 },
};

const agent = new TravelAgent({
  store,
  now: deps.now,
  createAdapter: createClaudeAdapterFactory({ config, store, deps }),
  buildSystemPrompt: (tripId) => buildSystemPrompt(store, tripId, deps.now()),
});
const { runner, handler } = createTravelRuntime({ agent, threadsDbPath: paths.threadsDb });

const app = buildServer({ service: new TripService(store, deps.now), copilotHandler: handler });
await app.listen({ host: "127.0.0.1", port: config.port });

// Resume in the background so the server is reachable while runs are re-sent.
void recoverInterruptedRuns({
  store,
  runner,
  agent,
  now: deps.now,
  newId: randomUUID,
  log: (message) => console.warn(message),
});

let shuttingDown = false;
const shutdown = async (): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  await app.close();
  store.close();
};

process.once("SIGINT", () => {
  void shutdown();
});
process.once("SIGTERM", () => {
  void shutdown();
});

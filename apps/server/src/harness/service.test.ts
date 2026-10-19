import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, type Registry } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { createTravelExtension } from "../agent/extension";
import type { TravelDeps } from "../agent/deps";
import { tripContextSection } from "../agent/section";
import { TripBriefDoc, TripPlanDoc, TripSourcesDoc } from "../trips/docs";
import type { DeepSeekClient } from "../deepseek/client";
import { TravelService } from "./service";

function testEnv() {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  return { faux, models, model: faux.getModel()!, registry: createRegistry() };
}

function fakeDeps(): TravelDeps {
  return {
    now: () => new Date("2026-10-19T00:00:00Z"),
    deepseek: {
      search: async () => [],
      fetch: async () => ({ title: "", url: "", content: "" }),
    } as unknown as DeepSeekClient,
    generateSketch: async () => ({ svg: "<svg />", status: "ok" }),
    caps: { search: 40, fetch: 30 },
  };
}

function extensionRegistry(deps: TravelDeps): Registry {
  const registry = createRegistry();
  registry.install(createTravelExtension(deps));
  return registry;
}

it("reopens the same SQLite and keeps the trip", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-demo-"));
  const env = testEnv();
  const service = await TravelService.open({
    dataDir: dir,
    models: env.models,
    registry: env.registry,
    defaultModel: env.model,
  });
  const trip = await service.createTrip({
    title: "泰山",
    destination: "泰山",
    startDate: "2026-10-26",
    days: 3,
  });
  await service.close();
  const reopened = await TravelService.open({
    dataDir: dir,
    models: env.models,
    registry: env.registry,
    defaultModel: env.model,
  });
  expect((await reopened.getSnapshot(trip.tripId)).trip.title).toBe("泰山");
  await reopened.close();
});

it("returns the existing submission for a duplicate request id", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-demo-"));
  const env = testEnv();
  env.faux.setResponses([fauxAssistantMessage([fauxText("收到")])]);
  const service = await TravelService.open({
    dataDir: dir,
    models: env.models,
    registry: env.registry,
    defaultModel: env.model,
  });
  const trip = await service.createTrip({
    title: "泰山",
    destination: "泰山",
    startDate: "2026-10-26",
    days: 3,
  });
  const a = await service.submitMessage(trip.tripId, "泰山三天", "r1");
  const b = await service.submitMessage(trip.tripId, "泰山三天", "r1");
  expect(b.submissionId).toBe(a.submissionId);
  await service.close();
});

it("snapshots a new trip with its brief, empty plan, zero counts, and idle state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-demo-"));
  const env = testEnv();
  const service = await TravelService.open({
    dataDir: dir,
    models: env.models,
    registry: env.registry,
    defaultModel: env.model,
  });
  const trip = await service.createTrip({
    title: "泰山",
    destination: "泰山",
    startDate: "2026-10-26",
    days: 3,
  });
  const snapshot = await service.getSnapshot(trip.tripId);
  expect(snapshot.brief.destination).toBe("泰山");
  expect(snapshot.brief.startDate).toBe("2026-10-26");
  expect(snapshot.brief.days).toBe(3);
  expect(snapshot.plan.days).toEqual([]);
  expect(Object.keys(snapshot.sources)).toHaveLength(0);
  expect(snapshot.research).toEqual({ searchCount: 0, fetchCount: 0 });
  expect(snapshot.running).toBe(false);
  await service.close();
});

it("lists trips from the index", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-demo-"));
  const env = testEnv();
  const service = await TravelService.open({
    dataDir: dir,
    models: env.models,
    registry: env.registry,
    defaultModel: env.model,
  });
  const trip = await service.createTrip({
    title: "泰山",
    destination: "泰山",
    startDate: "2026-10-26",
    days: 3,
  });
  await expect(service.listTrips()).resolves.toEqual([trip]);
  await service.close();
});

it("returns the transcript as an array", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-demo-"));
  const env = testEnv();
  const service = await TravelService.open({
    dataDir: dir,
    models: env.models,
    registry: env.registry,
    defaultModel: env.model,
  });
  const trip = await service.createTrip({
    title: "泰山",
    destination: "泰山",
    startDate: "2026-10-26",
    days: 3,
  });
  const transcript = await service.getTranscript(trip.tripId);
  expect(Array.isArray(transcript)).toBe(true);
  expect(transcript).toHaveLength(0);
  await service.close();
});

it("registers all six travel tools with the production caps", () => {
  const deps = fakeDeps();
  const registry = extensionRegistry(deps);
  expect(registry.snapshot().tools().map(({ tool }) => tool.name)).toEqual([
    "trip_update_brief",
    "plan_emit_day",
    "plan_finalize",
    "deepseek_search",
    "deepseek_fetch",
    "sketch_day",
  ]);
  expect(deps.caps).toEqual({ search: 40, fetch: 30 });
});

describe("tripContextSection", () => {
  const card = {
    dayIndex: 1,
    date: "2026-10-26",
    title: "登山",
    blocks: [],
    scenery: [],
    food: [],
    transport: [],
    estimatedCostCny: [0, 0] as [number, number],
    sources: [],
    svgStatus: "pending" as const,
    updatedAt: "",
  };

  function render(docs: {
    brief?: unknown;
    plan?: unknown;
    sources?: unknown;
  }): Promise<string | undefined> {
    return Promise.resolve(
      tripContextSection.render(
        {
          conversationId: "c1",
          agent: {} as never,
          env: undefined,
          shown: {},
          read: {
            snapshot: async (token: unknown) => {
              if (token === TripBriefDoc) return docs.brief;
              if (token === TripPlanDoc) return docs.plan;
              if (token === TripSourcesDoc) return docs.sources;
              return undefined;
            },
          },
        } as never,
        BACKGROUND_CONTEXT,
      ),
    );
  }

  it("tolerates absent documents", async () => {
    await expect(render({})).resolves.toBeUndefined();
  });

  it("renders a compact brief, plan, and source-count summary", async () => {
    const text = await render({
      brief: { destination: "泰山", startDate: "2026-10-26", days: 3 },
      plan: { days: [card] },
      sources: {
        s1: { id: "s1", query: "泰山", title: "泰山", url: "https://example.com", snippet: "", kind: "search" },
      },
    });
    expect(text).toContain("destination=泰山");
    expect(text).toContain("D1 2026-10-26 登山");
    expect(text).toContain("Sources: 1");
  });
});

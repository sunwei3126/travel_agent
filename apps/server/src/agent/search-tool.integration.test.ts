import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { createRegistry } from "@earendil-works/pi-durable";
import type { TripSnapshot } from "@pi-demo/shared";
import { describe, expect, it, vi } from "vitest";
import type { DeepSeekClient, SearchHit } from "../deepseek/client";
import { TravelService } from "../harness/service";
import type { TravelDeps } from "./deps";
import { createTravelExtension } from "./extension";

const hits: SearchHit[] = [
  {
    title: "泰山景区官网",
    url: "https://example.com/gov",
    snippet: "门票信息",
    authority: 4,
  },
  {
    title: "徒步攻略",
    url: "https://example.com/blog",
    snippet: "路线信息",
    authority: 1,
  },
];

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function waitForSnapshot(
  service: TravelService,
  tripId: string,
): Promise<TripSnapshot> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const snapshot = await service.getSnapshot(tripId);
    if (
      snapshot.research.searchCount === 1 &&
      snapshot.research.fetchCount === 2 &&
      !snapshot.running
    ) {
      return snapshot;
    }
    await sleep(50);
  }
  throw new Error("search tool run did not finish");
}

/**
 * Exercises deepseek_search through the real pi-durable harness: the model
 * calls the tool, the tool performs real commits (including auto-fetch), and
 * its model-visible output is read back from the transcript. This catches
 * settled-overlay misuse that a plain-object fake cannot.
 */
describe("deepseek_search via the real harness", () => {
  it("searches, auto-fetches, stores content, and returns the sources", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-demo-search-tool-"));
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const model = faux.getModel()!;

    const search = vi.fn(async () => hits);
    // The live endpoint returns only {content}; keep that shape.
    const fetch = vi.fn(async (url: string) => ({ content: `正文来自 ${url}` }));
    const deps: TravelDeps = {
      now: () => new Date("2026-10-19T00:00:00Z"),
      deepseek: { search, fetch } as unknown as DeepSeekClient,
      generateSketch: async () => ({ svg: "<svg />", status: "ok" }),
      caps: { search: 40, fetch: 30 },
    };
    const registry = createRegistry();
    registry.install(createTravelExtension(deps));

    const service = await TravelService.open({
      dataDir: dir,
      models,
      registry,
      defaultModel: model,
    });
    const trip = await service.createTrip({
      title: "泰山",
      destination: "泰山",
      startDate: "2026-10-26",
      days: 3,
    });

    faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall("deepseek_search", { query: "泰山 门票" }, { id: "call-1" })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage([fauxText("研究完成")]),
    ]);

    try {
      await service.submitMessage(trip.tripId, "泰山 门票", "r1");
      const snapshot = await waitForSnapshot(service, trip.tripId);

      expect(search).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(snapshot.research.searchCount).toBe(1);
      expect(snapshot.research.fetchCount).toBe(2);
      expect(snapshot.faults).toEqual([]);

      const sources = Object.values(snapshot.sources);
      expect(sources).toHaveLength(2);
      for (const source of sources) {
        expect(source.fetchedAt).toBeTruthy();
        expect(source.content).toContain(source.url);
      }

      const transcript = await service.getTranscript(trip.tripId);
      const toolOutput = transcript
        .filter((entry) => entry.role === "tool")
        .map((entry) => entry.content)
        .join("\n");
      expect(toolOutput).not.toContain("Cannot use a settled overlay");
      expect(toolOutput).toContain("[");
      expect(toolOutput).toContain("https://example.com/gov");
      expect(toolOutput).toContain("https://example.com/blog");
      expect(toolOutput).toContain("fetchedContent");
      expect(toolOutput).toContain("正文来自 https://example.com/gov");
      expect(toolOutput).toContain("正文来自 https://example.com/blog");
    } finally {
      await service.close();
    }
  }, 30_000);
});

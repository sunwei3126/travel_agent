import type { TripResearch, TripSources } from "@pi-demo/shared";
import { describe, expect, it, vi } from "vitest";
import type { DeepSeekClient, SearchHit } from "../deepseek/client";
import { addSearchToSources, sourceIdForUrl } from "../research/sources";
import {
  TripResearchDoc,
  TripSearchCacheDoc,
  TripSourcesDoc,
  type SearchCache,
} from "../trips/docs";
import { enforceCap } from "./tools/caps";
import { createFetchTool } from "./tools/fetch";
import { createSearchTool, searchCacheKey } from "./tools/search";

it("enforces the per-trip search and fetch caps", () => {
  expect(() => enforceCap(40, 40, "search")).toThrow("search cap reached");
  expect(() => enforceCap(39, 40, "search")).not.toThrow();
  expect(() => enforceCap(30, 30, "fetch")).toThrow("fetch cap reached");
});

type Docs = {
  research: TripResearch;
  sources: TripSources;
  cache: SearchCache;
};

function fakeApi(docs: Docs) {
  const docFor = (token: unknown): unknown => {
    if (token === TripResearchDoc) return docs.research;
    if (token === TripSourcesDoc) return docs.sources;
    if (token === TripSearchCacheDoc) return docs.cache;
    return undefined;
  };
  return {
    conversationId: 1,
    snapshot: async (token: unknown) => docFor(token),
    commit: async <T>(
      change: (tx: { doc: (token: unknown) => Promise<unknown> }) => T | Promise<T>,
    ): Promise<T> =>
      change({
        doc: async (token: unknown) => docFor(token),
      }),
  };
}

function docs(): Docs {
  return {
    research: { searchCount: 0, fetchCount: 0 },
    sources: {},
    cache: {},
  };
}

const hit: SearchHit = {
  title: "泰山景区官网",
  url: "https://example.com/taishan/tickets",
  snippet: "旺季门票 115 元，索道另行收费。",
  date: "2026-09-01",
  authority: 4,
  rerankScore: 2,
};

const fetchResult = (url: string) => ({
  title: `页面 ${url}`,
  url,
  content: `来自 ${url} 的已抓取正文`,
});

const hits3: SearchHit[] = [
  { ...hit, title: "博客", url: "https://example.com/blog", authority: 1 },
  { ...hit, title: "官网", url: "https://example.com/gov", authority: 4 },
  { ...hit, title: "OTA", url: "https://example.com/ota", authority: 3 },
];

function searchTool(deepseek: DeepSeekClient) {
  return createSearchTool({
    now: () => new Date("2026-10-19T00:00:00Z"),
    deepseek,
    generateSketch: async () => ({ svg: "", status: "ok" }),
    caps: { search: 40, fetch: 30 },
  });
}

describe("deepseek_search", () => {
  it("returns the source id, URL, snippet, authority, and freshness to the model", async () => {
    const deepseek = {
      search: vi.fn(async () => [hit]),
      fetch: vi.fn(async (url: string) => fetchResult(url)),
    } as unknown as DeepSeekClient;
    const store = docs();
    const tool = searchTool(deepseek);

    const result = await tool.execute(
      { query: "泰山 门票" },
      fakeApi(store) as never,
      {} as never,
    );
    const text = (result.output as Array<{ text: string }>)[0].text;
    const sourceId = (result.structuredOutput as { sourceIds: string[] }).sourceIds[0];

    expect(result.structuredOutput).toEqual({ sourceIds: [expect.any(String)] });
    expect(text).toContain(`[${sourceId}]`);
    expect(text).toContain(hit.url);
    expect(text).toContain(hit.snippet);
    expect(text).toContain("authority: 4");
    expect(text).toContain("(fresh)");
    // A search verifies its top result automatically.
    expect(text).toContain("fetched: yes");
    expect(text).toContain(`来自 ${hit.url} 的已抓取正文`);
  });

  it("reuses the normalized query cache without another API call or count", async () => {
    const search = vi.fn(async () => [hit]);
    const fetch = vi.fn(async (url: string) => fetchResult(url));
    const tool = searchTool({ search, fetch } as unknown as DeepSeekClient);
    const store = docs();
    const api = fakeApi(store);

    const first = await tool.execute({ query: " 泰山   门票 " }, api as never, {} as never);
    const second = await tool.execute({ query: "泰山 门票" }, api as never, {} as never);

    expect(search).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(second.structuredOutput).toEqual(first.structuredOutput);
    expect(store.research.searchCount).toBe(1);
    expect(store.research.fetchCount).toBe(1);
    expect(store.research.searchAttempts).toEqual({
      [searchCacheKey("泰山 门票", {})]: 1,
    });
  });

  it("does not treat a different option set as a cache hit", async () => {
    const search = vi.fn(async () => [hit]);
    const fetch = vi.fn(async (url: string) => fetchResult(url));
    const tool = searchTool({ search, fetch } as unknown as DeepSeekClient);
    const store = docs();
    const api = fakeApi(store);

    await tool.execute({ query: "泰山 门票" }, api as never, {} as never);
    await tool.execute(
      { query: "泰山 门票", needContent: true },
      api as never,
      {} as never,
    );

    expect(search).toHaveBeenCalledTimes(2);
    expect(store.research.searchCount).toBe(2);
  });

  it("tells the model not to plan from memory when nothing is found", async () => {
    const tool = searchTool({
      search: async () => [],
      fetch: vi.fn(),
    } as unknown as DeepSeekClient);
    const result = await tool.execute(
      { query: "空白查询" },
      fakeApi(docs()) as never,
      {} as never,
    );
    expect((result.output as Array<{ text: string }>)[0].text).toContain(
      "Found 0 sources",
    );
  });

  it("auto-fetches the top two authority results and exposes verified content", async () => {
    const search = vi.fn(async () => hits3);
    const fetch = vi.fn(async (url: string) => fetchResult(url));
    const store = docs();
    const result = await searchTool({ search, fetch } as unknown as DeepSeekClient).execute(
      { query: "泰山 门票" },
      fakeApi(store) as never,
      {} as never,
    );

    expect(fetch.mock.calls.map((call) => call[0])).toEqual([
      hits3[1].url,
      hits3[2].url,
    ]);
    expect(store.research.fetchCount).toBe(2);

    const text = (result.output as Array<{ text: string }>)[0].text;
    for (const fetchedHit of [hits3[1], hits3[2]]) {
      const id = sourceIdForUrl(fetchedHit.url);
      expect(text).toContain(`[${id}]`);
      expect(text).toContain(`来自 ${fetchedHit.url} 的已抓取正文`);
    }
  });

  it("respects the remaining fetch cap when auto-fetching", async () => {
    const search = vi.fn(async () => hits3);
    const fetch = vi.fn(async (url: string) => fetchResult(url));
    const store = docs();
    store.research.fetchCount = 29; // one fetch remains under the cap of 30

    await searchTool({ search, fetch } as unknown as DeepSeekClient).execute(
      { query: "泰山 门票" },
      fakeApi(store) as never,
      {} as never,
    );

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe(hits3[1].url);
    expect(store.research.fetchCount).toBe(30);
  });

  it("keeps the search successful when one auto-fetch fails", async () => {
    const twoHits = [hits3[1], hits3[0]];
    const search = vi.fn(async () => twoHits);
    const fetch = vi.fn(async (url: string) => {
      if (url === hits3[1].url) throw new Error("page timeout");
      return fetchResult(url);
    });
    const store = docs();

    const result = await searchTool({ search, fetch } as unknown as DeepSeekClient).execute(
      { query: "泰山 门票" },
      fakeApi(store) as never,
      {} as never,
    );

    expect(store.research.searchCount).toBe(1);
    expect(store.research.fetchCount).toBe(1);
    const text = (result.output as Array<{ text: string }>)[0].text;

    const failedId = sourceIdForUrl(hits3[1].url);
    const failedBlock = text
      .split("\n[")
      .find((block) => block.startsWith(`${failedId}]`));
    expect(failedBlock).toContain("fetched: no");
    expect(failedBlock).toContain(hits3[1].snippet);

    const fetchedId = sourceIdForUrl(hits3[0].url);
    expect(text).toContain(`[${fetchedId}]`);
    expect(text).toContain(`来自 ${hits3[0].url} 的已抓取正文`);
  });

  it("does not re-fetch already-fetched sources on a cache hit", async () => {
    const search = vi.fn(async () => [hits3[1], hits3[2]]);
    const fetch = vi.fn(async (url: string) => fetchResult(url));
    const store = docs();
    const api = fakeApi(store);
    const tool = searchTool({ search, fetch } as unknown as DeepSeekClient);

    await tool.execute({ query: "泰山 门票" }, api as never, {} as never);
    expect(fetch).toHaveBeenCalledTimes(2);
    await tool.execute({ query: "泰山 门票" }, api as never, {} as never);

    expect(search).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(store.research.fetchCount).toBe(2);
  });
});

describe("deepseek_fetch", () => {
  function fetchedStore(): Docs {
    const store = docs();
    addSearchToSources(store.sources, "泰山 门票", [hit], new Date("2026-10-19"));
    return store;
  }

  it("returns the source id and truncated page content to the model", async () => {
    const fetch = vi.fn(async () => ({
      title: hit.title,
      url: hit.url,
      content: "红门开始徒步，中天门索道 100 元。",
    }));
    const tool = createFetchTool({
      now: () => new Date("2026-10-19T00:00:00Z"),
      deepseek: { search: vi.fn(), fetch } as unknown as DeepSeekClient,
      generateSketch: async () => ({ svg: "", status: "ok" }),
      caps: { search: 40, fetch: 30 },
    });
    const store = fetchedStore();
    const result = await tool.execute({ url: hit.url }, fakeApi(store) as never, {} as never);
    const text = (result.output as Array<{ text: string }>)[0].text;
    const sourceId = (result.structuredOutput as { sourceId: string }).sourceId;

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(text).toContain(`[${sourceId}]`);
    expect(text).toContain("红门开始徒步");
    expect(text).toContain(hit.url);
    expect(text).toContain("fetchedAt: 2026-10-19T00:00:00.000Z");
    expect(store.research.fetchCount).toBe(1);
  });

  it("fetches the same URL only once", async () => {
    const fetch = vi.fn(async () => ({
      title: hit.title,
      url: hit.url,
      content: "正文",
    }));
    const tool = createFetchTool({
      now: () => new Date("2026-10-19T00:00:00Z"),
      deepseek: { search: vi.fn(), fetch } as unknown as DeepSeekClient,
      generateSketch: async () => ({ svg: "", status: "ok" }),
      caps: { search: 40, fetch: 30 },
    });
    const store = fetchedStore();
    const api = fakeApi(store);

    await tool.execute({ url: hit.url }, api as never, {} as never);
    await tool.execute({ url: `${hit.url}/#section` }, api as never, {} as never);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(store.research.fetchCount).toBe(1);
  });

  it("rejects a URL that did not come from search", async () => {
    const fetch = vi.fn();
    const tool = createFetchTool({
      now: () => new Date("2026-10-19T00:00:00Z"),
      deepseek: { search: vi.fn(), fetch } as unknown as DeepSeekClient,
      generateSketch: async () => ({ svg: "", status: "ok" }),
      caps: { search: 40, fetch: 30 },
    });

    await expect(
      tool.execute(
        { url: "https://evil.example/steal" },
        fakeApi(docs()) as never,
        {} as never,
      ),
    ).rejects.toThrow("must come from a deepseek_search result");
    expect(fetch).not.toHaveBeenCalled();
  });
});

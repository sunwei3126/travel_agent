import { describe, expect, it, vi } from "vitest";
import type { DeepSeekClient, SearchHit } from "../deepseek/client";
import { addSearchToSources, sourceIdForUrl } from "../research/sources";
import { enforceCap } from "./tools/caps";
import { createFetchTool } from "./tools/fetch";
import { createSearchTool, searchCacheKey } from "./tools/search";
import { TRIP_ID, invoke, makeContext, textOf } from "./tools/test-support";

it("enforces the per-trip search and fetch caps", () => {
  expect(() => enforceCap(40, 40, "search")).toThrow("search cap reached");
  expect(() => enforceCap(39, 40, "search")).not.toThrow();
  expect(() => enforceCap(30, 30, "fetch")).toThrow("fetch cap reached");
});

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

function setup(deepseek: unknown) {
  const ctx = makeContext({ deepseek: deepseek as DeepSeekClient });
  return { ctx, tool: createSearchTool(ctx) };
}

describe("deepseek_search", () => {
  it("returns the source id, URL, snippet, authority, and freshness to the model", async () => {
    const deepseek = { search: vi.fn(async () => [hit]), fetch: vi.fn(async (url: string) => fetchResult(url)) };
    const { tool } = setup(deepseek);

    const result = await invoke(tool, { query: "泰山 门票" });
    const text = textOf(result);

    expect(text).toContain(`[${sourceIdForUrl(hit.url)}]`);
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
    const { ctx, tool } = setup({ search, fetch });

    const first = await invoke(tool, { query: " 泰山   门票 " });
    const second = await invoke(tool, { query: "泰山 门票" });

    expect(search).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(textOf(second)).toContain(`[${sourceIdForUrl(hit.url)}]`);
    expect(textOf(first)).toContain(`[${sourceIdForUrl(hit.url)}]`);
    const research = ctx.store.getDoc(TRIP_ID, "research");
    expect(research.searchCount).toBe(1);
    expect(research.fetchCount).toBe(1);
    expect(research.searchAttempts).toEqual({ [searchCacheKey("泰山 门票", {})]: 1 });
  });

  it("does not treat a different option set as a cache hit", async () => {
    const search = vi.fn(async () => [hit]);
    const { ctx, tool } = setup({ search, fetch: vi.fn(async (url: string) => fetchResult(url)) });

    await invoke(tool, { query: "泰山 门票" });
    await invoke(tool, { query: "泰山 门票", needContent: true });

    expect(search).toHaveBeenCalledTimes(2);
    expect(ctx.store.getDoc(TRIP_ID, "research").searchCount).toBe(2);
  });

  it("tells the model not to plan from memory when nothing is found", async () => {
    const { tool } = setup({ search: async () => [], fetch: vi.fn() });
    const result = await invoke(tool, { query: "空白查询" });
    expect(textOf(result)).toContain("Found 0 sources");
  });

  it("auto-fetches the top two authority results and exposes verified content", async () => {
    const search = vi.fn(async () => hits3);
    const fetch = vi.fn(async (url: string) => fetchResult(url));
    const { ctx, tool } = setup({ search, fetch });

    const result = await invoke(tool, { query: "泰山 门票" });

    expect(fetch.mock.calls.map((call) => call[0])).toEqual([hits3[1].url, hits3[2].url]);
    expect(ctx.store.getDoc(TRIP_ID, "research").fetchCount).toBe(2);

    const text = textOf(result);
    for (const fetchedHit of [hits3[1], hits3[2]]) {
      expect(text).toContain(`[${sourceIdForUrl(fetchedHit.url)}]`);
      expect(text).toContain(`来自 ${fetchedHit.url} 的已抓取正文`);
    }
  });

  it("respects the remaining fetch cap when auto-fetching", async () => {
    const search = vi.fn(async () => hits3);
    const fetch = vi.fn(async (url: string) => fetchResult(url));
    const { ctx, tool } = setup({ search, fetch });
    ctx.store.setDoc(TRIP_ID, "research", { searchCount: 0, fetchCount: 29 }); // one fetch remains under the cap of 30

    await invoke(tool, { query: "泰山 门票" });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe(hits3[1].url);
    expect(ctx.store.getDoc(TRIP_ID, "research").fetchCount).toBe(30);
  });

  it("stores a fetch result that only contains content under the searched URL", async () => {
    const search = vi.fn(async () => [hits3[1]]);
    const fetch = vi.fn(async () => ({ content: "正文" }) as never);
    const { ctx, tool } = setup({ search, fetch });

    const result = await invoke(tool, { query: "泰山 门票" });

    const id = sourceIdForUrl(hits3[1].url);
    expect(ctx.store.getDoc(TRIP_ID, "research").fetchCount).toBe(1);
    const stored = ctx.store.getDoc(TRIP_ID, "sources")[id];
    expect(stored).toMatchObject({ url: hits3[1].url, title: hits3[1].url, content: "正文" });
    expect(stored.fetchedAt).toBeTruthy();
    expect(textOf(result)).toContain(`[${id}]`);
    expect(textOf(result)).toContain("fetchedContent: 正文");
  });

  it("keeps the search successful when one auto-fetch fails", async () => {
    const search = vi.fn(async () => [hits3[1], hits3[0]]);
    const fetch = vi.fn(async (url: string) => {
      if (url === hits3[1].url) throw new Error("page timeout");
      return fetchResult(url);
    });
    const { ctx, tool } = setup({ search, fetch });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await invoke(tool, { query: "泰山 门票" });

    const research = ctx.store.getDoc(TRIP_ID, "research");
    expect(research.searchCount).toBe(1);
    expect(research.fetchCount).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(hits3[1].url));
    errorSpy.mockRestore();
    const text = textOf(result);

    const failedId = sourceIdForUrl(hits3[1].url);
    const failedBlock = text.split("\n[").find((block) => block.startsWith(`${failedId}]`));
    expect(failedBlock).toContain("fetched: no");
    expect(failedBlock).toContain(hits3[1].snippet);

    const fetchedId = sourceIdForUrl(hits3[0].url);
    expect(text).toContain(`[${fetchedId}]`);
    expect(text).toContain(`来自 ${hits3[0].url} 的已抓取正文`);
  });

  it("does not re-fetch already-fetched sources on a cache hit", async () => {
    const search = vi.fn(async () => [hits3[1], hits3[2]]);
    const fetch = vi.fn(async (url: string) => fetchResult(url));
    const { ctx, tool } = setup({ search, fetch });

    await invoke(tool, { query: "泰山 门票" });
    expect(fetch).toHaveBeenCalledTimes(2);
    await invoke(tool, { query: "泰山 门票" });

    expect(search).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(ctx.store.getDoc(TRIP_ID, "research").fetchCount).toBe(2);
  });

  it("returns an error result when the search cap is reached", async () => {
    const search = vi.fn(async () => [hit]);
    const { ctx, tool } = setup({ search, fetch: vi.fn() });
    ctx.store.setDoc(TRIP_ID, "research", { searchCount: 40, fetchCount: 0 });

    const result = await invoke(tool, { query: "新的查询" });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("search cap reached");
    expect(search).not.toHaveBeenCalled();
  });
});

describe("deepseek_fetch", () => {
  function fetchSetup(fetch: unknown) {
    const ctx = makeContext({ deepseek: { search: vi.fn(), fetch } as unknown as DeepSeekClient });
    const sources = ctx.store.getDoc(TRIP_ID, "sources");
    addSearchToSources(sources, "泰山 门票", [hit], new Date("2026-10-19"));
    ctx.store.setDoc(TRIP_ID, "sources", sources);
    return { ctx, tool: createFetchTool(ctx) };
  }

  it("returns the source id and truncated page content to the model", async () => {
    const fetch = vi.fn(async () => ({
      title: hit.title,
      url: hit.url,
      content: "红门开始徒步，中天门索道 100 元。",
    }));
    const { ctx, tool } = fetchSetup(fetch);

    const result = await invoke(tool, { url: hit.url });
    const text = textOf(result);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(text).toContain(`[${sourceIdForUrl(hit.url)}]`);
    expect(text).toContain("红门开始徒步");
    expect(text).toContain(hit.url);
    expect(text).toContain("fetchedAt: 2026-10-19T00:00:00.000Z");
    expect(ctx.store.getDoc(TRIP_ID, "research").fetchCount).toBe(1);
  });

  it("fetches the same URL only once", async () => {
    const fetch = vi.fn(async () => ({ title: hit.title, url: hit.url, content: "正文" }));
    const { ctx, tool } = fetchSetup(fetch);

    await invoke(tool, { url: hit.url });
    await invoke(tool, { url: `${hit.url}/#section` });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(ctx.store.getDoc(TRIP_ID, "research").fetchCount).toBe(1);
  });

  it("rejects a URL that did not come from search", async () => {
    const fetch = vi.fn();
    const ctx = makeContext({ deepseek: { search: vi.fn(), fetch } as unknown as DeepSeekClient });

    const result = await invoke(createFetchTool(ctx), { url: "https://evil.example/steal" });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("must come from a deepseek_search result");
    expect(fetch).not.toHaveBeenCalled();
  });
});

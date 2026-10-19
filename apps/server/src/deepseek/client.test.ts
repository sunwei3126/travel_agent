import { describe, expect, it, vi } from "vitest";
import { DeepSeekClient } from "./client";
import { RateLimiter } from "./rate-limiter";

it("posts a search with bearer auth and maps results", async () => {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
    results: [{ title: "泰山门票", url: "https://example.com/a", snippet: "s", summary: "sum", authority: 4, rerank_score: 2.1, site_name: "官网" }],
  }), { status: 200 }));
  const client = new DeepSeekClient({ apiKey: "k", fetchImpl });
  const hits = await client.search("泰山 门票", { count: 5 });
  expect(fetchImpl).toHaveBeenCalledWith("https://api.deepseek.com/v1/tools/search", expect.objectContaining({
    method: "POST", headers: expect.objectContaining({ Authorization: "Bearer k" }),
  }));
  expect(hits[0]).toMatchObject({ title: "泰山门票", authority: 4, rerankScore: 2.1 });
});

it("normalizes a live fetch response that only contains content", async () => {
  const fetchImpl = vi.fn(async () =>
    new Response(JSON.stringify({ content: "正文" }), { status: 200 }),
  );
  const client = new DeepSeekClient({ apiKey: "k", fetchImpl });

  await expect(client.fetch("https://example.com/page")).resolves.toEqual({
    url: "https://example.com/page",
    title: "https://example.com/page",
    content: "正文",
  });
});

it("keeps title and url when the fetch response provides them", async () => {
  const fetchImpl = vi.fn(async () =>
    new Response(
      JSON.stringify({
        title: "页面标题",
        url: "https://example.com/final",
        content: "正文",
      }),
      { status: 200 },
    ),
  );
  const client = new DeepSeekClient({ apiKey: "k", fetchImpl });

  await expect(client.fetch("https://example.com/page")).resolves.toEqual({
    url: "https://example.com/final",
    title: "页面标题",
    content: "正文",
  });
});

it("returns an empty list when DeepSeek has no results", async () => {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ results: [] }), { status: 200 }));
  expect(await new DeepSeekClient({ apiKey: "k", fetchImpl }).search("不存在的地方")).toEqual([]);
});

it("retries 429 once using Retry-After", async () => {
  const sleep = vi.fn(async () => {});
  const fetchImpl = vi.fn()
    .mockResolvedValueOnce(new Response("", { status: 429, headers: { "retry-after": "1" } }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ results: [] }), { status: 200 }));
  await new DeepSeekClient({ apiKey: "k", fetchImpl, sleep, qps: 1000 }).search("q");
  expect(sleep).toHaveBeenCalledWith(1000);
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});

it("rate limits to 5 QPS", async () => {
  let now = 0;
  const sleep = vi.fn(async (ms: number) => { now += ms; });
  const limiter = new RateLimiter({ qps: 5, now: () => now, sleep });
  for (let i = 0; i < 6; i++) await limiter.acquire();
  expect(sleep).toHaveBeenCalledWith(200);
});

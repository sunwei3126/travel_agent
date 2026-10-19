import { describe, expect, it } from "vitest";
import { addFetchToSource, addSearchToSources } from "./sources";
import { freshnessOf, isVerifiedFact, rankSources } from "./freshness";
import type { TripSources } from "@pi-demo/shared";

it("deduplicates by URL and enriches a search hit with fetched content", () => {
  const sources: TripSources = {};
  const ids = addSearchToSources(sources, "泰山", [{ title: "A", url: "https://a.com", snippet: "s", authority: 3 }], new Date("2026-10-19"));
  addSearchToSources(sources, "泰山", [{ title: "A2", url: "https://a.com", snippet: "s2", authority: 4 }], new Date("2026-10-19"));
  expect(Object.keys(sources)).toHaveLength(1);
  addFetchToSource(sources, { title: "A", url: "https://a.com", content: "正文" }, new Date("2026-10-19"));
  expect(sources[ids[0]].content).toBe("正文");
  expect(isVerifiedFact(sources[ids[0]])).toBe(true);
});

it("treats a 2023 source as stale and ranks official sources first", () => {
  const old: any = { id: "1", query: "q", title: "blog", url: "u1", snippet: "", date: "2023-01-01", authority: 1, kind: "search" };
  expect(freshnessOf(old, new Date("2026-10-19"))).toBe("stale");
  expect(rankSources([old, { ...old, id: "2", authority: 4 }])[0].id).toBe("2");
});

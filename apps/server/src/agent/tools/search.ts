import { tool } from "@anthropic-ai/claude-agent-sdk";
import type { TripSource, TripSources } from "@pi-demo/shared";
import { z } from "zod";
import type { FetchResult, SearchOptions } from "../../deepseek/client";
import { formatSearchResults } from "../../research/format";
import {
  addFetchToSource,
  addSearchToSources,
  normalizeUrl,
} from "../../research/sources";
import type { ToolContext } from "../deps";
import { enforceCap } from "./caps";
import { guarded, textResult } from "./helpers";

const shape = {
  query: z.string().describe("Search query"),
  count: z.number().optional().describe("Maximum number of results to return"),
  oriQuestion: z.string().optional().describe("The user's original question"),
  localization: z.string().optional().describe("Language or locale for results"),
  needContent: z.boolean().optional().describe("Ask for page content in the results"),
};

const AUTO_FETCH_LIMIT = 2;

/**
 * Stable cache key for a search: normalized query text plus every option that
 * changes the upstream request (undefined options are omitted).
 */
export function searchCacheKey(query: string, options: SearchOptions): string {
  return JSON.stringify({
    query: query.trim().replace(/\s+/g, " "),
    count: options.count ?? null,
    oriQuestion: options.oriQuestion?.trim() ?? null,
    localization: options.localization ?? null,
    needContent: options.needContent ?? false,
  });
}

/**
 * Picks the pages the search tool verifies itself: up to `limit` unique URLs,
 * preferring `authority >= 3`, then filling from the remaining results in
 * search order.
 */
export function selectFetchTargets<T extends { url: string; authority?: number }>(
  items: T[],
  limit: number = AUTO_FETCH_LIMIT,
): T[] {
  if (limit <= 0) return [];
  const seen = new Set<string>();
  const unique = items.filter((item) => {
    const key = normalizeUrl(item.url);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const preferred = unique.filter((item) => (item.authority ?? 0) >= 3);
  const selected = preferred.slice(0, limit);
  for (const item of unique) {
    if (selected.length >= limit) break;
    if (!selected.includes(item)) selected.push(item);
  }
  return selected;
}

function mergeSources(
  sources: TripSources,
  fetched: TripSource[],
): TripSources {
  if (fetched.length === 0) return sources;
  const merged: TripSources = { ...sources };
  for (const source of fetched) merged[source.id] = source;
  return merged;
}

function withFetchedIds(sourceIds: string[], fetched: TripSource[]): string[] {
  return [...new Set([...sourceIds, ...fetched.map((source) => source.id)])];
}

/**
 * Verifies up to `remaining` pages (at most two) from a search's own results.
 * Each URL is fetched independently: one failure is recorded as an unfetched
 * lead and never fails the search.
 */
async function autoFetch(
  ctx: ToolContext,
  now: Date,
  candidates: TripSource[],
  remaining: number,
): Promise<TripSource[]> {
  const targets = selectFetchTargets(
    candidates.filter((source) => source.fetchedAt === undefined),
    Math.min(AUTO_FETCH_LIMIT, Math.max(0, remaining)),
  );
  const fetched: TripSource[] = [];

  for (const target of targets) {
    try {
      const raw = await ctx.deps.deepseek.fetch(target.url);
      // Older/alternate response shapes may omit title/url. Keep the requested
      // URL as the identity instead of failing the whole search.
      const result: FetchResult = {
        content: typeof raw.content === "string" ? raw.content : "",
        url: typeof raw.url === "string" && raw.url.length > 0 ? raw.url : target.url,
        title:
          typeof raw.title === "string" && raw.title.length > 0
            ? raw.title
            : typeof raw.url === "string" && raw.url.length > 0
              ? raw.url
              : target.url,
      };
      const source = ctx.store.transaction(() => {
        const research = ctx.store.getDoc(ctx.tripId, "research");
        if (research.fetchCount >= ctx.deps.caps.fetch) return undefined;
        const stored = ctx.store.getDoc(ctx.tripId, "sources");
        const id = addFetchToSource(stored, result, now);
        research.fetchCount += 1;
        const attemptKey = normalizeUrl(target.url);
        research.fetchAttempts = {
          ...(research.fetchAttempts ?? {}),
          [attemptKey]: (research.fetchAttempts?.[attemptKey] ?? 0) + 1,
        };
        ctx.store.setDoc(ctx.tripId, "sources", stored);
        ctx.store.setDoc(ctx.tripId, "research", research);
        return { ...stored[id] };
      });
      if (source !== undefined) fetched.push(source);
    } catch (error) {
      // The snippet remains a lead; the search itself still succeeds, but the
      // failure is logged instead of disappearing silently.
      console.error(
        `[deepseek_search] auto-fetch failed for ${target.url}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return fetched;
}

export function createSearchTool(ctx: ToolContext) {
  return tool(
    "deepseek_search",
    "Search the web with DeepSeek, store the results as trip sources, and fetch the top two pages for verified content.",
    shape,
    (args) =>
      guarded(async () => {
        const options: SearchOptions = {
          count: args.count,
          oriQuestion: args.oriQuestion,
          localization: args.localization,
          needContent: args.needContent,
        };
        const cacheKey = searchCacheKey(args.query, options);
        const now = ctx.deps.now();

        const cached = ctx.store.getDoc(ctx.tripId, "searchCache");
        const currentSources = ctx.store.getDoc(ctx.tripId, "sources");
        const current = ctx.store.getDoc(ctx.tripId, "research");
        const fetchRemaining = ctx.deps.caps.fetch - current.fetchCount;

        const cachedIds = cached[cacheKey]?.sourceIds ?? [];
        if (cachedIds.length > 0 && cachedIds.every((id) => currentSources[id] !== undefined)) {
          // A cache hit is free for search, but may still verify top results the
          // previous attempt could not fetch, subject to the fetch cap.
          const candidates = cachedIds
            .map((id) => currentSources[id])
            .filter((source): source is TripSource => source !== undefined);
          const fetched = await autoFetch(ctx, now, candidates, fetchRemaining);
          const outputSources = mergeSources(currentSources, fetched);
          const outputIds = withFetchedIds(cachedIds, fetched);
          return textResult(formatSearchResults(args.query, outputIds, outputSources, now));
        }

        enforceCap(current.searchCount, ctx.deps.caps.search, "search");

        const hits = await ctx.deps.deepseek.search(args.query, options);

        const { sourceIds, candidates } = ctx.store.transaction(() => {
          const research = ctx.store.getDoc(ctx.tripId, "research");
          enforceCap(research.searchCount, ctx.deps.caps.search, "search");
          const stored = ctx.store.getDoc(ctx.tripId, "sources");
          const ids = addSearchToSources(stored, args.query, hits, now);
          const cache = ctx.store.getDoc(ctx.tripId, "searchCache");
          cache[cacheKey] = { sourceIds: ids, at: now.toISOString() };
          research.searchCount += 1;
          research.searchAttempts = {
            ...(research.searchAttempts ?? {}),
            [cacheKey]: (research.searchAttempts?.[cacheKey] ?? 0) + 1,
          };
          ctx.store.setDoc(ctx.tripId, "sources", stored);
          ctx.store.setDoc(ctx.tripId, "searchCache", cache);
          ctx.store.setDoc(ctx.tripId, "research", research);
          return { sourceIds: ids, candidates: ids.map((id) => ({ ...stored[id] })) };
        });

        const fetched = await autoFetch(ctx, now, candidates, fetchRemaining);
        // Committed read after autoFetch, so the output includes both the search
        // results and the newly fetched content.
        const outputSources = mergeSources(ctx.store.getDoc(ctx.tripId, "sources"), fetched);
        const outputIds = withFetchedIds(sourceIds, fetched);

        return textResult(formatSearchResults(args.query, outputIds, outputSources, now));
      }),
  );
}

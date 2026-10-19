import { defineTool } from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";
import type { TripSources } from "@pi-demo/shared";
import type { SearchOptions } from "../../deepseek/client";
import { formatSearchResults } from "../../research/format";
import { addSearchToSources } from "../../research/sources";
import {
  TripResearchDoc,
  TripSearchCacheDoc,
  TripSourcesDoc,
} from "../../trips/docs";
import type { TravelDeps } from "../deps";
import { enforceCap } from "./caps";

const parameters = Type.Object({
  query: Type.String({ description: "Search query" }),
  count: Type.Optional(Type.Number({ description: "Maximum number of results to return" })),
  oriQuestion: Type.Optional(Type.String({ description: "The user's original question" })),
  localization: Type.Optional(Type.String({ description: "Language or locale for results" })),
  needContent: Type.Optional(Type.Boolean({ description: "Ask for page content in the results" })),
});

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

export function createSearchTool(deps: TravelDeps) {
  return defineTool({
    name: "deepseek_search",
    description: "Search the web with DeepSeek and store the results as trip sources.",
    parameters,
    structuredOutputSchema: Type.Object({ sourceIds: Type.Array(Type.String()) }),
    replay: "safe",
    execute: async (args, api, context) => {
      const options: SearchOptions = {
        count: args.count,
        oriQuestion: args.oriQuestion,
        localization: args.localization,
        needContent: args.needContent,
      };
      const cacheKey = searchCacheKey(args.query, options);
      const now = deps.now();

      const cached = await api.snapshot(
        TripSearchCacheDoc,
        api.conversationId,
        context,
      );
      const currentSources =
        (await api.snapshot(TripSourcesDoc, api.conversationId, context)) ??
        ({} as TripSources);
      const cachedIds = cached?.[cacheKey]?.sourceIds ?? [];
      if (
        cachedIds.length > 0 &&
        cachedIds.every((id) => currentSources[id] !== undefined)
      ) {
        return {
          output: [
            {
              type: "text" as const,
              text: formatSearchResults(args.query, cachedIds, currentSources, now),
            },
          ],
          structuredOutput: { sourceIds: cachedIds },
        };
      }

      const current = await api.snapshot(
        TripResearchDoc,
        api.conversationId,
        context,
      );
      enforceCap(current?.searchCount ?? 0, deps.caps.search, "search");

      const hits = await deps.deepseek.search(args.query, options);

      const { sourceIds, sources } = await api.commit(async (tx) => {
        const research = await tx.doc(TripResearchDoc, api.conversationId);
        enforceCap(research.searchCount, deps.caps.search, "search");
        const stored = await tx.doc(TripSourcesDoc, api.conversationId);
        const ids = addSearchToSources(stored, args.query, hits, now);
        const cache = await tx.doc(TripSearchCacheDoc, api.conversationId);
        cache[cacheKey] = { sourceIds: ids, at: now.toISOString() };
        research.searchCount += 1;
        research.searchAttempts = {
          ...(research.searchAttempts ?? {}),
          [cacheKey]: (research.searchAttempts?.[cacheKey] ?? 0) + 1,
        };
        return { sourceIds: ids, sources: stored };
      }, context);

      return {
        output: [
          {
            type: "text" as const,
            text: formatSearchResults(args.query, sourceIds, sources, now),
          },
        ],
        structuredOutput: { sourceIds },
      };
    },
  });
}

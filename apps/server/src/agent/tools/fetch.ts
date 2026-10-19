import { defineTool } from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";
import type { TripSources } from "@pi-demo/shared";
import { formatFetchResult } from "../../research/format";
import {
  addFetchToSource,
  findSourceByUrl,
  normalizeUrl,
} from "../../research/sources";
import { TripResearchDoc, TripSourcesDoc } from "../../trips/docs";
import type { TravelDeps } from "../deps";
import { enforceCap } from "./caps";

const parameters = Type.Object({
  url: Type.String({ description: "URL of the page to fetch" }),
});

export function createFetchTool(deps: TravelDeps) {
  return defineTool({
    name: "deepseek_fetch",
    description: "Fetch a web page with DeepSeek and store its content as a trip source.",
    parameters,
    structuredOutputSchema: Type.Object({ sourceId: Type.String() }),
    replay: "safe",
    execute: async (args, api, context) => {
      const now = deps.now();
      const sources =
        (await api.snapshot(TripSourcesDoc, api.conversationId, context)) ??
        ({} as TripSources);

      // Never fetch a URL the user invented: only pages returned by search.
      const existing = findSourceByUrl(sources, args.url);
      if (existing === undefined) {
        throw new Error(
          `Cannot fetch "${args.url}": the URL must come from a deepseek_search result. Search for it first.`,
        );
      }

      // Same-URL guard: a completed fetch is never repeated.
      if (existing.fetchedAt !== undefined) {
        return {
          output: [
            {
              type: "text" as const,
              text: formatFetchResult(existing, now),
            },
          ],
          structuredOutput: { sourceId: existing.id },
        };
      }

      const current = await api.snapshot(
        TripResearchDoc,
        api.conversationId,
        context,
      );
      enforceCap(current?.fetchCount ?? 0, deps.caps.fetch, "fetch");

      const result = await deps.deepseek.fetch(args.url);

      const { sourceId, source } = await api.commit(async (tx) => {
        const research = await tx.doc(TripResearchDoc, api.conversationId);
        enforceCap(research.fetchCount, deps.caps.fetch, "fetch");
        const stored = await tx.doc(TripSourcesDoc, api.conversationId);
        const id = addFetchToSource(stored, result, now);
        research.fetchCount += 1;
        const attemptKey = normalizeUrl(args.url);
        research.fetchAttempts = {
          ...(research.fetchAttempts ?? {}),
          [attemptKey]: (research.fetchAttempts?.[attemptKey] ?? 0) + 1,
        };
        return { sourceId: id, source: stored[id] };
      }, context);

      const outputSource =
        source ?? { ...existing, content: result.content, fetchedAt: now.toISOString() };

      return {
        output: [
          {
            type: "text" as const,
            text: formatFetchResult(outputSource, now),
          },
        ],
        structuredOutput: { sourceId },
      };
    },
  });
}

import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { formatFetchResult } from "../../research/format";
import {
  addFetchToSource,
  findSourceByUrl,
  normalizeUrl,
} from "../../research/sources";
import type { ToolContext } from "../deps";
import { enforceCap } from "./caps";
import { guarded, textResult } from "./helpers";

const shape = {
  url: z.string().describe("URL of the page to fetch"),
};

export function createFetchTool(ctx: ToolContext) {
  return tool(
    "deepseek_fetch",
    "Fetch a web page with DeepSeek and store its content as a trip source.",
    shape,
    (args) =>
      guarded(async () => {
        const now = ctx.deps.now();

        // Never fetch a URL the user invented: only pages returned by search.
        const existing = findSourceByUrl(ctx.store.getDoc(ctx.tripId, "sources"), args.url);
        if (existing === undefined) {
          throw new Error(
            `Cannot fetch "${args.url}": the URL must come from a deepseek_search result. Search for it first.`,
          );
        }

        // Same-URL guard: a completed fetch is never repeated.
        if (existing.fetchedAt !== undefined) {
          return textResult(formatFetchResult(existing, now));
        }

        enforceCap(ctx.store.getDoc(ctx.tripId, "research").fetchCount, ctx.deps.caps.fetch, "fetch");

        const result = await ctx.deps.deepseek.fetch(args.url);

        const source = ctx.store.transaction(() => {
          const research = ctx.store.getDoc(ctx.tripId, "research");
          enforceCap(research.fetchCount, ctx.deps.caps.fetch, "fetch");
          const stored = ctx.store.getDoc(ctx.tripId, "sources");
          const id = addFetchToSource(stored, result, now);
          research.fetchCount += 1;
          const attemptKey = normalizeUrl(args.url);
          research.fetchAttempts = {
            ...(research.fetchAttempts ?? {}),
            [attemptKey]: (research.fetchAttempts?.[attemptKey] ?? 0) + 1,
          };
          ctx.store.setDoc(ctx.tripId, "sources", stored);
          ctx.store.setDoc(ctx.tripId, "research", research);
          return { ...stored[id] };
        });

        return textResult(formatFetchResult(source, now));
      }),
  );
}

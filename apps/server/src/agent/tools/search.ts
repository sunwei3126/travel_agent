import { defineTool } from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";
import { addSearchToSources } from "../../research/sources";
import { TripResearchDoc, TripSourcesDoc } from "../../trips/docs";
import type { TravelDeps } from "../deps";
import { enforceCap } from "./caps";

const parameters = Type.Object({
  query: Type.String({ description: "Search query" }),
  count: Type.Optional(Type.Number({ description: "Maximum number of results to return" })),
  oriQuestion: Type.Optional(Type.String({ description: "The user's original question" })),
  localization: Type.Optional(Type.String({ description: "Language or locale for results" })),
  needContent: Type.Optional(Type.Boolean({ description: "Ask for page content in the results" })),
});

export function createSearchTool(deps: TravelDeps) {
  return defineTool({
    name: "deepseek_search",
    description: "Search the web with DeepSeek and store the results as trip sources.",
    parameters,
    structuredOutputSchema: Type.Object({ sourceIds: Type.Array(Type.String()) }),
    replay: "safe",
    execute: async (args, api, context) => {
      const current = await api.snapshot(
        TripResearchDoc,
        api.conversationId,
        context,
      );
      enforceCap(current?.searchCount ?? 0, deps.caps.search, "search");

      const hits = await deps.deepseek.search(args.query, {
        count: args.count,
        oriQuestion: args.oriQuestion,
        localization: args.localization,
        needContent: args.needContent,
      });

      const sourceIds = await api.commit(async (tx) => {
        const research = await tx.doc(TripResearchDoc, api.conversationId);
        enforceCap(research.searchCount, deps.caps.search, "search");
        const sources = await tx.doc(TripSourcesDoc, api.conversationId);
        const ids = addSearchToSources(sources, args.query, hits, deps.now());
        research.searchCount += 1;
        return ids;
      }, context);

      return {
        output: [
          {
            type: "text",
            text: `Found ${sourceIds.length} source(s) for "${args.query}".`,
          },
        ],
        structuredOutput: { sourceIds },
      };
    },
  });
}

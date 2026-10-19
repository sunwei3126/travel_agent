import { defineTool } from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";
import { addFetchToSource } from "../../research/sources";
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
      const result = await deps.deepseek.fetch(args.url);

      const sourceId = await api.commit(async (tx) => {
        const research = await tx.doc(TripResearchDoc, api.conversationId);
        enforceCap(research.fetchCount, deps.caps.fetch, "fetch");
        const sources = await tx.doc(TripSourcesDoc, api.conversationId);
        const id = addFetchToSource(sources, result, deps.now());
        research.fetchCount += 1;
        return id;
      }, context);

      return {
        output: [
          {
            type: "text",
            text: `Fetched "${result.title}".`,
          },
        ],
        structuredOutput: { sourceId },
      };
    },
  });
}

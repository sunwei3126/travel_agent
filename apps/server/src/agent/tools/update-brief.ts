import { defineTool } from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";
import { missingBriefFields } from "@pi-demo/shared";
import { validateBrief } from "../../plan/validate";
import { TripBriefDoc, mergeBrief } from "../../trips/docs";
import type { TravelDeps } from "../deps";

const parameters = Type.Object({
  destination: Type.Optional(Type.String({ description: "Destination city or area" })),
  origin: Type.Optional(Type.String({ description: "Departure city" })),
  startDate: Type.Optional(Type.String({ description: "Start date as YYYY-MM-DD" })),
  days: Type.Optional(Type.Number({ description: "Number of days, at least 1" })),
  budgetCny: Type.Optional(Type.Number({ description: "Total budget in CNY, greater than 0" })),
  companions: Type.Optional(Type.String({ description: "Who travels with the user" })),
  fitness: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("average"), Type.Literal("high")])),
  interests: Type.Optional(Type.Array(Type.String(), { description: "Interests that shape the itinerary" })),
  constraints: Type.Optional(Type.Array(Type.String(), { description: "Hard constraints to respect" })),
  assumptions: Type.Optional(Type.Array(Type.String(), { description: "Assumptions made explicit to the user" })),
});

export function createUpdateBriefTool(deps: TravelDeps) {
  return defineTool({
    name: "trip_update_brief",
    description: "Merge new or corrected trip requirements into the durable trip brief.",
    parameters,
    structuredOutputSchema: Type.Object({ missing: Type.Array(Type.String()) }),
    replay: "safe",
    execute: async (args, api, context) => {
      const missing = await api.commit(async (tx) => {
        const brief = await tx.doc(TripBriefDoc, api.conversationId);
        const merged = mergeBrief(brief, args);
        // Incremental updates are allowed to remain incomplete, but a real
        // calendar date and a positive day count are enforced immediately.
        const errors = validateBrief(merged, deps.now(), { requireComplete: false });
        if (errors.length > 0) {
          throw new Error(`Invalid trip brief: ${errors.join("; ")}`);
        }
        Object.assign(brief, merged);
        return missingBriefFields(brief);
      }, context);

      return {
        output: [
          {
            type: "text",
            text: missing.length === 0 ? "Brief is complete." : `Missing brief fields: ${missing.join(", ")}`,
          },
        ],
        structuredOutput: { missing },
      };
    },
  });
}

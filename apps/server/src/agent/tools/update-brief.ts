import { tool } from "@anthropic-ai/claude-agent-sdk";
import { missingBriefFields } from "@pi-demo/shared";
import { z } from "zod";
import { validateBrief } from "../../plan/validate";
import { mergeBrief } from "../../trips/docs";
import type { ToolContext } from "../deps";
import { guarded, textResult } from "./helpers";

const shape = {
  destination: z.string().optional().describe("Destination city or area"),
  origin: z.string().optional().describe("Departure city"),
  startDate: z.string().optional().describe("Start date as YYYY-MM-DD"),
  days: z.number().optional().describe("Number of days, at least 1"),
  budgetCny: z.number().optional().describe("Total budget in CNY, greater than 0"),
  companions: z.string().optional().describe("Who travels with the user"),
  fitness: z.enum(["low", "average", "high"]).optional(),
  interests: z.array(z.string()).optional().describe("Interests that shape the itinerary"),
  constraints: z.array(z.string()).optional().describe("Hard constraints to respect"),
  assumptions: z.array(z.string()).optional().describe("Assumptions made explicit to the user"),
};

export function createUpdateBriefTool(ctx: ToolContext) {
  return tool(
    "trip_update_brief",
    "Merge new or corrected trip requirements into the durable trip brief.",
    shape,
    (args) =>
      guarded(() => {
        const missing = ctx.store.transaction(() => {
          const merged = mergeBrief(ctx.store.getDoc(ctx.tripId, "brief"), args);
          // Incremental updates may stay incomplete, but a real calendar date and a
          // positive day count are enforced immediately.
          const errors = validateBrief(merged, ctx.deps.now(), { requireComplete: false });
          if (errors.length > 0) throw new Error(`Invalid trip brief: ${errors.join("; ")}`);
          ctx.store.setDoc(ctx.tripId, "brief", merged);
          return missingBriefFields(merged);
        });
        return textResult(
          missing.length === 0 ? "Brief is complete." : `Missing brief fields: ${missing.join(", ")}`,
        );
      }),
  );
}

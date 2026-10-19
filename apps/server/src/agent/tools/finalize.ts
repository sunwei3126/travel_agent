import { defineTool } from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";
import { finalizeBudget } from "../../plan/budget";
import { TripBriefDoc, TripPlanDoc } from "../../trips/docs";

export const finalizeTool = defineTool({
  name: "plan_finalize",
  description: "Sum the day-card cost ranges against the trip budget and store the result on the plan.",
  parameters: Type.Object({}),
  structuredOutputSchema: Type.Object({
    low: Type.Number(),
    high: Type.Number(),
    cap: Type.Number(),
    withinBudget: Type.Boolean(),
  }),
  replay: "safe",
  execute: async (_args, api, context) => {
    const summary = await api.commit(async (tx) => {
      const brief = await tx.doc(TripBriefDoc, api.conversationId);
      if (typeof brief.budgetCny !== "number") {
        throw new Error("Cannot finalize: trip brief has no budgetCny");
      }

      const plan = await tx.doc(TripPlanDoc, api.conversationId);
      const result = finalizeBudget(plan, brief.budgetCny);
      plan.budget = result;
      return result;
    }, context);

    return {
      output: [
        {
          type: "text",
          text: `Estimated ${summary.low}-${summary.high} CNY against a ${summary.cap} CNY budget: ${
            summary.withinBudget ? "within budget" : "over budget"
          }.`,
        },
      ],
      structuredOutput: summary,
    };
  },
});

import { tool } from "@anthropic-ai/claude-agent-sdk";
import { finalizeBudget } from "../../plan/budget";
import type { ToolContext } from "../deps";
import { guarded, textResult } from "./helpers";

export function createFinalizeTool(ctx: ToolContext) {
  return tool(
    "plan_finalize",
    "Sum the day-card cost ranges against the trip budget and store the result on the plan.",
    {},
    () =>
      guarded(() => {
        const summary = ctx.store.transaction(() => {
          const brief = ctx.store.getDoc(ctx.tripId, "brief");
          if (typeof brief.budgetCny !== "number") {
            throw new Error("Cannot finalize: trip brief has no budgetCny");
          }
          const plan = ctx.store.getDoc(ctx.tripId, "plan");
          const result = finalizeBudget(plan, brief.budgetCny);
          ctx.store.setDoc(ctx.tripId, "plan", { ...plan, budget: result });
          return result;
        });
        return textResult(
          `Estimated ${summary.low}-${summary.high} CNY against a ${summary.cap} CNY budget: ${
            summary.withinBudget ? "within budget" : "over budget"
          }.`,
        );
      }),
  );
}

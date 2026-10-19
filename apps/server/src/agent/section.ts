import { section } from "@earendil-works/pi-durable";
import type { TripBrief, TripPlan, TripSources } from "@pi-demo/shared";
import { TripBriefDoc, TripPlanDoc, TripSourcesDoc } from "../trips/docs";

type TripContextState = {
  brief?: Readonly<TripBrief> | undefined;
  plan?: Readonly<TripPlan> | undefined;
  sources?: Readonly<TripSources> | undefined;
};

/** Render the durable trip state as a compact system-prompt section body. */
export function renderTripContext(state: TripContextState): string | undefined {
  const { brief, plan, sources } = state;
  const sourceCount = Object.keys(sources ?? {}).length;
  const hasBrief = brief !== undefined && Object.keys(brief).length > 0;
  const hasPlan = plan !== undefined && (plan.days.length > 0 || plan.summary !== undefined || plan.budget !== undefined);
  if (!hasBrief && !hasPlan && sourceCount === 0) return undefined;

  const lines: string[] = [];
  if (hasBrief) {
    const parts: string[] = [];
    if (brief.destination !== undefined) parts.push(`destination=${brief.destination}`);
    if (brief.origin !== undefined) parts.push(`origin=${brief.origin}`);
    if (brief.startDate !== undefined) parts.push(`start=${brief.startDate}`);
    if (brief.days !== undefined) parts.push(`days=${brief.days}`);
    if (brief.budgetCny !== undefined) parts.push(`budget=${brief.budgetCny} CNY`);
    if (brief.companions !== undefined) parts.push(`companions=${brief.companions}`);
    if (brief.fitness !== undefined) parts.push(`fitness=${brief.fitness}`);
    if (brief.interests !== undefined && brief.interests.length > 0) {
      parts.push(`interests=${brief.interests.join(", ")}`);
    }
    if (brief.constraints !== undefined && brief.constraints.length > 0) {
      parts.push(`constraints=${brief.constraints.join(", ")}`);
    }
    lines.push(`Brief: ${parts.length > 0 ? parts.join("; ") : "recorded"}`);
  }

  if (hasPlan) {
    const days = plan.days
      .map((day) => `D${day.dayIndex} ${day.date} ${day.title}`)
      .join("; ");
    if (days.length > 0) lines.push(`Plan: ${days}`);
    if (plan.summary !== undefined) lines.push(`Plan summary: ${plan.summary}`);
    if (plan.budget !== undefined) {
      lines.push(
        `Budget: ${plan.budget.low}-${plan.budget.high} CNY of ${plan.budget.cap} CNY (${
          plan.budget.withinBudget ? "within budget" : "over budget"
        })`,
      );
    }
  }

  lines.push(`Sources: ${sourceCount}`);
  return lines.join("\n");
}

export const tripContextSection = section("trip", async (input, context) => {
  const brief = await input.read.snapshot(TripBriefDoc, input.conversationId, context);
  const plan = await input.read.snapshot(TripPlanDoc, input.conversationId, context);
  const sources = await input.read.snapshot(TripSourcesDoc, input.conversationId, context);
  return renderTripContext({ brief, plan, sources });
});

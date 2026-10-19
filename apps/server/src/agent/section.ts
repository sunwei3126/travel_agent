import { section } from "@earendil-works/pi-durable";
import type { DayCard, TripBrief, TripPlan, TripSources } from "@pi-demo/shared";
import { freshnessOf, isVerifiedFact, rankSources } from "../research/freshness";
import { TripBriefDoc, TripPlanDoc, TripSourcesDoc } from "../trips/docs";

type TripContextState = {
  brief?: Readonly<TripBrief> | undefined;
  plan?: Readonly<TripPlan> | undefined;
  sources?: Readonly<TripSources> | undefined;
};

const MAX_BLOCKS_PER_DAY = 8;
const MAX_SOURCES = 40;

function renderDay(day: DayCard): string {
  const blocks = day.blocks.slice(0, MAX_BLOCKS_PER_DAY).map((block) => {
    const cost =
      block.costCny === undefined ? "" : ` (¥${block.costCny[0]}–¥${block.costCny[1]})`;
    return `${block.time} ${block.title}${cost}`;
  });
  if (day.blocks.length > MAX_BLOCKS_PER_DAY) {
    blocks.push(`+${day.blocks.length - MAX_BLOCKS_PER_DAY} more blocks`);
  }
  const svg = day.svgStatus === "ok" ? "svg=ok" : `svg=${day.svgStatus}`;
  const parts = [`D${day.dayIndex} ${day.date} ${day.title} [${svg}]`];
  if (blocks.length > 0) parts.push(`blocks: ${blocks.join(" | ")}`);
  parts.push(`cost: ¥${day.estimatedCostCny[0]}–¥${day.estimatedCostCny[1]}`);
  if (day.sources.length > 0) parts.push(`sources: ${day.sources.join(", ")}`);
  return parts.join("; ");
}

/** Render the durable trip state as a compact system-prompt section body. */
export function renderTripContext(
  state: TripContextState,
  now: Date = new Date(),
): string | undefined {
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
    for (const day of [...plan.days].sort((a, b) => a.dayIndex - b.dayIndex)) {
      lines.push(`Plan ${renderDay(day)}`);
    }
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
  if (sources !== undefined && sourceCount > 0) {
    const ranked = rankSources(Object.values(sources), now).slice(0, MAX_SOURCES);
    for (const source of ranked) {
      lines.push(
        `[${source.id}] ${source.title || "(untitled)"} — ${source.url}; date=${
          source.date ?? "unknown"
        } (${freshnessOf(source, now)}); authority=${
          source.authority ?? "unknown"
        }; fetched=${isVerifiedFact(source) ? "yes" : "no"}; kind=${source.kind}`,
      );
    }
    if (sourceCount > MAX_SOURCES) {
      lines.push(`+${sourceCount - MAX_SOURCES} more sources`);
    }
  }
  return lines.join("\n");
}

export const tripContextSection = section("trip", async (input, context) => {
  const brief = await input.read.snapshot(TripBriefDoc, input.conversationId, context);
  const plan = await input.read.snapshot(TripPlanDoc, input.conversationId, context);
  const sources = await input.read.snapshot(TripSourcesDoc, input.conversationId, context);
  return renderTripContext({ brief, plan, sources });
});

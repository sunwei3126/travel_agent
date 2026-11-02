import { tool } from "@anthropic-ai/claude-agent-sdk";
import { isBriefComplete, missingBriefFields } from "@pi-demo/shared";
import type { Claim, DayBlock, DayCard, TripPlan } from "@pi-demo/shared";
import { z } from "zod";
import { validateDayCard } from "../../plan/validate";
import { upsertDayCard } from "../../trips/docs";
import type { ToolContext } from "../deps";
import { guarded, textResult } from "./helpers";

const ClaimSchema = z.object({
  text: z.string(),
  kind: z.enum(["fact", "opinion"]),
  sourceIds: z.array(z.string()),
  unverified: z.boolean().optional(),
});

// A fixed-length pair is an array with a length constraint. Tuple schemas
// serialize to an array-form `items`, which DeepSeek's function-calling
// validator rejects before the first model request.
const CostPair = z.array(z.number()).length(2);

const DayBlockSchema = z.object({
  time: z.string(),
  title: z.string(),
  detail: z.string(),
  claims: z.array(ClaimSchema),
  costCny: CostPair.optional(),
});

export const emitDayShape = {
  dayIndex: z.number().describe("1-based day number"),
  date: z.string().describe("Date of this day as YYYY-MM-DD"),
  title: z.string(),
  blocks: z.array(DayBlockSchema),
  scenery: z.array(ClaimSchema),
  food: z.array(ClaimSchema),
  transport: z.array(ClaimSchema),
  estimatedCostCny: CostPair,
  sources: z.array(z.string()).describe("Source ids used by this day"),
};

type EmitDayBlockArgs = {
  time: string;
  title: string;
  detail: string;
  claims: Claim[];
  costCny?: number[];
};

export type EmitDayArgs = {
  dayIndex: number;
  date: string;
  title: string;
  blocks: EmitDayBlockArgs[];
  scenery: Claim[];
  food: Claim[];
  transport: Claim[];
  estimatedCostCny: number[];
  sources: string[];
};

function toPair(value: number[], label: string): [number, number] {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    !value.every((part) => typeof part === "number" && Number.isFinite(part))
  ) {
    throw new Error(`${label} must be an array of exactly two numbers`);
  }
  return [value[0], value[1]];
}

function contentOf(day: DayCard): string {
  return JSON.stringify({
    date: day.date,
    title: day.title,
    blocks: day.blocks,
    scenery: day.scenery,
    food: day.food,
    transport: day.transport,
    estimatedCostCny: day.estimatedCostCny,
    sources: day.sources,
  });
}

/**
 * Applies one emitted day to a plan. Re-emitting unchanged content keeps the
 * existing SVG; changed content invalidates it (status `pending`) so a stale
 * sketch is never shown, and only the targeted day is replaced.
 */
export function applyDayEmit(plan: TripPlan, args: EmitDayArgs, now: Date): TripPlan {
  const blocks: DayBlock[] = args.blocks.map((block, index) => ({
    time: block.time,
    title: block.title,
    detail: block.detail,
    claims: block.claims,
    ...(block.costCny === undefined
      ? {}
      : { costCny: toPair(block.costCny, `blocks[${index}].costCny`) }),
  }));

  const candidate: DayCard = {
    dayIndex: args.dayIndex,
    date: args.date,
    title: args.title,
    blocks,
    scenery: args.scenery,
    food: args.food,
    transport: args.transport,
    estimatedCostCny: toPair(args.estimatedCostCny, "estimatedCostCny"),
    sources: args.sources,
    svgStatus: "pending",
    updatedAt: now.toISOString(),
  };

  const existing = plan.days.find((day) => day.dayIndex === args.dayIndex);
  if (existing !== undefined && contentOf(existing) === contentOf(candidate)) {
    candidate.svgStatus = existing.svgStatus;
    if (existing.svg !== undefined) candidate.svg = existing.svg;
  }

  return upsertDayCard(plan, candidate);
}

export function createEmitDayTool(ctx: ToolContext) {
  return tool(
    "plan_emit_day",
    "Write or replace one day card in the durable trip plan.",
    emitDayShape,
    (args) =>
      guarded(() => {
        const now = ctx.deps.now();
        ctx.store.transaction(() => {
          const brief = ctx.store.getDoc(ctx.tripId, "brief");
          if (!isBriefComplete(brief)) {
            throw new Error(
              `Cannot emit day ${args.dayIndex}: trip brief is incomplete (missing ${missingBriefFields(brief).join(", ")})`,
            );
          }

          const sources = ctx.store.getDoc(ctx.tripId, "sources");
          const plan = ctx.store.getDoc(ctx.tripId, "plan");
          const next = applyDayEmit(plan, args, now);
          const card = next.days.find((day) => day.dayIndex === args.dayIndex)!;
          const errors = validateDayCard(card, sources, brief);
          if (errors.length > 0) {
            throw new Error(`Cannot emit day ${args.dayIndex}: ${errors.join("; ")}`);
          }

          ctx.store.setDoc(ctx.tripId, "plan", next);
        });
        return textResult(`Day ${args.dayIndex} written.`);
      }),
  );
}

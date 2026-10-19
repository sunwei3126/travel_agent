import { defineTool } from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";
import { isBriefComplete, missingBriefFields } from "@pi-demo/shared";
import type { Claim, DayBlock, DayCard, TripPlan } from "@pi-demo/shared";
import { TripBriefDoc, TripPlanDoc, TripSourcesDoc, upsertDayCard } from "../../trips/docs";
import { validateDayCard } from "../../plan/validate";
import type { TravelDeps } from "../deps";

const ClaimSchema = Type.Object({
  text: Type.String(),
  kind: Type.Union([Type.Literal("fact"), Type.Literal("opinion")]),
  sourceIds: Type.Array(Type.String()),
  unverified: Type.Optional(Type.Boolean()),
});

// A fixed-length pair is expressed as an array with object `items`. Tuple
// schemas serialize to an array-form `items`, which DeepSeek's function-calling
// validator rejects before the first model request.
const CostPair = Type.Array(Type.Number(), { minItems: 2, maxItems: 2 });

const DayBlock = Type.Object({
  time: Type.String(),
  title: Type.String(),
  detail: Type.String(),
  claims: Type.Array(ClaimSchema),
  costCny: Type.Optional(CostPair),
});

const parameters = Type.Object({
  dayIndex: Type.Number({ description: "1-based day number" }),
  date: Type.String({ description: "Date of this day as YYYY-MM-DD" }),
  title: Type.String(),
  blocks: Type.Array(DayBlock),
  scenery: Type.Array(ClaimSchema),
  food: Type.Array(ClaimSchema),
  transport: Type.Array(ClaimSchema),
  estimatedCostCny: CostPair,
  sources: Type.Array(Type.String(), { description: "Source ids used by this day" }),
});

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

export function createEmitDayTool(deps: TravelDeps) {
  return defineTool({
    name: "plan_emit_day",
    description: "Write or replace one day card in the durable trip plan.",
    parameters,
    replay: "safe",
    execute: async (args, api, context) => {
      const now = deps.now();
      await api.commit(async (tx) => {
        const brief = await tx.doc(TripBriefDoc, api.conversationId);
        if (!isBriefComplete(brief)) {
          throw new Error(
            `Cannot emit day ${args.dayIndex}: trip brief is incomplete (missing ${missingBriefFields(brief).join(", ")})`,
          );
        }

        const sources = await tx.doc(TripSourcesDoc, api.conversationId);
        const plan = await tx.doc(TripPlanDoc, api.conversationId);
        const next = applyDayEmit(plan, args, now);
        const card = next.days.find((day) => day.dayIndex === args.dayIndex)!;
        const errors = validateDayCard(card, sources, brief);
        if (errors.length > 0) {
          throw new Error(`Cannot emit day ${args.dayIndex}: ${errors.join("; ")}`);
        }

        plan.days = next.days;
      }, context);

      return { output: [{ type: "text", text: `Day ${args.dayIndex} written.` }] };
    },
  });
}

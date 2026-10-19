import { defineTool } from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";
import { isBriefComplete, missingBriefFields } from "@pi-demo/shared";
import type { DayCard } from "@pi-demo/shared";
import { TripBriefDoc, TripSourcesDoc, TripPlanDoc, upsertDayCard } from "../../trips/docs";
import { validateDayCard } from "../../plan/validate";
import type { TravelDeps } from "../deps";

const Claim = Type.Object({
  text: Type.String(),
  kind: Type.Union([Type.Literal("fact"), Type.Literal("opinion")]),
  sourceIds: Type.Array(Type.String()),
  unverified: Type.Optional(Type.Boolean()),
});

const DayBlock = Type.Object({
  time: Type.String(),
  title: Type.String(),
  detail: Type.String(),
  claims: Type.Array(Claim),
  costCny: Type.Optional(Type.Tuple([Type.Number(), Type.Number()])),
});

const parameters = Type.Object({
  dayIndex: Type.Number({ description: "1-based day number" }),
  date: Type.String({ description: "Date of this day as YYYY-MM-DD" }),
  title: Type.String(),
  blocks: Type.Array(DayBlock),
  scenery: Type.Array(Claim),
  food: Type.Array(Claim),
  transport: Type.Array(Claim),
  estimatedCostCny: Type.Tuple([Type.Number(), Type.Number()]),
  sources: Type.Array(Type.String(), { description: "Source ids used by this day" }),
});

export function createEmitDayTool(deps: TravelDeps) {
  return defineTool({
    name: "plan_emit_day",
    description: "Write or replace one day card in the durable trip plan.",
    parameters,
    replay: "safe",
    execute: async (args, api, context) => {
      await api.commit(async (tx) => {
        const brief = await tx.doc(TripBriefDoc, api.conversationId);
        if (!isBriefComplete(brief)) {
          throw new Error(
            `Cannot emit day ${args.dayIndex}: trip brief is incomplete (missing ${missingBriefFields(brief).join(", ")})`,
          );
        }

        const sources = await tx.doc(TripSourcesDoc, api.conversationId);
        const card: DayCard = {
          ...args,
          svgStatus: "pending",
          updatedAt: deps.now().toISOString(),
        };
        const errors = validateDayCard(card, sources, brief);
        if (errors.length > 0) {
          throw new Error(`Cannot emit day ${args.dayIndex}: ${errors.join("; ")}`);
        }

        const plan = await tx.doc(TripPlanDoc, api.conversationId);
        plan.days = upsertDayCard(plan, card).days;
      }, context);

      return { output: [{ type: "text", text: `Day ${args.dayIndex} written.` }] };
    },
  });
}

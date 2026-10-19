import { Type, type Static } from "@sinclair/typebox";

export const FitnessSchema = Type.Union([
  Type.Literal("low"),
  Type.Literal("average"),
  Type.Literal("high"),
]);

export const TripBriefSchema = Type.Object({
  destination: Type.Optional(Type.String()),
  origin: Type.Optional(Type.String()),
  startDate: Type.Optional(Type.String()),
  days: Type.Optional(Type.Number()),
  budgetCny: Type.Optional(Type.Number()),
  companions: Type.Optional(Type.String()),
  fitness: Type.Optional(FitnessSchema),
  interests: Type.Optional(Type.Array(Type.String())),
  constraints: Type.Optional(Type.Array(Type.String())),
  assumptions: Type.Optional(Type.Array(Type.String())),
});
export type TripBrief = Static<typeof TripBriefSchema>;

export const ClaimSchema = Type.Object({
  text: Type.String(),
  kind: Type.Union([Type.Literal("fact"), Type.Literal("opinion")]),
  sourceIds: Type.Array(Type.String()),
  unverified: Type.Optional(Type.Boolean()),
});
export type Claim = Static<typeof ClaimSchema>;

export const DayBlockSchema = Type.Object({
  time: Type.String(),
  title: Type.String(),
  detail: Type.String(),
  claims: Type.Array(ClaimSchema),
  costCny: Type.Optional(Type.Tuple([Type.Number(), Type.Number()])),
});
export type DayBlock = Static<typeof DayBlockSchema>;

export const DayCardSchema = Type.Object({
  dayIndex: Type.Number(),
  date: Type.String(),
  title: Type.String(),
  blocks: Type.Array(DayBlockSchema),
  scenery: Type.Array(ClaimSchema),
  food: Type.Array(ClaimSchema),
  transport: Type.Array(ClaimSchema),
  estimatedCostCny: Type.Tuple([Type.Number(), Type.Number()]),
  sources: Type.Array(Type.String()),
  svg: Type.Optional(Type.String()),
  svgStatus: Type.Union([
    Type.Literal("ok"),
    Type.Literal("failed"),
    Type.Literal("pending"),
  ]),
  updatedAt: Type.String(),
});
export type DayCard = Static<typeof DayCardSchema>;

export const BudgetSummarySchema = Type.Object({
  low: Type.Number(),
  high: Type.Number(),
  cap: Type.Number(),
  withinBudget: Type.Boolean(),
});
export type BudgetSummary = Static<typeof BudgetSummarySchema>;

export const TripPlanSchema = Type.Object({
  days: Type.Array(DayCardSchema),
  summary: Type.Optional(Type.String()),
  budget: Type.Optional(BudgetSummarySchema),
});
export type TripPlan = Static<typeof TripPlanSchema>;

export type TripSource = {
  id: string;
  query: string;
  title: string;
  url: string;
  snippet: string;
  summary?: string;
  content?: string;
  date?: string;
  authority?: number;
  rerankScore?: number;
  fetchedAt?: string;
  kind: "search" | "fetch";
};

export type TripSources = Record<string, TripSource>;

export type TranscriptEntry = {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  name?: string;
};

export type TripIndexEntry = {
  tripId: string;
  conversationId: string;
  title: string;
  destination: string;
  startDate: string;
  days: number;
  updatedAt: string;
  status: "active" | "completed";
};

export type TripResearch = { searchCount: number; fetchCount: number };

export type TripState = {
  brief: TripBrief;
  plan: TripPlan;
  sources: TripSources;
  research: TripResearch & { running: boolean };
};

export type TripSnapshot = {
  trip: TripIndexEntry;
  brief: TripBrief;
  plan: TripPlan;
  sources: TripSources;
  research: TripResearch;
  running: boolean;
};

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const isFitness = (value: unknown): value is TripBrief["fitness"] =>
  value === "low" || value === "average" || value === "high";

const requiredFieldChecks: Array<{
  field: string;
  isPresent: (brief: TripBrief) => boolean;
}> = [
  { field: "destination", isPresent: (b) => isNonEmptyString(b.destination) },
  { field: "origin", isPresent: (b) => isNonEmptyString(b.origin) },
  {
    field: "startDate",
    isPresent: (b) =>
      typeof b.startDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(b.startDate),
  },
  {
    field: "days",
    isPresent: (b) => typeof b.days === "number" && Number.isFinite(b.days) && b.days >= 1,
  },
  {
    field: "budgetCny",
    isPresent: (b) =>
      typeof b.budgetCny === "number" && Number.isFinite(b.budgetCny) && b.budgetCny > 0,
  },
  { field: "companions", isPresent: (b) => isNonEmptyString(b.companions) },
  { field: "fitness", isPresent: (b) => isFitness(b.fitness) },
  {
    field: "interests",
    isPresent: (b) => Array.isArray(b.interests) && b.interests.length > 0,
  },
];

export function missingBriefFields(brief: TripBrief): string[] {
  return requiredFieldChecks
    .filter(({ isPresent }) => !isPresent(brief))
    .map(({ field }) => field);
}

export function isBriefComplete(brief: TripBrief): boolean {
  return missingBriefFields(brief).length === 0;
}

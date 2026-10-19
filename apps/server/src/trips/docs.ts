import { defineDoc } from "@earendil-works/pi-durable";
import type { DayCard, TripBrief, TripPlan, TripResearch, TripSources } from "@pi-demo/shared";

const conversationDoc = {
  scope: "conversation",
  history: "latest",
  fork: "initial",
} as const;

export const TripBriefDoc = defineDoc<TripBrief>({
  ...conversationDoc,
  kind: "trip.brief",
  version: 1,
  initial: () => ({}),
});

export const TripPlanDoc = defineDoc<TripPlan>({
  ...conversationDoc,
  kind: "trip.plan",
  version: 1,
  initial: () => ({ days: [] }),
});

export const TripSourcesDoc = defineDoc<TripSources>({
  ...conversationDoc,
  kind: "trip.sources",
  version: 1,
  initial: () => ({}),
});

export const TripResearchDoc = defineDoc<TripResearch>({
  ...conversationDoc,
  kind: "trip.research",
  version: 1,
  initial: () => ({ searchCount: 0, fetchCount: 0 }),
});

export function mergeBrief(current: TripBrief, patch: Partial<TripBrief>): TripBrief {
  return { ...current, ...patch };
}

export function upsertDayCard(plan: TripPlan, card: DayCard): TripPlan {
  const index = plan.days.findIndex((day) => day.dayIndex === card.dayIndex);
  const days = [...plan.days];
  if (index === -1) {
    days.push(card);
  } else {
    days[index] = card;
  }
  return { ...plan, days };
}

import type { DayCard, TripBrief, TripPlan } from "@pi-demo/shared";

export type SearchCacheEntry = {
  sourceIds: string[];
  at: string;
};

/** Normalized search key -> ids already returned for that query and options. */
export type SearchCache = Record<string, SearchCacheEntry>;

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

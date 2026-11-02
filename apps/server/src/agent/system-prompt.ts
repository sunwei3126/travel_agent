import type { TripStore } from "../store/trip-store";
import { PLANNER_INSTRUCTIONS } from "./prompts";
import { renderTripContext } from "./section";

/** Planner instructions plus a compact view of the trip's current state, rebuilt at every run start. */
export function buildSystemPrompt(store: TripStore, tripId: string, now: Date): string {
  const context = renderTripContext(
    {
      brief: store.getDoc(tripId, "brief"),
      plan: store.getDoc(tripId, "plan"),
      sources: store.getDoc(tripId, "sources"),
    },
    now,
  );
  return context === undefined
    ? PLANNER_INSTRUCTIONS
    : `${PLANNER_INSTRUCTIONS}\n\n## Current trip state\n${context}`;
}

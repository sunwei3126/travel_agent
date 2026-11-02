import type { DayCard } from "@pi-demo/shared";
import type { DeepSeekClient } from "../deepseek/client";
import type { TripStore } from "../store/trip-store";

export type SketchResult = {
  svg: string;
  status: "ok" | "failed";
  error?: string;
};

export type TravelDeps = {
  now: () => Date;
  deepseek: DeepSeekClient;
  generateSketch: (day: DayCard) => Promise<SketchResult>;
  caps: { search: number; fetch: number };
};

/** What every tool needs: the trip it is bound to, the store, and shared services. */
export type ToolContext = {
  tripId: string;
  store: TripStore;
  deps: TravelDeps;
};

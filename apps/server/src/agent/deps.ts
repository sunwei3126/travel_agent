import type { DayCard } from "@pi-demo/shared";
import type { DeepSeekClient } from "../deepseek/client";

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

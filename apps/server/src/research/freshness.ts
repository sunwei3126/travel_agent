import type { TripSource } from "@pi-demo/shared";

export type Freshness = "fresh" | "stale" | "unknown";

const FRESH_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

export function freshnessOf(source: TripSource, now: Date): Freshness {
  if (!source.date) return "unknown";
  const date = new Date(source.date);
  if (Number.isNaN(date.getTime())) return "unknown";
  return Math.abs(now.getTime() - date.getTime()) <= FRESH_WINDOW_MS
    ? "fresh"
    : "stale";
}

export function isVerifiedFact(source: TripSource): boolean {
  return source.fetchedAt !== undefined;
}

const freshnessRank = (freshness: Freshness): number => {
  if (freshness === "fresh") return 0;
  if (freshness === "unknown") return 1;
  return 2;
};

const scoreOf = (source: TripSource): number =>
  (source.authority ?? 0) * 10 + (source.rerankScore ?? 0);

export function rankSources(sources: TripSource[]): TripSource[] {
  const now = new Date();
  return [...sources].sort((a, b) => {
    const byFreshness =
      freshnessRank(freshnessOf(a, now)) - freshnessRank(freshnessOf(b, now));
    return byFreshness !== 0 ? byFreshness : scoreOf(b) - scoreOf(a);
  });
}

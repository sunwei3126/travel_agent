import type { TripSource, TripSources } from "@pi-demo/shared";
import { freshnessOf, isVerifiedFact, rankSources } from "./freshness";

/** Bounds for the model-visible research channel. Full data stays in `trip.sources`. */
export const MAX_SNIPPET_CHARS = 300;
export const MAX_CONTENT_CHARS = 4000;

function truncate(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max)}…[truncated]`;
}

function sourceLines(source: TripSource, now: Date): string[] {
  const freshness = freshnessOf(source, now);
  return [
    `[${source.id}] ${source.title || "(untitled)"}`,
    `  url: ${source.url}`,
    `  date: ${source.date ?? "unknown"} (${freshness}); authority: ${
      source.authority ?? "unknown"
    }; fetched: ${isVerifiedFact(source) ? "yes" : "no"}`,
    `  snippet: ${truncate(source.snippet, MAX_SNIPPET_CHARS) || "(none)"}`,
  ];
}

/**
 * Model-visible search results: ids, titles, URLs, dates, authority, freshness,
 * and snippets, ordered by freshness and authority. The model needs these to
 * choose what to fetch and to cite valid ids.
 */
export function formatSearchResults(
  query: string,
  sourceIds: string[],
  sources: TripSources,
  now: Date,
): string {
  const unique = [...new Set(sourceIds)];
  if (unique.length === 0) {
    return [
      `Found 0 sources for "${query}".`,
      "Do not plan from memory; try a different query or tell the user what is missing.",
    ].join("\n");
  }

  const ranked = rankSources(
    unique
      .map((id) => sources[id])
      .filter((source): source is TripSource => source !== undefined),
    now,
  );
  const lines = [
    `Found ${unique.length} source(s) for "${query}", ranked by freshness and authority.`,
    "Cite the bracketed ids; snippets are leads, so fetch a page before using a hard fact.",
  ];
  for (const source of ranked) lines.push(...sourceLines(source, now));
  return lines.join("\n");
}

/** Model-visible fetch result: source id, metadata, and truncated page body. */
export function formatFetchResult(source: TripSource, now: Date): string {
  const freshness = freshnessOf(source, now);
  return [
    `Fetched [${source.id}] "${source.title || "(untitled)"}"`,
    `url: ${source.url}`,
    `fetchedAt: ${source.fetchedAt ?? "unknown"}; date: ${
      source.date ?? "unknown"
    } (${freshness}); authority: ${source.authority ?? "unknown"}`,
    `content (truncated to ${MAX_CONTENT_CHARS} chars):`,
    truncate(source.content ?? "", MAX_CONTENT_CHARS) || "(empty page)",
  ].join("\n");
}

import { createHash } from "node:crypto";
import type { TripSource, TripSources } from "@pi-demo/shared";
import type { FetchResult, SearchHit } from "../deepseek/client";

export function sourceIdForUrl(url: string): string {
  return createHash("sha256").update(normalizeUrl(url)).digest("hex").slice(0, 12);
}

/**
 * Normalizes a URL for cache identity: trims, lower-cases the scheme and host,
 * drops the fragment, and removes a trailing slash. Invalid URLs are returned
 * trimmed so callers can still compare exact strings.
 */
export function normalizeUrl(value: string): string {
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed);
    url.hash = "";
    const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;
    return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}${pathname}${url.search}`;
  } catch {
    return trimmed;
  }
}

/** Finds a stored source by normalized URL, regardless of how it was added. */
export function findSourceByUrl(
  sources: TripSources,
  url: string,
): TripSource | undefined {
  const normalized = normalizeUrl(url);
  return Object.values(sources).find(
    (source) => normalizeUrl(source.url) === normalized,
  );
}

const highest = (a: number | undefined, b: number | undefined): number | undefined => {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.max(a, b);
};

export function addSearchToSources(
  sources: TripSources,
  query: string,
  hits: SearchHit[],
  now: Date,
): string[] {
  return hits.map((hit) => {
    const id = sourceIdForUrl(hit.url);
    const existing = sources[id];
    if (existing) {
      existing.authority = highest(existing.authority, hit.authority);
      existing.rerankScore = highest(existing.rerankScore, hit.rerankScore);
    } else {
      sources[id] = {
        id,
        query,
        title: hit.title,
        url: hit.url,
        snippet: hit.snippet,
        ...(hit.summary !== undefined && { summary: hit.summary }),
        ...(hit.content !== undefined && { content: hit.content }),
        ...(hit.date !== undefined && { date: hit.date }),
        ...(hit.authority !== undefined && { authority: hit.authority }),
        ...(hit.rerankScore !== undefined && { rerankScore: hit.rerankScore }),
        kind: "search",
      };
    }
    return id;
  });
}

export function addFetchToSource(
  sources: TripSources,
  result: FetchResult,
  now: Date,
): string {
  const id = sourceIdForUrl(result.url);
  const fetchedAt = now.toISOString();
  const existing: TripSource | undefined = sources[id];
  if (existing) {
    existing.title = result.title;
    existing.content = result.content;
    existing.fetchedAt = fetchedAt;
    existing.kind = "fetch";
  } else {
    sources[id] = {
      id,
      query: "",
      title: result.title,
      url: result.url,
      snippet: "",
      content: result.content,
      fetchedAt,
      kind: "fetch",
    };
  }
  return id;
}

export type SourceStoreOptions = {
  read: () => Promise<TripSources>;
  commit: (mutate: (sources: TripSources) => void) => Promise<void>;
  now?: () => Date;
};

export class SourceStore {
  constructor(private readonly opts: SourceStoreOptions) {}

  async addSearch(query: string, hits: SearchHit[]): Promise<string[]> {
    let ids: string[] = [];
    await this.opts.commit((sources) => {
      ids = addSearchToSources(sources, query, hits, this.currentTime());
    });
    return ids;
  }

  async addFetch(result: FetchResult): Promise<string> {
    let id = "";
    await this.opts.commit((sources) => {
      id = addFetchToSource(sources, result, this.currentTime());
    });
    return id;
  }

  async get(id: string): Promise<TripSource | undefined> {
    return (await this.opts.read())[id];
  }

  async all(): Promise<TripSources> {
    return this.opts.read();
  }

  private currentTime(): Date {
    return this.opts.now?.() ?? new Date();
  }
}

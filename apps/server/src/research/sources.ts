import { createHash } from "node:crypto";
import type { TripSource, TripSources } from "@pi-demo/shared";
import type { FetchResult, SearchHit } from "../deepseek/client";

export function sourceIdForUrl(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 12);
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

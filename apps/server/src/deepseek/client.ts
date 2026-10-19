import { defaultSleep, RateLimiter } from "./rate-limiter";

export const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_QPS = 5;
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 500;

export type SearchOptions = {
  count?: number;
  oriQuestion?: string;
  localization?: string;
  needContent?: boolean;
};

export type SearchHit = {
  title: string;
  url: string;
  snippet: string;
  summary?: string;
  content?: string;
  date?: string;
  authority?: number;
  rerankScore?: number;
  siteName?: string;
};

export type FetchResult = {
  title: string;
  url: string;
  content: string;
};

export type DeepSeekClientOptions = {
  apiKey: string;
  baseUrl?: string;
  qps?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
};

export class DeepSeekError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "DeepSeekError";
  }
}

type RawSearchHit = {
  title: string;
  url: string;
  snippet: string;
  summary?: string;
  content?: string;
  date?: string;
  authority?: number;
  rerank_score?: number;
  site_name?: string;
};

export class DeepSeekClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly searchLimiter: RateLimiter;
  private readonly fetchLimiter: RateLimiter;

  constructor(opts: DeepSeekClientOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? defaultSleep;
    const qps = opts.qps ?? DEFAULT_QPS;
    this.searchLimiter = new RateLimiter({ qps, sleep: this.sleep });
    this.fetchLimiter = new RateLimiter({ qps, sleep: this.sleep });
  }

  async search(query: string, opts: SearchOptions = {}): Promise<SearchHit[]> {
    const data = await this.post<{ results?: RawSearchHit[] }>(
      "/v1/tools/search",
      {
        query,
        count: opts.count,
        ori_question: opts.oriQuestion,
        localization: opts.localization,
        need_content: opts.needContent,
      },
      this.searchLimiter,
    );
    return (data.results ?? []).map((hit) => ({
      title: hit.title,
      url: hit.url,
      snippet: hit.snippet,
      summary: hit.summary,
      content: hit.content,
      date: hit.date,
      authority: hit.authority,
      rerankScore: hit.rerank_score,
      siteName: hit.site_name,
    }));
  }

  async fetch(url: string): Promise<FetchResult> {
    // The live endpoint returns only `{ content }`; other deployments also send
    // title/url. Normalize both shapes so callers always get a complete result.
    const raw =
      (await this.post<{
        title?: unknown;
        url?: unknown;
        content?: unknown;
      }>("/v1/tools/fetch", { url }, this.fetchLimiter)) ?? {};

    const returnedUrl =
      typeof raw.url === "string" && raw.url.length > 0 ? raw.url : url;
    return {
      content: typeof raw.content === "string" ? raw.content : "",
      url: returnedUrl,
      title:
        typeof raw.title === "string" && raw.title.length > 0
          ? raw.title
          : returnedUrl,
    };
  }

  private async post<T>(path: string, body: unknown, limiter: RateLimiter): Promise<T> {
    const endpoint = `${this.baseUrl}${path}`;
    for (let attempt = 0; ; attempt++) {
      await limiter.acquire();
      const response = await this.fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (response.ok) return (await response.json()) as T;

      const retryable = response.status === 429 || (response.status >= 500 && response.status < 600);
      if (retryable && attempt < MAX_RETRIES) {
        await this.sleep(this.retryDelayMs(response, attempt));
        continue;
      }

      throw new DeepSeekError(response.status, await response.text());
    }
  }

  private retryDelayMs(response: Response, attempt: number): number {
    const retryAfter = response.headers.get("retry-after");
    const seconds = retryAfter === null ? Number.NaN : Number(retryAfter);
    if (Number.isFinite(seconds)) return seconds * 1000;
    return BASE_BACKOFF_MS * 2 ** attempt;
  }
}

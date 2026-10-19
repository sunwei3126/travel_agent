# 泰山旅游规划智能体 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local, durable travel-planning agent that asks for missing trip facts, researches with DeepSeek Search/Fetch, and produces Chinese day-by-day cards with model-generated SVG sketches in a CopilotKit chat.

**Architecture:** npm-workspaces monorepo. `apps/server` runs pi-durable over SQLite, exposes Fastify REST plus an AG-UI endpoint, and owns DeepSeek and model calls. `apps/web` is Next.js + CopilotKit; its per-trip runtime route forwards AG-UI to the server. `packages/shared` holds TypeBox schemas and shared types.

**Tech Stack:** Node 22.22, TypeScript ESM, pi-durable 1.3.0, pi-ai 1.3.0, Fastify, SQLite, Next.js App Router, React, CopilotKit 1.79.1, AG-UI, Vitest, React Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-19-taishan-travel-agent-design.md`

## Global Constraints

- Node.js must be `>=22.19.0`; the machine has `22.22.1`.
- Single process owns `data/pi.sqlite`; bind the server to `127.0.0.1`.
- UI copy and generated plan content are Chinese.
- Env: `DEEPSEEK_API_KEY`, `MAGPIE_BASE_URL=http://127.0.0.1:3425`, `MAGPIE_MODEL=openrouter/deepseek/deepseek-v4.1-flash-1017`, `PORT=4000`, `DATA_DIR=./data`, `AGENT_URL=http://127.0.0.1:4000/agui`.
- Never expose `DEEPSEEK_API_KEY` or any model key to the browser.
- DeepSeek: 5 QPS per endpoint; at most 40 search and 30 fetch calls per trip.
- Completed search/fetch calls are never repeated; an in-flight call may repeat once after a crash (at-most-once).
- Hard-fact claims require claim-level `sourceIds`; unverified claims are marked per claim.
- Budget pass/fail uses the sum of all day-card upper bounds.
- Only DeepSeek Search/Fetch for external data; no 12306, weather, or other APIs.
- SVG must be sanitized server-side and rendered as a data-URL `<img>` in the browser.
- Documents use `defineDoc` with `history: "latest"`; plan writes are idempotent by 1-based `dayIndex`.
- The repo is not a git repository yet; initialize it in Task 1 before the first commit.

## Review Focus

These are the five inputs most likely to break a real user, and each has a test in the owning task.

1. Empty or non-trip text (blank, "你好", a URL with no destination) — must not write a plan; the agent asks for the missing brief fields.
2. A past or impossible date (for example `2020-01-01`, or `days: 0`) — brief validation rejects it before research starts.
3. DeepSeek returns zero results or only low-authority results — the plan must state the gap and must not fabricate facts or emit unsourced hard claims.
4. The model wraps SVG in a Markdown fence or emits an XML declaration — the extractor strips the wrapper and the validator sanitizes the SVG.
5. The same user message is sent twice, or a client retries after a timeout — the second submit with the same `requestId` returns the existing submission and starts no second run.

---

### Task 1: Workspace scaffold and shared schemas

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `.gitignore`
- Create: `packages/shared/package.json`, `packages/shared/tsconfig.json`
- Create: `packages/shared/src/index.ts`, `packages/shared/src/trip.ts`
- Test: `packages/shared/src/trip.test.ts`

**Interfaces:**
- Produces: `TripBrief`, `DayCard`, `DayBlock`, `Claim`, `TripPlan`, `TripSource`, `TripSources`, `BudgetSummary`, `TripSnapshot`, `TripIndexEntry`, `TripResearch`
- Shapes:
  - `TripBrief = { destination?: string; origin?: string; startDate?: string; days?: number; budgetCny?: number; companions?: string; fitness?: "low" | "average" | "high"; interests?: string[]; constraints?: string[]; assumptions?: string[] }`
  - `Claim = { text: string; kind: "fact" | "opinion"; sourceIds: string[]; unverified?: boolean }`
  - `DayBlock = { time: string; title: string; detail: string; claims: Claim[]; costCny?: [number, number] }`
  - `DayCard = { dayIndex: number; date: string; title: string; blocks: DayBlock[]; scenery: Claim[]; food: Claim[]; transport: Claim[]; estimatedCostCny: [number, number]; sources: string[]; svg?: string; svgStatus: "ok" | "failed" | "pending"; updatedAt: string }`
  - `TripPlan = { days: DayCard[]; summary?: string; budget?: BudgetSummary }`
  - `TripSource = { id: string; query: string; title: string; url: string; snippet: string; summary?: string; content?: string; date?: string; authority?: number; rerankScore?: number; fetchedAt?: string; kind: "search" | "fetch" }`
  - `TripSources = Record<string, TripSource>`
  - `TranscriptEntry = { id: string; role: "user" | "assistant" | "tool"; content: string; name?: string }`
  - `TripIndexEntry = { tripId: string; conversationId: string; title: string; destination: string; startDate: string; days: number; updatedAt: string; status: "active" | "completed" }`
  - `TripResearch = { searchCount: number; fetchCount: number }`
  - `BudgetSummary = { low: number; high: number; cap: number; withinBudget: boolean }`
  - `TripState = { brief: TripBrief; plan: TripPlan; sources: TripSources; research: TripResearch & { running: boolean } }`
  - `TripSnapshot = { trip: TripIndexEntry; brief: TripBrief; plan: TripPlan; sources: TripSources; research: TripResearch; running: boolean }`
- Produces: `isBriefComplete(brief: TripBrief): boolean`, `missingBriefFields(brief: TripBrief): string[]`
- Produces TypeBox schemas: `TripBriefSchema`, `DayCardSchema`, `TripPlanSchema`

- [ ] **Step 1: Initialize git and the workspace root**

Run: `git init` then create the root `package.json` with `"private": true`, `"workspaces": ["apps/*", "packages/*"]`, and scripts `test`, `dev`, `acceptance:live`, `acceptance:crash`. Add `@sinclair/typebox` to `packages/shared` and use `Value.Check` from `@sinclair/typebox/value` in tests.

- [ ] **Step 2: Write the failing shared-schema test**

```ts
import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { DayCardSchema, TripBriefSchema, isBriefComplete, missingBriefFields } from "./index";

const brief = {
  destination: "泰山", origin: "上海虹桥", startDate: "2026-10-26", days: 3,
  budgetCny: 3000, companions: "独自", fitness: "average" as const,
  interests: ["风景", "美食"], constraints: [], assumptions: [],
};

describe("trip schemas", () => {
  it("accepts the Tai Shan brief and reports it complete", () => {
    expect(Value.Check(TripBriefSchema, brief)).toBe(true);
    expect(isBriefComplete(brief)).toBe(true);
    expect(missingBriefFields({})).toEqual([
      "destination", "origin", "startDate", "days", "budgetCny", "companions", "fitness", "interests",
    ]);
  });
  it("accepts a 30-day card and rejects a card without cost", () => {
    const card = {
      dayIndex: 30, date: "2026-11-24", title: "第 30 天", blocks: [],
      scenery: [], food: [], transport: [], estimatedCostCny: [100, 200],
      sources: [], svgStatus: "pending" as const, updatedAt: "2026-10-19T00:00:00.000Z",
    };
    expect(Value.Check(DayCardSchema, card)).toBe(true);
    expect(Value.Check(DayCardSchema, { ...card, estimatedCostCny: undefined })).toBe(false);
  });
});
```

- [ ] **Step 3: Run the test and verify it fails**

Run: `npm test -w @pi-demo/shared`
Expected: FAIL because `./index` exports are missing.

- [ ] **Step 4: Implement the schemas and helpers**

`isBriefComplete` returns true only when destination and origin are non-empty strings, `startDate` matches `YYYY-MM-DD`, `days >= 1`, `budgetCny > 0`, companions is non-empty, fitness is `low|average|high`, and interests has at least one item. `missingBriefFields` returns the field names in the order shown in the test.

- [ ] **Step 5: Run the test and verify it passes**

Run: `npm test -w @pi-demo/shared`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json tsconfig.base.json .gitignore packages/shared
git commit -m "chore: scaffold workspace and shared trip schemas"
```

---

### Task 2: Trip index store

**Files:**
- Create: `apps/server/package.json`, `apps/server/tsconfig.json`, `apps/server/vitest.config.ts`
- Create: `apps/server/src/trips/index-store.ts`
- Test: `apps/server/src/trips/index-store.test.ts`

**Interfaces:**
- Consumes: `TripIndexEntry` from `@pi-demo/shared`
- Produces: `class TripIndexStore { constructor(filePath: string); list(): Promise<TripIndexEntry[]>; get(tripId: string): Promise<TripIndexEntry | undefined>; upsert(entry: TripIndexEntry): Promise<void> }`
- `list()` sorts by `updatedAt` descending.

- [ ] **Step 1: Write the failing test**

```ts
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TripIndexStore } from "./index-store";

it("persists, sorts, and reads back trips atomically", async () => {
  const dir = await mkdtemp(join(tmpdir(), "trips-"));
  const store = new TripIndexStore(join(dir, "trips.json"));
  await store.upsert({ tripId: "a", conversationId: "c1", title: "旧", destination: "泰山", startDate: "2026-10-26", days: 3, updatedAt: "2026-10-18T00:00:00Z", status: "active" });
  await store.upsert({ tripId: "b", conversationId: "c2", title: "新", destination: "黄山", startDate: "2026-11-01", days: 2, updatedAt: "2026-10-19T00:00:00Z", status: "active" });
  expect((await store.list()).map((t) => t.tripId)).toEqual(["b", "a"]);
  expect(await store.get("missing")).toBeUndefined();
  expect(JSON.parse(await (await import("node:fs/promises")).readFile(join(dir, "trips.json"), "utf8"))).toHaveLength(2);
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run src/trips/index-store.test.ts` in `apps/server`.
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement `TripIndexStore`**

Read the JSON file (missing file means `[]`). Write by serializing to `trips.json.tmp`, then `rename` to `trips.json`. `upsert` replaces an entry with the same `tripId`.

- [ ] **Step 4: Run the test and verify it passes**

Run: `npx vitest run src/trips/index-store.test.ts` in `apps/server`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/package.json apps/server/tsconfig.json apps/server/vitest.config.ts apps/server/src/trips
git commit -m "feat: add atomic trip index store"
```

---

### Task 3: DeepSeek Search/Fetch client

**Files:**
- Create: `apps/server/src/deepseek/client.ts`, `apps/server/src/deepseek/rate-limiter.ts`
- Test: `apps/server/src/deepseek/client.test.ts`

**Interfaces:**
- Produces: `class RateLimiter { constructor(opts: { qps: number; now?: () => number; sleep?: (ms: number) => Promise<void> }); acquire(): Promise<void> }`
- Produces: `class DeepSeekClient { constructor(opts: { apiKey: string; baseUrl?: string; qps?: number; fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> }); search(query: string, opts?: SearchOptions): Promise<SearchHit[]>; fetch(url: string): Promise<FetchResult> }`
- `SearchOptions = { count?: number; oriQuestion?: string; localization?: string; needContent?: boolean }`
- `SearchHit = { title: string; url: string; snippet: string; summary?: string; content?: string; date?: string; authority?: number; rerankScore?: number; siteName?: string }`
- `FetchResult = { title: string; url: string; content: string }`
- Default base URL: `https://api.deepseek.com`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from "vitest";
import { DeepSeekClient } from "./client";
import { RateLimiter } from "./rate-limiter";

it("posts a search with bearer auth and maps results", async () => {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
    results: [{ title: "泰山门票", url: "https://example.com/a", snippet: "s", summary: "sum", authority: 4, rerank_score: 2.1, site_name: "官网" }],
  }), { status: 200 }));
  const client = new DeepSeekClient({ apiKey: "k", fetchImpl });
  const hits = await client.search("泰山 门票", { count: 5 });
  expect(fetchImpl).toHaveBeenCalledWith("https://api.deepseek.com/v1/tools/search", expect.objectContaining({
    method: "POST", headers: expect.objectContaining({ Authorization: "Bearer k" }),
  }));
  expect(hits[0]).toMatchObject({ title: "泰山门票", authority: 4, rerankScore: 2.1 });
});

it("returns an empty list when DeepSeek has no results", async () => {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ results: [] }), { status: 200 }));
  expect(await new DeepSeekClient({ apiKey: "k", fetchImpl }).search("不存在的地方")).toEqual([]);
});

it("retries 429 once using Retry-After", async () => {
  const sleep = vi.fn(async () => {});
  const fetchImpl = vi.fn()
    .mockResolvedValueOnce(new Response("", { status: 429, headers: { "retry-after": "1" } }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ results: [] }), { status: 200 }));
  await new DeepSeekClient({ apiKey: "k", fetchImpl, sleep, qps: 1000 }).search("q");
  expect(sleep).toHaveBeenCalledWith(1000);
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});

it("rate limits to 5 QPS", async () => {
  let now = 0;
  const sleep = vi.fn(async (ms: number) => { now += ms; });
  const limiter = new RateLimiter({ qps: 5, now: () => now, sleep });
  for (let i = 0; i < 6; i++) await limiter.acquire();
  expect(sleep).toHaveBeenCalledWith(200);
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `npx vitest run src/deepseek/client.test.ts` in `apps/server`.
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement the client and limiter**

`search` sends `{ query, count, ori_question, localization, need_content }` to `/v1/tools/search` and maps `results[]`. `fetch` sends `{ url }` to `/v1/tools/fetch` and maps `{ title, url, content }`. The client creates two limiters, one for search and one for fetch, both at `qps` (default 5). Retry 429 and 5xx up to 3 times with exponential backoff; honor `Retry-After` in seconds. Throw `DeepSeekError` with `{ status, message }` for other non-2xx responses. `RateLimiter` serializes acquisitions with a minimum interval of `1000 / qps` ms using the injected clock and sleep.

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npx vitest run src/deepseek/client.test.ts` in `apps/server`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/deepseek
git commit -m "feat: add DeepSeek Search and Fetch client"
```

---

### Task 4: Source store and freshness policy

**Files:**
- Create: `apps/server/src/research/sources.ts`, `apps/server/src/research/freshness.ts`
- Test: `apps/server/src/research/sources.test.ts`

**Interfaces:**
- Consumes: `SearchHit`, `FetchResult` from Task 3; `TripSource`, `TripSources` from shared.
- Produces: `sourceIdForUrl(url: string): string` (12-char SHA-256 prefix)
- Produces: `addSearchToSources(sources: TripSources, query: string, hits: SearchHit[], now: Date): string[]` (mutates `sources`, returns ids)
- Produces: `addFetchToSource(sources: TripSources, result: FetchResult, now: Date): string` (mutates `sources`, returns the id)
- Produces: `class SourceStore { constructor(opts: { read: () => Promise<TripSources>; commit: (mutate: (sources: TripSources) => void) => Promise<void>; now?: () => Date }); addSearch(query: string, hits: SearchHit[]): Promise<string[]>; addFetch(result: FetchResult): Promise<string>; get(id: string): Promise<TripSource | undefined>; all(): Promise<TripSources> }` (thin wrapper; tools call the pure functions inside `api.commit`)
- Produces: `freshnessOf(source: TripSource, now: Date): "fresh" | "stale" | "unknown"`
- Produces: `isVerifiedFact(source: TripSource): boolean` (`fetchedAt` is set)
- Produces: `rankSources(sources: TripSource[]): TripSource[]`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { addFetchToSource, addSearchToSources } from "./sources";
import { freshnessOf, isVerifiedFact, rankSources } from "./freshness";
import type { TripSources } from "@pi-demo/shared";

it("deduplicates by URL and enriches a search hit with fetched content", () => {
  const sources: TripSources = {};
  const ids = addSearchToSources(sources, "泰山", [{ title: "A", url: "https://a.com", snippet: "s", authority: 3 }], new Date("2026-10-19"));
  addSearchToSources(sources, "泰山", [{ title: "A2", url: "https://a.com", snippet: "s2", authority: 4 }], new Date("2026-10-19"));
  expect(Object.keys(sources)).toHaveLength(1);
  addFetchToSource(sources, { title: "A", url: "https://a.com", content: "正文" }, new Date("2026-10-19"));
  expect(sources[ids[0]].content).toBe("正文");
  expect(isVerifiedFact(sources[ids[0]])).toBe(true);
});

it("treats a 2023 source as stale and ranks official sources first", () => {
  const old: any = { id: "1", query: "q", title: "blog", url: "u1", snippet: "", date: "2023-01-01", authority: 1, kind: "search" };
  expect(freshnessOf(old, new Date("2026-10-19"))).toBe("stale");
  expect(rankSources([old, { ...old, id: "2", authority: 4 }])[0].id).toBe("2");
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run src/research/sources.test.ts` in `apps/server`.
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement the store and policy**

`addSearchToSources` creates a source per unique URL and keeps the highest `authority`/`rerankScore`. `addFetchToSource` sets `content`, `fetchedAt`, and `kind: "fetch"`. `freshnessOf` returns `unknown` without a date, `fresh` when the date is within 90 days of `now`, otherwise `stale`. `rankSources` sorts fresh before stale, then by `authority * 10 + rerankScore` descending. `SourceStore` is a thin async wrapper around the same pure functions.

- [ ] **Step 4: Run the test and verify it passes**

Run: `npx vitest run src/research/sources.test.ts` in `apps/server`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/research
git commit -m "feat: add source store and freshness policy"
```

---

### Task 5: SVG extraction, validation, sanitization, and placeholder

**Files:**
- Create: `apps/server/src/svg/validate.ts`, `apps/server/src/svg/placeholder.ts`
- Test: `apps/server/src/svg/validate.test.ts`

**Interfaces:**
- Produces: `extractSvg(raw: string): string | null` (handles ```svg fences, `<svg>` blocks, and XML declarations)
- Produces: `validateAndSanitizeSvg(raw: string): { ok: true; svg: string } | { ok: false; reason: string }`
- Produces: `placeholderSvg(title: string): string`
- Limits: max width/height 1200×800; require a `viewBox`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { extractSvg, validateAndSanitizeSvg } from "./validate";
import { placeholderSvg } from "./placeholder";

it("extracts fenced SVG and strips an XML declaration", () => {
  const raw = '```svg\n<?xml version="1.0"?><svg viewBox="0 0 100 100"><circle cx="1" cy="1" r="1"/></svg>\n```';
  expect(extractSvg(raw)).toContain("<svg");
  expect(validateAndSanitizeSvg(raw).ok).toBe(true);
});

it("removes scripts, event handlers, and external references", () => {
  const raw = '<svg viewBox="0 0 100 100" onload="alert(1)" xmlns:xlink="http://www.w3.org/1999/xlink"><script>alert(1)</script><image href="https://evil.test/a.png"/><use xlink:href="#ok"/></svg>';
  const result = validateAndSanitizeSvg(raw);
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.svg).not.toContain("<script");
    expect(result.svg).not.toContain("onload");
    expect(result.svg).not.toContain("https://evil.test");
    expect(result.svg).toContain("#ok");
  }
});

it("rejects missing viewBox, oversized SVG, and malformed XML", () => {
  expect(validateAndSanitizeSvg("<svg width='100' height='100'></svg>").ok).toBe(false);
  expect(validateAndSanitizeSvg('<svg viewBox="0 0 2000 100"></svg>').ok).toBe(false);
  expect(validateAndSanitizeSvg("<svg viewBox='0 0 10 10'>").ok).toBe(false);
});

it("placeholder includes the escaped day title", () => {
  expect(placeholderSvg("Day 1 <山>")).toContain("Day 1 &lt;山&gt;");
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run src/svg/validate.test.ts` in `apps/server`.
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement**

Use `@xmldom/xmldom` to parse. Reject non-`svg` roots and missing `viewBox`. Walk elements and remove `script`, `foreignObject`, `iframe`, `object`, `embed`; remove attributes whose names start with `on`; remove `href`/`xlink:href` unless the value starts with `#`; remove `<image>` with an external href; remove `style` values containing `url(http`. Parse `width`/`height` when present and reject values above the limits; the viewBox width/height are also checked.

- [ ] **Step 4: Run the test and verify it passes**

Run: `npx vitest run src/svg/validate.test.ts` in `apps/server`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/svg
git commit -m "feat: add SVG extraction, sanitization, and placeholder"
```

---

### Task 6: Sketch generator with retry and fallback

**Files:**
- Create: `apps/server/src/svg/generate.ts`
- Test: `apps/server/src/svg/generate.test.ts`

**Interfaces:**
- Consumes: `DayCard` from shared; `validateAndSanitizeSvg`, `placeholderSvg`.
- Produces: `generateDaySketch(opts: { day: DayCard; generate: (prompt: string) => Promise<string> }): Promise<{ svg: string; status: "ok" | "failed"; error?: string }>`
- The prompt names the day title and up to five block titles, and requires SVG only.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from "vitest";
import { generateDaySketch } from "./generate";

const day = { dayIndex: 1, date: "2026-10-26", title: "抵达与老城", blocks: [{ time: "14:00", title: "岱庙", detail: "", claims: [] }], scenery: [], food: [], transport: [], estimatedCostCny: [0, 0], sources: [], svgStatus: "pending", updatedAt: "" } as any;

it("retries once when the first SVG is invalid", async () => {
  const generate = vi.fn()
    .mockResolvedValueOnce("not svg")
    .mockResolvedValueOnce('<svg viewBox="0 0 100 100"><rect width="10" height="10"/></svg>');
  const result = await generateDaySketch({ day, generate });
  expect(result.status).toBe("ok");
  expect(generate).toHaveBeenCalledTimes(2);
  expect(generate.mock.calls[1][0]).toContain("not svg");
});

it("falls back to a placeholder after two failures", async () => {
  const result = await generateDaySketch({ day, generate: async () => "still not svg" });
  expect(result.status).toBe("failed");
  expect(result.svg).toContain("Day 1");
  expect(result.error).toBeTruthy();
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run src/svg/generate.test.ts` in `apps/server`.
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement**

Build the prompt with `day.title` and `day.blocks.map(b => b.title)`. Call `generate`; run `validateAndSanitizeSvg`; on failure call `generate` again with the prompt plus the validation reason; on the second failure return `placeholderSvg(`Day ${day.dayIndex} · ${day.title}`)` with `status: "failed"`.

- [ ] **Step 4: Run the test and verify it passes**

Run: `npx vitest run src/svg/generate.test.ts` in `apps/server`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/svg/generate.ts apps/server/src/svg/generate.test.ts
git commit -m "feat: add SVG sketch generation with retry and fallback"
```

---

### Task 7: Magpie provider and model configuration

**Files:**
- Create: `apps/server/src/model/magpie.ts`
- Test: `apps/server/src/model/magpie.test.ts`

**Interfaces:**
- Consumes: pi-ai `createModels`, `createProvider`, `anthropicMessagesApi`.
- Produces: `createMagpieModels(env?: NodeJS.ProcessEnv): Models`
- Produces: `resolveMagpieModel(models: Models, env?: NodeJS.ProcessEnv): Model`
- Defaults: base URL `http://127.0.0.1:3425`, model `openrouter/deepseek/deepseek-v4.1-flash-1017`, context window `1048576`, max output `393216`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { createMagpieModels, resolveMagpieModel } from "./magpie";

it("registers the magpie Anthropic-compatible provider", () => {
  const models = createMagpieModels({});
  const model = resolveMagpieModel(models, {});
  expect(model.provider).toBe("magpie");
  expect(model.api).toBe("anthropic-messages");
  expect(model.baseUrl).toBe("http://127.0.0.1:3425");
  expect(model.id).toBe("openrouter/deepseek/deepseek-v4.1-flash-1017");
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run src/model/magpie.test.ts` in `apps/server`.
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement**

Create a provider with `id: "magpie"`, an auth resolver that returns `{ auth: {} }`, one model entry carrying `headers: { "x-api-key": "magpie" }` (pi-ai 1.3.0 needs a non-empty request credential), and `api: anthropicMessagesApi()` imported from `@earendil-works/pi-ai/api/anthropic-messages.lazy`. Read `MAGPIE_BASE_URL` and `MAGPIE_MODEL` overrides. Add a skipped live test gated by `MAGPIE_LIVE=1` that calls `completeSimple` with "回复 OK".

- [ ] **Step 4: Run the test and verify it passes**

Run: `npx vitest run src/model/magpie.test.ts` in `apps/server`.
Expected: PASS; the live test is skipped.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/model
git commit -m "feat: add magpie Anthropic Messages provider"
```

---

### Task 8: Trip documents, brief validation, day-card validation, and budget

**Files:**
- Create: `apps/server/src/trips/docs.ts`, `apps/server/src/plan/validate.ts`, `apps/server/src/plan/budget.ts`
- Test: `apps/server/src/plan/validate.test.ts`, `apps/server/src/plan/budget.test.ts`

**Interfaces:**
- Produces: `TripBriefDoc`, `TripPlanDoc`, `TripSourcesDoc`, `TripResearchDoc` from `defineDoc`.
- Produces: `mergeBrief(current: TripBrief, patch: Partial<TripBrief>): TripBrief`
- Produces: `upsertDayCard(plan: TripPlan, card: DayCard): TripPlan` (replaces by `dayIndex`)
- Produces: `validateBrief(brief: TripBrief, now: Date): string[]` (includes past-date and `days < 1`)
- Produces: `validateDayCard(card: DayCard, sources: TripSources, brief: TripBrief): string[]`
- Produces: `finalizeBudget(plan: TripPlan, cap: number): BudgetSummary`
- `BudgetSummary = { low: number; high: number; cap: number; withinBudget: boolean }`

- [ ] **Step 1: Write the failing validation test**

```ts
import { describe, expect, it } from "vitest";
import { validateBrief, validateDayCard } from "./validate";

const brief = { destination: "泰山", origin: "上海虹桥", startDate: "2026-10-26", days: 3, budgetCny: 3000, companions: "独自", fitness: "average", interests: ["风景"], constraints: [], assumptions: [] } as any;
const sources = { s1: { id: "s1", query: "q", title: "t", url: "u", snippet: "", kind: "fetch", fetchedAt: "2026-10-19" } } as any;

it("rejects a past date and a zero-day trip", () => {
  expect(validateBrief({ ...brief, startDate: "2020-01-01" }, new Date("2026-10-19"))).toContain("startDate must not be in the past");
  expect(validateBrief({ ...brief, days: 0 }, new Date("2026-10-19"))).toContain("days must be at least 1");
});

it("requires claim-level sources for hard facts and allows unverified claims", () => {
  const fact = { text: "门票 115 元", kind: "fact", sourceIds: ["missing"] };
  const card = { dayIndex: 1, date: "2026-10-26", title: "D1", blocks: [{ time: "09:00", title: "红门", detail: "", claims: [fact] }], scenery: [], food: [], transport: [], estimatedCostCny: [100, 200], sources: [], svgStatus: "pending", updatedAt: "" } as any;
  expect(validateDayCard(card, sources, brief)).toContain("claim references unknown source: missing");
  const unverified = { ...fact, sourceIds: [], unverified: true };
  expect(validateDayCard({ ...card, blocks: [{ ...card.blocks[0], claims: [unverified] }] }, sources, brief)).toEqual([]);
});

it("refuses a day card while the brief is incomplete", () => {
  const card = { dayIndex: 1, date: "2026-10-26", title: "D1", blocks: [], scenery: [], food: [], transport: [], estimatedCostCny: [0, 0], sources: [], svgStatus: "pending", updatedAt: "" } as any;
  expect(validateDayCard(card, sources, {})).toContain("brief is incomplete");
});
```

- [ ] **Step 2: Write the failing budget test**

```ts
import { expect, it } from "vitest";
import { finalizeBudget } from "./budget";

it("sums upper bounds and compares with the cap", () => {
  const plan = { days: [
    { estimatedCostCny: [100, 1200] }, { estimatedCostCny: [200, 1300] }, { estimatedCostCny: [300, 600] },
  ] } as any;
  expect(finalizeBudget(plan, 3000)).toEqual({ low: 600, high: 3100, cap: 3000, withinBudget: false });
});
```

- [ ] **Step 3: Run both tests and verify they fail**

Run: `npx vitest run src/plan` in `apps/server`.
Expected: FAIL.

- [ ] **Step 4: Implement**

`validateDayCard` first pushes `brief is incomplete` when `!isBriefComplete(brief)`, then checks `dayIndex >= 1`, a non-empty date, non-negative costs with `low <= high`, and every claim whose `kind === "fact"` and is not `unverified` has at least one source id that exists. `finalizeBudget` sums all day-card low and high bounds and sets `withinBudget = high <= cap`.

- [ ] **Step 5: Run both tests and verify they pass**

Run: `npx vitest run src/plan` in `apps/server`.
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/trips/docs.ts apps/server/src/plan
git commit -m "feat: add trip docs and plan validation"
```

---

### Task 9a: Brief, day-card, and finalize tools

**Files:**
- Create: `apps/server/src/agent/tools/update-brief.ts`, `emit-day.ts`, `finalize.ts`
- Create: `apps/server/src/agent/extension.ts`
- Test: `apps/server/src/agent/tools.test.ts`

**Interfaces:**
- Produces tool names: `trip_update_brief`, `plan_emit_day`, `plan_finalize`.
- Produces: `createTravelExtension(deps: TravelDeps): Extension` where `TravelDeps = { now: () => Date }` for this task; later tasks extend it.
- `trip_update_brief` merges its arguments into `TripBriefDoc` and returns `{ missing: string[] }` as `structuredOutput`.
- `plan_emit_day` refuses with an error result when `isBriefComplete` is false or `validateDayCard` returns errors; otherwise it replaces the card with the same `dayIndex`.
- `plan_finalize` writes `plan.budget` and returns `BudgetSummary`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { mergeBrief, upsertDayCard } from "../trips/docs";
import { finalizeBudget } from "../plan/budget";

const card = { dayIndex: 1, date: "2026-10-26", title: "旧", blocks: [], scenery: [], food: [], transport: [], estimatedCostCny: [100, 200], sources: [], svgStatus: "pending", updatedAt: "" } as any;

it("merges brief patches and replaces a day card by index", () => {
  expect(mergeBrief({}, { destination: "泰山" })).toMatchObject({ destination: "泰山" });
  const plan = upsertDayCard({ days: [] }, card);
  expect(plan.days).toHaveLength(1);
  const updated = upsertDayCard(plan, { ...card, title: "新" });
  expect(updated.days).toHaveLength(1);
  expect(updated.days[0].title).toBe("新");
});

it("finalizes the 3100 upper bound as over budget", () => {
  expect(finalizeBudget({ days: [{ estimatedCostCny: [100, 1200] }, { estimatedCostCny: [200, 1300] }, { estimatedCostCny: [300, 600] }] } as any, 3000).withinBudget).toBe(false);
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run src/agent/tools.test.ts` in `apps/server`.
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement the tools**

Each tool uses `api.commit(async (tx) => { const brief = await tx.doc(TripBriefDoc, api.conversationId); ... })`. `plan_emit_day` calls `validateDayCard` and throws a descriptive error on failure (pi-durable converts a throw into an error result). Mark all three tools `replay: "safe"`.

- [ ] **Step 4: Run the test and verify it passes**

Run: `npx vitest run src/agent/tools.test.ts` in `apps/server`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/agent
git commit -m "feat: add brief, day-card, and budget tools"
```

---

### Task 9b: Search, fetch, and sketch tools

**Files:**
- Create: `apps/server/src/agent/tools/search.ts`, `fetch.ts`, `sketch-day.ts`, `caps.ts`
- Modify: `apps/server/src/agent/extension.ts`
- Test: `apps/server/src/agent/research-tools.test.ts`

**Interfaces:**
- Extends `TravelDeps` with `{ deepseek: DeepSeekClient; generateSketch: (day: DayCard) => Promise<{ svg: string; status: "ok" | "failed"; error?: string }>; caps: { search: number; fetch: number } }`.
- Produces: `enforceCap(count: number, cap: number, kind: "search" | "fetch"): void` (throws when `count >= cap`).
- The tools build the source mutations inside `api.commit` with `addSearchToSources` / `addFetchToSource`.
- `deepseek_search` returns `structuredOutput: { sourceIds: string[] }`; it throws after 40 calls in one conversation.
- `deepseek_fetch` returns `structuredOutput: { sourceId: string }`; it throws after 30 calls.
- `sketch_day` calls `generateSketch`, writes `svg` and `svgStatus` into the day card, and returns `{ status }`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { enforceCap } from "./caps";

it("enforces the per-trip search and fetch caps", () => {
  expect(() => enforceCap(40, 40, "search")).toThrow("search cap reached");
  expect(() => enforceCap(39, 40, "search")).not.toThrow();
  expect(() => enforceCap(30, 30, "fetch")).toThrow("fetch cap reached");
});
```

Source writing is already covered by the pure-function tests in Task 4; the tool wiring is covered by the live acceptance in Task 16.

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run src/agent/research-tools.test.ts` in `apps/server`.
Expected: FAIL.

- [ ] **Step 3: Implement the tools**

In the same `api.commit` that writes sources, increment `TripResearchDoc.searchCount`/`fetchCount` and call `enforceCap` first. `deepseek_search` calls `addSearchToSources`; `deepseek_fetch` calls `addFetchToSource`. Mark all three `replay: "safe"`. `sketch_day` treats a failed sketch as a non-error result with `structuredOutput: { status: "failed" }`.

- [ ] **Step 4: Run the test and verify it passes**

Run: `npx vitest run src/agent/research-tools.test.ts` in `apps/server`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/agent
git commit -m "feat: add search, fetch, and sketch tools"
```

---

### Task 10: System prompt section and TravelService

**Files:**
- Create: `apps/server/src/agent/prompts.ts`, `apps/server/src/agent/section.ts`
- Create: `apps/server/src/harness/service.ts`
- Test: `apps/server/src/harness/service.test.ts`

**Interfaces:**
- Produces: `PLANNER_INSTRUCTIONS: string` (clarify-first; search/fetch before emitting; emit day cards then sketch each day; cite claims; never fabricate).
- Produces: `tripContextSection` rendering a compact `{ brief, plan summaries, source count }`.
- Produces: `TravelService.open(opts: { dataDir: string; models: Models; registry: Registry; defaultModel: Model; now?: () => Date }): Promise<TravelService>`
- `registry` must already contain `createTravelExtension(...)`; the service does not wire external dependencies.
- `TravelService.createTrip(input: { title: string; destination: string; startDate: string; days: number }): Promise<TripIndexEntry>`
- `TravelService.getSnapshot(tripId: string): Promise<TripSnapshot>`
- `TravelService.submitMessage(tripId: string, content: string, requestId: string): Promise<{ submissionId: string }>`
- `TravelService.getTranscript(tripId: string): Promise<TranscriptEntry[]>`
- `TravelService.watchEvents(tripId: string): AsyncIterable<PiEvent>` (wraps `watchEvents(harness, conversationId, context)`)
- `TravelService.close(): Promise<void>`

- [ ] **Step 1: Write the failing durability test**

```ts
import { fauxAssistantMessage, fauxProvider, fauxText, createModels } from "@earendil-works/pi-ai";
import { createRegistry } from "@earendil-works/pi-durable";

function testEnv() {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  return { faux, models, model: faux.getModel()!, registry: createRegistry() };
}

it("reopens the same SQLite and keeps the trip", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-demo-"));
  const env = testEnv();
  const service = await TravelService.open({ dataDir: dir, models: env.models, registry: env.registry, defaultModel: env.model });
  const trip = await service.createTrip({ title: "泰山", destination: "泰山", startDate: "2026-10-26", days: 3 });
  await service.close();
  const reopened = await TravelService.open({ dataDir: dir, models: env.models, registry: env.registry, defaultModel: env.model });
  expect((await reopened.getSnapshot(trip.tripId)).trip.title).toBe("泰山");
  await reopened.close();
});

it("returns the existing submission for a duplicate request id", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-demo-"));
  const env = testEnv();
  env.faux.setResponses([fauxAssistantMessage([fauxText("收到")])]);
  const service = await TravelService.open({ dataDir: dir, models: env.models, registry: env.registry, defaultModel: env.model });
  const trip = await service.createTrip({ title: "泰山", destination: "泰山", startDate: "2026-10-26", days: 3 });
  const a = await service.submitMessage(trip.tripId, "泰山三天", "r1");
  const b = await service.submitMessage(trip.tripId, "泰山三天", "r1");
  expect(b.submissionId).toBe(a.submissionId);
  await service.close();
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `npx vitest run src/harness/service.test.ts` in `apps/server`.
Expected: FAIL.

- [ ] **Step 3: Implement `TravelService`**

Open `openNodeSqliteStorage(join(dataDir, "pi.sqlite"))`, `Harness.open(storage, { models, registry })`, then `harness.resume()`. Create trips with `harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: defaultModel } })` and initialize `TripBriefDoc` with `{ destination, startDate, days }`, plus empty `TripPlanDoc`, `TripSourcesDoc`, and `TripResearchDoc` in the same commit. Persist the index entry after creation. `submitMessage` calls `conversation.submit({ type: "input", content, requestId })`. `getSnapshot` reads the docs and the index entry, and sets `running` from the conversation's busy state. `close` calls `harness.close()`.

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npx vitest run src/harness/service.test.ts` in `apps/server`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/agent/prompts.ts apps/server/src/agent/section.ts apps/server/src/harness
git commit -m "feat: add travel service with durable trips"
```

---

### Task 11: AG-UI event mapper

**Files:**
- Create: `apps/server/src/agui/mapper.ts`
- Test: `apps/server/src/agui/mapper.test.ts`

**Interfaces:**
- Consumes: `@ag-ui/core` event types.
- Produces: `buildSnapshot(snapshot: { threadId: string; runId: string; entries: TranscriptEntry[]; brief: TripBrief; plan: TripPlan; sources: TripSources; research: TripResearch; running: boolean }): AguiEvent[]` (emits `MESSAGES_SNAPSHOT` then `STATE_SNAPSHOT`).
- Produces: `createPiEventMapper(): { map(batch: PiEvent | PiEvent[]): AguiEvent[] }` with per-run state for message ids and emitted text.
- Produces: `mapPiEvents(batch: PiEvent | PiEvent[]): AguiEvent[]` as a stateless convenience (fresh mapper per call):
  - assistant text start/delta/end → `TEXT_MESSAGE_START` / `TEXT_MESSAGE_CONTENT` / `TEXT_MESSAGE_END`
  - tool start/end → `TOOL_CALL_START` / `TOOL_CALL_RESULT`
  - run terminal error → `RUN_ERROR`
- `state = { brief, plan, sources, research: { searchCount, fetchCount, running } }`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { buildSnapshot, mapPiEvents } from "./mapper";

const card = { dayIndex: 1, date: "2026-10-26", title: "D1", blocks: [], scenery: [], food: [], transport: [], estimatedCostCny: [0, 0], sources: [], svgStatus: "pending", updatedAt: "" } as any;

it("builds a messages snapshot and a state snapshot", () => {
  const events = buildSnapshot({ threadId: "t1", runId: "r1", entries: [], brief: {}, plan: { days: [card] }, sources: {}, research: { searchCount: 1, fetchCount: 0 }, running: true });
  expect(events.map((e) => e.type)).toEqual(["MESSAGES_SNAPSHOT", "STATE_SNAPSHOT"]);
  expect((events[1] as any).snapshot.plan.days).toHaveLength(1);
});

it("maps text and tool events with stable ids", () => {
  expect(mapPiEvents([{ type: "message_update", messageId: "m1", delta: "你" } as any])[0]).toMatchObject({ type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "你" });
  expect(mapPiEvents([{ type: "tool_execution_start", toolCallId: "tc1", toolName: "deepseek_search" } as any])[0]).toMatchObject({ type: "TOOL_CALL_START", toolCallId: "tc1" });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run src/agui/mapper.test.ts` in `apps/server`.
Expected: FAIL.

- [ ] **Step 3: Implement the mapper**

Use the exact AG-UI event field names from `@ag-ui/core` (`type`, `threadId`, `runId`, `messageId`, `delta`, `toolCallId`, `toolCallName`, `content`, `snapshot`). Keep message ids stable across deltas. Because pi-durable commits the first partial inside `message_start.message` and the tail inside `message_end.entry.model[0]`, the mapper must emit text from both and only the not-yet-emitted suffix at the end. Each assistant message gets a distinct id; `text_start` changes must not emit a second `TEXT_MESSAGE_START`.

- [ ] **Step 4: Run the test and verify it passes**

Run: `npx vitest run src/agui/mapper.test.ts` in `apps/server`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/agui
git commit -m "feat: map pi-durable events to AG-UI"
```

---

### Task 12: HTTP server and AG-UI endpoint

**Files:**
- Create: `apps/server/src/http/app.ts`, `apps/server/src/http/routes/trips.ts`, `apps/server/src/http/routes/agui.ts`, `apps/server/src/main.ts`
- Test: `apps/server/src/http/app.test.ts`

**Interfaces:**
- `buildServer({ service, logger? }): FastifyInstance`
- Routes:
  - `GET /health` → `{ ok: true }`
  - `GET /api/trips` → `TripIndexEntry[]`
  - `POST /api/trips` → `201 TripIndexEntry`; body `{ title, destination, startDate, days }`
  - `GET /api/trips/:tripId` → `TripSnapshot`; `404` unknown
  - `POST /api/trips/:tripId/messages` → `202 { submissionId }`; `400` empty content; duplicate `requestId` returns the same id
  - `POST /agui?tripId=...` → `text/event-stream`; extracts the last user message; uses `runId` as `requestId`; `400` empty message; `404` unknown trip

- [ ] **Step 1: Write the failing route test**

```ts
// Define `fakeService` at the top of this test file: an in-memory trip index plus a
// `watchEvents` async iterable that yields one snapshot event and then ends.
import { describe, expect, it } from "vitest";
import { buildServer } from "./app";

it("creates, lists, and rejects empty messages", async () => {
  const app = buildServer({ service: fakeService });
  const created = await app.inject({ method: "POST", url: "/api/trips", payload: { title: "泰山", destination: "泰山", startDate: "2026-10-26", days: 3 } });
  expect(created.statusCode).toBe(201);
  const id = created.json().tripId;
  const empty = await app.inject({ method: "POST", url: `/api/trips/${id}/messages`, payload: { content: "  ", requestId: "r1" } });
  expect(empty.statusCode).toBe(400);
  expect((await app.inject({ method: "GET", url: "/api/trips" })).json()).toHaveLength(1);
  expect((await app.inject({ method: "GET", url: "/api/trips/missing" })).statusCode).toBe(404);
});

it("streams an AG-UI snapshot", async () => {
  const app = buildServer({ service: fakeService });
  const res = await app.inject({ method: "POST", url: "/agui?tripId=abc", payload: { runId: "r1", messages: [{ id: "m1", role: "user", content: "泰山" }] } });
  expect(res.headers["content-type"]).toContain("text/event-stream");
  expect(res.body).toContain("STATE_SNAPSHOT");
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run src/http/app.test.ts` in `apps/server`.
Expected: FAIL.

- [ ] **Step 3: Implement the routes**

Use Fastify's `reply.raw` for SSE, with `Content-Type: text/event-stream`, `Cache-Control: no-cache`, and `Connection: keep-alive`. Write each event as `data: ${JSON.stringify(event)}\n\n`. End the stream when the service's event iterator finishes or the client disconnects.

`main.ts` wires env → `createMagpieModels`/`resolveMagpieModel` → `DeepSeekClient` → a `generate` closure using `models.completeSimple` → `generateDaySketch` → `createTravelExtension` → `createRegistry` → `TravelService.open` → `buildServer`.

The `/agui` route submits the last user message with `runId` as the request id, emits `RUN_STARTED`, emits `buildSnapshot({ entries: await service.getTranscript(tripId), ...snapshot })`, then iterates `service.watchEvents(tripId)` with one `createPiEventMapper()` per run (the initial pi-durable `snapshot` event is ignored by the mapper), and ends with `RUN_FINISHED` or `RUN_ERROR`. The route also needs `service.listTrips()` for `GET /api/trips`; add that method to `TravelService` with a focused test. Task 12's `main.ts` passes `caps: { search: 40, fetch: 30 }`, a real `DeepSeekClient`, and a `generateSketch` built from `generateDaySketch`.

- [ ] **Step 4: Run the test and verify it passes**

Run: `npx vitest run src/http/app.test.ts` in `apps/server`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/http apps/server/src/main.ts
git commit -m "feat: add Fastify REST and AG-UI endpoints"
```

---

### Task 13: Web scaffold, API client, trip list, and creation

**Files:**
- Create: `apps/web/package.json`, `apps/web/tsconfig.json`, `apps/web/next.config.ts`, `apps/web/vitest.config.ts`
- Create: `apps/web/app/layout.tsx`, `apps/web/app/page.tsx`, `apps/web/app/globals.css`
- Create: `apps/web/lib/api.ts`, `apps/web/components/TripList.tsx`, `apps/web/components/NewTripForm.tsx`
- Test: `apps/web/lib/api.test.ts`, `apps/web/components/TripList.test.tsx`, `apps/web/components/NewTripForm.test.tsx`

**Interfaces:**
- Produces: `listTrips(): Promise<TripIndexEntry[]>`, `createTrip(input): Promise<TripIndexEntry>`, `getTrip(tripId): Promise<TripSnapshot>`
- `apiFetch` prefixes `NEXT_PUBLIC_API_URL` (default `/backend`); `next.config.ts` rewrites `/backend/:path*` to `API_URL` (default `http://127.0.0.1:4000`) so the browser stays same-origin and no CORS is needed.
- `NewTripForm` fields: title, destination, startDate, days; submit navigates to `/trips/${tripId}`.

- [ ] **Step 1: Write the failing tests**

```ts
it("posts a new trip", async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({
    tripId: "t1", conversationId: "c1", title: "泰山", destination: "泰山", startDate: "2026-10-26", days: 3, updatedAt: "2026-10-19", status: "active",
  }), { status: 201 }));
  vi.stubGlobal("fetch", fetchMock);
  await createTrip({ title: "泰山", destination: "泰山", startDate: "2026-10-26", days: 3 });
  expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/trips"), expect.objectContaining({ method: "POST" }));
});
```

```tsx
it("renders a trip row", () => {
  render(<TripList trips={[{ tripId: "t1", conversationId: "c1", title: "泰山", destination: "泰山", startDate: "2026-10-26", days: 3, updatedAt: "2026-10-19T10:00:00Z", status: "active" }]} />);
  expect(screen.getByText("泰山")).toBeInTheDocument();
  expect(screen.getByText(/2026-10-26/)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `npx vitest run` in `apps/web`.
Expected: FAIL.

- [ ] **Step 3: Implement the scaffold and components**

Use `next.config.ts` with `transpilePackages: ["@pi-demo/shared"]` and a `rewrites()` entry mapping `/backend/:path*` to `process.env.API_URL ?? "http://127.0.0.1:4000"`. Use React Testing Library with `jsdom`. The home page fetches the trip list and renders `TripList` + `NewTripForm`.

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npx vitest run` in `apps/web`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "feat: add web scaffold, trip list, and creation form"
```

---

### Task 14: Per-trip CopilotKit runtime and chat page

**Files:**
- Create: `apps/web/app/api/copilotkit/[tripId]/route.ts`
- Create: `apps/web/app/trips/[tripId]/page.tsx`, `apps/web/components/TravelChat.tsx`, `apps/web/hooks/useTripSnapshot.ts`, `apps/web/lib/agent-config.ts`
- Test: `apps/web/components/TravelChat.test.tsx`, `apps/web/hooks/useTripSnapshot.test.tsx`

**Interfaces:**
- Runtime route builds `new HttpAgent({ url: `${AGENT_URL}?tripId=${tripId}` })` and exports `POST` via the CopilotKit Next.js App Router endpoint helper.
- `TravelChat` renders `<CopilotKit runtimeUrl={`/api/copilotkit/${tripId}`} agent="travel">` and a `CopilotChat` with Chinese labels.
- `useTripSnapshot(tripId)` fetches the snapshot on mount and polls every 2s while `running` is true; stops when idle.

- [ ] **Step 1: Write the failing tests**

```ts
it("builds a per-trip agent URL", () => {
  expect(createAgentConfig("abc").url).toBe("http://127.0.0.1:4000/agui?tripId=abc");
});
```

```tsx
it("polls while running and stops when idle", async () => {
  vi.useFakeTimers();
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(jsonResponse({ ...snapshot, running: true }))
    .mockResolvedValueOnce(jsonResponse({ ...snapshot, running: false }));
  vi.stubGlobal("fetch", fetchMock);
  const { result } = renderHook(() => useTripSnapshot("t1"));
  await waitFor(() => expect(result.current.snapshot?.running).toBe(true));
  await vi.advanceTimersByTimeAsync(2000);
  await waitFor(() => expect(result.current.snapshot?.running).toBe(false));
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `npx vitest run src` in `apps/web` (or the test paths).
Expected: FAIL.

- [ ] **Step 3: Implement**

Export a `createAgentConfig(tripId: string, baseUrl = process.env.AGENT_URL ?? "http://127.0.0.1:4000/agui"): { url: string }` helper for testing. The route uses it to construct `new HttpAgent(createAgentConfig(tripId))`. `CopilotChat` labels: input placeholder "说说你想去哪、玩几天、在意什么", assistant name "旅行助手".

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npx vitest run` in `apps/web`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "feat: add per-trip CopilotKit runtime and chat page"
```

---

### Task 15: Day cards, plan board, brief checklist, research progress, and budget UI

**Files:**
- Create: `apps/web/components/DayCard.tsx`, `PlanBoard.tsx`, `BriefChecklist.tsx`, `ResearchProgress.tsx`, `BudgetSummary.tsx`
- Test: `apps/web/components/DayCard.test.tsx`, `apps/web/components/PlanBoard.test.tsx`, `apps/web/components/BriefChecklist.test.tsx`

**Interfaces:**
- Produces: `svgDataUrl(svg: string): string` (UTF-8 safe, `TextEncoder` + `btoa`).
- `DayCard({ card, justUpdated? }: { card: DayCard; justUpdated?: boolean })` renders:
  - the SVG as `<img src={svgDataUrl(card.svg)} />`
  - root element has `data-testid="day-card"`
  - title, date, time blocks, scenery/food/transport claims, cost range, source chips
  - `已更新` badge when `updatedAt` changed since the previous render (prop `justUpdated?: boolean`)
  - `未核实` next to each unverified fact claim
- `PlanBoard({ plan }: { plan: TripPlan })` renders cards sorted by `dayIndex`; an update to one card does not reorder the rest.
- `BriefChecklist({ missing }: { missing: string[] })` renders one row per missing field with Chinese labels.
- `ResearchProgress({ searchCount, fetchCount, running })` renders counts and a running indicator.
- `BudgetSummary({ budget }: { budget: BudgetSummary })` shows `¥low–¥high / ¥cap` and an over-budget style when `!withinBudget`.

- [ ] **Step 1: Write the failing component tests**

```tsx
const card = { dayIndex: 1, date: "2026-10-26", title: "抵达与老城", blocks: [], scenery: [], food: [], transport: [], estimatedCostCny: [100, 200], sources: [], svg: '<svg viewBox="0 0 10 10"></svg>', svgStatus: "ok", updatedAt: "" } as any;

it("renders the title and a data-URL SVG", () => {
  render(<DayCard card={card} />);
  expect(screen.getByText("抵达与老城")).toBeInTheDocument();
  expect(screen.getByRole("img").getAttribute("src")).toMatch(/^data:image\/svg\+xml;base64,/);
});

it("marks an unverified fact claim", () => {
  render(<DayCard card={{ ...card, blocks: [{ time: "09:00", title: "红门", detail: "", claims: [{ text: "门票 115", kind: "fact", sourceIds: [], unverified: true }] }] }} />);
  expect(screen.getByText("未核实")).toBeInTheDocument();
});

it("renders 30 day cards in order", () => {
  render(<PlanBoard plan={{ days: Array.from({ length: 30 }, (_, i) => ({ ...card, dayIndex: i + 1 })) }} />);
  expect(screen.getAllByTestId("day-card")).toHaveLength(30);
});

it("shows missing brief fields and an over-budget summary", () => {
  render(<BriefChecklist missing={["destination"]} />);
  expect(screen.getByText("目的地")).toBeInTheDocument();
  render(<BudgetSummary budget={{ low: 600, high: 3100, cap: 3000, withinBudget: false }} />);
  expect(screen.getByText(/3100/)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `npx vitest run src` in `apps/web`.
Expected: FAIL.

- [ ] **Step 3: Implement the components**

Keep them presentational; no data fetching. Use Chinese labels and compact card styling. For the data-URL helper, export `svgDataUrl(svg: string): string` and test it separately with a Chinese title to prove UTF-8 encoding.

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npx vitest run` in `apps/web`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "feat: add day cards and plan status UI"
```

---

### Task 16: Wire the trip page and add acceptance scripts

**Files:**
- Modify: `apps/web/app/trips/[tripId]/page.tsx`, `apps/web/components/TravelChat.tsx`
- Create: `scripts/acceptance-live.ts`, `scripts/crash-resume.sh`, `README.md`
- Test: `apps/web/components/TripView.test.tsx`

**Interfaces:**
- `TripView` combines `TravelChat` + `PlanBoard` + `BriefChecklist` + `ResearchProgress` + `BudgetSummary` from the snapshot and the CopilotKit state.
- `scripts/acceptance-live.ts`:
  1. `POST /api/trips`
  2. Submit the Tai Shan brief
  3. Poll `GET /api/trips/:id` until `running === false` (max 15 min)
  4. Assert 3 day cards; every hard-fact claim has a non-empty `sourceIds`; a budget result; and either `svgStatus: "ok"` or a placeholder with `svgStatus: "failed"`
- `scripts/crash-resume.sh`: start the server, submit the brief, wait for the first search, `kill -9`, restart, poll until complete, and assert no completed search was repeated (server logs an incrementing `searchCount`).

- [ ] **Step 1: Write the failing `TripView` test**

```tsx
it("shows the chat, cards, missing fields, research counts, and budget", () => {
  render(<TripView tripId="t1" initial={snapshot} />);
  expect(screen.getByText("旅行助手")).toBeInTheDocument();
  expect(screen.getAllByTestId("day-card")).toHaveLength(3);
  expect(screen.getByText("目的地")).toBeInTheDocument();
  expect(screen.getByText(/搜索 12/)).toBeInTheDocument();
  expect(screen.getByText(/¥3000/)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run src` in `apps/web`.
Expected: FAIL.

- [ ] **Step 3: Implement `TripView` and the scripts**

`TripView` reads `useTripSnapshot(tripId)` for the durable snapshot and `useCoAgent<TripState>({ name: "travel" })` for live state; prefer the live state when it has a newer `updatedAt`. The `TripView` test uses a snapshot whose brief is missing `destination`, so the checklist renders `目的地`; mock `useCoAgent` to return an empty state. Add `tsx` to the root devDependencies and `dev`/`start` scripts to `apps/server/package.json` so the root `npm run dev` starts the API. The acceptance scripts use `tsx` and Node's global `fetch`.

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npx vitest run` in `apps/web`.
Expected: PASS.

- [ ] **Step 5: Run the live acceptance manually**

Run: `DEEPSEEK_API_KEY=... npm run acceptance:live` with magpie running. Expected: the Tai Shan brief yields three day cards, sources on every hard-fact claim, and a budget result. This is a live check, not a CI test.

- [ ] **Step 6: Commit**

```bash
git add apps/web scripts README.md
git commit -m "feat: wire trip view and add acceptance scripts"
```

---

## Self-Review

**Spec coverage:** Tasks cover the spec's clarify-first flow (8, 9a, 10), DeepSeek research (3, 4, 9b), claim-level citations and budget (8), SVG generation and sanitization (5, 6), durability and resume (10), AG-UI bridge (11, 12), CopilotKit UI (13–16), and the agreed non-goals. The Tai Shan acceptance scenario is Task 16.

**Review Focus coverage:** Empty/non-trip text is tested in Task 8 (`missingBriefFields({})`) and Task 12 (empty message 400). Past dates are tested in Task 8. Zero search results are tested in Task 3 and 4. Fenced/XML-wrapped SVG is tested in Task 5. Duplicate `requestId` is tested in Task 10 and Task 12.

**Type consistency:** `TripSnapshot` is used consistently in Tasks 10, 12, 13, and 16. The source helpers return source ids as `string[]`; `plan_emit_day` and `sketch_day` consume `DayCard`; `BudgetSummary` is produced by `finalizeBudget` and consumed by the UI. `DayCard.svgStatus` is `"ok" | "failed" | "pending"` throughout.

**Proportion:** The plan defines interfaces and tests, not full implementations. Bodies are left to the implementer except where the spec pins exact values (field lists, limits, event mappings).

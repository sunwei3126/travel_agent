import { randomUUID } from "node:crypto";
import type { Claim, TripSnapshot } from "@pi-demo/shared";

const API_URL = (process.env.API_URL ?? "http://127.0.0.1:4000").replace(
  /\/$/,
  "",
);
const START_DATE =
  process.env.ACCEPTANCE_START_DATE ??
  new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const BRIEF = `泰山玩三天，${START_DATE} 从上海虹桥火车站出发，自己去，预算 3000，体力一般，在意风景和美食`;
const POLL_INTERVAL_MS = 3000;
const START_TIMEOUT_MS = 60_000;
// Measured on 2026-11-03 against the local gateway: a full Tai Shan trip
// (6 searches, 13 fetches, 3 day cards, 3 sketches, one budget revision)
// took about 35 minutes end to end, so 15 minutes was not reachable.
const RUN_TIMEOUT_MS = 45 * 60 * 1000;

/**
 * Closes the run's SSE socket when the acceptance ends. Without it the drained
 * stream keeps the socket (and therefore Node) alive after a failed assertion,
 * so a timeout would hang instead of exiting.
 */
const runAbort = new AbortController();

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(30_000),
    headers: {
      "content-type": "application/json",
      ...init?.headers,
    },
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `${init?.method ?? "GET"} ${path} failed (${response.status}): ${detail}`,
    );
  }

  return (await response.json()) as T;
}

/**
 * Starts a run through the CopilotKit runtime; progress is read from the trip
 * snapshot. The SSE body is drained in the background so the socket stays open
 * for the whole run, and `signal` closes it when the acceptance ends.
 */
async function submitRun(
  tripId: string,
  content: string,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch(`${API_URL}/api/copilotkit/agent/travel/run`, {
    method: "POST",
    signal,
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify({
      threadId: tripId,
      runId: randomUUID(),
      state: {},
      tools: [],
      context: [],
      forwardedProps: {},
      messages: [{ id: randomUUID(), role: "user", content }],
    }),
  });
  if (!response.ok || response.body === null) {
    throw new Error(
      `POST /api/copilotkit/agent/travel/run failed (${response.status}): ${await response
        .text()
        .catch(() => "")}`,
    );
  }
  void response.body
    .pipeTo(new WritableStream(), { signal })
    .catch(() => {});
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function dayClaims(day: TripSnapshot["plan"]["days"][number]): Claim[] {
  return [
    ...day.blocks.flatMap((block) => block.claims),
    ...day.scenery,
    ...day.food,
    ...day.transport,
  ];
}

async function waitForServer(): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      await request("/health");
      return;
    } catch {
      await sleep(1000);
    }
  }
  throw new Error(`Server is not reachable at ${API_URL}`);
}

async function main(): Promise<void> {
  await waitForServer();

  const trip = await request<{ tripId: string }>("/api/trips", {
    method: "POST",
    body: JSON.stringify({
      title: "泰山三日游",
      destination: "泰山",
      startDate: START_DATE,
      days: 3,
    }),
  });
  const tripId = encodeURIComponent(trip.tripId);

  await submitRun(trip.tripId, BRIEF, runAbort.signal);

  const getSnapshot = (): Promise<TripSnapshot> =>
    request<TripSnapshot>(`/api/trips/${tripId}`);

  const overallDeadline = Date.now() + RUN_TIMEOUT_MS;
  const startDeadline = Math.min(
    Date.now() + START_TIMEOUT_MS,
    overallDeadline,
  );
  let snapshot = await getSnapshot();
  while (
    !snapshot.running &&
    snapshot.plan.days.length === 0 &&
    snapshot.research.searchCount === 0 &&
    Date.now() < startDeadline
  ) {
    await sleep(POLL_INTERVAL_MS);
    snapshot = await getSnapshot();
  }

  assert(
    snapshot.running ||
      snapshot.plan.days.length > 0 ||
      snapshot.research.searchCount > 0,
    `run did not start within ${START_TIMEOUT_MS / 1000}s`,
  );

  while (snapshot.running && Date.now() < overallDeadline) {
    await sleep(POLL_INTERVAL_MS);
    snapshot = await getSnapshot();
  }

  assert(
    !snapshot.running,
    `run did not finish within ${RUN_TIMEOUT_MS / 60_000} minutes`,
  );

  assert(
    snapshot.plan.days.length === 3,
    `expected 3 day cards, got ${snapshot.plan.days.length}`,
  );

  let factCount = 0;
  let verifiedFactCount = 0;
  for (const day of snapshot.plan.days) {
    assert(
      day.svgStatus === "ok" || day.svgStatus === "failed",
      `day ${day.dayIndex} has svgStatus "${day.svgStatus}"`,
    );

    for (const claim of dayClaims(day)) {
      if (claim.kind !== "fact") continue;
      factCount += 1;
      assert(
        claim.sourceIds.length > 0 || claim.unverified === true,
        `day ${day.dayIndex} fact claim is neither sourced nor unverified: ${claim.text}`,
      );
      if (
        claim.unverified !== true &&
        claim.sourceIds.some((id) => snapshot.sources[id]?.fetchedAt !== undefined)
      ) {
        verifiedFactCount += 1;
      }
    }
  }

  assert(factCount > 0, "plan contains no fact claims");
  assert(
    verifiedFactCount > 0,
    "no fact claim is backed by a fetched source; snippets alone are unverified leads",
  );
  assert(
    snapshot.research.fetchCount > 0,
    "no pages were fetched; hard facts cannot have been verified",
  );

  const budget = snapshot.plan.budget;
  assert(budget !== undefined, "plan.budget is missing");
  assert(
    budget.withinBudget === true,
    `plan is over budget: ¥${budget.high} > ¥${budget.cap}`,
  );
  assert(
    budget.high <= 3000,
    `budget upper bound ¥${budget.high} exceeds the ¥3000 acceptance cap`,
  );

  console.log(
    [
      `Trip ${trip.tripId}: ${snapshot.plan.days.length} day cards`,
      `${factCount} facts (${verifiedFactCount} verified from fetched pages)`,
      `budget ¥${budget.low}–¥${budget.high} / ¥${budget.cap}`,
      `research ${snapshot.research.searchCount} searches, ${snapshot.research.fetchCount} fetches`,
    ].join("; "),
  );
}

main()
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.exitCode = 1;
    // Flush the message, then exit hard: a lingering socket or timer must never
    // turn a failed acceptance (start timeout, run timeout) into a hang.
    process.stderr.write(`${message}\n`, () => process.exit(1));
  })
  .finally(() => {
    runAbort.abort();
  });

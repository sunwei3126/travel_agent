import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { EMPTY, Observable, Subject, type Observable as Obs } from "rxjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventType, type AbstractAgent, type BaseEvent } from "@ag-ui/client";
import type { AgentRunnerRunRequest } from "@copilotkit/runtime/v2";
import { TravelAgent } from "./agent/travel-agent";
import { TripStore } from "./store/trip-store";
import { RESUME_NOTE, clearStaleRunState, recoverInterruptedRuns } from "./recovery";

const NOW = new Date("2026-10-19T00:00:00Z");
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tempDb = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "recovery-"));
  dirs.push(dir);
  return join(dir, "threads.db");
};

describe("clearStaleRunState", () => {
  it("returns 0 when the database does not exist", () => {
    expect(clearStaleRunState(tempDb())).toBe(0);
  });

  it("returns 0 when the runner has not created its tables yet", () => {
    const path = tempDb();
    new Database(path).close();
    expect(clearStaleRunState(path)).toBe(0);
  });

  it("clears every stuck is_running flag and leaves the rest alone", () => {
    const path = tempDb();
    const db = new Database(path);
    db.exec("CREATE TABLE run_state (thread_id TEXT PRIMARY KEY, is_running INTEGER DEFAULT 0, current_run_id TEXT, updated_at INTEGER NOT NULL)");
    db.prepare("INSERT INTO run_state VALUES ('a', 1, 'r1', 1), ('b', 1, 'r2', 1), ('c', 0, NULL, 1)").run();
    db.close();

    expect(clearStaleRunState(path)).toBe(2);

    const check = new Database(path, { readonly: true });
    expect(check.prepare("SELECT thread_id, is_running FROM run_state ORDER BY thread_id").all()).toEqual([
      { thread_id: "a", is_running: 0 },
      { thread_id: "b", is_running: 0 },
      { thread_id: "c", is_running: 0 },
    ]);
    check.close();
  });

  it("refuses a runner schema it does not understand", () => {
    const path = tempDb();
    const db = new Database(path);
    db.exec("CREATE TABLE run_state (thread_id TEXT PRIMARY KEY, running INTEGER)");
    db.close();
    expect(() => clearStaleRunState(path)).toThrow("run_state is missing is_running");
  });
});

describe("RESUME_NOTE", () => {
  it("pins the literal text the crash acceptance script greps for", () => {
    // The recovery test below asserts the note via this same constant, so a retyped
    // note (comma, period, spacing) would keep every test green while breaking the
    // `服务已重启` grep in the crash acceptance script. Pin the exact string here.
    expect(RESUME_NOTE).toBe("服务已重启，请继续未完成的任务。");
  });
});

describe("recoverInterruptedRuns", () => {
  const agent = { clone: () => ({ cloned: true }) } as unknown as AbstractAgent;
  let counter = 0;
  const newId = () => `id-${(counter += 1)}`;

  function storeWithRun(tripId = "a") {
    const store = TripStore.open(":memory:");
    store.beginRun({ tripId, runId: "old", userMessageId: "m0", userText: "最初的请求", startedAt: NOW.toISOString() });
    return store;
  }

  const options = (store: TripStore, run: (request: AgentRunnerRunRequest) => Obs<BaseEvent>) => ({
    store,
    runner: { run },
    agent,
    now: () => NOW,
    newId,
  });

  it("re-sends the original message plus a resume note and counts the attempt", async () => {
    const store = storeWithRun();
    const run = vi.fn((_request: AgentRunnerRunRequest) => EMPTY);

    await recoverInterruptedRuns(options(store, run));

    expect(run).toHaveBeenCalledTimes(1);
    const request = run.mock.calls[0][0];
    expect(request.threadId).toBe("a");
    expect(request.agent).toEqual({ cloned: true });
    expect(request.input.forwardedProps).toEqual({ recovery: true });
    expect(request.input.messages).toEqual([
      { id: "m0", role: "user", content: "最初的请求" },
      { id: expect.any(String), role: "user", content: RESUME_NOTE },
    ]);
    expect(store.getInflight("a")?.attempts).toBe(1);
  });

  it("gives up after the attempt limit with a fault and removes the row", async () => {
    const store = storeWithRun();
    store.bumpAttempts("a");
    store.bumpAttempts("a");
    const run = vi.fn((_request: AgentRunnerRunRequest) => EMPTY);

    await recoverInterruptedRuns(options(store, run));

    expect(run).not.toHaveBeenCalled();
    expect(store.getInflight("a")).toBeUndefined();
    expect(store.getDoc("a", "faults")).toEqual([
      { kind: "recovery", message: "Recovery gave up after 2 attempts", at: NOW.toISOString() },
    ]);
  });

  it("skips a trip whose run finished or was replaced before its turn", async () => {
    const store = storeWithRun();
    const run = vi.fn((_request: AgentRunnerRunRequest) => {
      // While the first trip recovers, a user starts a new run on the second one.
      store.beginRun({ tripId: "b", runId: "new-run", userMessageId: "m5", userText: "新的请求", startedAt: NOW.toISOString() });
      return EMPTY;
    });
    store.beginRun({ tripId: "b", runId: "old-b", userMessageId: "m1", userText: "旧请求", startedAt: "2026-10-19T00:00:01.000Z" });

    await recoverInterruptedRuns(options(store, run));

    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0].threadId).toBe("a");
    expect(store.getInflight("b")).toMatchObject({ runId: "new-run", userText: "新的请求", attempts: 0 });
  });

  it("recovers trips one at a time", async () => {
    const store = storeWithRun("a");
    store.beginRun({ tripId: "b", runId: "old-b", userMessageId: "m1", userText: "请求 b", startedAt: "2026-10-19T00:00:01.000Z" });
    const first = new Subject<BaseEvent>();
    const started: string[] = [];
    const run = vi.fn((request: { threadId: string }) => {
      started.push(request.threadId);
      return request.threadId === "a" ? first : EMPTY;
    });

    const done = recoverInterruptedRuns(options(store, run));
    await Promise.resolve();
    expect(started).toEqual(["a"]);
    first.complete();
    await done;
    expect(started).toEqual(["a", "b"]);
  });

  it("removes the row when the runner refuses the run, without throwing", async () => {
    const store = storeWithRun();
    const log = vi.fn();
    const run = vi.fn((_request: AgentRunnerRunRequest) => {
      throw new Error("Thread already running");
    });

    await recoverInterruptedRuns({ ...options(store, run), log });

    expect(store.getInflight("a")).toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Thread already running"));
  });

  it("keeps going when a recovered run errors", async () => {
    const store = storeWithRun("a");
    store.beginRun({ tripId: "b", runId: "old-b", userMessageId: "m1", userText: "请求 b", startedAt: "2026-10-19T00:00:01.000Z" });
    const started: string[] = [];
    const run = vi.fn((request: { threadId: string }) => {
      started.push(request.threadId);
      return request.threadId === "a"
        ? new Observable<BaseEvent>((subscriber) => subscriber.error(new Error("model failed")))
        : EMPTY;
    });

    await recoverInterruptedRuns(options(store, run));

    expect(started).toEqual(["a", "b"]);
  });

  it("times out a stuck run and moves on to the next trip", async () => {
    const store = storeWithRun("a");
    store.beginRun({ tripId: "b", runId: "old-b", userMessageId: "m1", userText: "请求 b", startedAt: "2026-10-19T00:00:01.000Z" });
    const started: string[] = [];
    const run = vi.fn((request: { threadId: string }) => {
      started.push(request.threadId);
      // The first trip's recovered run never settles.
      return request.threadId === "a" ? new Observable<BaseEvent>(() => {}) : EMPTY;
    });
    const log = vi.fn();

    await recoverInterruptedRuns({ ...options(store, run), timeoutMs: 10, log });

    expect(started).toEqual(["a", "b"]);
    expect(store.getInflight("a")).toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("timed out"));
  });

  it("times out a run that stalls after its first event and moves on", async () => {
    const store = storeWithRun("a");
    store.beginRun({ tripId: "b", runId: "old-b", userMessageId: "m1", userText: "请求 b", startedAt: "2026-10-19T00:00:01.000Z" });
    const started: string[] = [];
    const run = vi.fn((request: { threadId: string }) => {
      started.push(request.threadId);
      return request.threadId === "a"
        ? new Observable<BaseEvent>((subscriber) => {
            // The run starts, then goes silent without settling.
            subscriber.next({
              type: EventType.RUN_STARTED,
              threadId: "a",
              runId: "stalled",
            } as BaseEvent);
          })
        : EMPTY;
    });
    const log = vi.fn();

    await recoverInterruptedRuns({ ...options(store, run), timeoutMs: 10, log });

    expect(started).toEqual(["a", "b"]);
    expect(store.getInflight("a")).toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("timed out"));
  });

  it("drops the row of a real agent run that stalls mid-stream", async () => {
    const store = TripStore.open(":memory:");
    store.upsertTrip({
      tripId: "t1",
      conversationId: "t1",
      title: "x",
      destination: "泰山",
      startDate: "2026-10-26",
      days: 3,
      updatedAt: NOW.toISOString(),
      status: "active",
    });
    store.beginRun({ tripId: "t1", runId: "old", userMessageId: "m0", userText: "最初的请求", startedAt: NOW.toISOString() });
    const agent = new TravelAgent({
      store,
      now: () => NOW,
      buildSystemPrompt: () => "p",
      createAdapter: () => ({
        run: () =>
          new Observable<BaseEvent>((subscriber) => {
            subscriber.next({
              type: EventType.RUN_STARTED,
              threadId: "t1",
              runId: "stalled",
            } as BaseEvent);
          }),
        interrupt: async () => {},
      }),
    });
    // A runner that does not tear the agent run down when its own stream ends,
    // so only the recovery pass can clear the row the agent rewrote.
    const runner = {
      run: (request: AgentRunnerRunRequest) =>
        new Observable<BaseEvent>((subscriber) => {
          (request.agent as TravelAgent).run(request.input).subscribe({
            next: (event) => subscriber.next(event),
            error: (error: unknown) => subscriber.error(error),
            complete: () => subscriber.complete(),
          });
        }),
    };
    const log = vi.fn();

    await recoverInterruptedRuns({ store, runner, agent, now: () => NOW, newId, timeoutMs: 10, log });

    expect(store.getInflight("t1")).toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("timed out"));
  });
});

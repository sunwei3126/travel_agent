import { describe, expect, it } from "vitest";
import type { TripIndexEntry } from "@pi-demo/shared";
import { TripStore } from "./trip-store";

const entry = (tripId: string, updatedAt: string): TripIndexEntry => ({
  tripId,
  conversationId: tripId,
  title: `trip ${tripId}`,
  destination: "泰山",
  startDate: "2026-10-26",
  days: 3,
  updatedAt,
  status: "active",
});

const run = (tripId: string) => ({
  tripId,
  runId: "r1",
  userMessageId: "m1",
  userText: "泰山三天",
  startedAt: "2026-10-19T00:00:00.000Z",
});

describe("TripStore trips", () => {
  it("lists trips newest first and finds one by id", () => {
    const store = TripStore.open(":memory:");
    store.upsertTrip(entry("a", "2026-10-19T00:00:00.000Z"));
    store.upsertTrip(entry("b", "2026-10-20T00:00:00.000Z"));
    expect(store.listTrips().map((trip) => trip.tripId)).toEqual(["b", "a"]);
    expect(store.getTrip("a")?.title).toBe("trip a");
    expect(store.getTrip("missing")).toBeUndefined();
  });

  it("replaces an existing trip on upsert", () => {
    const store = TripStore.open(":memory:");
    store.upsertTrip(entry("a", "2026-10-19T00:00:00.000Z"));
    store.upsertTrip({ ...entry("a", "2026-10-21T00:00:00.000Z"), title: "renamed" });
    expect(store.listTrips()).toHaveLength(1);
    expect(store.getTrip("a")?.title).toBe("renamed");
  });
});

describe("TripStore docs", () => {
  it("returns the initial value for a document that was never written", () => {
    const store = TripStore.open(":memory:");
    expect(store.getDoc("t", "brief")).toEqual({});
    expect(store.getDoc("t", "plan")).toEqual({ days: [] });
    expect(store.getDoc("t", "sources")).toEqual({});
    expect(store.getDoc("t", "research")).toEqual({ searchCount: 0, fetchCount: 0 });
    expect(store.getDoc("t", "searchCache")).toEqual({});
    expect(store.getDoc("t", "faults")).toEqual([]);
  });

  it("round-trips a document and keeps trips isolated", () => {
    const store = TripStore.open(":memory:");
    store.setDoc("a", "brief", { destination: "泰山" });
    store.setDoc("a", "brief", { destination: "泰山", days: 3 });
    expect(store.getDoc("a", "brief")).toEqual({ destination: "泰山", days: 3 });
    expect(store.getDoc("b", "brief")).toEqual({});
  });

  it("returns a fresh object so callers cannot mutate stored state", () => {
    const store = TripStore.open(":memory:");
    store.setDoc("a", "research", { searchCount: 1, fetchCount: 0 });
    const first = store.getDoc("a", "research");
    first.searchCount = 99;
    expect(store.getDoc("a", "research").searchCount).toBe(1);
  });

  it("rolls back every write in a transaction that throws", () => {
    const store = TripStore.open(":memory:");
    expect(() =>
      store.transaction(() => {
        store.setDoc("a", "brief", { destination: "泰山" });
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(store.getDoc("a", "brief")).toEqual({});
  });

  it("keeps only the ten newest faults and can clear them", () => {
    const store = TripStore.open(":memory:");
    for (let index = 0; index < 12; index += 1) {
      store.appendFault("a", { kind: "claude.run", message: `m${index}`, at: "2026-10-19T00:00:00.000Z" });
    }
    const faults = store.getDoc("a", "faults");
    expect(faults).toHaveLength(10);
    expect(faults[0]?.message).toBe("m2");
    expect(faults[9]?.message).toBe("m11");
    store.clearFaults("a");
    expect(store.getDoc("a", "faults")).toEqual([]);
  });
});

describe("TripStore sessions", () => {
  it("stores one session id per trip", () => {
    const store = TripStore.open(":memory:");
    expect(store.getSessionId("a")).toBeUndefined();
    store.setSessionId("a", "s1");
    store.setSessionId("a", "s2");
    expect(store.getSessionId("a")).toBe("s2");
    expect(store.getSessionId("b")).toBeUndefined();
  });

  it("clears a trip's session id without touching other trips", () => {
    const store = TripStore.open(":memory:");
    store.setSessionId("a", "s1");
    store.setSessionId("b", "s2");
    store.clearSessionId("a");
    expect(store.getSessionId("a")).toBeUndefined();
    expect(store.getSessionId("b")).toBe("s2");
    store.clearSessionId("missing");
    expect(store.getSessionId("b")).toBe("s2");
  });
});

describe("TripStore inflight runs", () => {
  it("records a run and removes it when it ends", () => {
    const store = TripStore.open(":memory:");
    store.beginRun(run("a"));
    expect(store.getInflight("a")).toEqual({ ...run("a"), attempts: 0 });
    expect(store.listInflight()).toHaveLength(1);
    store.endRun("a");
    expect(store.getInflight("a")).toBeUndefined();
    expect(store.listInflight()).toEqual([]);
  });

  it("replaces a stale row and resets attempts on a new run", () => {
    const store = TripStore.open(":memory:");
    store.beginRun(run("a"));
    store.bumpAttempts("a");
    store.beginRun({ ...run("a"), runId: "r2", userText: "新的请求" });
    expect(store.getInflight("a")).toMatchObject({ runId: "r2", userText: "新的请求", attempts: 0 });
  });

  it("touchRun keeps the original message and the attempt count", () => {
    const store = TripStore.open(":memory:");
    store.beginRun(run("a"));
    expect(store.bumpAttempts("a")).toBe(1);
    store.touchRun("a", "r-recovery", "2026-10-20T00:00:00.000Z");
    expect(store.getInflight("a")).toEqual({
      tripId: "a",
      runId: "r-recovery",
      userMessageId: "m1",
      userText: "泰山三天",
      attempts: 1,
      startedAt: "2026-10-20T00:00:00.000Z",
    });
  });
});

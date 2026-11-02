import { describe, expect, it } from "vitest";
import { TripStore } from "../store/trip-store";
import { TripService } from "./service";

const NOW = new Date("2026-10-19T00:00:00Z");
const input = { title: "泰山三日游", destination: "泰山", startDate: "2026-10-26", days: 3 };

function setup() {
  const store = TripStore.open(":memory:");
  return { store, service: new TripService(store, () => NOW) };
}

describe("TripService", () => {
  it("creates a trip seeded with the brief fields the form collected", () => {
    const { service, store } = setup();
    const entry = service.createTrip(input);
    expect(entry).toMatchObject({
      title: "泰山三日游",
      destination: "泰山",
      startDate: "2026-10-26",
      days: 3,
      status: "active",
      updatedAt: NOW.toISOString(),
    });
    expect(entry.conversationId).toBe(entry.tripId);
    expect(store.getDoc(entry.tripId, "brief")).toEqual({ destination: "泰山", startDate: "2026-10-26", days: 3 });
  });

  it("rejects an impossible calendar date", () => {
    const { service } = setup();
    expect(() => service.createTrip({ ...input, startDate: "2026-02-30" })).toThrow(/^Invalid trip:/);
  });

  it("lists trips newest first", () => {
    const store = TripStore.open(":memory:");
    let tick = 0;
    const service = new TripService(store, () => new Date(NOW.getTime() + (tick += 1000)));
    const first = service.createTrip(input);
    const second = service.createTrip({ ...input, title: "第二个" });
    expect(service.listTrips().map((trip) => trip.tripId)).toEqual([second.tripId, first.tripId]);
  });

  it("builds a snapshot and reports running while a run is in flight", () => {
    const { service, store } = setup();
    const { tripId } = service.createTrip(input);
    expect(service.getSnapshot(tripId)).toMatchObject({
      trip: { tripId },
      brief: { destination: "泰山" },
      plan: { days: [] },
      sources: {},
      research: { searchCount: 0, fetchCount: 0 },
      running: false,
      faults: [],
    });
    store.beginRun({ tripId, runId: "r1", userMessageId: "m1", userText: "x", startedAt: NOW.toISOString() });
    expect(service.getSnapshot(tripId).running).toBe(true);
  });

  it("throws a not-found error for an unknown trip", () => {
    const { service } = setup();
    expect(() => service.getSnapshot("nope")).toThrow("Trip not found: nope");
  });
});

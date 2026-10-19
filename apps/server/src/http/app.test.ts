import type { TripIndexEntry, TripSnapshot } from "@pi-demo/shared";
import { describe, expect, it } from "vitest";
import { buildServer, type TravelServiceApi } from "./app";
import { nextUnlessDisconnected } from "./routes/agui";

function makeFakeService(): TravelServiceApi {
  const trips = new Map<string, TripIndexEntry>();
  const submissions = new Map<string, string>();
  let sequence = 0;

  return {
    async listTrips() {
      return [...trips.values()];
    },
    async createTrip(input) {
      sequence += 1;
      const tripId = `t${sequence}`;
      const entry: TripIndexEntry = {
        tripId,
        conversationId: tripId,
        title: input.title,
        destination: input.destination,
        startDate: input.startDate,
        days: input.days,
        updatedAt: "2026-10-19T00:00:00.000Z",
        status: "active",
      };
      trips.set(tripId, entry);
      return entry;
    },
    async getSnapshot(tripId): Promise<TripSnapshot> {
      const trip = trips.get(tripId);
      if (trip === undefined) throw new Error(`Trip not found: ${tripId}`);
      return {
        trip,
        brief: {
          destination: trip.destination,
          startDate: trip.startDate,
          days: trip.days,
        },
        plan: { days: [] },
        sources: {},
        research: { searchCount: 0, fetchCount: 0 },
        running: false,
      };
    },
    async submitMessage(tripId, _content, requestId) {
      if (!trips.has(tripId)) throw new Error(`Trip not found: ${tripId}`);
      const key = `${tripId}:${requestId}`;
      let submissionId = submissions.get(key);
      if (submissionId === undefined) {
        sequence += 1;
        submissionId = `s${sequence}`;
        submissions.set(key, submissionId);
      }
      return { submissionId };
    },
    async getTranscript() {
      return [];
    },
    async *watchEvents(tripId) {
      if (!trips.has(tripId)) throw new Error(`Trip not found: ${tripId}`);
      yield { type: "snapshot" } as never;
    },
    async recordFault() {},
    async clearFaults() {},
    async close() {},
  };
}

async function createTripId(app: ReturnType<typeof buildServer>): Promise<string> {
  const created = await app.inject({
    method: "POST",
    url: "/api/trips",
    payload: { title: "泰山", destination: "泰山", startDate: "2026-10-26", days: 3 },
  });
  return created.json().tripId as string;
}

describe("REST routes", () => {
  it("reports health", async () => {
    const app = buildServer({ service: makeFakeService() });
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
  });

  it("creates, lists, and rejects empty messages", async () => {
    const app = buildServer({ service: makeFakeService() });
    const created = await app.inject({
      method: "POST",
      url: "/api/trips",
      payload: { title: "泰山", destination: "泰山", startDate: "2026-10-26", days: 3 },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().tripId as string;
    expect(created.json()).toMatchObject({ destination: "泰山", days: 3 });

    const empty = await app.inject({
      method: "POST",
      url: `/api/trips/${id}/messages`,
      payload: { content: "  ", requestId: "r1" },
    });
    expect(empty.statusCode).toBe(400);

    expect((await app.inject({ method: "GET", url: "/api/trips" })).json()).toHaveLength(1);
    expect((await app.inject({ method: "GET", url: `/api/trips/${id}` })).json().trip.tripId).toBe(
      id,
    );
    expect((await app.inject({ method: "GET", url: "/api/trips/missing" })).statusCode).toBe(404);
  });

  it("validates the create body", async () => {
    const app = buildServer({ service: makeFakeService() });
    const response = await app.inject({
      method: "POST",
      url: "/api/trips",
      payload: { title: "泰山" },
    });
    expect(response.statusCode).toBe(400);
  });

  it("rejects an impossible calendar date at creation", async () => {
    const app = buildServer({ service: makeFakeService() });
    const response = await app.inject({
      method: "POST",
      url: "/api/trips",
      payload: {
        title: "泰山",
        destination: "泰山",
        startDate: "2026-02-30",
        days: 3,
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain("real calendar date");
  });

  it("returns the same submission for a duplicate request id", async () => {
    const app = buildServer({ service: makeFakeService() });
    const tripId = await createTripId(app);
    const send = () =>
      app.inject({
        method: "POST",
        url: `/api/trips/${tripId}/messages`,
        payload: { content: "泰山三天", requestId: "r1" },
      });

    const first = await send();
    const second = await send();
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect(second.json().submissionId).toBe(first.json().submissionId);
  });

  it("returns 404 when submitting to an unknown trip", async () => {
    const app = buildServer({ service: makeFakeService() });
    const response = await app.inject({
      method: "POST",
      url: "/api/trips/missing/messages",
      payload: { content: "泰山", requestId: "r1" },
    });
    expect(response.statusCode).toBe(404);
  });
});

describe("AG-UI route", () => {
  it("streams a snapshot and finishes the run", async () => {
    const app = buildServer({ service: makeFakeService() });
    const tripId = await createTripId(app);

    const response = await app.inject({
      method: "POST",
      url: `/agui?tripId=${tripId}`,
      payload: { runId: "r1", messages: [{ id: "m1", role: "user", content: "泰山" }] },
    });

    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body).toContain("STATE_SNAPSHOT");
    expect(response.body).toContain("RUN_STARTED");
    expect(response.body).toContain("RUN_FINISHED");
  });

  it("rejects an empty user message", async () => {
    const app = buildServer({ service: makeFakeService() });
    const tripId = await createTripId(app);

    const response = await app.inject({
      method: "POST",
      url: `/agui?tripId=${tripId}`,
      payload: { runId: "r1", messages: [{ id: "m1", role: "user", content: "  " }] },
    });

    expect(response.statusCode).toBe(400);
  });

  it("returns 404 for an unknown trip", async () => {
    const app = buildServer({ service: makeFakeService() });
    const response = await app.inject({
      method: "POST",
      url: "/agui?tripId=missing",
      payload: { runId: "r1", messages: [{ id: "m1", role: "user", content: "泰山" }] },
    });
    expect(response.statusCode).toBe(404);
  });
});

describe("nextUnlessDisconnected", () => {
  it("returns the next event when it arrives before the disconnect", async () => {
    const events: AsyncIterator<number> = {
      next: async () => ({ done: false, value: 7 }),
    };

    await expect(
      nextUnlessDisconnected(events, new Promise<void>(() => {})),
    ).resolves.toEqual({ kind: "event", result: { done: false, value: 7 } });
  });

  it("stops waiting when the client disconnects before the next event", async () => {
    let disconnect!: () => void;
    const signal = new Promise<void>((resolve) => {
      disconnect = resolve;
    });
    const events: AsyncIterator<number> = {
      next: () => new Promise<IteratorResult<number>>(() => {}),
    };

    const pending = nextUnlessDisconnected(events, signal);
    disconnect();
    await expect(pending).resolves.toEqual({ kind: "disconnected" });
  });
});

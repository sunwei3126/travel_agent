import { describe, expect, it } from "vitest";
import { TripStore } from "../store/trip-store";
import { TripService } from "../trips/service";
import { buildServer } from "./app";
import type { NodeHandler } from "./routes/copilotkit";

const body = { title: "泰山三日游", destination: "泰山", startDate: "2099-10-26", days: 3 };

function build(copilotHandler?: NodeHandler) {
  const service = new TripService(TripStore.open(":memory:"));
  return buildServer({ service, copilotHandler });
}

describe("REST routes", () => {
  it("reports health", async () => {
    const response = await build().inject({ method: "GET", url: "/health" });
    expect(response.json()).toEqual({ ok: true });
  });

  it("creates a trip, lists it, and returns its snapshot", async () => {
    const app = build();
    const created = await app.inject({ method: "POST", url: "/api/trips", payload: body });
    expect(created.statusCode).toBe(201);
    const { tripId } = created.json();

    const list = await app.inject({ method: "GET", url: "/api/trips" });
    expect(list.json().map((trip: { tripId: string }) => trip.tripId)).toEqual([tripId]);

    const snapshot = await app.inject({ method: "GET", url: `/api/trips/${tripId}` });
    expect(snapshot.statusCode).toBe(200);
    expect(snapshot.json()).toMatchObject({ trip: { tripId }, brief: { destination: "泰山" }, running: false });
  });

  it("validates the create body", async () => {
    const app = build();
    for (const payload of [{}, { ...body, days: 0 }, { ...body, startDate: "26-10-2099" }, { ...body, extra: 1 }]) {
      const response = await app.inject({ method: "POST", url: "/api/trips", payload });
      expect(response.statusCode).toBe(400);
    }
  });

  it("rejects an impossible calendar date at creation", async () => {
    const response = await build().inject({
      method: "POST",
      url: "/api/trips",
      payload: { ...body, startDate: "2099-02-30" },
    });
    expect(response.statusCode).toBe(400);
    expect(typeof response.json().error).toBe("string");
  });

  it("returns 404 for an unknown trip", async () => {
    const response = await build().inject({ method: "GET", url: "/api/trips/nope" });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "Trip not found: nope" });
  });

  it("no longer serves the removed message and transcript routes", async () => {
    const app = build();
    const post = await app.inject({ method: "POST", url: "/api/trips/x/messages", payload: { content: "hi", requestId: "r" } });
    const get = await app.inject({ method: "GET", url: "/api/trips/x/transcript" });
    expect(post.statusCode).toBe(404);
    expect(get.statusCode).toBe(404);
  });

  it("keeps JSON parsing for REST while the runtime route reads its own body", async () => {
    const seen: string[] = [];
    const handler: NodeHandler = async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      seen.push(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(204);
      res.end();
    };
    const app = build(handler);
    const created = await app.inject({ method: "POST", url: "/api/trips", payload: body });
    expect(created.statusCode).toBe(201);
    await app.inject({ method: "POST", url: "/api/copilotkit/agent/travel/run", payload: { runId: "r1" } });
    expect(seen).toEqual(['{"runId":"r1"}']);
  });
});

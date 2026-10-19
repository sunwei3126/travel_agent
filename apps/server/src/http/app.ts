import type { TranscriptEntry, TripIndexEntry, TripSnapshot } from "@pi-demo/shared";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import type { CreateTripInput, PiEvent } from "../harness/service";
import { registerAguiRoute } from "./routes/agui";
import { registerTripRoutes } from "./routes/trips";

/** The subset of `TravelService` the HTTP layer depends on. */
export type TravelServiceApi = {
  listTrips(): Promise<TripIndexEntry[]>;
  createTrip(input: CreateTripInput): Promise<TripIndexEntry>;
  getSnapshot(tripId: string): Promise<TripSnapshot>;
  submitMessage(
    tripId: string,
    content: string,
    requestId: string,
  ): Promise<{ submissionId: string }>;
  getTranscript(tripId: string): Promise<TranscriptEntry[]>;
  watchEvents(tripId: string): AsyncIterable<PiEvent>;
  close(): Promise<void>;
};

export type BuildServerOptions = {
  service: TravelServiceApi;
  logger?: FastifyServerOptions["logger"];
};

export function buildServer({ service, logger = false }: BuildServerOptions): FastifyInstance {
  const app = Fastify({ logger });

  app.get("/health", async () => ({ ok: true }));
  registerTripRoutes(app, service);
  registerAguiRoute(app, service);

  return app;
}

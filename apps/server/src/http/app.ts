import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import type { TripService } from "../trips/service";
import { registerCopilotKitRoute, type NodeHandler } from "./routes/copilotkit";
import { registerTripRoutes } from "./routes/trips";

/** The subset of `TripService` the HTTP layer depends on. */
export type TripServiceApi = Pick<TripService, "listTrips" | "createTrip" | "getSnapshot">;

export type BuildServerOptions = {
  service: TripServiceApi;
  /** The CopilotKit runtime handler; omitted in tests that only exercise REST. */
  copilotHandler?: NodeHandler;
  logger?: FastifyServerOptions["logger"];
};

export function buildServer({
  service,
  copilotHandler,
  logger = false,
}: BuildServerOptions): FastifyInstance {
  // Fastify's default ajv options silently strip unknown body properties, which
  // would defeat `additionalProperties: false` in the route schemas.
  const app = Fastify({ logger, ajv: { customOptions: { removeAdditional: false } } });

  app.get("/health", async () => ({ ok: true }));
  registerTripRoutes(app, service);
  if (copilotHandler !== undefined) registerCopilotKitRoute(app, copilotHandler);

  return app;
}

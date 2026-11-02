import type { FastifyInstance } from "fastify";
import { validateBrief } from "../../plan/validate";
import type { CreateTripInput } from "../../trips/service";
import type { TripServiceApi } from "../app";

const createTripSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["title", "destination", "startDate", "days"],
    properties: {
      title: { type: "string", minLength: 1 },
      destination: { type: "string", minLength: 1 },
      startDate: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
      days: { type: "integer", minimum: 1 },
    },
  },
};

/** Maps the service's unknown-trip errors to HTTP 404. */
export function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && /^(Trip|Conversation) not found:/.test(error.message);
}

export function registerTripRoutes(app: FastifyInstance, service: TripServiceApi): void {
  app.get("/api/trips", async () => service.listTrips());

  app.post<{ Body: CreateTripInput }>(
    "/api/trips",
    { schema: createTripSchema },
    async (request, reply) => {
      const errors = validateBrief(request.body, new Date(), { requireComplete: false });
      if (errors.length > 0) {
        return reply.code(400).send({ error: errors.join("; ") });
      }
      return reply.code(201).send(service.createTrip(request.body));
    },
  );

  app.get<{ Params: { tripId: string } }>("/api/trips/:tripId", async (request, reply) => {
    try {
      return service.getSnapshot(request.params.tripId);
    } catch (error) {
      if (isNotFoundError(error)) return reply.code(404).send({ error: (error as Error).message });
      throw error;
    }
  });
}

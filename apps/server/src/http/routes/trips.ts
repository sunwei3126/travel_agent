import type { FastifyInstance } from "fastify";
import { toAguiMessages } from "../../agui/mapper";
import type { CreateTripInput } from "../../harness/service";
import { validateBrief } from "../../plan/validate";
import type { TravelServiceApi } from "../app";

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

const messageBodySchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["content", "requestId"],
    properties: {
      content: { type: "string" },
      requestId: { type: "string", minLength: 1 },
    },
  },
};

/** Maps the service's unknown-trip errors to HTTP 404. */
export function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && /^(Trip|Conversation) not found:/.test(error.message);
}

export function registerTripRoutes(app: FastifyInstance, service: TravelServiceApi): void {
  app.get("/api/trips", async () => service.listTrips());

  app.post<{ Body: CreateTripInput }>(
    "/api/trips",
    { schema: createTripSchema },
    async (request, reply) => {
      const errors = validateBrief(request.body, new Date(), {
        requireComplete: false,
      });
      if (errors.length > 0) {
        return reply.code(400).send({ error: errors.join("; ") });
      }
      const entry = await service.createTrip(request.body);
      return reply.code(201).send(entry);
    },
  );

  app.get<{ Params: { tripId: string } }>("/api/trips/:tripId", async (request, reply) => {
    try {
      return await service.getSnapshot(request.params.tripId);
    } catch (error) {
      if (isNotFoundError(error)) return reply.code(404).send({ error: (error as Error).message });
      throw error;
    }
  });

  app.get<{ Params: { tripId: string } }>(
    "/api/trips/:tripId/transcript",
    async (request, reply) => {
      try {
        return toAguiMessages(await service.getTranscript(request.params.tripId));
      } catch (error) {
        if (isNotFoundError(error)) return reply.code(404).send({ error: (error as Error).message });
        throw error;
      }
    },
  );

  app.post<{
    Params: { tripId: string };
    Body: { content: string; requestId: string };
  }>(
    "/api/trips/:tripId/messages",
    { schema: messageBodySchema },
    async (request, reply) => {
      const { content, requestId } = request.body;
      if (content.trim().length === 0) {
        return reply.code(400).send({ error: "content must not be empty" });
      }

      try {
        const result = await service.submitMessage(request.params.tripId, content, requestId);
        return reply.code(202).send(result);
      } catch (error) {
        if (isNotFoundError(error)) return reply.code(404).send({ error: (error as Error).message });
        throw error;
      }
    },
  );
}

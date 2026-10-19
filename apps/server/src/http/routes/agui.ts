import { contentToText, EventType, type AGUIEvent, type RunAgentInput } from "@ag-ui/core";
import type { TranscriptEntry, TripSnapshot } from "@pi-demo/shared";
import type { FastifyInstance } from "fastify";
import { buildSnapshot, createPiEventMapper } from "../../agui/mapper";
import type { TravelServiceApi } from "../app";
import { isNotFoundError } from "./trips";

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
};

export type NextEvent<T> =
  | { kind: "event"; result: IteratorResult<T> }
  | { kind: "disconnected" };

/**
 * Races the next streamed event against the client closing the connection, so
 * a handler parked on a quiet stream still returns when the client leaves.
 */
export function nextUnlessDisconnected<T>(
  events: AsyncIterator<T>,
  disconnected: Promise<void>,
): Promise<NextEvent<T>> {
  return Promise.race([
    events.next().then((result) => ({ kind: "event" as const, result })),
    disconnected.then(() => ({ kind: "disconnected" as const })),
  ]);
}

function lastUserText(input: Partial<RunAgentInput>): string {
  const messages = Array.isArray(input.messages) ? input.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") return contentToText(message.content).trim();
  }
  return "";
}

export function registerAguiRoute(app: FastifyInstance, service: TravelServiceApi): void {
  app.post<{ Querystring: { tripId?: string }; Body: Partial<RunAgentInput> }>(
    "/agui",
    async (request, reply) => {
      const tripId = request.query.tripId;
      if (typeof tripId !== "string" || tripId.length === 0) {
        return reply.code(400).send({ error: "tripId is required" });
      }

      const runId = request.body?.runId;
      if (typeof runId !== "string" || runId.length === 0) {
        return reply.code(400).send({ error: "runId is required" });
      }

      const content = lastUserText(request.body ?? {});
      if (content.length === 0) {
        return reply.code(400).send({ error: "the last user message must not be empty" });
      }

      let snapshot: TripSnapshot;
      let entries: TranscriptEntry[];
      try {
        snapshot = await service.getSnapshot(tripId);
        await service.submitMessage(tripId, content, runId);
        entries = await service.getTranscript(tripId);
      } catch (error) {
        if (isNotFoundError(error)) return reply.code(404).send({ error: (error as Error).message });
        throw error;
      }

      reply.hijack();
      reply.raw.writeHead(200, SSE_HEADERS);

      const write = (event: AGUIEvent): void => {
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      };

      const events = service.watchEvents(tripId)[Symbol.asyncIterator]();
      const mapper = createPiEventMapper();
      let disconnected = false;
      let terminal = false;
      let notifyDisconnect!: () => void;
      const disconnectPromise = new Promise<void>((resolve) => {
        notifyDisconnect = resolve;
      });
      const onClose = (): void => {
        disconnected = true;
        notifyDisconnect();
      };
      reply.raw.on("close", onClose);

      try {
        write({ type: EventType.RUN_STARTED, threadId: tripId, runId });
        for (const event of buildSnapshot({ threadId: tripId, runId, entries, ...snapshot })) {
          write(event);
        }

        while (!terminal) {
          const next = await nextUnlessDisconnected(events, disconnectPromise);
          if (disconnected || next.kind === "disconnected") break;
          if (next.result.done === true) break;
          for (const event of mapper.map(next.result.value)) {
            write(event);
            if (event.type === EventType.RUN_ERROR) {
              terminal = true;
              break;
            }
          }
        }

        if (!disconnected && !terminal) {
          write({ type: EventType.RUN_FINISHED, threadId: tripId, runId });
        }
      } catch (error) {
        if (!disconnected) {
          write({
            type: EventType.RUN_ERROR,
            message: error instanceof Error ? error.message : "Run failed",
          });
        }
      } finally {
        reply.raw.off("close", onClose);
        // Immediate cancellation needs abort support in watchEvents; the
        // returned promise is not awaited so the handler can finish now.
        void events.return?.()?.catch(() => {});
        reply.raw.end();
      }
    },
  );
}

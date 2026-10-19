import { contentToText, EventType, type AGUIEvent, type RunAgentInput } from "@ag-ui/core";
import type { TranscriptEntry, TripSnapshot } from "@pi-demo/shared";
import type { FastifyInstance } from "fastify";
import { buildSnapshot, createPiEventMapper } from "../../agui/mapper";
import type { PiEvent } from "../../harness/service";
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

      // Attach the watcher before submitting. `events.next()` primes the async
      // generator, so the watch is registered atomically before the run can
      // start and no run_start/run_end event can be missed.
      const abortController = new AbortController();
      const events = service
        .watchEvents(tripId, abortController.signal)
        [Symbol.asyncIterator]();

      let snapshot: TripSnapshot;
      let entries: TranscriptEntry[];
      let initialWatch: IteratorResult<PiEvent>;
      try {
        snapshot = await service.getSnapshot(tripId);
        initialWatch = await events.next();
        await service.submitMessage(tripId, content, runId);
        entries = await service.getTranscript(tripId);
      } catch (error) {
        abortController.abort();
        void events.return?.()?.catch(() => {});
        if (isNotFoundError(error)) return reply.code(404).send({ error: (error as Error).message });
        throw error;
      }

      reply.hijack();
      reply.raw.writeHead(200, SSE_HEADERS);

      const write = (event: AGUIEvent): void => {
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      };

      const mapper = createPiEventMapper();
      let disconnected = false;
      let terminal = false;
      let notifyDisconnect!: () => void;
      const disconnectPromise = new Promise<void>((resolve) => {
        notifyDisconnect = resolve;
      });
      const onClose = (): void => {
        disconnected = true;
        abortController.abort();
        notifyDisconnect();
      };
      reply.raw.on("close", onClose);

      try {
        write({ type: EventType.RUN_STARTED, threadId: tripId, runId });
        for (const event of buildSnapshot({ threadId: tripId, runId, entries, ...snapshot })) {
          write(event);
        }

        const consume = async (raw: unknown): Promise<boolean> => {
          const type =
            typeof raw === "object" && raw !== null
              ? (raw as { type?: unknown }).type
              : undefined;
          if (type === "run_start") {
            await service.clearFaults(tripId).catch(() => {});
          } else if (type === "task_failed") {
            const fault = raw as {
              kind?: unknown;
              message?: unknown;
              taskId?: unknown;
            };
            await service
              .recordFault(tripId, {
                kind: typeof fault.kind === "string" ? fault.kind : "unknown",
                message:
                  typeof fault.message === "string" ? fault.message : "Task failed",
                ...(typeof fault.taskId === "string" ||
                typeof fault.taskId === "number"
                  ? { taskId: String(fault.taskId) }
                  : {}),
                at: new Date().toISOString(),
              })
              .catch(() => {});
          }
          for (const event of mapper.map(raw as never)) {
            write(event);
            if (event.type === EventType.RUN_ERROR) {
              terminal = true;
              break;
            }
          }
          // watchEvents is conversation-scoped and stays open after a run, so
          // the durable run_end is the run's terminal signal.
          return type === "run_end" || terminal;
        };

        let ended = initialWatch.done !== true && (await consume(initialWatch.value));

        while (!terminal && !ended) {
          const next = await nextUnlessDisconnected(events, disconnectPromise);
          if (disconnected || next.kind === "disconnected") break;
          if (next.result.done === true) break;
          ended = await consume(next.result.value);
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
        // Abort the watcher so its generator's `finally` stops the stream.
        abortController.abort();
        void events.return?.()?.catch(() => {});
        reply.raw.end();
      }
    },
  );
}

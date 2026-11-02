import { AbstractAgent, EventType, type BaseEvent, type RunAgentInput } from "@ag-ui/client";
import { Observable } from "rxjs";
import type { TripStore } from "../store/trip-store";

export type AdapterHandle = {
  run(input: RunAgentInput): Observable<BaseEvent>;
  interrupt(): Promise<void>;
};

export type AdapterFactory = (options: { tripId: string; systemPrompt: string }) => AdapterHandle;

export type TravelAgentDeps = {
  store: TripStore;
  createAdapter: AdapterFactory;
  buildSystemPrompt: (tripId: string) => string;
  now: () => Date;
};

export const FAULT_KIND = "claude.run";
const ERROR_RESULT_MESSAGE = "The model run ended with an error result";
/** The SDK's wording when a stored `resume` id no longer has a transcript. */
const SESSION_UNAVAILABLE = /original sdk session is unavailable/i;

type EventRecord = BaseEvent & Record<string, unknown>;

/** Plain text of a user message; multimodal content keeps only its text parts. */
function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text"
        ? String((part as { text?: unknown }).text ?? "")
        : "",
    )
    .join("");
}

function lastUserMessage(
  messages: RunAgentInput["messages"],
): { id: string; text: string } | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    const text = textOfContent(message.content).trim();
    if (text.length > 0) return { id: message.id, text };
  }
  return undefined;
}

function sessionIdOf(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as { session_id?: unknown; data?: { session_id?: unknown } };
  const id = record.session_id ?? record.data?.session_id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

const isErrorResult = (result: unknown): boolean =>
  typeof result === "object" && result !== null && (result as { isError?: unknown }).isError === true;

const isRecovery = (input: RunAgentInput): boolean =>
  (input.forwardedProps as { recovery?: unknown } | undefined)?.recovery === true;

/**
 * Runs one trip turn: a fresh Claude adapter per run, in-flight bookkeeping so
 * an interrupted run can be resumed, session-id capture, and error surfacing.
 * `threadId` is the trip id.
 */
export class TravelAgent extends AbstractAgent {
  private current: AdapterHandle | undefined;

  constructor(private deps: TravelAgentDeps) {
    super({ agentId: "travel" });
  }

  /** CopilotKit runs a clone per request; the base clone does not call the constructor. */
  override clone(): TravelAgent {
    const copy = super.clone() as TravelAgent;
    copy.deps = this.deps;
    return copy;
  }

  override abortRun(): void {
    void this.current?.interrupt().catch(() => {});
    super.abortRun();
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      const { store, createAdapter, buildSystemPrompt, now } = this.deps;
      const tripId = input.threadId;

      if (store.getTrip(tripId) === undefined) {
        subscriber.error(new Error(`Trip not found: ${tripId}`));
        return undefined;
      }
      const user = lastUserMessage(input.messages);
      if (user === undefined) {
        subscriber.error(new Error("The run input has no user message"));
        return undefined;
      }

      const startedAt = now().toISOString();
      if (isRecovery(input)) {
        // The row keeps the original message and attempt count across restarts.
        store.touchRun(tripId, input.runId, startedAt);
      } else {
        store.beginRun({ tripId, runId: input.runId, userMessageId: user.id, userText: user.text, startedAt });
      }
      store.clearFaults(tripId);

      const sessionId = store.getSessionId(tripId);
      const adapter = createAdapter({ tripId, systemPrompt: buildSystemPrompt(tripId) });
      this.current = adapter;

      let finished = false;
      const finish = (): void => {
        if (finished) return;
        finished = true;
        store.endRun(tripId);
      };
      const fail = (message: string): void =>
        store.appendFault(tripId, { kind: FAULT_KIND, message, at: now().toISOString() });

      const subscription = adapter
        .run({
          ...input,
          forwardedProps: {
            ...(input.forwardedProps ?? {}),
            ...(sessionId === undefined ? {} : { resume: sessionId }),
          },
        })
        .subscribe({
          next: (event) => {
            const record = event as EventRecord;
            if (record.type === EventType.CUSTOM && record.name === "system:init") {
              const id = sessionIdOf(record.value);
              if (id !== undefined) store.setSessionId(tripId, id);
            }
            if (record.type === EventType.RUN_FINISHED && isErrorResult(record.result)) {
              fail(ERROR_RESULT_MESSAGE);
              subscriber.next({
                type: EventType.RUN_ERROR,
                message: ERROR_RESULT_MESSAGE,
                code: "MODEL_ERROR",
              } as BaseEvent);
              finish();
              return;
            }
            if (record.type === EventType.RUN_ERROR) {
              const message = typeof record.message === "string" ? record.message : "Run failed";
              if (SESSION_UNAVAILABLE.test(message)) {
                // A stale resume id would fail every later turn; drop it so the
                // next message starts a fresh SDK session instead.
                store.clearSessionId(tripId);
              }
              fail(message);
              finish();
            } else if (record.type === EventType.RUN_FINISHED) {
              finish();
            }
            subscriber.next(event);
          },
          error: (error: unknown) => {
            fail(error instanceof Error ? error.message : String(error));
            finish();
            subscriber.error(error);
          },
          complete: () => {
            finish();
            subscriber.complete();
          },
        });

      return () => {
        subscription.unsubscribe();
        finish();
        if (this.current === adapter) this.current = undefined;
      };
    });
  }
}

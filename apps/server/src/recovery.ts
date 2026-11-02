import { existsSync } from "node:fs";
import type { AbstractAgent, BaseEvent, RunAgentInput } from "@ag-ui/client";
import type { AgentRunnerRunRequest } from "@copilotkit/runtime/v2";
import Database from "better-sqlite3";
import { lastValueFrom, timeout, TimeoutError, type Observable } from "rxjs";
import type { TripStore } from "./store/trip-store";

export const RESUME_NOTE = "服务已重启，请继续未完成的任务。";
/** A recovered run that never settles must not block the trips behind it. */
const DEFAULT_RECOVERY_TIMEOUT_MS = 15 * 60 * 1000;

const REQUIRED_COLUMNS = ["thread_id", "is_running", "current_run_id"] as const;

/**
 * `@copilotkit/sqlite-runner` keeps `run_state.is_running` in its database and
 * refuses to start a run on a thread that is flagged, with no liveness check.
 * After an unclean shutdown the flag stays set, so it must be cleared before
 * the runner is constructed. Returns how many flags were cleared.
 */
export function clearStaleRunState(threadsDbPath: string): number {
  if (!existsSync(threadsDbPath)) return 0;
  const db = new Database(threadsDbPath);
  try {
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'run_state'")
      .get();
    if (table === undefined) return 0;
    const columns = (db.prepare("PRAGMA table_info(run_state)").all() as { name: string }[]).map(
      (column) => column.name,
    );
    for (const required of REQUIRED_COLUMNS) {
      if (!columns.includes(required)) {
        throw new Error(
          `Unsupported @copilotkit/sqlite-runner schema: run_state is missing ${required}`,
        );
      }
    }
    return db.prepare("UPDATE run_state SET is_running = 0 WHERE is_running = 1").run().changes;
  } finally {
    db.close();
  }
}

export type RecoveryRunner = {
  run(request: AgentRunnerRunRequest): Observable<BaseEvent>;
};

export type RecoverOptions = {
  store: TripStore;
  runner: RecoveryRunner;
  agent: AbstractAgent;
  maxAttempts?: number;
  /** Per-trip bound on one recovered run; defaults to 15 minutes. */
  timeoutMs?: number;
  now: () => Date;
  newId: () => string;
  log?: (message: string) => void;
};

/**
 * Re-sends every run that was in flight when the process died, one trip at a
 * time. The original user message is replayed so the chat history stays whole,
 * followed by a visible note; the SDK session itself resumes via the stored id.
 */
export async function recoverInterruptedRuns(options: RecoverOptions): Promise<void> {
  const { store, runner, agent, now, newId, log } = options;
  const maxAttempts = options.maxAttempts ?? 2;
  const timeoutMs = options.timeoutMs ?? DEFAULT_RECOVERY_TIMEOUT_MS;

  for (const pending of store.listInflight()) {
    // A run that finished, or was replaced by a new user message, is not ours to redo.
    const current = store.getInflight(pending.tripId);
    if (current === undefined || current.runId !== pending.runId) continue;

    if (current.attempts >= maxAttempts) {
      store.appendFault(current.tripId, {
        kind: "recovery",
        message: `Recovery gave up after ${current.attempts} attempts`,
        at: now().toISOString(),
      });
      store.endRun(current.tripId);
      continue;
    }

    store.bumpAttempts(current.tripId);
    const input: RunAgentInput = {
      threadId: current.tripId,
      runId: newId(),
      state: {},
      tools: [],
      context: [],
      forwardedProps: { recovery: true },
      messages: [
        { id: current.userMessageId, role: "user", content: current.userText },
        { id: newId(), role: "user", content: RESUME_NOTE },
      ],
    };

    try {
      await lastValueFrom(
        runner
          .run({ threadId: current.tripId, agent: agent.clone(), input })
          .pipe(timeout({ first: timeoutMs })),
        { defaultValue: undefined },
      );
    } catch (error) {
      if (error instanceof TimeoutError) {
        log?.(`Recovery run for ${current.tripId} timed out after ${timeoutMs}ms`);
      } else {
        log?.(
          `Recovery run for ${current.tripId} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      // A run that started has already recorded its fault and cleared its row;
      // one the runner refused, or one that timed out, may leave the original
      // row behind. Only the row this pass read is ours to drop.
      if (store.getInflight(current.tripId)?.runId === current.runId) store.endRun(current.tripId);
    }
  }
}

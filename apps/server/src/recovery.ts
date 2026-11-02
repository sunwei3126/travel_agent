import { existsSync } from "node:fs";
import type { AbstractAgent, BaseEvent, RunAgentInput } from "@ag-ui/client";
import type { AgentRunnerRunRequest } from "@copilotkit/runtime/v2";
import Database from "better-sqlite3";
import { lastValueFrom, type Observable } from "rxjs";
import type { TripStore } from "./store/trip-store";

export const RESUME_NOTE = "服务已重启，请继续未完成的任务。";

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
      await lastValueFrom(runner.run({ threadId: current.tripId, agent: agent.clone(), input }), {
        defaultValue: undefined,
      });
    } catch (error) {
      log?.(
        `Recovery run for ${current.tripId} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      // A run that started has already recorded its fault and cleared its row;
      // one the runner refused leaves the original row behind.
      if (store.getInflight(current.tripId)?.runId === current.runId) store.endRun(current.tripId);
    }
  }
}

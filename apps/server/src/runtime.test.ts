import { AbstractAgent, EventType, type BaseEvent, type RunAgentInput } from "@ag-ui/client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Observable } from "rxjs";
import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "./http/app";
import { createTravelRuntime } from "./runtime";
import { TripStore } from "./store/trip-store";
import { TripService } from "./trips/service";

class EchoAgent extends AbstractAgent {
  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      const messageId = "echo-1";
      subscriber.next({ type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId } as BaseEvent);
      subscriber.next({ type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant" } as BaseEvent);
      subscriber.next({ type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: "echo: 泰山" } as BaseEvent);
      subscriber.next({ type: EventType.TEXT_MESSAGE_END, messageId } as BaseEvent);
      subscriber.next({ type: EventType.RUN_FINISHED, threadId: input.threadId, runId: input.runId } as BaseEvent);
      subscriber.complete();
    });
  }
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // The runner keeps its database handle open for the process lifetime.
    }
  }
});

function build() {
  const dir = mkdtempSync(join(tmpdir(), "runtime-"));
  dirs.push(dir);
  const threadsDbPath = join(dir, "threads.db");
  const { handler } = createTravelRuntime({ agent: new EchoAgent({ agentId: "travel" }), threadsDbPath });
  const app = buildServer({ service: new TripService(TripStore.open(":memory:")), copilotHandler: handler });
  return { app, threadsDbPath };
}

describe("createTravelRuntime", () => {
  it("advertises the travel agent", async () => {
    const { app } = build();
    const response = await app.inject({ method: "GET", url: "/api/copilotkit/info" });
    expect(response.statusCode).toBe(200);
    expect(JSON.stringify(response.json())).toContain("travel");
  });

  it("streams a run as AG-UI events and persists it in the runner database", async () => {
    const { app, threadsDbPath } = build();
    const response = await app.inject({
      method: "POST",
      url: "/api/copilotkit/agent/travel/run",
      payload: {
        threadId: "trip-1",
        runId: "r1",
        state: {},
        tools: [],
        context: [],
        forwardedProps: {},
        messages: [{ id: "m1", role: "user", content: "泰山三天" }],
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("echo: 泰山");
    expect(response.body).toContain("RUN_FINISHED");

    const db = new Database(threadsDbPath, { readonly: true });
    expect(db.prepare("SELECT run_id FROM agent_runs WHERE thread_id = 'trip-1'").all()).toEqual([{ run_id: "r1" }]);
    expect(db.prepare("SELECT is_running FROM run_state WHERE thread_id = 'trip-1'").get()).toEqual({ is_running: 0 });
    db.close();
  });
});

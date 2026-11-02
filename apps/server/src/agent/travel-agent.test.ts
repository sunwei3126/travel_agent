import { EventType, type BaseEvent, type RunAgentInput } from "@ag-ui/client";
import { Observable, Subject, lastValueFrom, toArray } from "rxjs";
import { describe, expect, it, vi } from "vitest";
import { TripStore } from "../store/trip-store";
import { TravelAgent, type AdapterHandle } from "./travel-agent";

const NOW = new Date("2026-10-19T00:00:00Z");

const input = (overrides: Partial<RunAgentInput> = {}): RunAgentInput => ({
  threadId: "t1",
  runId: "r1",
  state: {},
  tools: [],
  context: [],
  forwardedProps: {},
  messages: [{ id: "m1", role: "user", content: "泰山三天" }],
  ...overrides,
});

function setup(adapterFor: (seen: { input?: RunAgentInput }) => AdapterHandle) {
  const store = TripStore.open(":memory:");
  store.upsertTrip({
    tripId: "t1",
    conversationId: "t1",
    title: "x",
    destination: "泰山",
    startDate: "2026-10-26",
    days: 3,
    updatedAt: NOW.toISOString(),
    status: "active",
  });
  const seen: { input?: RunAgentInput; systemPrompt?: string } = {};
  const agent = new TravelAgent({
    store,
    now: () => NOW,
    buildSystemPrompt: (tripId) => `prompt for ${tripId}`,
    createAdapter: ({ systemPrompt }) => {
      seen.systemPrompt = systemPrompt;
      return adapterFor(seen);
    },
  });
  return { store, agent, seen };
}

const scripted = (events: BaseEvent[], tail?: { error: Error }) =>
  (seen: { input?: RunAgentInput }): AdapterHandle => ({
    run: (runInput) =>
      new Observable<BaseEvent>((subscriber) => {
        seen.input = runInput;
        for (const event of events) subscriber.next(event);
        if (tail) subscriber.error(tail.error);
        else subscriber.complete();
      }),
    interrupt: async () => {},
  });

const init = { type: EventType.CUSTOM, name: "system:init", value: { type: "system", subtype: "init", session_id: "s1" } } as unknown as BaseEvent;
const finished = { type: EventType.RUN_FINISHED, threadId: "t1", runId: "r1", result: { isError: false } } as unknown as BaseEvent;

const collect = (agent: TravelAgent, runInput = input()) =>
  lastValueFrom(agent.run(runInput).pipe(toArray()));

describe("TravelAgent", () => {
  it("passes the adapter's events through and builds the prompt for the trip", async () => {
    const { agent, seen } = setup(scripted([init, finished]));
    const events = await collect(agent);
    expect(events).toEqual([init, finished]);
    expect(seen.systemPrompt).toBe("prompt for t1");
  });

  it("records the original user message while the run is in flight and clears it after", async () => {
    const store = TripStore.open(":memory:");
    store.upsertTrip({ tripId: "t1", conversationId: "t1", title: "x", destination: "泰山", startDate: "2026-10-26", days: 3, updatedAt: NOW.toISOString(), status: "active" });
    let during: unknown;
    const agent = new TravelAgent({
      store,
      now: () => NOW,
      buildSystemPrompt: () => "p",
      createAdapter: () => ({
        run: () =>
          new Observable<BaseEvent>((subscriber) => {
            during = store.getInflight("t1");
            subscriber.next(finished);
            subscriber.complete();
          }),
        interrupt: async () => {},
      }),
    });
    await collect(agent);
    expect(during).toMatchObject({ tripId: "t1", runId: "r1", userMessageId: "m1", userText: "泰山三天", attempts: 0 });
    expect(store.getInflight("t1")).toBeUndefined();
  });

  it("stores the session id from system:init and resumes it on the next run", async () => {
    const { agent, store, seen } = setup(scripted([init, finished]));
    await collect(agent);
    expect(store.getSessionId("t1")).toBe("s1");
    await collect(agent, input({ runId: "r2" }));
    expect(seen.input?.forwardedProps).toMatchObject({ resume: "s1" });
  });

  it("does not send resume for a trip that has no session yet", async () => {
    const { agent, seen } = setup(scripted([finished]));
    await collect(agent);
    expect(seen.input?.forwardedProps).not.toHaveProperty("resume");
  });

  it("rewrites an error result into RUN_ERROR and records a fault", async () => {
    const errored = { type: EventType.RUN_FINISHED, threadId: "t1", runId: "r1", result: { isError: true } } as unknown as BaseEvent;
    const { agent, store } = setup(scripted([init, errored]));
    const events = await collect(agent);
    expect(events.map((event) => event.type)).toEqual([EventType.CUSTOM, EventType.RUN_ERROR]);
    expect(store.getDoc("t1", "faults")).toEqual([
      { kind: "claude.run", message: expect.stringContaining("error result"), at: NOW.toISOString() },
    ]);
    expect(store.getInflight("t1")).toBeUndefined();
  });

  it("records a fault for a RUN_ERROR event and ends the run", async () => {
    const runError = { type: EventType.RUN_ERROR, message: "gateway down" } as unknown as BaseEvent;
    const { agent, store } = setup(scripted([runError]));
    await collect(agent);
    expect(store.getDoc("t1", "faults")[0]).toMatchObject({ kind: "claude.run", message: "gateway down" });
    expect(store.getInflight("t1")).toBeUndefined();
  });

  it("clears the stored session id when the SDK reports it unavailable", async () => {
    const runError = {
      type: EventType.RUN_ERROR,
      message:
        "original SDK session is unavailable. Restore its transcript/store and original working directory.",
    } as unknown as BaseEvent;
    const { agent, store, seen } = setup(scripted([runError]));
    store.setSessionId("t1", "stale");

    await collect(agent);

    expect(store.getSessionId("t1")).toBeUndefined();
    expect(store.getDoc("t1", "faults")[0]).toMatchObject({
      kind: "claude.run",
      message: expect.stringContaining("session is unavailable"),
    });

    await collect(agent, input({ runId: "r2" }));
    expect(seen.input?.forwardedProps).not.toHaveProperty("resume");
  });

  it("keeps the stored session id for other run errors", async () => {
    const runError = { type: EventType.RUN_ERROR, message: "gateway down" } as unknown as BaseEvent;
    const { agent, store } = setup(scripted([runError]));
    store.setSessionId("t1", "s1");

    await collect(agent);

    expect(store.getSessionId("t1")).toBe("s1");
  });

  it("records a fault and errors when the adapter stream fails", async () => {
    const { agent, store } = setup(scripted([init], { error: new Error("spawn failed") }));
    await expect(collect(agent)).rejects.toThrow("spawn failed");
    expect(store.getDoc("t1", "faults")[0]).toMatchObject({ kind: "claude.run", message: "spawn failed" });
    expect(store.getInflight("t1")).toBeUndefined();
  });

  it("clears faults from the previous run when a new run starts", async () => {
    const { agent, store } = setup(scripted([finished]));
    store.appendFault("t1", { kind: "claude.run", message: "old", at: NOW.toISOString() });
    await collect(agent);
    expect(store.getDoc("t1", "faults")).toEqual([]);
  });

  it("fails for an unknown trip without touching the in-flight table", async () => {
    const { agent, store } = setup(scripted([finished]));
    await expect(collect(agent, input({ threadId: "nope" }))).rejects.toThrow("Trip not found: nope");
    expect(store.listInflight()).toEqual([]);
  });

  it("fails when the input carries no user message", async () => {
    const { agent } = setup(scripted([finished]));
    await expect(collect(agent, input({ messages: [] }))).rejects.toThrow("no user message");
  });

  it("keeps the original message and attempt count for a recovery run", async () => {
    const { agent, store } = setup(scripted([finished]));
    store.beginRun({ tripId: "t1", runId: "old", userMessageId: "m0", userText: "最初的请求", startedAt: NOW.toISOString() });
    store.bumpAttempts("t1");
    let during: unknown;
    const spy = vi.spyOn(store, "endRun").mockImplementation(() => {
      during = store.getInflight("t1");
    });
    await collect(
      agent,
      input({
        runId: "r-recovery",
        forwardedProps: { recovery: true },
        messages: [
          { id: "m0", role: "user", content: "最初的请求" },
          { id: "m9", role: "user", content: "服务已重启，请继续未完成的任务。" },
        ],
      }),
    );
    spy.mockRestore();
    expect(during).toMatchObject({ runId: "r-recovery", userMessageId: "m0", userText: "最初的请求", attempts: 1 });
  });

  it("ends the run and unsubscribes from the adapter when the consumer leaves early", () => {
    const source = new Subject<BaseEvent>();
    let sourceUnsubscribed = false;
    const { agent, store } = setup(() => ({
      run: () => new Observable<BaseEvent>((subscriber) => {
        const subscription = source.subscribe(subscriber);
        return () => {
          sourceUnsubscribed = true;
          subscription.unsubscribe();
        };
      }),
      interrupt: async () => {},
    }));
    const subscription = agent.run(input()).subscribe();
    expect(store.getInflight("t1")).toBeDefined();
    subscription.unsubscribe();
    expect(sourceUnsubscribed).toBe(true);
    expect(store.getInflight("t1")).toBeUndefined();
  });

  it("interrupts the active adapter when the run is aborted", () => {
    const interrupt = vi.fn(async () => {});
    const { agent } = setup(() => ({ run: () => new Observable<BaseEvent>(), interrupt }));
    agent.run(input()).subscribe();
    agent.abortRun();
    expect(interrupt).toHaveBeenCalledTimes(1);
  });

  it("keeps its dependencies on the per-request clone", async () => {
    const { agent } = setup(scripted([finished]));
    const events = await collect(agent.clone());
    expect(events).toEqual([finished]);
  });
});

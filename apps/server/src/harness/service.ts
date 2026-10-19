import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { Model, Models, ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
  defineExtension,
  Harness,
  LiveDoc,
  watchEvents as watchConversationEvents,
  type AgentEvent,
  type Conversation,
  type ConversationId,
  type Registry,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type {
  TranscriptEntry,
  TripBrief,
  TripFault,
  TripIndexEntry,
  TripPlan,
  TripResearch,
  TripSnapshot,
} from "@pi-demo/shared";
import { PLANNER_INSTRUCTIONS } from "../agent/prompts";
import { tripContextSection } from "../agent/section";
import { validateBrief } from "../plan/validate";
import {
  TripBriefDoc,
  TripFaultsDoc,
  TripPlanDoc,
  TripResearchDoc,
  TripSourcesDoc,
} from "../trips/docs";
import { TripIndexStore } from "../trips/index-store";
import { toTranscriptEntries } from "./transcript";

/** One event from the pi-durable conversation event stream. */
export type PiEvent = AgentEvent;

export type TravelServiceOptions = {
  dataDir: string;
  models: Models;
  registry: Registry;
  defaultModel: Model<string>;
  thinkingLevel?: ModelThinkingLevel;
  now?: () => Date;
};

export type CreateTripInput = {
  title: string;
  destination: string;
  startDate: string;
  days: number;
};

const TravelContextExtension = defineExtension({
  name: "travel-context",
  sections: [tripContextSection],
});

const EMPTY_PLAN: TripPlan = { days: [] };

const toConversationId = (value: string): ConversationId => Number(value) as ConversationId;
const EMPTY_RESEARCH: TripResearch = { searchCount: 0, fetchCount: 0 };

export class TravelService {
  private readonly context: Context = BACKGROUND_CONTEXT;

  private readonly upgradedThinkingTrips = new Set<string>();

  private constructor(
    private readonly harness: Harness,
    private readonly index: TripIndexStore,
    private readonly defaultModel: Model<string>,
    private readonly thinkingLevel: ModelThinkingLevel,
    private readonly now: () => Date,
  ) {}

  static async open(options: TravelServiceOptions): Promise<TravelService> {
    await mkdir(options.dataDir, { recursive: true });
    options.registry.install(TravelContextExtension);

    const storage = await openNodeSqliteStorage(join(options.dataDir, "pi.sqlite"));
    const now = options.now ?? (() => new Date());
    const harness = await Harness.open(
      storage,
      {
        models: options.models,
        registry: options.registry,
        now: () => now().getTime(),
      },
      BACKGROUND_CONTEXT,
    );
    harness.resume();

    return new TravelService(
      harness,
      new TripIndexStore(join(options.dataDir, "trips.json")),
      options.defaultModel,
      options.thinkingLevel ?? "off",
      now,
    );
  }

  async createTrip(input: CreateTripInput): Promise<TripIndexEntry> {
    // Creation only records the seed fields, so completeness is not required
    // yet; an impossible or past calendar date is still rejected here.
    const initialBrief: TripBrief = {
      destination: input.destination,
      startDate: input.startDate,
      days: input.days,
    };
    const errors = validateBrief(initialBrief, this.now(), { requireComplete: false });
    if (errors.length > 0) {
      throw new Error(`Invalid trip: ${errors.join("; ")}`);
    }

    const conversation = await this.harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: {
          model: { provider: this.defaultModel.provider, modelId: this.defaultModel.id },
          instructions: PLANNER_INSTRUCTIONS,
          thinkingLevel: this.thinkingLevel,
        },
        init: async (tx, conversationId) => {
          const brief = await tx.doc(TripBriefDoc, conversationId);
          brief.destination = input.destination;
          brief.startDate = input.startDate;
          brief.days = input.days;

          const plan = await tx.doc(TripPlanDoc, conversationId);
          plan.days = [];

          await tx.doc(TripSourcesDoc, conversationId);

          const research = await tx.doc(TripResearchDoc, conversationId);
          research.searchCount = 0;
          research.fetchCount = 0;
        },
      },
      this.context,
    );

    const entry: TripIndexEntry = {
      tripId: String(conversation.id),
      conversationId: String(conversation.id),
      title: input.title,
      destination: input.destination,
      startDate: input.startDate,
      days: input.days,
      updatedAt: this.now().toISOString(),
      status: "active",
    };
    await this.index.upsert(entry);
    return entry;
  }

  async listTrips(): Promise<TripIndexEntry[]> {
    return this.index.list();
  }

  async getSnapshot(tripId: string): Promise<TripSnapshot> {
    const trip = await this.requireTrip(tripId);
    const conversationId = toConversationId(trip.conversationId);
    await this.requireConversation(conversationId);

    const brief = (await this.harness.snapshot(TripBriefDoc, conversationId, this.context)) ?? {};
    const plan = (await this.harness.snapshot(TripPlanDoc, conversationId, this.context)) ?? EMPTY_PLAN;
    const sources = (await this.harness.snapshot(TripSourcesDoc, conversationId, this.context)) ?? {};
    const research =
      (await this.harness.snapshot(TripResearchDoc, conversationId, this.context)) ?? EMPTY_RESEARCH;
    const faults = (
      await this.harness.snapshot(TripFaultsDoc, conversationId, this.context)
    )?.items ?? [];
    const live = await this.harness.snapshot(LiveDoc, conversationId, this.context);

    return {
      trip,
      brief,
      plan,
      sources,
      research,
      running: live?.run !== undefined,
      faults,
    };
  }

  async recordFault(tripId: string, fault: TripFault): Promise<void> {
    const conversation = await this.requireConversationById(tripId);
    await conversation.commit(async (tx) => {
      const faults = await tx.doc(TripFaultsDoc, conversation.id);
      faults.items = [...faults.items, fault].slice(-10);
    }, this.context);
  }

  async clearFaults(tripId: string): Promise<void> {
    const conversation = await this.requireConversationById(tripId);
    await conversation.commit(async (tx) => {
      const faults = await tx.doc(TripFaultsDoc, conversation.id);
      faults.items = [];
    }, this.context);
  }

  async submitMessage(
    tripId: string,
    content: string,
    requestId: string,
  ): Promise<{ submissionId: string }> {
    const conversation = await this.requireConversationById(tripId);
    await this.ensureThinkingLevel(tripId, conversation);
    const submission = await conversation.submit({ type: "input", content, requestId }, this.context);
    return { submissionId: String(submission.id) };
  }

  private async ensureThinkingLevel(
    tripId: string,
    conversation: Conversation,
  ): Promise<void> {
    if (this.thinkingLevel === "off" || this.upgradedThinkingTrips.has(tripId)) {
      return;
    }
    const agent = await conversation.agent(this.context);
    if (agent.thinkingLevel !== this.thinkingLevel) {
      await conversation.configure({ thinkingLevel: this.thinkingLevel }, this.context);
    }
    this.upgradedThinkingTrips.add(tripId);
  }

  async getTranscript(tripId: string): Promise<TranscriptEntry[]> {
    const conversation = await this.requireConversationById(tripId);
    const state = await conversation.viewState(this.context);
    try {
      return toTranscriptEntries(state.value.entries);
    } finally {
      state.dispose();
    }
  }

  watchEvents(tripId: string, signal?: AbortSignal): AsyncIterable<PiEvent> {
    return this.streamEvents(tripId, signal);
  }

  async close(): Promise<void> {
    await this.harness.close(this.context);
  }

  private async *streamEvents(
    tripId: string,
    signal?: AbortSignal,
  ): AsyncGenerator<PiEvent> {
    const trip = await this.requireTrip(tripId);
    const stream = await watchConversationEvents(
      this.harness,
      toConversationId(trip.conversationId),
      this.context,
    );

    const pending: PiEvent[] = [];
    let wake: (() => void) | undefined;
    let closed = false;
    let aborted = signal?.aborted ?? false;
    const onAbort = (): void => {
      aborted = true;
      wake?.();
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    stream.start(async (events) => {
      pending.push(...events);
      wake?.();
    });
    void stream.closed.then(() => {
      closed = true;
      wake?.();
    });

    try {
      yield stream.snapshot;
      while (true) {
        if (aborted) return;
        const next = pending.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        if (closed) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
          // The abort may have landed between the check above and this assignment.
          if (aborted) resolve();
        });
        wake = undefined;
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
      await stream.stop();
    }
  }

  private async requireTrip(tripId: string): Promise<TripIndexEntry> {
    const trip = await this.index.get(tripId);
    if (trip === undefined) throw new Error(`Trip not found: ${tripId}`);
    return trip;
  }

  private async requireConversationById(tripId: string): Promise<Conversation> {
    const trip = await this.requireTrip(tripId);
    return this.requireConversation(toConversationId(trip.conversationId));
  }

  private async requireConversation(conversationId: ConversationId): Promise<Conversation> {
    const conversation = await this.harness.conversation(conversationId, this.context);
    if (conversation === undefined) {
      throw new Error(`Conversation not found: ${conversationId}`);
    }
    return conversation;
  }
}

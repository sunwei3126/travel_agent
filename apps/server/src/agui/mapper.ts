import { EventType, type AGUIEvent, type Message as AguiMessage } from "@ag-ui/core";
import { contentText } from "@earendil-works/pi-ai";
import type {
  TranscriptEntry,
  TripBrief,
  TripPlan,
  TripResearch,
  TripSources,
} from "@pi-demo/shared";
import type { PiEvent } from "../harness/service";

export type SnapshotInput = {
  threadId: string;
  runId: string;
  entries: TranscriptEntry[];
  brief: TripBrief;
  plan: TripPlan;
  sources: TripSources;
  research: TripResearch;
  running: boolean;
};

/** Stateful mapper for one AG-UI run. Create one per run. */
export type PiEventMapper = {
  map(batch: PiEvent | PiEvent[]): AGUIEvent[];
};

type UnknownRecord = Record<string, unknown>;

type MessageState = {
  id: string;
  /** Text already sent for this message, in the order it was sent. */
  emitted: string;
  /** Text already sent for each assistant-message content index. */
  blocks: Map<number, string>;
  /** Whether `TEXT_MESSAGE_START` was emitted and `TEXT_MESSAGE_END` is still due. */
  open: boolean;
};

type MapperState = {
  current: MessageState | undefined;
  sequence: number;
  /** Tool calls started in this run whose `TOOL_CALL_END` is still due. */
  activeTools: Set<string>;
};

const asRecord = (value: unknown): UnknownRecord | undefined =>
  typeof value === "object" && value !== null ? (value as UnknownRecord) : undefined;

const asText = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const asId = (value: unknown): string | undefined =>
  typeof value === "string" || typeof value === "number" ? String(value) : undefined;

/** Creates the per-run state needed for message ids and text already emitted. */
export function createPiEventMapper(): PiEventMapper {
  const state: MapperState = { current: undefined, sequence: 0, activeTools: new Set() };
  return { map: (batch) => mapBatch(state, batch) };
}

/** Emits the conversation snapshot the AG-UI runtime starts from. */
export function buildSnapshot(input: SnapshotInput): AGUIEvent[] {
  return [
    {
      type: EventType.MESSAGES_SNAPSHOT,
      messages: input.entries.map(toAguiMessage),
    },
    {
      type: EventType.STATE_SNAPSHOT,
      snapshot: {
        brief: input.brief,
        plan: input.plan,
        sources: input.sources,
        research: { ...input.research, running: input.running },
      },
    },
  ];
}

/**
 * Stateless convenience for a single batch. Real streams should use
 * `createPiEventMapper()` so message ids and emitted text survive batches.
 */
export function mapPiEvents(batch: PiEvent | PiEvent[]): AGUIEvent[] {
  return createPiEventMapper().map(batch);
}

function mapBatch(state: MapperState, batch: PiEvent | PiEvent[]): AGUIEvent[] {
  const events: readonly unknown[] = Array.isArray(batch) ? batch : [batch];
  const mapped: AGUIEvent[] = [];
  for (const event of events) {
    const record = asRecord(event);
    if (record !== undefined) mapPiEvent(state, record, mapped);
  }
  return mapped;
}

function toAguiMessage(entry: TranscriptEntry): AguiMessage {
  if (entry.role === "tool") {
    return { id: entry.id, role: "tool", content: entry.content, toolCallId: entry.id };
  }
  if (entry.role === "user") {
    return { id: entry.id, role: "user", content: entry.content };
  }
  return { id: entry.id, role: "assistant", content: entry.content };
}

function mapPiEvent(state: MapperState, event: UnknownRecord, out: AGUIEvent[]): void {
  switch (event.type) {
    case "snapshot": {
      // Late attach: the durable snapshot may already carry an in-flight
      // generation partial. Seed it so later deltas are never content without
      // a preceding TEXT_MESSAGE_START.
      const generation = asRecord(event.generation);
      const message = asRecord(generation?.message);
      if (message?.role !== "assistant") return;
      const target = state.current ?? newMessage(state, undefined);
      appendMessageText(target, message.content, out);
      return;
    }

    case "message_start":
    case "text_start": {
      const source = asRecord(event.message);
      const explicitId = asText(event.messageId);
      if (event.type !== "text_start" && source?.role !== "assistant" && explicitId === undefined) {
        return;
      }
      const message = newMessage(state, explicitId);
      startMessage(message, out);
      if (source?.role === "assistant") appendMessageText(message, source.content, out);
      return;
    }

    case "message_update":
    case "text_delta": {
      const message = ensureMessage(state, event);
      const delta = asText(event.delta);
      if (delta !== undefined) {
        appendText(message, delta, out);
        return;
      }
      // Real pi-durable shape: the message text arrives as relative changes.
      const changes = Array.isArray(event.changes) ? event.changes : [];
      for (const value of changes) {
        const change = asRecord(value);
        if (change === undefined) continue;
        if (change.type === "text_start" || change.type === "block") {
          const block = asRecord(change.block);
          if (block?.type === "text" && typeof block.text === "string") {
            appendBlockText(message, contentIndexOf(change), block.text, out);
          }
        } else if (change.type === "text_delta" && typeof change.delta === "string") {
          const index = contentIndexOf(change);
          const previous = message.blocks.get(index) ?? "";
          appendBlockText(message, index, previous + change.delta, out);
        } else if (change.type === "message") {
          const full = asRecord(change.message);
          if (full?.role === "assistant") appendMessageText(message, full.content, out);
        }
      }
      return;
    }

    case "message_end":
    case "text_end": {
      const entry = asRecord(event.entry);
      const source = Array.isArray(entry?.model) ? asRecord(entry.model[0]) : undefined;
      const assistant = source?.role === "assistant";
      if (
        event.type === "text_end" ||
        assistant ||
        asText(event.messageId) !== undefined
      ) {
        const message = ensureMessage(state, event);
        if (assistant) appendMessageText(message, source!.content, out);
        startMessage(message, out);
        out.push({ type: EventType.TEXT_MESSAGE_END, messageId: message.id });
        message.open = false;
        state.current = undefined;
      }
      return;
    }

    case "tool_execution_start": {
      const toolCallId = asText(event.toolCallId);
      const toolCallName = asText(event.toolName);
      if (toolCallId !== undefined && toolCallName !== undefined) {
        out.push({ type: EventType.TOOL_CALL_START, toolCallId, toolCallName });
        // AG-UI tracks a call as active from START; ARGS and END close it.
        out.push({
          type: EventType.TOOL_CALL_ARGS,
          toolCallId,
          delta: JSON.stringify(event.args ?? {}),
        });
        state.activeTools.add(toolCallId);
      }
      return;
    }

    case "tool_execution_end": {
      const toolCallId = asText(event.toolCallId);
      if (toolCallId === undefined) return;
      // A result seen without a start (late attach) is left as RESULT only;
      // emitting END without an active call would fail protocol validation.
      if (state.activeTools.has(toolCallId)) {
        out.push({ type: EventType.TOOL_CALL_END, toolCallId });
        state.activeTools.delete(toolCallId);
      }
      out.push({
        type: EventType.TOOL_CALL_RESULT,
        messageId: toolResultMessageId(event, toolCallId),
        toolCallId,
        content: toolResultContent(event),
      });
      return;
    }

    case "task_failed": {
      const code = asText(event.kind);
      const message = asText(event.message) ?? "Task failed";
      // Surface every parked/faulted task distinctly to the UI. A generation
      // task owns the run, so its fault also ends the run; a failed tool task
      // does not end the run, and the model may retry the tool.
      out.push({
        type: EventType.CUSTOM,
        name: "travel.task_failed",
        value: {
          kind: code ?? "unknown",
          message,
          ...(asId(event.taskId) === undefined ? {} : { taskId: asId(event.taskId) }),
        },
      });
      if (code !== undefined && code !== "pi.generation") return;
      out.push({
        type: EventType.RUN_ERROR,
        message,
        ...(code === undefined ? {} : { code }),
      });
      return;
    }

    case "run_end": {
      closeOpenEntities(state, out);
      return;
    }

    case "run_error":
    case "error": {
      const code = asText(event.code);
      out.push({
        type: EventType.RUN_ERROR,
        message: asText(event.message) ?? asText(event.error) ?? "Run failed",
        ...(code === undefined ? {} : { code }),
      });
      return;
    }
  }
}

function newMessage(state: MapperState, explicitId: string | undefined): MessageState {
  state.sequence += 1;
  const message: MessageState = {
    id: explicitId ?? `assistant-${state.sequence}`,
    emitted: "",
    blocks: new Map(),
    open: false,
  };
  state.current = message;
  return message;
}

/** Emits TEXT_MESSAGE_START once, before any content or end for a message. */
function startMessage(message: MessageState, out: AGUIEvent[]): void {
  if (message.open) return;
  message.open = true;
  out.push({ type: EventType.TEXT_MESSAGE_START, messageId: message.id });
}

/** Closes entities left open when a run ends, so RUN_FINISHED can be accepted. */
function closeOpenEntities(state: MapperState, out: AGUIEvent[]): void {
  if (state.current?.open === true) {
    out.push({ type: EventType.TEXT_MESSAGE_END, messageId: state.current.id });
    state.current.open = false;
  }
  for (const toolCallId of state.activeTools) {
    out.push({ type: EventType.TOOL_CALL_END, toolCallId });
  }
  state.activeTools.clear();
  state.current = undefined;
}

function ensureMessage(state: MapperState, event: UnknownRecord): MessageState {
  const explicitId = asText(event.messageId);
  if (explicitId !== undefined && state.current?.id !== explicitId) {
    return newMessage(state, explicitId);
  }
  return state.current ?? newMessage(state, explicitId);
}

/** Emits the part of a text block that has not been sent yet. */
function appendBlockText(
  message: MessageState,
  index: number,
  fullText: string,
  out: AGUIEvent[],
): void {
  const previous = message.blocks.get(index) ?? "";
  if (fullText.length <= previous.length) {
    message.blocks.set(index, fullText);
    return;
  }
  const delta = fullText.slice(previous.length);
  message.blocks.set(index, fullText);
  // An empty block has not started yet, so its first text still needs the
  // separator that contentText puts between text blocks.
  const separator = previous.length === 0 && message.emitted.length > 0 ? "\n" : "";
  appendText(message, separator + delta, out);
}

/** Emits the not-yet-sent part of a whole assistant message. */
function appendMessageText(message: MessageState, content: unknown, out: AGUIEvent[]): void {
  if (typeof content === "string") {
    appendSuffix(message, content, out);
    return;
  }
  if (!Array.isArray(content)) return;
  for (const [index, value] of content.entries()) {
    const block = asRecord(value);
    if (block?.type === "text" && typeof block.text === "string") {
      appendBlockText(message, index, block.text, out);
    }
  }
}

/** Emits only the suffix of a full message that has not been sent yet. */
function appendSuffix(message: MessageState, fullText: string, out: AGUIEvent[]): void {
  if (fullText.length <= message.emitted.length) return;
  const delta = fullText.slice(message.emitted.length);
  message.emitted = fullText;
  startMessage(message, out);
  out.push({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: message.id, delta });
}

function appendText(message: MessageState, delta: string, out: AGUIEvent[]): void {
  if (delta.length === 0) return;
  message.emitted += delta;
  startMessage(message, out);
  out.push({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: message.id, delta });
}

function contentIndexOf(change: UnknownRecord): number {
  return typeof change.contentIndex === "number" ? change.contentIndex : 0;
}

function toolResultMessageId(event: UnknownRecord, toolCallId: string): string {
  const entry = asRecord(event.entry);
  return asId(entry?.id) ?? `tool-result-${toolCallId}`;
}

function toolResultContent(event: UnknownRecord): string {
  const entry = asRecord(event.entry);
  const message = Array.isArray(entry?.model) ? asRecord(entry.model[0]) : undefined;
  if (message?.role === "toolResult") {
    const content = message.content;
    if (typeof content === "string" || Array.isArray(content)) {
      return contentText(content);
    }
  }

  const result = asRecord(event.result);
  if (result !== undefined && result.structuredOutput !== undefined) {
    return typeof result.structuredOutput === "string"
      ? result.structuredOutput
      : JSON.stringify(result.structuredOutput);
  }
  return "";
}

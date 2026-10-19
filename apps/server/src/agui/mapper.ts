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
};

type MapperState = {
  current: MessageState | undefined;
  sequence: number;
};

const asRecord = (value: unknown): UnknownRecord | undefined =>
  typeof value === "object" && value !== null ? (value as UnknownRecord) : undefined;

const asText = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const asId = (value: unknown): string | undefined =>
  typeof value === "string" || typeof value === "number" ? String(value) : undefined;

/** Creates the per-run state needed for message ids and text already emitted. */
export function createPiEventMapper(): PiEventMapper {
  const state: MapperState = { current: undefined, sequence: 0 };
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
    case "snapshot":
      return;

    case "message_start":
    case "text_start": {
      const source = asRecord(event.message);
      const explicitId = asText(event.messageId);
      if (event.type !== "text_start" && source?.role !== "assistant" && explicitId === undefined) {
        return;
      }
      const message = newMessage(state, explicitId);
      out.push({ type: EventType.TEXT_MESSAGE_START, messageId: message.id });
      if (source?.role === "assistant") appendInitialText(message, source.content, out);
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
        if (assistant) appendSuffix(message, assistantText(source!.content), out);
        out.push({ type: EventType.TEXT_MESSAGE_END, messageId: message.id });
        state.current = undefined;
      }
      return;
    }

    case "tool_execution_start": {
      const toolCallId = asText(event.toolCallId);
      const toolCallName = asText(event.toolName);
      if (toolCallId !== undefined && toolCallName !== undefined) {
        out.push({ type: EventType.TOOL_CALL_START, toolCallId, toolCallName });
      }
      return;
    }

    case "tool_execution_end": {
      const toolCallId = asText(event.toolCallId);
      if (toolCallId === undefined) return;
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
      // A generation task owns the run; a failed tool task does not end it.
      if (code !== undefined && code !== "pi.generation") return;
      out.push({
        type: EventType.RUN_ERROR,
        message: asText(event.message) ?? "Task failed",
        ...(code === undefined ? {} : { code }),
      });
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
  };
  state.current = message;
  return message;
}

function ensureMessage(state: MapperState, event: UnknownRecord): MessageState {
  const explicitId = asText(event.messageId);
  if (explicitId !== undefined && state.current?.id !== explicitId) {
    return newMessage(state, explicitId);
  }
  return state.current ?? newMessage(state, explicitId);
}

/** Emits the text carried by the first committed partial or whole message. */
function appendInitialText(message: MessageState, content: unknown, out: AGUIEvent[]): void {
  if (typeof content === "string") {
    appendText(message, content, out);
    return;
  }
  if (!Array.isArray(content)) return;
  for (const [index, value] of content.entries()) {
    const block = asRecord(value);
    if (block?.type === "text" && typeof block.text === "string") {
      message.blocks.set(index, block.text);
    }
  }
  const text = assistantText(content);
  if (text.length > 0) {
    message.emitted = text;
    out.push({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: message.id, delta: text });
  }
}

/** Emits the part of a text block that has not been sent yet. */
function appendBlockText(
  message: MessageState,
  index: number,
  fullText: string,
  out: AGUIEvent[],
): void {
  const previous = message.blocks.get(index);
  if (previous === undefined) {
    message.blocks.set(index, fullText);
    if (fullText.length === 0) return;
    const separator = message.emitted.length > 0 ? "\n" : "";
    appendText(message, separator + fullText, out);
    return;
  }
  if (fullText.length <= previous.length) return;
  const delta = fullText.slice(previous.length);
  message.blocks.set(index, fullText);
  appendText(message, delta, out);
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
  out.push({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: message.id, delta });
}

function appendText(message: MessageState, delta: string, out: AGUIEvent[]): void {
  if (delta.length === 0) return;
  message.emitted += delta;
  out.push({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: message.id, delta });
}

function contentIndexOf(change: UnknownRecord): number {
  return typeof change.contentIndex === "number" ? change.contentIndex : 0;
}

function assistantText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return contentText(content);
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

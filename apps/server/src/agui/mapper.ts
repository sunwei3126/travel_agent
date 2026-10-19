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

/**
 * pi-durable partial assistant messages carry no id, so the run's streamed
 * assistant message uses one stable id for its start, deltas, and end.
 */
const ASSISTANT_MESSAGE_ID = "assistant";

type UnknownRecord = Record<string, unknown>;

const asRecord = (value: unknown): UnknownRecord | undefined =>
  typeof value === "object" && value !== null ? (value as UnknownRecord) : undefined;

const asText = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const asId = (value: unknown): string | undefined =>
  typeof value === "string" || typeof value === "number" ? String(value) : undefined;

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
 * Maps one pi-durable event batch (or one event) to AG-UI events. The initial
 * pi-durable `snapshot` event is ignored: `buildSnapshot` already supplied it.
 */
export function mapPiEvents(batch: PiEvent | PiEvent[]): AGUIEvent[] {
  const events: readonly unknown[] = Array.isArray(batch) ? batch : [batch];
  const mapped: AGUIEvent[] = [];
  for (const event of events) {
    const record = asRecord(event);
    if (record !== undefined) mapPiEvent(record, mapped);
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

function mapPiEvent(event: UnknownRecord, out: AGUIEvent[]): void {
  switch (event.type) {
    case "snapshot":
      return;

    case "message_start":
    case "text_start": {
      const message = asRecord(event.message);
      if (
        event.type === "text_start" ||
        message?.role === "assistant" ||
        asText(event.messageId) !== undefined
      ) {
        out.push({ type: EventType.TEXT_MESSAGE_START, messageId: messageIdOf(event) });
      }
      return;
    }

    case "message_update":
    case "text_delta": {
      const messageId = messageIdOf(event);
      const delta = asText(event.delta);
      if (delta !== undefined) {
        out.push({ type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta });
        return;
      }
      // Real pi-durable shape: the message text arrives as relative changes.
      const changes = Array.isArray(event.changes) ? event.changes : [];
      for (const value of changes) {
        const change = asRecord(value);
        if (change?.type === "text_start") {
          out.push({ type: EventType.TEXT_MESSAGE_START, messageId });
        } else if (change?.type === "text_delta" && typeof change.delta === "string") {
          out.push({ type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: change.delta });
        }
      }
      return;
    }

    case "message_end":
    case "text_end": {
      const entry = asRecord(event.entry);
      const message = Array.isArray(entry?.model) ? asRecord(entry.model[0]) : undefined;
      if (
        event.type === "text_end" ||
        message?.role === "assistant" ||
        asText(event.messageId) !== undefined
      ) {
        out.push({ type: EventType.TEXT_MESSAGE_END, messageId: messageIdOf(event) });
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

function messageIdOf(event: UnknownRecord): string {
  return asText(event.messageId) ?? ASSISTANT_MESSAGE_ID;
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

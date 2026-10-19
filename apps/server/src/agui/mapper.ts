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

type ReasoningState = {
  messageId: string;
  spanId: string;
  contentIndex: number;
  emitted: string;
  open: boolean;
  encryptedSent: boolean;
};

type MessageState = {
  id: string;
  /** Text already sent for this message, in the order it was sent. */
  emitted: string;
  /** Text already sent for each assistant-message content index. */
  blocks: Map<number, string>;
  reasoning: Map<number, ReasoningState>;
  toolCallsByIndex: Map<number, string>;
  /** Whether `TEXT_MESSAGE_START` was emitted and `TEXT_MESSAGE_END` is still due. */
  open: boolean;
};

type ToolTrace = {
  id: string;
  name: string;
  parentMessageId?: string;
  argsSent: string;
  started: boolean;
  ended: boolean;
  executing: boolean;
  taskId?: string;
  output: string;
};

type MapperState = {
  current: MessageState | undefined;
  sequence: number;
  /** Tool calls started in this run whose `TOOL_CALL_END` is still due. */
  activeTools: Set<string>;
  tools: Map<string, ToolTrace>;
};

const asRecord = (value: unknown): UnknownRecord | undefined =>
  typeof value === "object" && value !== null ? (value as UnknownRecord) : undefined;

const asText = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const asId = (value: unknown): string | undefined =>
  typeof value === "string" || typeof value === "number" ? String(value) : undefined;

/** Creates the per-run state needed for message ids and text already emitted. */
export function createPiEventMapper(): PiEventMapper {
  const state: MapperState = {
    current: undefined,
    sequence: 0,
    activeTools: new Set(),
    tools: new Map(),
  };
  return { map: (batch) => mapBatch(state, batch) };
}

/** Emits the conversation snapshot the AG-UI runtime starts from. */
export function buildSnapshot(input: SnapshotInput): AGUIEvent[] {
  return [
    {
      type: EventType.MESSAGES_SNAPSHOT,
      messages: toAguiMessages(input.entries),
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

/** Converts shared transcript entries into the AG-UI message shape. */
export function toAguiMessages(entries: TranscriptEntry[]): AguiMessage[] {
  return entries.map((entry) => {
    if (entry.role === "reasoning") {
      return {
        id: entry.id,
        role: "reasoning",
        content: entry.content,
        ...(entry.encryptedValue === undefined
          ? {}
          : { encryptedValue: entry.encryptedValue }),
      } as AguiMessage;
    }
    if (entry.role === "tool") {
      return {
        id: entry.id,
        role: "tool",
        content: entry.content,
        toolCallId: entry.toolCallId ?? entry.id,
        ...(entry.error === undefined ? {} : { error: entry.error }),
        ...(entry.name === undefined
          ? {}
          : {
              metadata: {
                "travel.tool": {
                  name: entry.name,
                  status: entry.error === undefined ? "ok" : "error",
                },
              },
            }),
      } as AguiMessage;
    }
    if (entry.role === "user") {
      return { id: entry.id, role: "user", content: entry.content } as AguiMessage;
    }
    return {
      id: entry.id,
      role: "assistant",
      ...(entry.content.length === 0 ? {} : { content: entry.content }),
      ...(entry.toolCalls === undefined || entry.toolCalls.length === 0
        ? {}
        : {
            toolCalls: entry.toolCalls.map((toolCall) => ({
              id: toolCall.id,
              type: "function" as const,
              function: {
                name: toolCall.name,
                arguments: toolCall.arguments,
              },
            })),
          }),
    } as AguiMessage;
  });
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

function mapPiEvent(state: MapperState, event: UnknownRecord, out: AGUIEvent[]): void {
  switch (event.type) {
    case "snapshot": {
      // Late attach: the durable snapshot may already carry an in-flight
      // generation partial. Seed it so later deltas are never content without
      // a preceding start.
      const generation = asRecord(event.generation);
      const message = asRecord(generation?.message);
      if (message?.role !== "assistant") return;
      const target = state.current ?? newMessage(state, undefined);
      appendMessageContent(state, target, message.content, out, false);
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
      if (source?.role === "assistant") {
        appendMessageContent(state, message, source.content, out, false);
      }
      return;
    }

    case "message_update":
    case "text_delta": {
      const message = ensureMessage(state, event);
      const delta = asText(event.delta);
      if (delta !== undefined) {
        closeReasoning(message, out);
        appendText(message, delta, out);
        return;
      }
      // Real pi-durable shape: the message text arrives as relative changes.
      const changes = Array.isArray(event.changes) ? event.changes : [];
      for (const value of changes) {
        const change = asRecord(value);
        if (change === undefined) continue;
        const index = contentIndexOf(change);

        if (change.type === "thinking_start") {
          const block = asRecord(change.block);
          if (block === undefined || !reasoningCovered(message, index, block)) {
            const reasoning = ensureReasoning(message, index, out);
            appendReasoningBlock(reasoning, block, out);
          }
        } else if (change.type === "thinking_delta" && typeof change.delta === "string") {
          const reasoning = ensureReasoning(message, index, out);
          appendReasoningDelta(reasoning, change.delta, out);
        } else if (change.type === "toolcall_start") {
          const block = asRecord(change.block);
          if (block?.type === "toolCall") {
            closeReasoning(message, out);
            startToolCallBlock(state, message, index, block, out);
          }
        } else if (change.type === "toolcall_delta") {
          // pi-durable sends value fragments (`path` + `delta`), not JSON.
          // Keep the call open and send the authoritative JSON at message_end
          // or tool_execution_start instead of corrupting the argument stream.
        } else if (change.type === "text_start" || change.type === "block") {
          const block = asRecord(change.block);
          if (block?.type === "thinking") {
            if (!reasoningCovered(message, index, block)) {
              const reasoning = ensureReasoning(message, index, out);
              appendReasoningBlock(reasoning, block, out);
            }
          } else if (block?.type === "text" && typeof block.text === "string") {
            closeReasoning(message, out);
            appendBlockText(message, index, block.text, out);
          } else if (block?.type === "toolCall") {
            closeReasoning(message, out);
            startToolCallBlock(state, message, index, block, out);
          }
        } else if (change.type === "text_delta" && typeof change.delta === "string") {
          closeReasoning(message, out);
          const previous = message.blocks.get(index) ?? "";
          appendBlockText(message, index, previous + change.delta, out);
        } else if (change.type === "message") {
          const full = asRecord(change.message);
          if (full?.role === "assistant") {
            appendMessageContent(state, message, full.content, out, false);
          }
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
        if (assistant) appendMessageContent(state, message, source!.content, out, true);
        closeReasoning(message, out);
        if (message.open) {
          out.push({ type: EventType.TEXT_MESSAGE_END, messageId: message.id });
          message.open = false;
        }
        state.current = undefined;
      }
      return;
    }

    case "tool_execution_start": {
      const toolCallId = asText(event.toolCallId);
      const toolCallName = asText(event.toolName);
      if (toolCallId !== undefined && toolCallName !== undefined) {
        const trace = startTool(state, toolCallId, toolCallName, undefined, out);
        trace.executing = true;
        const taskId = asId(event.taskId);
        if (taskId !== undefined) trace.taskId = taskId;
        appendToolArgs(trace, JSON.stringify(event.args ?? {}), out);
        endTool(state, trace, out);
      }
      return;
    }

    case "tool_execution_update": {
      const toolCallId = asText(event.toolCallId);
      if (toolCallId === undefined) return;
      const trace = state.tools.get(toolCallId);
      const output = asRecord(event.output);
      let text = trace?.output ?? "";
      if (output !== undefined) {
        if (typeof output.set === "string") {
          text = output.set;
        } else {
          const trimStart =
            typeof output.trimStart === "number" ? output.trimStart : 0;
          if (trimStart > 0) text = text.slice(trimStart);
          if (typeof output.append === "string") text += output.append;
        }
      }
      if (text.length > 16 * 1024) text = text.slice(-16 * 1024);
      if (trace !== undefined) trace.output = text;
      out.push({
        type: EventType.CUSTOM,
        name: "travel.tool_progress",
        value: {
          toolCallId,
          toolName: trace?.name ?? asText(event.toolName) ?? "tool",
          status: "running",
          output: text,
          ...(event.details === undefined ? {} : { details: event.details }),
          ...(event.diagnostics === undefined
            ? {}
            : { diagnostics: event.diagnostics }),
        },
      } as AGUIEvent);
      return;
    }

    case "tool_execution_end": {
      const toolCallId = asText(event.toolCallId);
      if (toolCallId === undefined) return;
      const trace = state.tools.get(toolCallId);
      if (trace !== undefined) endTool(state, trace, out);

      const isError = toolResultIsError(event);
      const content =
        toolResultContent(event) ||
        (isError ? "工具执行失败或未返回结果" : "");
      const name =
        trace?.name ?? asText(event.toolName) ?? "tool";
      const durationMs = toolResultDuration(event);
      out.push({
        type: EventType.TOOL_CALL_RESULT,
        messageId: toolResultMessageId(event, toolCallId),
        toolCallId,
        content,
        metadata: {
          "travel.tool": {
            name,
            status: isError ? "error" : "ok",
            ...(isError ? { error: content } : {}),
            ...(trace?.taskId === undefined ? {} : { taskId: trace.taskId }),
            ...(asText(event.parentToolCallId) === undefined
              ? {}
              : { parentToolCallId: asText(event.parentToolCallId) }),
            ...(durationMs === undefined ? {} : { durationMs }),
          },
        },
      } as AGUIEvent);
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
      } as AGUIEvent);
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
    reasoning: new Map(),
    toolCallsByIndex: new Map(),
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
  if (state.current !== undefined) {
    closeReasoning(state.current, out);
    if (state.current.open) {
      out.push({ type: EventType.TEXT_MESSAGE_END, messageId: state.current.id });
      state.current.open = false;
    }
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
function appendMessageContent(
  state: MapperState,
  message: MessageState,
  content: unknown,
  out: AGUIEvent[],
  final: boolean,
): void {
  if (typeof content === "string") {
    closeReasoning(message, out);
    appendSuffix(message, content, out);
    return;
  }
  if (!Array.isArray(content)) return;
  for (const [index, value] of content.entries()) {
    const block = asRecord(value);
    if (block === undefined) continue;
    if (block.type === "thinking") {
      // message_end replays blocks that already streamed. Do not open a new
      // reasoning span for text that was fully emitted before the replay.
      if (reasoningCovered(message, index, block)) continue;
      const reasoning = ensureReasoning(message, index, out);
      appendReasoningBlock(reasoning, block, out);
    } else if (block.type === "text" && typeof block.text === "string") {
      closeReasoning(message, out);
      appendBlockText(message, index, block.text, out);
    } else if (block.type === "toolCall") {
      closeReasoning(message, out);
      if (final) {
        finishToolCallBlock(state, message, index, block, out);
      } else {
        startToolCallBlock(state, message, index, block, out);
      }
    }
  }
}

/** Whether a thinking block replayed at message_end was already emitted. */
function reasoningCovered(
  message: MessageState,
  index: number,
  block: UnknownRecord,
): boolean {
  const existing = message.reasoning.get(index);
  if (existing === undefined) return false;
  if (block.redacted === true) {
    return existing.encryptedSent || existing.emitted.length > 0;
  }
  const text = typeof block.thinking === "string" ? block.thinking : "";
  return text.length <= existing.emitted.length;
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

/** Ensures a reasoning message/span exists and is open, emitting its starts. */
function ensureReasoning(
  message: MessageState,
  index: number,
  out: AGUIEvent[],
): ReasoningState {
  const existing = message.reasoning.get(index);
  if (existing?.open === true) return existing;

  const suffix =
    existing === undefined ? String(index) : `${index}-${message.reasoning.size}`;
  const messageId = `${message.id}-thinking-${suffix}`;
  const reasoning: ReasoningState = {
    messageId,
    spanId: `${messageId}-span`,
    contentIndex: index,
    // Carry emitted text so a reopened span only sends the new suffix.
    emitted: existing?.emitted ?? "",
    open: true,
    encryptedSent: existing?.encryptedSent ?? false,
  };
  message.reasoning.set(index, reasoning);
  out.push({
    type: EventType.REASONING_START,
    messageId: reasoning.spanId,
  } as AGUIEvent);
  out.push({
    type: EventType.REASONING_MESSAGE_START,
    messageId: reasoning.messageId,
    role: "reasoning",
  } as AGUIEvent);
  return reasoning;
}

function appendReasoningBlock(
  reasoning: ReasoningState,
  block: UnknownRecord | undefined,
  out: AGUIEvent[],
): void {
  if (block === undefined) return;
  if (block.redacted === true) {
    if (
      typeof block.thinkingSignature === "string" &&
      !reasoning.encryptedSent
    ) {
      reasoning.encryptedSent = true;
      out.push({
        type: EventType.REASONING_ENCRYPTED_VALUE,
        subtype: "message",
        entityId: reasoning.messageId,
        encryptedValue: block.thinkingSignature,
      } as AGUIEvent);
    }
    return;
  }
  if (typeof block.thinking === "string") {
    appendReasoningText(reasoning, block.thinking, out);
  }
}

function appendReasoningText(
  reasoning: ReasoningState,
  fullText: string,
  out: AGUIEvent[],
): void {
  if (fullText.length <= reasoning.emitted.length) return;
  const delta = fullText.slice(reasoning.emitted.length);
  reasoning.emitted = fullText;
  out.push({
    type: EventType.REASONING_MESSAGE_CONTENT,
    messageId: reasoning.messageId,
    delta,
  } as AGUIEvent);
}

function appendReasoningDelta(
  reasoning: ReasoningState,
  delta: string,
  out: AGUIEvent[],
): void {
  if (delta.length === 0) return;
  reasoning.emitted += delta;
  out.push({
    type: EventType.REASONING_MESSAGE_CONTENT,
    messageId: reasoning.messageId,
    delta,
  } as AGUIEvent);
}

/** Closes every open reasoning message/span for a message. */
function closeReasoning(message: MessageState, out: AGUIEvent[]): void {
  for (const reasoning of message.reasoning.values()) {
    if (!reasoning.open) continue;
    reasoning.open = false;
    out.push({
      type: EventType.REASONING_MESSAGE_END,
      messageId: reasoning.messageId,
    } as AGUIEvent);
    out.push({
      type: EventType.REASONING_END,
      messageId: reasoning.spanId,
    } as AGUIEvent);
  }
}

/** Starts a tool call from a streamed toolCall block, without arguments. */
function startToolCallBlock(
  state: MapperState,
  message: MessageState,
  index: number,
  block: UnknownRecord,
  out: AGUIEvent[],
): void {
  const toolCallId = asId(block.id);
  const name = asText(block.name);
  if (toolCallId === undefined || name === undefined) return;
  message.toolCallsByIndex.set(index, toolCallId);
  startTool(state, toolCallId, name, message.id, out);
}

/** Starts a tool call from a complete block and sends its full arguments. */
function finishToolCallBlock(
  state: MapperState,
  message: MessageState,
  index: number,
  block: UnknownRecord,
  out: AGUIEvent[],
): void {
  const toolCallId = asId(block.id);
  const name = asText(block.name);
  if (toolCallId === undefined || name === undefined) return;
  message.toolCallsByIndex.set(index, toolCallId);
  const trace = startTool(state, toolCallId, name, message.id, out);
  appendToolArgs(trace, JSON.stringify(block.arguments ?? {}), out);
  // The call stays active until tool_execution_start (or run_end) ends it.
}

function startTool(
  state: MapperState,
  id: string,
  name: string,
  parentMessageId: string | undefined,
  out: AGUIEvent[],
): ToolTrace {
  let trace = state.tools.get(id);
  if (trace === undefined) {
    trace = {
      id,
      name,
      parentMessageId,
      argsSent: "",
      started: false,
      ended: false,
      executing: false,
      output: "",
    };
    state.tools.set(id, trace);
  }
  if (!trace.started) {
    trace.started = true;
    state.activeTools.add(id);
    out.push({
      type: EventType.TOOL_CALL_START,
      toolCallId: id,
      toolCallName: name,
      ...(parentMessageId === undefined ? {} : { parentMessageId }),
    } as AGUIEvent);
  }
  return trace;
}

function appendToolArgs(trace: ToolTrace, fullJson: string, out: AGUIEvent[]): void {
  if (fullJson.length === 0) return;
  if (trace.argsSent.length === 0) {
    trace.argsSent = fullJson;
    out.push({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: trace.id,
      delta: fullJson,
    });
    return;
  }
  if (fullJson.startsWith(trace.argsSent)) {
    const delta = fullJson.slice(trace.argsSent.length);
    if (delta.length === 0) return;
    trace.argsSent = fullJson;
    out.push({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: trace.id,
      delta,
    });
  }
  // If the authoritative JSON is not an extension of what was streamed, keep
  // the streamed arguments rather than corrupting them.
}

function endTool(state: MapperState, trace: ToolTrace, out: AGUIEvent[]): void {
  if (trace.ended) return;
  trace.ended = true;
  state.activeTools.delete(trace.id);
  out.push({ type: EventType.TOOL_CALL_END, toolCallId: trace.id });
}

function toolResultMessageId(event: UnknownRecord, toolCallId: string): string {
  const entry = asRecord(event.entry);
  return asId(entry?.id) ?? `tool-result-${toolCallId}`;
}

function toolResultIsError(event: UnknownRecord): boolean {
  const entry = asRecord(event.entry);
  const message = Array.isArray(entry?.model) ? asRecord(entry.model[0]) : undefined;
  if (message?.isError === true) return true;
  const result = asRecord(event.result);
  return result?.isError === true;
}

function toolResultDuration(event: UnknownRecord): number | undefined {
  const entry = asRecord(event.entry);
  const message = Array.isArray(entry?.model) ? asRecord(entry.model[0]) : undefined;
  if (typeof message?.durationMs === "number") return message.durationMs;
  return typeof event.durationMs === "number" ? event.durationMs : undefined;
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

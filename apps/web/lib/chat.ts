import type {
  AssistantMessage,
  Message,
  ReasoningMessage,
  ToolCall,
  ToolMessage,
  UserMessage,
} from "@ag-ui/core";

export type ToolTrace = {
  call: ToolCall;
  result?: ToolMessage;
};

export type ChatSegment =
  | { kind: "user"; message: UserMessage }
  | { kind: "reasoning"; message: ReasoningMessage }
  | { kind: "assistant"; message: AssistantMessage; tools: ToolTrace[] }
  | { kind: "orphan-tool"; message: ToolMessage };

export type ToolStatus = "running" | "ok" | "error" | "unfinished";

/** Groups assistant tool calls with their tool results and sorts the transcript. */
export function buildChatSegments(messages: readonly Message[]): ChatSegment[] {
  const results = new Map<string, ToolMessage>();
  for (const message of messages) {
    if (message.role === "tool") results.set(message.toolCallId, message);
  }

  const consumed = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const call of message.toolCalls ?? []) consumed.add(call.id);
  }

  const segments: ChatSegment[] = [];
  for (const message of messages) {
    switch (message.role) {
      case "user":
        segments.push({ kind: "user", message });
        break;
      case "reasoning":
        segments.push({ kind: "reasoning", message });
        break;
      case "assistant": {
        const tools = (message.toolCalls ?? []).map((call) => {
          const result = results.get(call.id);
          return { call, result };
        });
        segments.push({ kind: "assistant", message, tools });
        break;
      }
      case "tool":
        if (!consumed.has(message.toolCallId)) {
          segments.push({ kind: "orphan-tool", message });
        }
        break;
      default:
        break;
    }
  }
  return segments;
}

/** Derives the visible status of one tool call. */
export function toolStatus(trace: ToolTrace, isLoading: boolean): ToolStatus {
  if (trace.result !== undefined) {
    if (trace.result.error !== undefined && trace.result.error !== "") {
      return "error";
    }
    if (toolErrorEnvelope(trace.result.content) !== undefined) return "error";
    const metadata = trace.result.metadata as
      | Record<string, unknown>
      | undefined;
    const toolMetadata = metadata?.["travel.tool"] as
      | Record<string, unknown>
      | undefined;
    if (toolMetadata?.status === "error") return "error";
    return "ok";
  }
  if (isLoading) return "running";
  return "unfinished";
}

export function toolStatusLabel(status: ToolStatus): string {
  switch (status) {
    case "running":
      return "运行中";
    case "ok":
      return "已完成";
    case "error":
      return "失败";
    case "unfinished":
      return "未完成";
  }
}

/**
 * `@ag-ui/claude-agent-sdk` serializes a failed tool result as
 * `{"error":true,"content":"..."}`; the content is omitted when the tool
 * returned no message.
 */
function toolErrorEnvelope(
  content: ToolMessage["content"],
): { error: true; content?: string } | undefined {
  if (typeof content !== "string" || !content.trimStart().startsWith("{")) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || !("error" in parsed)) {
    return undefined;
  }
  if (parsed.error !== true) return undefined;
  const text = "content" in parsed ? parsed.content : undefined;
  return typeof text === "string" && text.length > 0
    ? { error: true, content: text }
    : { error: true };
}

/** Pretty-prints a JSON string, keeping the raw value when it is not JSON. */
export function prettyJson(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

const TOOL_LABELS: Record<string, string> = {
  trip_update_brief: "更新行程信息",
  deepseek_search: "搜索资料",
  deepseek_fetch: "读取网页",
  plan_emit_day: "生成日程",
  sketch_day: "绘制草图",
  plan_finalize: "完成规划",
};

export function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name;
}

/** Flattens AG-UI tool result content into displayable text. */
export function toolResultText(content: ToolMessage["content"]): string {
  const envelope = toolErrorEnvelope(content);
  if (envelope !== undefined) {
    return envelope.content ?? "工具执行失败，未返回原因。";
  }
  if (typeof content === "string") return content;
  return content
    .map((part) => (part.type === "text" ? part.text : `[${part.type}]`))
    .join("\n");
}

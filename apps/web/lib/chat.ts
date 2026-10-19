import type {
  AssistantMessage,
  Message,
  ReasoningMessage,
  ToolCall,
  ToolMessage,
  UserMessage,
} from "@ag-ui/core";

export type ToolProgress = {
  output: string;
  details?: unknown;
  diagnostics?: unknown;
};

export type ToolTrace = {
  call: ToolCall;
  result?: ToolMessage;
  progress?: ToolProgress;
};

export type ChatSegment =
  | { kind: "user"; message: UserMessage }
  | { kind: "reasoning"; message: ReasoningMessage }
  | { kind: "assistant"; message: AssistantMessage; tools: ToolTrace[] }
  | { kind: "orphan-tool"; message: ToolMessage };

export type ToolStatus = "running" | "ok" | "error" | "unfinished";

/** Groups assistant tool calls with their tool results and sorts the transcript. */
export function buildChatSegments(
  messages: readonly Message[],
  progress?: ReadonlyMap<string, ToolProgress>,
): ChatSegment[] {
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
          return {
            call,
            result,
            progress: result === undefined ? progress?.get(call.id) : undefined,
          };
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
    const metadata = trace.result.metadata as
      | Record<string, unknown>
      | undefined;
    const toolMetadata = metadata?.["travel.tool"] as
      | Record<string, unknown>
      | undefined;
    if (toolMetadata?.status === "error") return "error";
    return "ok";
  }
  if (trace.progress !== undefined || isLoading) return "running";
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
  if (typeof content === "string") return content;
  return content
    .map((part) => (part.type === "text" ? part.text : `[${part.type}]`))
    .join("\n");
}

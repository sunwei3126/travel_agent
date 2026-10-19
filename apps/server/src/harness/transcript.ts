import { contentText } from "@earendil-works/pi-ai";
import type { TranscriptEntry, TranscriptToolCall } from "@pi-demo/shared";

type TranscriptSourceEntry = {
  id: string | number;
  model?: readonly unknown[];
};

type UnknownRecord = Record<string, unknown>;

const asRecord = (value: unknown): UnknownRecord | undefined =>
  typeof value === "object" && value !== null ? (value as UnknownRecord) : undefined;

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

/** Converts committed transcript entries into the shared, UI-facing shape. */
export function toTranscriptEntries(
  entries: readonly TranscriptSourceEntry[],
): TranscriptEntry[] {
  const result: TranscriptEntry[] = [];

  for (const entry of entries) {
    const message = asRecord(entry.model?.[0]);
    if (message === undefined) continue;
    const id = String(entry.id);

    if (message.role === "user") {
      result.push({
        id,
        role: "user",
        content: contentText(message.content as never),
      });
      continue;
    }

    if (message.role === "toolResult") {
      const content = contentText(message.content as never);
      result.push({
        id,
        role: "tool",
        content,
        toolCallId: asString(message.toolCallId) ?? id,
        ...(asString(message.toolName) === undefined
          ? {}
          : { name: asString(message.toolName) }),
        ...(message.isError === true
          ? { error: content.length > 0 ? content : "工具执行失败" }
          : {}),
      });
      continue;
    }

    if (message.role !== "assistant") continue;

    const blocks = Array.isArray(message.content) ? message.content : [];
    const toolCalls: TranscriptToolCall[] = [];

    for (const [index, value] of blocks.entries()) {
      const block = asRecord(value);
      if (block === undefined) continue;
      if (block.type === "thinking") {
        const thinking = asString(block.thinking);
        if (thinking !== undefined) {
          result.push({
            id: `${id}-thinking-${index}`,
            role: "reasoning",
            content: thinking,
            ...(block.redacted === true && typeof block.thinkingSignature === "string"
              ? { encryptedValue: block.thinkingSignature }
              : {}),
          });
        }
      } else if (block.type === "toolCall") {
        const toolCallId = asString(block.id);
        const name = asString(block.name);
        if (toolCallId !== undefined && name !== undefined) {
          toolCalls.push({
            id: toolCallId,
            name,
            arguments: JSON.stringify(block.arguments ?? {}),
          });
        }
      }
    }

    const content = contentText(message.content as never);
    if (content.length > 0 || toolCalls.length > 0) {
      result.push({
        id,
        role: "assistant",
        content,
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
      });
    }
  }

  return result;
}

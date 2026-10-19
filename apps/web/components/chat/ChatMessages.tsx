import { contentToText, type ToolCall } from "@ag-ui/core";
import type { ChatSegment } from "../../lib/chat";
import { ReasoningBlock } from "./ReasoningBlock";
import { ToolCallBlock } from "./ToolCallBlock";

function orphanName(metadata: unknown): string {
  if (typeof metadata !== "object" || metadata === null) return "tool";
  const tool = (metadata as Record<string, unknown>)["travel.tool"];
  if (typeof tool !== "object" || tool === null) return "tool";
  const name = (tool as Record<string, unknown>).name;
  return typeof name === "string" && name.length > 0 ? name : "tool";
}

export function ChatMessages({
  segments,
  isLoading,
}: {
  segments: ChatSegment[];
  isLoading: boolean;
}) {
  if (segments.length === 0) {
    return <p className="empty">还没有消息，先说说你的旅行需求吧。</p>;
  }

  return (
    <div className="chat-messages">
      {segments.map((segment) => {
        switch (segment.kind) {
          case "user":
            return (
              <div key={segment.message.id} className="chat-message chat-message-user">
                {contentToText(segment.message.content)}
              </div>
            );
          case "reasoning":
            return (
              <ReasoningBlock
                key={segment.message.id}
                content={segment.message.content}
                encrypted={segment.message.encryptedValue !== undefined}
              />
            );
          case "assistant":
            if (
              (segment.message.content === undefined ||
                segment.message.content.length === 0) &&
              segment.tools.length === 0
            ) {
              return null;
            }
            return (
              <div key={segment.message.id} className="chat-message chat-message-assistant">
                {segment.message.content !== undefined &&
                  segment.message.content.length > 0 && (
                    <div className="chat-bubble">{segment.message.content}</div>
                  )}
                {segment.tools.map((trace) => (
                  <ToolCallBlock
                    key={trace.call.id}
                    trace={trace}
                    isLoading={isLoading}
                  />
                ))}
              </div>
            );
          case "orphan-tool": {
            const call: ToolCall = {
              id: segment.message.toolCallId,
              type: "function",
              function: {
                name: orphanName(segment.message.metadata),
                arguments: "",
              },
            };
            return (
              <ToolCallBlock
                key={segment.message.id}
                trace={{ call, result: segment.message }}
                isLoading={isLoading}
              />
            );
          }
        }
      })}
    </div>
  );
}

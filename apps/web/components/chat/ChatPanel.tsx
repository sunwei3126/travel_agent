"use client";

import { useCopilotChatInternal } from "@copilotkit/react-core";
import { useDefaultRenderTool } from "@copilotkit/react-core/v2";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { buildChatSegments } from "../../lib/chat";
import { ChatMessages } from "./ChatMessages";

export function ChatPanel() {
  // CopilotKit's own message views render tool calls too; give them a
  // renderer so dev builds do not warn about our custom panel.
  useDefaultRenderTool({});

  const { messages, sendMessage, stopGeneration, isLoading, isAvailable } =
    useCopilotChatInternal();

  const [input, setInput] = useState("");
  const [sendError, setSendError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottom = useRef(true);

  const segments = useMemo(() => buildChatSegments(messages), [messages]);

  useEffect(() => {
    const element = scrollRef.current;
    if (element === null) return;
    if (stickToBottom.current) element.scrollTop = element.scrollHeight;
  }, [segments]);

  const onScroll = (): void => {
    const element = scrollRef.current;
    if (element === null) return;
    stickToBottom.current =
      element.scrollHeight - element.scrollTop - element.clientHeight < 40;
  };

  const send = async (): Promise<void> => {
    const content = input.trim();
    if (content.length === 0 || isLoading) return;
    setInput("");
    setSendError(null);
    try {
      await sendMessage({
        id: `user-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        role: "user",
        content,
      });
    } catch (error) {
      setSendError(error instanceof Error ? error.message : String(error));
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) {
      return;
    }
    event.preventDefault();
    void send();
  };

  return (
    <section className="chat-panel" aria-label="旅行助手">
      <header className="chat-header">
        <h2>旅行助手</h2>
        {isLoading && (
          <span className="chat-status chat-status-running">
            助手正在思考…
          </span>
        )}
      </header>

      {sendError !== null && (
        <p className="chat-error" role="alert">
          发送失败：{sendError}
        </p>
      )}

      <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
        <ChatMessages segments={segments} isLoading={isLoading} />
      </div>

      <div className="chat-composer">
        <textarea
          className="chat-input"
          placeholder="说说你想去哪、玩几天、在意什么"
          rows={2}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={onKeyDown}
        />
        {isLoading ? (
          <button
            type="button"
            className="chat-stop"
            onClick={() => stopGeneration()}
          >
            停止
          </button>
        ) : (
          <button
            type="button"
            className="chat-send"
            disabled={input.trim().length === 0}
            onClick={() => void send()}
          >
            发送
          </button>
        )}
      </div>
    </section>
  );
}

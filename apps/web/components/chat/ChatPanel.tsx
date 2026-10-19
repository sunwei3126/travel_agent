"use client";

import { useCopilotChatInternal } from "@copilotkit/react-core";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { getTranscript } from "../../lib/api";
import {
  buildChatSegments,
  type ToolProgress,
} from "../../lib/chat";
import { ChatMessages } from "./ChatMessages";

export function ChatPanel({ tripId }: { tripId: string }) {
  const {
    messages,
    sendMessage,
    stopGeneration,
    isLoading,
    isAvailable,
    setMessages,
    agent,
  } = useCopilotChatInternal();

  const [input, setInput] = useState("");
  const [sendError, setSendError] = useState<string | null>(null);
  const [progress, setProgress] = useState<Map<string, ToolProgress>>(
    () => new Map(),
  );
  const historyLoaded = useRef(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottom = useRef(true);

  useEffect(() => {
    if (!isAvailable || messages.length > 0 || historyLoaded.current) return;
    historyLoaded.current = true;
    void getTranscript(tripId)
      .then((history) => {
        if (history.length > 0) setMessages(history);
      })
      .catch(() => {
        // The next run's MESSAGES_SNAPSHOT restores the transcript.
      });
  }, [isAvailable, messages.length, setMessages, tripId]);

  useEffect(() => {
    if (agent === undefined || agent === null) return;
    const subscription = agent.subscribe({
      onCustomEvent: ({ event }) => {
        if (event.name !== "travel.tool_progress") return;
        const value = event.value as
          | { toolCallId?: unknown; output?: unknown }
          | undefined;
        if (
          typeof value?.toolCallId !== "string" ||
          typeof value.output !== "string"
        ) {
          return;
        }
        setProgress((previous) => {
          const next = new Map(previous);
          next.set(value.toolCallId as string, {
            output: value.output as string,
          });
          return next;
        });
      },
    });
    return () => {
      subscription.unsubscribe();
    };
  }, [agent]);

  useEffect(() => {
    if (isLoading) return;
    setProgress((previous) => (previous.size === 0 ? previous : new Map()));
  }, [isLoading]);

  const segments = useMemo(
    () => buildChatSegments(messages, progress),
    [messages, progress],
  );

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

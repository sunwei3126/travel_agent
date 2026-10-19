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
import { getTranscript, getTrip } from "../../lib/api";
import {
  buildChatSegments,
  type ToolProgress,
} from "../../lib/chat";
import { ChatMessages } from "./ChatMessages";

export function ChatPanel({ tripId }: { tripId: string }) {
  // CopilotKit's own message views render tool calls too; give them a
  // renderer so dev builds do not warn about our custom panel.
  useDefaultRenderTool({});

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
    if (!isAvailable || historyLoaded.current) return;
    // A live conversation may already be in memory when the runtime becomes
    // available; do not replace it with committed history.
    if (messages.length > 0) return;
    historyLoaded.current = true;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const refresh = async (): Promise<void> => {
      const history = await getTranscript(tripId);
      if (!cancelled && history.length > 0) setMessages(history);
    };

    // A reload during a run only sees committed entries; keep checking the
    // durable snapshot and refresh the chat once the run finishes.
    const waitForRunEnd = async (): Promise<void> => {
      try {
        const trip = await getTrip(tripId);
        if (cancelled) return;
        if (trip.running) {
          timer = setTimeout(() => void waitForRunEnd(), 2000);
          return;
        }
        await refresh();
      } catch {
        timer = setTimeout(() => void waitForRunEnd(), 2000);
      }
    };

    void (async () => {
      try {
        const [history, trip] = await Promise.all([
          getTranscript(tripId),
          getTrip(tripId),
        ]);
        if (cancelled) return;
        if (history.length > 0) setMessages(history);
        if (trip.running) timer = setTimeout(() => void waitForRunEnd(), 2000);
      } catch {
        // The next run's MESSAGES_SNAPSHOT restores the transcript.
      }
    })();

    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
    // `messages` is intentionally read once: later updates are live state, not
    // a reason to refetch history.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAvailable, setMessages, tripId]);

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

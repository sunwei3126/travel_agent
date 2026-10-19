import {
  prettyJson,
  toolLabel,
  toolResultText,
  toolStatus,
  toolStatusLabel,
  type ToolTrace,
} from "../../lib/chat";

export function ToolCallBlock({
  trace,
  isLoading,
}: {
  trace: ToolTrace;
  isLoading: boolean;
}) {
  const status = toolStatus(trace, isLoading);
  const name = trace.call.function.name;
  const resultText =
    trace.result === undefined ? undefined : toolResultText(trace.result.content);
  const bodyText =
    status === "error" ? (trace.result?.error ?? resultText) : resultText;

  return (
    <details
      className={`chat-trace chat-tool${status === "error" ? " chat-trace-error" : ""}`}
      data-testid="tool-call"
    >
      <summary className="chat-trace-summary">
        工具调用 · {toolLabel(name)} ·{" "}
        <span className={`chat-status chat-status-${status}`}>
          {toolStatusLabel(status)}
        </span>
        <span className="chat-tool-name">（{name}）</span>
      </summary>
      <div className="chat-trace-body">
        <div className="chat-trace-section">
          <span className="chat-trace-label">参数</span>
          <pre>{prettyJson(trace.call.function.arguments)}</pre>
        </div>
        {bodyText !== undefined && (
          <div className="chat-trace-section">
            <span className="chat-trace-label">
              {status === "error" ? "错误" : "结果"}
            </span>
            <pre>{bodyText}</pre>
          </div>
        )}
        {trace.progress !== undefined && trace.progress.output.length > 0 && (
          <div className="chat-trace-section">
            <span className="chat-trace-label">实时输出</span>
            <pre>{trace.progress.output}</pre>
          </div>
        )}
      </div>
    </details>
  );
}

export function ReasoningBlock({
  content,
  encrypted = false,
}: {
  content: string;
  encrypted?: boolean;
}) {
  const streaming = content.length === 0 && !encrypted;
  const text =
    encrypted && (content.length === 0 || content === "[Reasoning redacted]")
      ? "该模型的思考过程已隐藏。"
      : streaming
        ? "思考中…"
        : content;

  return (
    <details className="chat-trace" data-testid="reasoning-block">
      <summary className="chat-trace-summary">
        {streaming ? "思考中…" : `思考过程 · ${text.length} 字`}
      </summary>
      <pre className="chat-trace-body">{text}</pre>
    </details>
  );
}

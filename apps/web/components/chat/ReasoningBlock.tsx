export function ReasoningBlock({
  content,
  encrypted = false,
}: {
  content: string;
  encrypted?: boolean;
}) {
  const text =
    encrypted && (content.length === 0 || content === "[Reasoning redacted]")
      ? "该模型的思考过程已隐藏。"
      : content.length === 0
        ? "思考中…"
        : content;

  return (
    <details className="chat-trace" data-testid="reasoning-block">
      <summary className="chat-trace-summary">思考过程 · {text.length} 字</summary>
      <pre className="chat-trace-body">{text}</pre>
    </details>
  );
}

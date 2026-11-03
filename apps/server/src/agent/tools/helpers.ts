import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) {
    if (error === undefined || error === null) return "Tool failed";
    const text = String(error).trim();
    return text.length > 0 ? text : "Tool failed";
  }
  const message = error.message.trim();
  if (message.length > 0) return message;
  return error.name !== "Error" ? `${error.name} without a message` : "Tool failed without a message";
}

export function errorResult(error: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: describeError(error) }],
    isError: true,
  };
}

/** Runs a tool body; a thrown error becomes an `isError` result instead of failing the run. */
export async function guarded(
  body: () => CallToolResult | Promise<CallToolResult>,
): Promise<CallToolResult> {
  try {
    return await body();
  } catch (error) {
    return errorResult(error);
  }
}

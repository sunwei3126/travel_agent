import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

export function errorResult(error: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
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

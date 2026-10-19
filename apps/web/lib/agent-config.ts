const DEFAULT_AGENT_URL = "http://127.0.0.1:4000/agui";

export function createAgentConfig(
  tripId: string,
  baseUrl = process.env.AGENT_URL ?? DEFAULT_AGENT_URL,
): { url: string } {
  return { url: `${baseUrl}?tripId=${encodeURIComponent(tripId)}` };
}

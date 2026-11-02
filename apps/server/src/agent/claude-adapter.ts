import { ClaudeAgentAdapter } from "@ag-ui/claude-agent-sdk";
import type { RunAgentInput } from "@ag-ui/client";
import { claudeEnv, dataPaths, thinkingOption, type ServerConfig } from "../config";
import type { TripStore } from "../store/trip-store";
import type { TravelDeps } from "./deps";
import { TRAVEL_SERVER_NAME, createTravelMcpServer } from "./mcp";
import type { AdapterFactory } from "./travel-agent";

/**
 * The SDK adapter creates its per-thread bookkeeping (`bindings`, `admitted`,
 * `activeQueries`, `sessions`) only in the constructor, and `AbstractAgent.clone()`
 * does not run constructors — CopilotKit clones the agent for every request, so a
 * clone would carry `undefined` fields and `run()` would throw. Re-create them.
 */
export class TravelClaudeAdapter extends ClaudeAgentAdapter {
  override clone(): TravelClaudeAdapter {
    const copy = super.clone() as TravelClaudeAdapter;
    const fields = copy as unknown as Record<string, unknown>;
    fields.bindings = new Map();
    fields.admitted = new Set();
    fields.activeQueries = new Map();
    fields.sessions = new Map();
    return copy;
  }

  /**
   * The trip lives in the `TripStore` and the model may call only the six travel
   * tools, so drop the AG-UI `state`/`tools` inputs: either one would make the
   * adapter register its `ag_ui` MCP server, append its state addendum to the
   * system prompt, and auto-grant tools outside the trip surface.
   */
  override buildOptions(...args: Parameters<ClaudeAgentAdapter["buildOptions"]>) {
    const [input, ...rest] = args;
    const { state: _state, tools: _tools, ...withoutAgUi } = input;
    // `RunAgentInput.state` is required by the protocol type, but the SDK reads a
    // missing state as "no shared state"; the cast drops it deliberately.
    return super.buildOptions(withoutAgUi as RunAgentInput, ...rest);
  }
}

/** One adapter per run: built-in tools off, only the trip-bound travel tools granted. */
export function createClaudeAdapterFactory(options: {
  config: ServerConfig;
  store: TripStore;
  deps: TravelDeps;
}): AdapterFactory {
  const { config, store, deps } = options;
  const paths = dataPaths(config);
  return ({ tripId, systemPrompt }) => {
    const { server, allowedTools } = createTravelMcpServer({ tripId, store, deps });
    return new TravelClaudeAdapter({
      agentId: "travel",
      model: config.model.modelId,
      systemPrompt,
      tools: [],
      mcpServers: { [TRAVEL_SERVER_NAME]: server },
      allowedTools,
      permissionMode: "dontAsk",
      settingSources: [],
      cwd: paths.workspace,
      env: claudeEnv(config),
      thinking: thinkingOption(config.model.thinkingLevel),
    });
  };
}

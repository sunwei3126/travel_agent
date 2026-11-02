import type { AbstractAgent } from "@ag-ui/client";
import { CopilotRuntime, createCopilotRuntimeHandler } from "@copilotkit/runtime/v2";
import { createCopilotNodeHandler } from "@copilotkit/runtime/v2/node";
import { SqliteAgentRunner } from "@copilotkit/sqlite-runner";
import type { NodeHandler } from "./http/routes/copilotkit";

export const AGENT_ID = "travel";
export const COPILOTKIT_BASE_PATH = "/api/copilotkit";

/**
 * The CopilotKit runtime for the travel agent. Thread history lives in the
 * runner's SQLite file; `connect` replays it and re-attaches to a live run.
 */
export function createTravelRuntime(options: {
  agent: AbstractAgent;
  threadsDbPath: string;
}): { runner: SqliteAgentRunner; handler: NodeHandler } {
  const runner = new SqliteAgentRunner({ dbPath: options.threadsDbPath });
  const runtime = new CopilotRuntime({ agents: { [AGENT_ID]: options.agent }, runner });
  const handler = createCopilotNodeHandler(
    createCopilotRuntimeHandler({ runtime, basePath: COPILOTKIT_BASE_PATH }),
  );
  return { runner, handler };
}

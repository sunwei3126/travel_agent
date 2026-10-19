import { HttpAgent } from "@ag-ui/client";
import {
  CopilotRuntime,
  copilotRuntimeNextJSAppRouterEndpoint,
} from "@copilotkit/runtime";
import { createAgentConfig } from "../../../../lib/agent-config";

type RouteContext = { params: Promise<{ tripId: string }> };

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const { tripId } = await context.params;
  const agent = new HttpAgent(createAgentConfig(tripId));
  // @copilotkit/runtime and @copilotkit/shared bundle separate @ag-ui/client
  // copies. Their private `_debug` field makes the otherwise identical agent
  // classes nominally incompatible, so accept the 1.0.3 agent structurally.
  const runtime = new CopilotRuntime({
    agents: { travel: agent },
  } as unknown as ConstructorParameters<typeof CopilotRuntime>[0]);
  const { handleRequest } = copilotRuntimeNextJSAppRouterEndpoint({
    runtime,
    endpoint: "/api/copilotkit",
  });

  return handleRequest(request);
}

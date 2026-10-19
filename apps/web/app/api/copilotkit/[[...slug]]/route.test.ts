import { beforeEach, describe, expect, it, vi } from "vitest";

const { handleRequestMock, agentConfigs, runtimeOptions, endpointOptions } =
  vi.hoisted(() => ({
    handleRequestMock: vi.fn(),
    agentConfigs: [] as unknown[],
    runtimeOptions: [] as unknown[],
    endpointOptions: [] as unknown[],
  }));

vi.mock("@ag-ui/client", () => ({
  HttpAgent: class {
    constructor(config: unknown) {
      agentConfigs.push(config);
    }
  },
}));

vi.mock("@copilotkit/runtime", () => ({
  CopilotRuntime: class {
    constructor(options: unknown) {
      runtimeOptions.push(options);
    }
  },
  copilotRuntimeNextJSAppRouterEndpoint: (options: unknown) => {
    endpointOptions.push(options);
    return { handleRequest: handleRequestMock };
  },
}));

vi.mock("../../../../lib/agent-config", () => ({
  createAgentConfig: (tripId: string) => ({ url: `agent://${tripId}` }),
}));

import { DELETE, GET, POST, PUT } from "./route";

describe("copilotkit catch-all route", () => {
  beforeEach(() => {
    handleRequestMock.mockReset();
    handleRequestMock.mockResolvedValue(new Response("ok"));
    agentConfigs.length = 0;
    runtimeOptions.length = 0;
    endpointOptions.length = 0;
  });

  it("exports the methods the CopilotKit client requests", () => {
    expect(GET).toBeTypeOf("function");
    expect(POST).toBeTypeOf("function");
    expect(PUT).toBeTypeOf("function");
    expect(DELETE).toBeTypeOf("function");
  });

  it("returns 400 when the trip id is missing", async () => {
    const response = await GET(new Request("http://localhost/api/copilotkit"), {
      params: Promise.resolve({}),
    });

    expect(response.status).toBe(400);
    expect(handleRequestMock).not.toHaveBeenCalled();
  });

  it("takes the trip id from the first slug segment", async () => {
    const request = new Request("http://localhost/api/copilotkit/539/info");
    const response = await POST(request, {
      params: Promise.resolve({ slug: ["539", "info"] }),
    });

    expect(response.status).toBe(200);
    expect(agentConfigs).toEqual([{ url: "agent://539" }]);
    expect(runtimeOptions).toEqual([
      { agents: { travel: expect.anything() } },
    ]);
    expect(endpointOptions).toEqual([
      { runtime: expect.anything(), endpoint: "/api/copilotkit" },
    ]);
    expect(handleRequestMock).toHaveBeenCalledWith(request);
  });
});

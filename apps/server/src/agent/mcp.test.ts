import { describe, expect, it } from "vitest";
import { TRAVEL_SERVER_NAME, buildTravelTools, createTravelMcpServer } from "./mcp";
import { makeContext } from "./tools/test-support";

describe("travel MCP server", () => {
  it("exposes exactly the six travel tools", () => {
    const names = buildTravelTools(makeContext()).map((tool) => tool.name);
    expect(names).toEqual([
      "trip_update_brief",
      "plan_emit_day",
      "plan_finalize",
      "deepseek_search",
      "deepseek_fetch",
      "sketch_day",
    ]);
  });

  it("builds an in-process server and grants only its own tools", () => {
    const { server, allowedTools } = createTravelMcpServer(makeContext());
    expect(server.type).toBe("sdk");
    expect(server.name).toBe(TRAVEL_SERVER_NAME);
    expect(allowedTools).toEqual(
      buildTravelTools(makeContext()).map((tool) => `mcp__travel__${tool.name}`),
    );
  });
});

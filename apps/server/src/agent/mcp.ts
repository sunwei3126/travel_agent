import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { ToolContext } from "./deps";
import { createEmitDayTool } from "./tools/emit-day";
import { createFetchTool } from "./tools/fetch";
import { createFinalizeTool } from "./tools/finalize";
import { createSearchTool } from "./tools/search";
import { createSketchDayTool } from "./tools/sketch-day";
import { createUpdateBriefTool } from "./tools/update-brief";

export const TRAVEL_SERVER_NAME = "travel";

export function buildTravelTools(ctx: ToolContext) {
  return [
    createUpdateBriefTool(ctx),
    createEmitDayTool(ctx),
    createFinalizeTool(ctx),
    createSearchTool(ctx),
    createFetchTool(ctx),
    createSketchDayTool(ctx),
  ];
}

/** An in-process MCP server bound to one trip, plus the allow-list that grants only its tools. */
export function createTravelMcpServer(ctx: ToolContext) {
  const tools = buildTravelTools(ctx);
  return {
    server: createSdkMcpServer({ name: TRAVEL_SERVER_NAME, version: "1.0.0", tools }),
    allowedTools: tools.map((tool) => `mcp__${TRAVEL_SERVER_NAME}__${tool.name}`),
  };
}

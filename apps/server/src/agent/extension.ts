import { defineExtension, type Extension } from "@earendil-works/pi-durable";
import type { TravelDeps } from "./deps";
import { createEmitDayTool } from "./tools/emit-day";
import { createFetchTool } from "./tools/fetch";
import { finalizeTool } from "./tools/finalize";
import { createSearchTool } from "./tools/search";
import { createSketchDayTool } from "./tools/sketch-day";
import { updateBriefTool } from "./tools/update-brief";

export type { TravelDeps } from "./deps";

export function createTravelExtension(deps: TravelDeps): Extension {
  return defineExtension({
    name: "travel",
    tools: [
      updateBriefTool,
      createEmitDayTool(deps),
      finalizeTool,
      createSearchTool(deps),
      createFetchTool(deps),
      createSketchDayTool(deps),
    ],
  });
}

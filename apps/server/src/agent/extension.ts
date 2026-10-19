import { defineExtension, type Extension } from "@earendil-works/pi-durable";
import { createEmitDayTool } from "./tools/emit-day";
import { finalizeTool } from "./tools/finalize";
import { updateBriefTool } from "./tools/update-brief";

export type TravelDeps = { now: () => Date };

export function createTravelExtension(deps: TravelDeps): Extension {
  return defineExtension({
    name: "travel",
    tools: [updateBriefTool, createEmitDayTool(deps), finalizeTool],
  });
}

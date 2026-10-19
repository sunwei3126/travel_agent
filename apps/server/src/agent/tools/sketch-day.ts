import { defineTool } from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";
import { TripPlanDoc } from "../../trips/docs";
import type { TravelDeps } from "../deps";

const parameters = Type.Object({
  dayIndex: Type.Number({ description: "1-based day number to sketch" }),
});

export function createSketchDayTool(deps: TravelDeps) {
  return defineTool({
    name: "sketch_day",
    description: "Generate an SVG sketch for one day card and store it on that card.",
    parameters,
    structuredOutputSchema: Type.Object({
      status: Type.Union([Type.Literal("ok"), Type.Literal("failed")]),
    }),
    replay: "safe",
    execute: async (args, api, context) => {
      const plan = await api.snapshot(TripPlanDoc, api.conversationId, context);
      const day = plan?.days.find((card) => card.dayIndex === args.dayIndex);
      if (!day) {
        throw new Error(
          `Cannot sketch day ${args.dayIndex}: no day card with that dayIndex`,
        );
      }

      const sketch = await deps.generateSketch(day);

      await api.commit(async (tx) => {
        const currentPlan = await tx.doc(TripPlanDoc, api.conversationId);
        const card = currentPlan.days.find(
          (candidate) => candidate.dayIndex === args.dayIndex,
        );
        if (!card) {
          throw new Error(
            `Cannot sketch day ${args.dayIndex}: no day card with that dayIndex`,
          );
        }
        card.svg = sketch.svg;
        card.svgStatus = sketch.status;
      }, context);

      return {
        output: [
          {
            type: "text",
            text: `Sketch for day ${args.dayIndex} is ${sketch.status}.`,
          },
        ],
        structuredOutput: { status: sketch.status },
      };
    },
  });
}

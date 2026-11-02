import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { ToolContext } from "../deps";
import { guarded, textResult } from "./helpers";

const shape = {
  dayIndex: z.number().describe("1-based day number to sketch"),
};

export function createSketchDayTool(ctx: ToolContext) {
  return tool(
    "sketch_day",
    "Generate an SVG sketch for one day card and store it on that card.",
    shape,
    (args) =>
      guarded(async () => {
        const missing = `Cannot sketch day ${args.dayIndex}: no day card with that dayIndex`;
        const day = ctx.store
          .getDoc(ctx.tripId, "plan")
          .days.find((card) => card.dayIndex === args.dayIndex);
        if (!day) throw new Error(missing);

        const sketch = await ctx.deps.generateSketch(day);

        ctx.store.transaction(() => {
          const plan = ctx.store.getDoc(ctx.tripId, "plan");
          const card = plan.days.find((candidate) => candidate.dayIndex === args.dayIndex);
          if (!card) throw new Error(missing);
          card.svg = sketch.svg;
          card.svgStatus = sketch.status;
          ctx.store.setDoc(ctx.tripId, "plan", plan);
        });

        return textResult(`Sketch for day ${args.dayIndex} is ${sketch.status}.`);
      }),
  );
}

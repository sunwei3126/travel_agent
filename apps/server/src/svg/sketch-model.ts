import { query } from "@anthropic-ai/claude-agent-sdk";
import { claudeEnv, dataPaths, type ServerConfig } from "../config";

const SKETCH_SYSTEM_PROMPT = "You produce a single SVG illustration. Reply with the SVG markup only.";

/** One tool-less, single-turn model call; used by `generateDaySketch`. */
export function createSketchGenerator(
  config: ServerConfig,
  run: typeof query = query,
): (prompt: string) => Promise<string> {
  const paths = dataPaths(config);
  return async (prompt) => {
    let result: string | undefined;
    for await (const message of run({
      prompt,
      options: {
        model: config.model.modelId,
        systemPrompt: SKETCH_SYSTEM_PROMPT,
        tools: [],
        maxTurns: 1,
        permissionMode: "dontAsk",
        settingSources: [],
        cwd: paths.sketchWorkspace,
        env: claudeEnv(config),
        thinking: { type: "disabled" },
      },
    })) {
      if (message.type !== "result") continue;
      if (message.subtype !== "success" || message.is_error) {
        throw new Error(`Sketch generation failed (${message.subtype})`);
      }
      result = message.result;
    }
    if (result === undefined) throw new Error("Sketch generation produced no result");
    return result;
  };
}

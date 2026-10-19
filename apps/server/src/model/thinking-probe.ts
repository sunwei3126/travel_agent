import type {
  Api,
  Model,
  ModelThinkingLevel,
  Models,
} from "@earendil-works/pi-ai";

export type ThinkingProbeResult = {
  supported: boolean;
  hasThinking: boolean;
  error?: string;
  sample?: string;
};

/** Asks the model for a short reasoning reply and reports whether thinking arrived. */
export async function probeThinkingSupport(
  models: Models,
  model: Model<string>,
  level: ModelThinkingLevel,
  timeoutMs = 30_000,
): Promise<ThinkingProbeResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const reasoning = level === "off" ? undefined : level;
  try {
    const result = await Promise.race([
      models.completeSimple(
        model as Model<Api>,
        {
          messages: [
            {
              role: "user",
              content: "Think step by step, then answer with the single word OK.",
              timestamp: Date.now(),
            },
          ],
        },
        reasoning === undefined ? undefined : { reasoning },
      ),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("thinking probe timed out")),
          timeoutMs,
        );
      }),
    ]);

    const thinking = result.content
      .filter((block) => block.type === "thinking")
      .map((block) => block.thinking)
      .join("");

    return {
      supported: true,
      hasThinking: thinking.length > 0,
      ...(thinking.length === 0 ? {} : { sample: thinking.slice(0, 200) }),
    };
  } catch (error) {
    return {
      supported: false,
      hasThinking: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

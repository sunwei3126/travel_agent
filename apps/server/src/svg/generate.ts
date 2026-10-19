import type { DayCard } from "@pi-demo/shared";
import { placeholderSvg } from "./placeholder";
import { validateAndSanitizeSvg } from "./validate";

/** Builds the model prompt for one day's SVG sketch. */
function buildPrompt(day: DayCard): string {
  const stops = day.blocks.slice(0, 5).map((block) => `- ${block.title}`);
  return [
    "Create a single illustration for one day of a travel itinerary.",
    `Day ${day.dayIndex}: ${day.title}`,
    ...(stops.length > 0 ? ["Highlights:", ...stops] : []),
    "Return valid SVG only. Include an xmlns and a viewBox no larger than 1200x800.",
    "Do not include scripts, event handlers, or external references.",
  ].join("\n");
}

type Attempt =
  | { ok: true; svg: string; raw: string }
  | { ok: false; reason: string; raw: string };

async function attempt(
  generate: (prompt: string) => Promise<string>,
  prompt: string,
): Promise<Attempt> {
  let raw: string;
  try {
    raw = await generate(prompt);
  } catch (error) {
    // A thrown generation error is a failed attempt, not an escape hatch that
    // skips the retry and placeholder path.
    return {
      ok: false,
      raw: "",
      reason: error instanceof Error ? error.message : "Sketch generation failed",
    };
  }
  const validated = validateAndSanitizeSvg(raw);
  if (!validated.ok) {
    return { ok: false, raw, reason: validated.reason };
  }
  return { ok: true, svg: validated.svg, raw };
}

export async function generateDaySketch(opts: {
  day: DayCard;
  generate: (prompt: string) => Promise<string>;
}): Promise<{ svg: string; status: "ok" | "failed"; error?: string }> {
  const prompt = buildPrompt(opts.day);

  const first = await attempt(opts.generate, prompt);
  if (first.ok) {
    return { svg: first.svg, status: "ok" };
  }

  const retryPrompt = [
    prompt,
    "",
    `The previous response was rejected: ${first.reason}`,
    ...(first.raw.length > 0 ? ["Previous response:", first.raw, ""] : []),
    "Return corrected SVG only.",
  ].join("\n");

  const second = await attempt(opts.generate, retryPrompt);
  if (second.ok) {
    return { svg: second.svg, status: "ok" };
  }

  return {
    svg: placeholderSvg(`Day ${opts.day.dayIndex} · ${opts.day.title}`),
    status: "failed",
    error: second.reason,
  };
}

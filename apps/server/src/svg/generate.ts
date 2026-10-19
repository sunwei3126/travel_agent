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

export async function generateDaySketch(opts: {
  day: DayCard;
  generate: (prompt: string) => Promise<string>;
}): Promise<{ svg: string; status: "ok" | "failed"; error?: string }> {
  const prompt = buildPrompt(opts.day);

  const firstRaw = await opts.generate(prompt);
  const first = validateAndSanitizeSvg(firstRaw);
  if (first.ok) {
    return { svg: first.svg, status: "ok" };
  }

  const retryPrompt = [
    prompt,
    "",
    `The previous response was rejected: ${first.reason}`,
    "Previous response:",
    firstRaw,
    "",
    "Return corrected SVG only.",
  ].join("\n");

  const secondRaw = await opts.generate(retryPrompt);
  const second = validateAndSanitizeSvg(secondRaw);
  if (second.ok) {
    return { svg: second.svg, status: "ok" };
  }

  return {
    svg: placeholderSvg(`Day ${opts.day.dayIndex} · ${opts.day.title}`),
    status: "failed",
    error: second.reason,
  };
}

import { isBriefComplete, missingBriefFields } from "@pi-demo/shared";
import type { Claim, DayCard, TripBrief, TripSources } from "@pi-demo/shared";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function dateOnly(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function validateBrief(brief: TripBrief, now: Date): string[] {
  const errors = missingBriefFields(brief);

  if (
    typeof brief.startDate === "string" &&
    DATE_PATTERN.test(brief.startDate) &&
    brief.startDate < dateOnly(now)
  ) {
    errors.push("startDate must not be in the past");
  }

  if (typeof brief.days === "number" && brief.days < 1) {
    errors.push("days must be at least 1");
  }

  return errors;
}

function claimErrors(claims: Claim[], sources: TripSources): string[] {
  const errors: string[] = [];
  for (const claim of claims) {
    if (claim.kind !== "fact" || claim.unverified) continue;
    if (claim.sourceIds.length === 0) {
      errors.push(`claim has no source: ${claim.text}`);
      continue;
    }
    for (const id of claim.sourceIds) {
      if (!(id in sources)) {
        errors.push(`claim references unknown source: ${id}`);
      }
    }
  }
  return errors;
}

export function validateDayCard(card: DayCard, sources: TripSources, brief: TripBrief): string[] {
  const errors: string[] = [];

  if (!isBriefComplete(brief)) {
    errors.push("brief is incomplete");
  }

  if (card.dayIndex < 1) {
    errors.push("dayIndex must be at least 1");
  }

  if (card.date.trim().length === 0) {
    errors.push("date is required");
  }

  const [low, high] = card.estimatedCostCny;
  if (low < 0 || high < 0) {
    errors.push("costs must be non-negative");
  }
  if (low > high) {
    errors.push("cost low must not exceed high");
  }

  errors.push(
    ...claimErrors(card.blocks.flatMap((block) => block.claims), sources),
    ...claimErrors(card.scenery, sources),
    ...claimErrors(card.food, sources),
    ...claimErrors(card.transport, sources),
  );

  return errors;
}

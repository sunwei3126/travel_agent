import { isBriefComplete, missingBriefFields } from "@pi-demo/shared";
import type { Claim, DayCard, TripBrief, TripSources } from "@pi-demo/shared";
import { isVerifiedFact } from "../research/freshness";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function dateOnly(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Whether a YYYY-MM-DD string names a real calendar day. */
export function isValidCalendarDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export type ValidateBriefOptions = {
  /**
   * Whether the brief must already contain every required field. Creation and
   * incremental updates pass `false`: they only enforce the date/day rules,
   * while the completeness guard stays in `plan_emit_day`.
   */
  requireComplete?: boolean;
};

export function validateBrief(
  brief: TripBrief,
  now: Date,
  options: ValidateBriefOptions = {},
): string[] {
  const requireComplete = options.requireComplete ?? true;
  const errors = requireComplete ? missingBriefFields(brief) : [];

  if (typeof brief.startDate === "string" && brief.startDate.length > 0) {
    if (!isValidCalendarDate(brief.startDate)) {
      errors.push("startDate must be a real calendar date (YYYY-MM-DD)");
    } else if (brief.startDate < dateOnly(now)) {
      errors.push("startDate must not be in the past");
    }
  }

  if (typeof brief.days === "number" && (!Number.isInteger(brief.days) || brief.days < 1)) {
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
      const source = sources[id];
      if (source === undefined) {
        errors.push(`claim references unknown source: ${id}`);
      } else if (!isVerifiedFact(source)) {
        // A search snippet is only a lead. Hard facts require the fetched page.
        errors.push(
          `claim cites an unfetched source (fetch the page before treating it as a fact): ${id}`,
        );
      }
    }
  }
  return errors;
}

function costErrors(cost: [number, number], label: string): string[] {
  const [low, high] = cost;
  const errors: string[] = [];
  if (!Number.isFinite(low) || !Number.isFinite(high)) {
    errors.push(`${label} must be finite numbers`);
    return errors;
  }
  if (low < 0 || high < 0) {
    errors.push(`${label} costs must be non-negative`);
  }
  if (low > high) {
    errors.push(`${label} cost low must not exceed high`);
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

  errors.push(...costErrors(card.estimatedCostCny, "estimatedCostCny"));
  card.blocks.forEach((block, index) => {
    if (block.costCny !== undefined) {
      errors.push(...costErrors(block.costCny, `blocks[${index}].costCny`));
    }
  });

  errors.push(
    ...claimErrors(card.blocks.flatMap((block) => block.claims), sources),
    ...claimErrors(card.scenery, sources),
    ...claimErrors(card.food, sources),
    ...claimErrors(card.transport, sources),
  );

  return errors;
}

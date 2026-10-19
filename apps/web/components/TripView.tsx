"use client";

import { useCoAgent } from "@copilotkit/react-core";
import {
  missingBriefFields,
  type TripPlan,
  type TripSnapshot,
  type TripState,
} from "@pi-demo/shared";
import { useTripSnapshot } from "../hooks/useTripSnapshot";
import { BriefChecklist } from "./BriefChecklist";
import { BudgetSummary } from "./BudgetSummary";
import { PlanBoard } from "./PlanBoard";
import { ResearchProgress } from "./ResearchProgress";
import { TravelChat } from "./TravelChat";

function newestDayUpdatedAt(plan: TripPlan): string {
  return plan.days.reduce(
    (newest, day) => (day.updatedAt > newest ? day.updatedAt : newest),
    "",
  );
}

function hasNewerPlan(
  live: TripState | undefined,
  durable: TripSnapshot,
): live is TripState {
  if (live == null || live.plan == null) return false;
  const liveUpdatedAt = newestDayUpdatedAt(live.plan);
  return (
    liveUpdatedAt.length > 0 &&
    liveUpdatedAt > newestDayUpdatedAt(durable.plan)
  );
}

function TripViewContent({
  tripId,
  initial,
}: {
  tripId: string;
  initial?: TripSnapshot;
}) {
  const { state, running: agentRunning } = useCoAgent<TripState>({
    name: "travel",
  });
  const { snapshot } = useTripSnapshot(tripId, agentRunning);

  const durable = snapshot ?? initial;
  if (durable === undefined) {
    return <p className="empty">加载中…</p>;
  }

  const live = hasNewerPlan(state, durable) ? state : undefined;
  const brief = live?.brief ?? durable.brief;
  const plan = live?.plan ?? durable.plan;
  const research = live?.research ?? durable.research;

  return (
    <div className="trip-view">
      <section aria-labelledby="brief-heading">
        <h2 id="brief-heading">行程信息</h2>
        <BriefChecklist missing={missingBriefFields(brief)} />
      </section>

      <ResearchProgress
        searchCount={research.searchCount}
        fetchCount={research.fetchCount}
        running={live?.research?.running ?? durable.running}
      />

      <section aria-labelledby="plan-heading" className="plan-board">
        <h2 id="plan-heading">行程计划</h2>
        <PlanBoard plan={plan} />
      </section>

      {plan.budget !== undefined && <BudgetSummary budget={plan.budget} />}
    </div>
  );
}

export function TripView({
  tripId,
  initial,
}: {
  tripId: string;
  initial?: TripSnapshot;
}) {
  return (
    <TravelChat tripId={tripId}>
      <TripViewContent tripId={tripId} initial={initial} />
    </TravelChat>
  );
}

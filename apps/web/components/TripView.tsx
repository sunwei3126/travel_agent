"use client";

import { useCoAgent } from "@copilotkit/react-core";
import {
  missingBriefFields,
  type TripSnapshot,
  type TripState,
} from "@pi-demo/shared";
import { useTripSnapshot } from "../hooks/useTripSnapshot";
import { BriefChecklist } from "./BriefChecklist";
import { BudgetSummary } from "./BudgetSummary";
import { PlanBoard } from "./PlanBoard";
import { ResearchProgress } from "./ResearchProgress";
import { TravelChat } from "./TravelChat";

type LiveTripState = TripState & { updatedAt?: string };

function hasNewerUpdatedAt(
  live: LiveTripState | undefined,
  durable: TripSnapshot,
): live is LiveTripState {
  return (
    live != null &&
    typeof live.updatedAt === "string" &&
    live.updatedAt > durable.trip.updatedAt
  );
}

function TripViewContent({
  tripId,
  initial,
}: {
  tripId: string;
  initial?: TripSnapshot;
}) {
  const { snapshot } = useTripSnapshot(tripId);
  const { state } = useCoAgent<LiveTripState>({ name: "travel" });

  const durable = snapshot ?? initial;
  if (durable === undefined) {
    return <p className="empty">加载中…</p>;
  }

  const live = hasNewerUpdatedAt(state, durable) ? state : undefined;
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

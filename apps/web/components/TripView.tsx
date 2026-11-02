"use client";

import { useCopilotChatInternal } from "@copilotkit/react-core";
import {
  missingBriefFields,
  type TripFault,
  type TripSnapshot,
} from "@pi-demo/shared";
import { useTripSnapshot } from "../hooks/useTripSnapshot";
import { BriefChecklist } from "./BriefChecklist";
import { BudgetSummary } from "./BudgetSummary";
import { PlanBoard } from "./PlanBoard";
import { ResearchProgress } from "./ResearchProgress";
import { TravelChat } from "./TravelChat";

function faultTitle(fault: TripFault): string {
  if (fault.kind === "recovery") return "任务恢复失败";
  return fault.kind === "claude.run" ? "生成任务已暂停" : "工具任务已暂停";
}

function TripViewContent({
  tripId,
  initial,
}: {
  tripId: string;
  initial?: TripSnapshot;
}) {
  // `useCopilotChatHeadless_c` is license-gated and becomes non-functional
  // without a public API key. Use the same free hook CopilotChat uses.
  const { sendMessage, isLoading } = useCopilotChatInternal();
  const { snapshot, error, loading, retry } = useTripSnapshot(tripId, isLoading);

  const durable = snapshot ?? initial;
  if (durable === undefined) {
    if (error !== null) {
      return (
        <div className="trip-error" role="alert">
          <p>{`加载行程失败：${error}`}</p>
          <button type="button" onClick={retry}>
            重试
          </button>
        </div>
      );
    }
    return <p className="empty">{loading ? "加载中…" : "暂无行程数据。"}</p>;
  }

  const { brief, plan, research, sources } = durable;
  const faults = durable.faults ?? [];

  const send = (content: string): void => {
    void sendMessage({
      id: `day-action-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      role: "user",
      content,
    });
  };

  return (
    <div className="trip-view">
      {error !== null && (
        <div className="trip-error" role="alert">
          <p>{`刷新行程失败：${error}`}</p>
          <button type="button" onClick={retry}>
            重试
          </button>
        </div>
      )}

      {faults.length > 0 && (
        <div className="trip-fault" role="alert" data-testid="trip-fault">
          <strong>{faultTitle(faults[faults.length - 1])}</strong>
          <p>{faults[faults.length - 1].message}</p>
          <button type="button" onClick={() => send("请重试刚才失败的任务。")}>
            重试任务
          </button>
        </div>
      )}

      <section aria-labelledby="brief-heading">
        <h2 id="brief-heading">行程信息</h2>
        <BriefChecklist missing={missingBriefFields(brief)} />
      </section>

      <ResearchProgress
        searchCount={research.searchCount}
        fetchCount={research.fetchCount}
        running={durable.running}
      />

      <section aria-labelledby="plan-heading" className="plan-board">
        <h2 id="plan-heading">行程计划</h2>
        <PlanBoard
          plan={plan}
          sources={sources}
          onRedraw={(dayIndex) =>
            send(`请重画第 ${dayIndex} 天的草图，其他天不要动。`)
          }
          onEditDay={(dayIndex) =>
            send(`我想修改第 ${dayIndex} 天，请只调整这一天。先问我具体想怎么改。`)
          }
        />
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

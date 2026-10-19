import type { TripPlan, TripSources } from "@pi-demo/shared";
import { DayCard } from "./DayCard";

export function PlanBoard({
  plan,
  sources,
  onRedraw,
  onEditDay,
}: {
  plan: TripPlan;
  sources?: TripSources;
  onRedraw?: (dayIndex: number) => void;
  onEditDay?: (dayIndex: number) => void;
}) {
  const days = [...plan.days].sort((a, b) => a.dayIndex - b.dayIndex);

  if (days.length === 0) {
    return <p className="empty">行程计划将在这里生成。</p>;
  }

  return (
    <div
      className="plan-board-list"
      style={{ display: "grid", gap: "1rem" }}
    >
      {days.map((card) => (
        <DayCard
          key={`${card.dayIndex}-${card.date}`}
          card={card}
          sources={sources}
          onRedraw={onRedraw}
          onEditDay={onEditDay}
        />
      ))}
    </div>
  );
}

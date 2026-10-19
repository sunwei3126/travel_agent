import type { TripPlan } from "@pi-demo/shared";
import { DayCard } from "./DayCard";

export function PlanBoard({ plan }: { plan: TripPlan }) {
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
        <DayCard key={`${card.dayIndex}-${card.date}`} card={card} />
      ))}
    </div>
  );
}

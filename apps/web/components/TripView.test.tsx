import type { TripSnapshot } from "@pi-demo/shared";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

const { snapshot } = vi.hoisted((): { snapshot: TripSnapshot } => {
  const day = (dayIndex: number) => ({
    dayIndex,
    date: `2026-10-${25 + dayIndex}`,
    title: `第 ${dayIndex} 天`,
    blocks: [],
    scenery: [],
    food: [],
    transport: [],
    estimatedCostCny: [100, 200] as [number, number],
    sources: [],
    svgStatus: "ok" as const,
    updatedAt: "2026-10-19T00:00:00.000Z",
  });

  return {
    snapshot: {
      trip: {
        tripId: "t1",
        conversationId: "c1",
        title: "泰山",
        destination: "泰山",
        startDate: "2026-10-26",
        days: 3,
        updatedAt: "2026-10-19T00:00:00.000Z",
        status: "active",
      },
      brief: {
        origin: "上海虹桥火车站",
        startDate: "2026-10-26",
        days: 3,
        budgetCny: 3000,
        companions: "自己",
        fitness: "average",
        interests: ["风景", "美食"],
      },
      plan: {
        days: [day(1), day(2), day(3)],
        budget: { low: 2000, high: 2800, cap: 3000, withinBudget: true },
      },
      sources: {},
      research: { searchCount: 12, fetchCount: 5 },
      running: false,
    },
  };
});

vi.mock("@copilotkit/react-core", () => ({
  useCoAgent: () => ({ state: {}, running: false }),
  CopilotKit: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@copilotkit/react-ui", () => ({
  CopilotChat: ({ labels }: { labels?: { title?: string } }) => (
    <div>{labels?.title}</div>
  ),
}));

vi.mock("../hooks/useTripSnapshot", () => ({
  useTripSnapshot: () => ({ snapshot, error: null, loading: false }),
}));

import { TripView } from "./TripView";

describe("TripView", () => {
  it("shows the chat, cards, missing fields, research counts, and budget", () => {
    render(<TripView tripId="t1" initial={snapshot} />);

    expect(screen.getByText("旅行助手")).toBeInTheDocument();
    expect(screen.getAllByTestId("day-card")).toHaveLength(3);
    expect(screen.getByText("目的地")).toBeInTheDocument();
    expect(screen.getByText(/搜索 12/)).toBeInTheDocument();
    expect(screen.getByText(/¥3000/)).toBeInTheDocument();
  });
});

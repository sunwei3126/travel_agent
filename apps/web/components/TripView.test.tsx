import type { TripSnapshot } from "@pi-demo/shared";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  snapshot,
  useCoAgentMock,
  useTripSnapshotMock,
  sendMessageMock,
  retryMock,
} = vi.hoisted((): {
  snapshot: TripSnapshot;
  useCoAgentMock: ReturnType<typeof vi.fn>;
  useTripSnapshotMock: ReturnType<typeof vi.fn>;
  sendMessageMock: ReturnType<typeof vi.fn>;
  retryMock: ReturnType<typeof vi.fn>;
} => {
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
    useCoAgentMock: vi.fn(),
    useTripSnapshotMock: vi.fn(),
    sendMessageMock: vi.fn().mockResolvedValue(undefined),
    retryMock: vi.fn(),
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
  useCoAgent: useCoAgentMock,
  useCopilotChatHeadless_c: () => ({ sendMessage: sendMessageMock }),
  CopilotKit: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@copilotkit/react-ui", () => ({
  CopilotChat: ({ labels }: { labels?: { title?: string } }) => (
    <div>{labels?.title}</div>
  ),
}));

vi.mock("../hooks/useTripSnapshot", () => ({
  useTripSnapshot: useTripSnapshotMock,
}));

import { fireEvent } from "@testing-library/react";
import { TripView } from "./TripView";

describe("TripView", () => {
  beforeEach(() => {
    useCoAgentMock.mockReset();
    useCoAgentMock.mockReturnValue({ state: {}, running: false });
    useTripSnapshotMock.mockReset();
    useTripSnapshotMock.mockReturnValue({
      snapshot,
      error: null,
      loading: false,
      retry: retryMock,
    });
    sendMessageMock.mockClear();
    retryMock.mockClear();
  });

  it("shows the chat, cards, missing fields, research counts, and budget", () => {
    render(<TripView tripId="t1" initial={snapshot} />);

    expect(screen.getByText("旅行助手")).toBeInTheDocument();
    expect(screen.getAllByTestId("day-card")).toHaveLength(3);
    expect(screen.getByText("目的地")).toBeInTheDocument();
    expect(screen.getByText(/搜索 12/)).toBeInTheDocument();
    expect(screen.getByText(/¥3000/)).toBeInTheDocument();
  });

  it("prefers live state when its day cards are newer", () => {
    useCoAgentMock.mockReturnValue({
      running: false,
      state: {
        brief: snapshot.brief,
        plan: {
          days: [
            {
              ...snapshot.plan.days[0],
              title: "实时第一天",
              updatedAt: "2026-10-20T00:00:00.000Z",
            },
          ],
        },
        sources: {},
        research: { searchCount: 20, fetchCount: 9, running: false },
      },
    });

    render(<TripView tripId="t1" initial={snapshot} />);

    expect(screen.getByText("实时第一天")).toBeInTheDocument();
    expect(screen.getAllByTestId("day-card")).toHaveLength(1);
    expect(screen.getByText(/搜索 20/)).toBeInTheDocument();
  });

  it("shows a load error with a retry action", () => {
    useTripSnapshotMock.mockReturnValue({
      snapshot: null,
      error: "network down",
      loading: false,
      retry: retryMock,
    });

    render(<TripView tripId="t1" />);

    expect(screen.getByRole("alert")).toHaveTextContent("network down");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(retryMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the cards and shows a transient refresh error", () => {
    useTripSnapshotMock.mockReturnValue({
      snapshot,
      error: "temporary failure",
      loading: false,
      retry: retryMock,
    });

    render(<TripView tripId="t1" initial={snapshot} />);

    expect(screen.getAllByTestId("day-card")).toHaveLength(3);
    expect(screen.getByText(/temporary failure/)).toBeInTheDocument();
  });

  it("sends targeted day actions through the chat", () => {
    render(<TripView tripId="t1" initial={snapshot} />);

    fireEvent.click(screen.getAllByRole("button", { name: "改这一天" })[0]);

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock.mock.calls[0][0]).toMatchObject({
      role: "user",
      content: expect.stringContaining("第 1 天"),
    });
  });

  it("offers a redraw action for a failed sketch", () => {
    useTripSnapshotMock.mockReturnValue({
      snapshot: {
        ...snapshot,
        plan: {
          ...snapshot.plan,
          days: [
            { ...snapshot.plan.days[0], svg: undefined, svgStatus: "failed" },
            snapshot.plan.days[1],
            snapshot.plan.days[2],
          ],
        },
      },
      error: null,
      loading: false,
      retry: retryMock,
    });

    render(<TripView tripId="t1" initial={snapshot} />);
    fireEvent.click(screen.getByRole("button", { name: "重画" }));

    expect(sendMessageMock.mock.calls[0][0].content).toContain("第 1 天");
  });

  it("surfaces a parked task fault and retries it", () => {
    useTripSnapshotMock.mockReturnValue({
      snapshot: {
        ...snapshot,
        faults: [
          {
            kind: "pi.tool",
            message: "工具超时",
            at: "2026-10-19T00:00:00.000Z",
          },
        ],
      },
      error: null,
      loading: false,
      retry: retryMock,
    });

    render(<TripView tripId="t1" initial={snapshot} />);

    expect(screen.getByTestId("trip-fault")).toHaveTextContent("工具任务已暂停");
    expect(screen.getByTestId("trip-fault")).toHaveTextContent("工具超时");
    fireEvent.click(screen.getByRole("button", { name: "重试任务" }));
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the durable state when live day cards are older", () => {
    useCoAgentMock.mockReturnValue({
      running: false,
      state: {
        brief: snapshot.brief,
        plan: {
          days: [
            {
              ...snapshot.plan.days[0],
              title: "旧实时",
              updatedAt: "2026-10-18T00:00:00.000Z",
            },
          ],
        },
        sources: {},
        research: { searchCount: 99, fetchCount: 0, running: false },
      },
    });

    render(<TripView tripId="t1" initial={snapshot} />);

    expect(screen.queryByText("旧实时")).not.toBeInTheDocument();
    expect(screen.getAllByTestId("day-card")).toHaveLength(3);
    expect(screen.getByText(/搜索 12/)).toBeInTheDocument();
    expect(screen.queryByText(/搜索 99/)).not.toBeInTheDocument();
  });
});

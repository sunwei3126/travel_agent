import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@copilotkit/react-core", () => ({
  CopilotKit: ({
    runtimeUrl,
    agent,
    threadId,
    useSingleEndpoint,
    children,
  }: {
    runtimeUrl: string;
    agent: string;
    threadId: string;
    useSingleEndpoint: boolean;
    children: ReactNode;
  }) => (
    <div
      data-testid="copilotkit"
      data-runtime-url={runtimeUrl}
      data-agent={agent}
      data-thread-id={threadId}
      data-single-endpoint={String(useSingleEndpoint)}
    >
      {children}
    </div>
  ),
}));

vi.mock("./chat/ChatPanel", () => ({
  ChatPanel: ({ tripId }: { tripId: string }) => (
    <div data-testid="chat-panel" data-trip-id={tripId}>
      旅行助手
    </div>
  ),
}));

import { TravelChat } from "./TravelChat";

describe("TravelChat", () => {
  it("mounts CopilotKit against the backend runtime with the trip as the thread", () => {
    render(<TravelChat tripId="abc" />);

    const provider = screen.getByTestId("copilotkit");
    expect(provider).toHaveAttribute("data-runtime-url", "/backend/api/copilotkit");
    expect(provider).toHaveAttribute("data-agent", "travel");
    expect(provider).toHaveAttribute("data-thread-id", "abc");
    expect(provider).toHaveAttribute("data-single-endpoint", "false");
    expect(screen.getByTestId("chat-panel")).toHaveAttribute("data-trip-id", "abc");
    expect(screen.getByText("旅行助手")).toBeInTheDocument();
  });

  it("passes the trip id through unchanged as the thread id", () => {
    render(<TravelChat tripId="a/b c" />);

    expect(screen.getByTestId("copilotkit")).toHaveAttribute("data-thread-id", "a/b c");
  });
});

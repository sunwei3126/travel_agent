import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { createAgentConfig } from "../lib/agent-config";

vi.mock("@copilotkit/react-core", () => ({
  CopilotKit: ({
    runtimeUrl,
    agent,
    children,
  }: {
    runtimeUrl: string;
    agent: string;
    children: ReactNode;
  }) => (
    <div data-testid="copilotkit" data-runtime-url={runtimeUrl} data-agent={agent}>
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

describe("createAgentConfig", () => {
  it("builds a per-trip agent URL", () => {
    expect(createAgentConfig("abc").url).toBe(
      "http://127.0.0.1:4000/agui?tripId=abc",
    );
  });
});

describe("TravelChat", () => {
  it("mounts CopilotKit against the per-trip runtime with Chinese labels", () => {
    render(<TravelChat tripId="abc" />);

    expect(screen.getByTestId("copilotkit")).toHaveAttribute(
      "data-runtime-url",
      "/api/copilotkit/abc",
    );
    expect(screen.getByTestId("copilotkit")).toHaveAttribute(
      "data-agent",
      "travel",
    );
    expect(screen.getByTestId("chat-panel")).toHaveAttribute(
      "data-trip-id",
      "abc",
    );
    expect(screen.getByText("旅行助手")).toBeInTheDocument();
  });

  it("encodes the trip id in the runtime URL", () => {
    render(<TravelChat tripId="a/b c" />);

    expect(screen.getByTestId("copilotkit")).toHaveAttribute(
      "data-runtime-url",
      "/api/copilotkit/a%2Fb%20c",
    );
  });
});

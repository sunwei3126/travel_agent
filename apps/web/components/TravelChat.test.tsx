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

vi.mock("@copilotkit/react-ui", () => ({
  CopilotChat: ({
    labels,
  }: {
    labels?: { title?: string; placeholder?: string };
  }) => (
    <div
      data-testid="copilot-chat"
      data-title={labels?.title}
      data-placeholder={labels?.placeholder}
    />
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
    expect(screen.getByTestId("copilot-chat")).toHaveAttribute(
      "data-placeholder",
      "说说你想去哪、玩几天、在意什么",
    );
    expect(screen.getByTestId("copilot-chat")).toHaveAttribute(
      "data-title",
      "旅行助手",
    );
  });

  it("encodes the trip id in the runtime URL", () => {
    render(<TravelChat tripId="a/b c" />);

    expect(screen.getByTestId("copilotkit")).toHaveAttribute(
      "data-runtime-url",
      "/api/copilotkit/a%2Fb%20c",
    );
  });
});

import type { Message } from "@ag-ui/core";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const chat = vi.hoisted(() => ({ hook: vi.fn() }));
vi.mock("@copilotkit/react-core", () => ({
  useCopilotChatInternal: chat.hook,
}));
vi.mock("@copilotkit/react-core/v2", () => ({
  useDefaultRenderTool: vi.fn(),
}));

import { ChatPanel } from "./ChatPanel";

const messages: Message[] = [
  { id: "u1", role: "user", content: "泰山三天" },
  { id: "r1", role: "reasoning", content: "先想一下" },
  {
    id: "a1",
    role: "assistant",
    content: "你好",
    toolCalls: [
      {
        id: "tc1",
        type: "function",
        function: { name: "deepseek_search", arguments: '{"query":"泰山"}' },
      },
    ],
  },
  { id: "t1", role: "tool", toolCallId: "tc1", content: "找到 3 条" },
];

function setup(overrides: Record<string, unknown> = {}) {
  const sendMessage = vi.fn(async () => {});
  const stopGeneration = vi.fn();
  chat.hook.mockReturnValue({
    messages,
    sendMessage,
    stopGeneration,
    isLoading: false,
    isAvailable: true,
    ...overrides,
  });
  return { sendMessage, stopGeneration };
}

describe("ChatPanel", () => {
  beforeEach(() => {
    chat.hook.mockReset();
  });

  it("renders messages, reasoning, and tool traces collapsed by default", () => {
    setup();
    render(<ChatPanel />);

    expect(screen.getByText("泰山三天")).toBeInTheDocument();
    expect(screen.getByText("你好")).toBeInTheDocument();

    const reasoning = screen.getByTestId("reasoning-block");
    expect(reasoning).not.toHaveAttribute("open");
    expect(within(reasoning).getByText("先想一下")).toBeInTheDocument();

    const tool = screen.getByTestId("tool-call");
    expect(tool).not.toHaveAttribute("open");
    expect(within(tool).getByText(/搜索资料/)).toBeInTheDocument();
    expect(within(tool).getByText(/已完成/)).toBeInTheDocument();

    fireEvent.click(within(reasoning).getByText(/思考过程/));
    expect(reasoning).toHaveAttribute("open");

    fireEvent.click(within(tool).getByText(/搜索资料/));
    expect(tool).toHaveAttribute("open");
    expect(within(tool).getByText(/泰山/)).toBeInTheDocument();
  });

  it("sends a message from the composer", async () => {
    const { sendMessage } = setup();
    render(<ChatPanel />);

    const input = screen.getByPlaceholderText("说说你想去哪、玩几天、在意什么");
    fireEvent.change(input, { target: { value: "去泰山" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ role: "user", content: "去泰山" }),
      );
    });
  });

  it("shows the loading state and stops generation", () => {
    const { stopGeneration } = setup({ isLoading: true });
    render(<ChatPanel />);

    expect(screen.getByText(/助手正在思考/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    expect(stopGeneration).toHaveBeenCalled();
  });

  it("sends on Enter and keeps Shift+Enter for a newline", async () => {
    const { sendMessage } = setup();
    render(<ChatPanel />);

    const input = screen.getByPlaceholderText("说说你想去哪、玩几天、在意什么");
    fireEvent.change(input, { target: { value: "去泰山" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(sendMessage).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ content: "去泰山" }),
      );
    });
  });

  it("labels an empty reasoning block as still thinking", () => {
    setup({
      messages: [{ id: "r2", role: "reasoning", content: "" }],
    });
    render(<ChatPanel />);

    const reasoning = screen.getByTestId("reasoning-block");
    expect(
      within(reasoning).getByText("思考中…", { selector: "summary" }),
    ).toBeInTheDocument();
  });

  it("shows a failed tool call with its error", () => {
    setup({
      messages: [
        {
          id: "a2",
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "tc2",
              type: "function",
              function: { name: "deepseek_fetch", arguments: "{}" },
            },
          ],
        },
        {
          id: "t2",
          role: "tool",
          toolCallId: "tc2",
          content: "读取失败",
          error: "boom",
        },
      ],
    });
    render(<ChatPanel />);

    const tool = screen.getByTestId("tool-call");
    expect(within(tool).getByText("失败")).toBeInTheDocument();
    fireEvent.click(within(tool).getByText(/读取网页/));
    expect(within(tool).getByText("boom")).toBeInTheDocument();
  });

  it("shows an empty state", () => {
    setup({ messages: [] });
    render(<ChatPanel />);
    expect(screen.getByText(/还没有消息/)).toBeInTheDocument();
  });
});

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NewTripForm } from "./NewTripForm";

const { push } = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

vi.mock("../lib/api", () => ({
  createTrip: vi.fn(),
}));

import { createTrip } from "../lib/api";

const mockedCreateTrip = vi.mocked(createTrip);

const trip = {
  tripId: "t1",
  conversationId: "c1",
  title: "泰山之行",
  destination: "泰山",
  startDate: "2026-10-26",
  days: 3,
  updatedAt: "2026-10-19",
  status: "active" as const,
};

describe("NewTripForm", () => {
  beforeEach(() => {
    push.mockReset();
    mockedCreateTrip.mockReset();
  });

  it("does not submit without a destination", () => {
    render(<NewTripForm />);

    fireEvent.change(screen.getByLabelText("标题"), {
      target: { value: "泰山之行" },
    });
    fireEvent.submit(screen.getByRole("form", { name: "新建行程" }));

    expect(mockedCreateTrip).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it("creates a trip and navigates to it", async () => {
    mockedCreateTrip.mockResolvedValue(trip);
    render(<NewTripForm />);

    fireEvent.change(screen.getByLabelText("标题"), {
      target: { value: "泰山之行" },
    });
    fireEvent.change(screen.getByLabelText("目的地"), {
      target: { value: "泰山" },
    });
    fireEvent.change(screen.getByLabelText("出发日期"), {
      target: { value: "2026-10-26" },
    });
    fireEvent.change(screen.getByLabelText("天数"), {
      target: { value: "3" },
    });
    fireEvent.submit(screen.getByRole("form", { name: "新建行程" }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/trips/t1"));
    expect(mockedCreateTrip).toHaveBeenCalledWith({
      title: "泰山之行",
      destination: "泰山",
      startDate: "2026-10-26",
      days: 3,
    });
  });
});

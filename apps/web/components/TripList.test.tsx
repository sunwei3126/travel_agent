import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TripList } from "./TripList";

describe("TripList", () => {
  it("renders a trip row", () => {
    render(
      <TripList
        trips={[
          {
            tripId: "t1",
            conversationId: "c1",
            title: "泰山",
            destination: "泰山",
            startDate: "2026-10-26",
            days: 3,
            updatedAt: "2026-10-19T10:00:00Z",
            status: "active",
          },
        ]}
      />,
    );

    expect(screen.getByText("泰山")).toBeInTheDocument();
    expect(screen.getByText(/2026-10-26/)).toBeInTheDocument();
  });
});

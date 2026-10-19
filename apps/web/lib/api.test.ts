import { afterEach, describe, expect, it, vi } from "vitest";
import { createTrip } from "./api";

describe("api client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts a new trip", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            tripId: "t1",
            conversationId: "c1",
            title: "泰山",
            destination: "泰山",
            startDate: "2026-10-26",
            days: 3,
            updatedAt: "2026-10-19",
            status: "active",
          }),
          { status: 201 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await createTrip({
      title: "泰山",
      destination: "泰山",
      startDate: "2026-10-26",
      days: 3,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/trips"),
      expect.objectContaining({ method: "POST" }),
    );
  });
});

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTripSnapshot } from "./useTripSnapshot";

const snapshot = {
  trip: {
    tripId: "t1",
    conversationId: "c1",
    title: "泰山",
    destination: "泰山",
    startDate: "2026-10-26",
    days: 3,
    updatedAt: "2026-10-19",
    status: "active",
  },
  brief: {},
  plan: {},
  sources: {},
  research: { searchCount: 0, fetchCount: 0 },
};

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

describe("useTripSnapshot", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("polls while running and stops when idle", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ...snapshot, running: true }))
      .mockResolvedValueOnce(jsonResponse({ ...snapshot, running: false }));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useTripSnapshot("t1"));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.snapshot?.running).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(result.current.snapshot?.running).toBe(false);

    expect(fetchMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("re-arms polling when the agent starts after an idle snapshot", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ...snapshot, running: false }))
      .mockResolvedValueOnce(jsonResponse({ ...snapshot, running: true }))
      .mockResolvedValueOnce(jsonResponse({ ...snapshot, running: false }));
    vi.stubGlobal("fetch", fetchMock);

    const { result, rerender } = renderHook(
      ({ active }) => useTripSnapshot("t1", active),
      { initialProps: { active: false } },
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.snapshot?.running).toBe(false);

    rerender({ active: true });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.snapshot?.running).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.current.snapshot?.running).toBe(false);
  });

  it("shows an error and resumes polling after a transient failure", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(jsonResponse({ ...snapshot, running: false }));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useTripSnapshot("t1"));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.error).toContain("network down");
    expect(result.current.snapshot).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(result.current.error).toBeNull();
    expect(result.current.snapshot).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries immediately when the retry action is called", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(jsonResponse({ ...snapshot, running: false }));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useTripSnapshot("t1"));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.error).toContain("network down");

    await act(async () => {
      result.current.retry();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.error).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not fetch again after unmount", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ ...snapshot, running: true }));
    vi.stubGlobal("fetch", fetchMock);

    const { unmount } = renderHook(() => useTripSnapshot("t1"));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    unmount();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

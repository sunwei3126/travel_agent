"use client";

import type { TripSnapshot } from "@pi-demo/shared";
import { useEffect, useState } from "react";
import { getTrip } from "../lib/api";

const POLL_INTERVAL_MS = 2000;

export function useTripSnapshot(tripId: string): {
  snapshot: TripSnapshot | null;
  error: string | null;
  loading: boolean;
} {
  const [snapshot, setSnapshot] = useState<TripSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function load(): Promise<void> {
      try {
        const next = await getTrip(tripId);
        if (!active) return;
        setSnapshot(next);
        setError(null);
        setLoading(false);
        if (next.running) {
          timer = setTimeout(load, POLL_INTERVAL_MS);
        }
      } catch (cause) {
        if (!active) return;
        setError(cause instanceof Error ? cause.message : "加载行程失败");
        setLoading(false);
      }
    }

    void load();

    return () => {
      active = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [tripId]);

  return { snapshot, error, loading };
}

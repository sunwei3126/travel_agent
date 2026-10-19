import type { Message } from "@ag-ui/core";
import type { TripIndexEntry, TripSnapshot } from "@pi-demo/shared";

const baseUrl = (process.env.NEXT_PUBLIC_API_URL ?? "/backend").replace(/\/$/, "");

export type CreateTripInput = {
  title: string;
  destination: string;
  startDate: string;
  days: number;
};

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init?.headers,
    },
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`API request failed (${response.status}): ${detail}`);
  }

  return (await response.json()) as T;
}

export function listTrips(): Promise<TripIndexEntry[]> {
  return apiFetch<TripIndexEntry[]>("/api/trips");
}

export function createTrip(input: CreateTripInput): Promise<TripIndexEntry> {
  return apiFetch<TripIndexEntry>("/api/trips", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function getTrip(tripId: string): Promise<TripSnapshot> {
  return apiFetch<TripSnapshot>(`/api/trips/${encodeURIComponent(tripId)}`);
}

export function getTranscript(tripId: string): Promise<Message[]> {
  return apiFetch<Message[]>(
    `/api/trips/${encodeURIComponent(tripId)}/transcript`,
  );
}

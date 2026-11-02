import { randomUUID } from "node:crypto";
import type { TripBrief, TripIndexEntry, TripSnapshot } from "@pi-demo/shared";
import { validateBrief } from "../plan/validate";
import type { TripStore } from "../store/trip-store";

export type CreateTripInput = {
  title: string;
  destination: string;
  startDate: string;
  days: number;
};

export class TripService {
  constructor(
    private readonly store: TripStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  createTrip(input: CreateTripInput): TripIndexEntry {
    // Creation only records the seed fields, so completeness is not required
    // yet; an impossible or past calendar date is still rejected here.
    const initialBrief: TripBrief = {
      destination: input.destination,
      startDate: input.startDate,
      days: input.days,
    };
    const errors = validateBrief(initialBrief, this.now(), { requireComplete: false });
    if (errors.length > 0) throw new Error(`Invalid trip: ${errors.join("; ")}`);

    const tripId = randomUUID();
    const entry: TripIndexEntry = {
      tripId,
      conversationId: tripId,
      title: input.title,
      destination: input.destination,
      startDate: input.startDate,
      days: input.days,
      updatedAt: this.now().toISOString(),
      status: "active",
    };
    this.store.transaction(() => {
      this.store.upsertTrip(entry);
      this.store.setDoc(tripId, "brief", initialBrief);
    });
    return entry;
  }

  listTrips(): TripIndexEntry[] {
    return this.store.listTrips();
  }

  getSnapshot(tripId: string): TripSnapshot {
    const trip = this.store.getTrip(tripId);
    if (trip === undefined) throw new Error(`Trip not found: ${tripId}`);
    return {
      trip,
      brief: this.store.getDoc(tripId, "brief"),
      plan: this.store.getDoc(tripId, "plan"),
      sources: this.store.getDoc(tripId, "sources"),
      research: this.store.getDoc(tripId, "research"),
      running: this.store.getInflight(tripId) !== undefined,
      faults: this.store.getDoc(tripId, "faults"),
    };
  }
}

import type { TripIndexEntry } from "@pi-demo/shared";
import Link from "next/link";

function formatUpdatedAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN");
}

export function TripList({ trips }: { trips: TripIndexEntry[] }) {
  if (trips.length === 0) {
    return <p className="empty">还没有行程，创建第一个吧。</p>;
  }

  return (
    <ul className="trip-list">
      {trips.map((trip) => (
        <li key={trip.tripId} className="trip-row">
          <Link className="trip-link" href={`/trips/${trip.tripId}`}>
            <strong>{trip.destination}</strong>
            {trip.title !== trip.destination && <span>{trip.title}</span>}
            <span>
              {trip.startDate} · {trip.days} 天
            </span>
            <span className="trip-updated">更新于 {formatUpdatedAt(trip.updatedAt)}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

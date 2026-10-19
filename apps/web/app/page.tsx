"use client";

import type { TripIndexEntry } from "@pi-demo/shared";
import { useEffect, useState } from "react";
import { NewTripForm } from "../components/NewTripForm";
import { TripList } from "../components/TripList";
import { listTrips } from "../lib/api";

export default function HomePage() {
  const [trips, setTrips] = useState<TripIndexEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    listTrips()
      .then((data) => {
        if (active) setTrips(data);
      })
      .catch((cause: unknown) => {
        if (active) {
          setError(cause instanceof Error ? cause.message : "加载行程失败");
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, []);

  return (
    <main className="page">
      <header className="page-header">
        <h1>泰山行程助手</h1>
        <p>选择已有行程，或创建一个新的旅行计划。</p>
      </header>

      <section aria-labelledby="trips-heading">
        <h2 id="trips-heading">我的行程</h2>
        {loading && <p>加载中…</p>}
        {error !== null && <p role="alert">{error}</p>}
        {!loading && error === null && <TripList trips={trips} />}
      </section>

      <NewTripForm />
    </main>
  );
}

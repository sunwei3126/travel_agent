"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { createTrip } from "../lib/api";

export function NewTripForm() {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [destination, setDestination] = useState("");
  const [startDate, setStartDate] = useState("");
  const [days, setDays] = useState("3");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const trimmedDestination = destination.trim();
    if (trimmedDestination.length === 0) {
      setError("请填写目的地");
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const trip = await createTrip({
        title: title.trim() || trimmedDestination,
        destination: trimmedDestination,
        startDate,
        days: Number(days),
      });
      router.push(`/trips/${trip.tripId}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "创建行程失败");
      setSubmitting(false);
    }
  }

  return (
    <form className="new-trip-form" aria-label="新建行程" onSubmit={handleSubmit}>
      <h2>新建行程</h2>

      <label htmlFor="trip-title">标题</label>
      <input
        id="trip-title"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        placeholder="例如：泰山三日游"
      />

      <label htmlFor="trip-destination">目的地</label>
      <input
        id="trip-destination"
        value={destination}
        onChange={(event) => setDestination(event.target.value)}
        placeholder="例如：泰山"
      />

      <label htmlFor="trip-start-date">出发日期</label>
      <input
        id="trip-start-date"
        type="date"
        value={startDate}
        onChange={(event) => setStartDate(event.target.value)}
      />

      <label htmlFor="trip-days">天数</label>
      <input
        id="trip-days"
        type="number"
        min={1}
        value={days}
        onChange={(event) => setDays(event.target.value)}
      />

      {error !== null && <p role="alert">{error}</p>}

      <button type="submit" disabled={submitting}>
        {submitting ? "创建中…" : "创建行程"}
      </button>
    </form>
  );
}

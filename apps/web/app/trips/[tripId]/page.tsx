"use client";

import { use } from "react";
import { TripView } from "../../../components/TripView";

export default function TripPage({
  params,
}: {
  params: Promise<{ tripId: string }>;
}) {
  const { tripId } = use(params);

  return (
    <main className="page trip-page">
      <header className="page-header">
        <h1>行程规划</h1>
        <p>和旅行助手聊聊，边聊边完善你的行程。</p>
      </header>

      <TripView tripId={tripId} />
    </main>
  );
}

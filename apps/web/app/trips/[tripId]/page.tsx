import { TravelChat } from "../../../components/TravelChat";

export default async function TripPage({
  params,
}: {
  params: Promise<{ tripId: string }>;
}) {
  const { tripId } = await params;

  return (
    <main className="page trip-page">
      <header className="page-header">
        <h1>行程规划</h1>
        <p>和旅行助手聊聊，边聊边完善你的行程。</p>
      </header>

      <TravelChat tripId={tripId} />

      <section aria-labelledby="plan-heading" className="plan-board">
        <h2 id="plan-heading">行程计划</h2>
        <p className="empty">行程计划将在这里生成。</p>
      </section>
    </main>
  );
}

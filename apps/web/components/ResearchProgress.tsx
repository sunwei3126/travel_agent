export function ResearchProgress({
  searchCount,
  fetchCount,
  running,
}: {
  searchCount: number;
  fetchCount: number;
  running: boolean;
}) {
  return (
    <div
      className="research-progress"
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: "0.75rem",
        color: "var(--muted)",
      }}
    >
      <span>{`搜索 ${searchCount} 次`}</span>
      <span>{`抓取 ${fetchCount} 次`}</span>
      {running && (
        <span className="research-running" role="status">
          研究中…
        </span>
      )}
    </div>
  );
}

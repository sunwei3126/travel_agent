const FIELD_LABELS: Record<string, string> = {
  destination: "目的地",
  origin: "出发地",
  startDate: "出发日期",
  days: "天数",
  budgetCny: "预算",
  companions: "同行人",
  fitness: "体力",
  interests: "偏好",
};

export function BriefChecklist({ missing }: { missing: string[] }) {
  if (missing.length === 0) {
    return <p className="brief-complete">信息已齐全。</p>;
  }

  return (
    <ul
      className="brief-checklist"
      style={{
        listStyle: "none",
        margin: 0,
        padding: 0,
        display: "grid",
        gap: "0.35rem",
      }}
    >
      {missing.map((field) => (
        <li
          key={field}
          className="brief-missing"
          style={{
            display: "flex",
            justifyContent: "space-between",
            gap: "1rem",
            padding: "0.45rem 0.6rem",
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: "6px",
          }}
        >
          <span>{FIELD_LABELS[field] ?? field}</span>
          <span className="brief-missing-hint">待补充</span>
        </li>
      ))}
    </ul>
  );
}

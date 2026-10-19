import type { BudgetSummary as BudgetSummaryData } from "@pi-demo/shared";

export function BudgetSummary({ budget }: { budget: BudgetSummaryData }) {
  return (
    <section
      className={`budget-summary${budget.withinBudget ? "" : " over-budget"}`}
      aria-label="预算"
      style={{
        display: "grid",
        gap: "0.25rem",
        padding: "0.75rem 1rem",
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: "8px",
        ...(budget.withinBudget
          ? {}
          : { borderColor: "#b42318", background: "#fef3f2" }),
      }}
    >
      <h2>预算</h2>
      <p className="budget-range">
        {`¥${budget.low}–¥${budget.high} / ¥${budget.cap}`}
      </p>
      {!budget.withinBudget && <p className="budget-warning">超出预算</p>}
    </section>
  );
}

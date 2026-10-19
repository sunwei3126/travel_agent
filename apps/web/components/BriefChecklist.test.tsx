import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BriefChecklist } from "./BriefChecklist";
import { BudgetSummary } from "./BudgetSummary";

describe("BriefChecklist", () => {
  it("shows missing brief fields and an over-budget summary", () => {
    render(<BriefChecklist missing={["destination"]} />);
    expect(screen.getByText("目的地")).toBeInTheDocument();

    render(
      <BudgetSummary
        budget={{ low: 600, high: 3100, cap: 3000, withinBudget: false }}
      />,
    );
    expect(screen.getByText(/3100/)).toBeInTheDocument();
  });

  it("renders one labelled row per missing field", () => {
    render(<BriefChecklist missing={["origin", "budgetCny"]} />);

    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("出发地");
    expect(rows[1]).toHaveTextContent("预算");
  });

  it("applies the over-budget style when the cap is exceeded", () => {
    render(
      <BudgetSummary
        budget={{ low: 600, high: 3100, cap: 3000, withinBudget: false }}
      />,
    );

    const summary = screen.getByText(/3100/).closest(".budget-summary");

    expect(summary).toHaveClass("over-budget");
    expect(summary).toHaveStyle({
      borderColor: "#b42318",
      backgroundColor: "#fef3f2",
    });
  });

  it("does not mark a within-budget summary", () => {
    render(
      <BudgetSummary
        budget={{ low: 600, high: 2900, cap: 3000, withinBudget: true }}
      />,
    );

    const summary = screen.getByText(/2900/).closest(".budget-summary");

    expect(summary).not.toHaveClass("over-budget");
    expect(summary).not.toHaveStyle({ borderColor: "#b42318" });
  });
});

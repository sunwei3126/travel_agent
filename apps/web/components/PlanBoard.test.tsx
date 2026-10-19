import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PlanBoard } from "./PlanBoard";

const card = {
  dayIndex: 1,
  date: "2026-10-26",
  title: "抵达与老城",
  blocks: [],
  scenery: [],
  food: [],
  transport: [],
  estimatedCostCny: [100, 200],
  sources: [],
  svg: '<svg viewBox="0 0 10 10"></svg>',
  svgStatus: "ok",
  updatedAt: "",
} as any;

function renderedTitles(): Array<string | null> {
  return screen
    .getAllByTestId("day-card")
    .map(
      (element) =>
        within(element).getByRole("heading", { level: 2 }).textContent,
    );
}

describe("PlanBoard", () => {
  it("renders 30 day cards in order", () => {
    render(
      <PlanBoard
        plan={{
          days: Array.from({ length: 30 }, (_, i) => ({
            ...card,
            dayIndex: i + 1,
          })),
        }}
      />,
    );

    expect(screen.getAllByTestId("day-card")).toHaveLength(30);
  });

  it("sorts by dayIndex and does not reorder when a card updates", () => {
    const { rerender } = render(
      <PlanBoard
        plan={{
          days: [
            { ...card, dayIndex: 2, date: "2026-10-27", title: "第二天" },
            { ...card, dayIndex: 1, date: "2026-10-26", title: "第一天" },
          ],
        }}
      />,
    );

    expect(renderedTitles()).toEqual(["第一天", "第二天"]);

    rerender(
      <PlanBoard
        plan={{
          days: [
            { ...card, dayIndex: 2, date: "2026-10-27", title: "第二天更新" },
            { ...card, dayIndex: 1, date: "2026-10-26", title: "第一天" },
          ],
        }}
      />,
    );

    expect(renderedTitles()).toEqual(["第一天", "第二天更新"]);
  });
});

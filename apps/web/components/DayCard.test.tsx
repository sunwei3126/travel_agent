import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DayCard, svgDataUrl } from "./DayCard";

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

describe("DayCard", () => {
  it("renders the title and a data-URL SVG", () => {
    render(<DayCard card={card} />);

    expect(screen.getByText("抵达与老城")).toBeInTheDocument();
    expect(screen.getByRole("img").getAttribute("src")).toMatch(
      /^data:image\/svg\+xml;base64,/,
    );
  });

  it("marks an unverified fact claim", () => {
    render(
      <DayCard
        card={{
          ...card,
          blocks: [
            {
              time: "09:00",
              title: "红门",
              detail: "",
              claims: [
                {
                  text: "门票 115",
                  kind: "fact",
                  sourceIds: [],
                  unverified: true,
                },
              ],
            },
          ],
        }}
      />,
    );

    expect(screen.getByText("未核实")).toBeInTheDocument();
  });

  it("encodes an SVG with a Chinese title as UTF-8", () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg"><text>泰山日出</text></svg>';

    const url = svgDataUrl(svg);
    const prefix = "data:image/svg+xml;base64,";

    expect(url.startsWith(prefix)).toBe(true);
    const bytes = Uint8Array.from(
      atob(url.slice(prefix.length)),
      (char) => char.charCodeAt(0),
    );
    expect(new TextDecoder().decode(bytes)).toBe(svg);
  });
});

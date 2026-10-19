import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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

  it("renders source chips as title links", () => {
    render(
      <DayCard
        card={{ ...card, sources: ["s1", "missing"] }}
        sources={{
          s1: {
            id: "s1",
            query: "泰山",
            title: "泰山景区官网",
            url: "https://example.com/taishan",
            snippet: "",
            kind: "search",
          },
        }}
      />,
    );

    const link = screen.getByRole("link", { name: "泰山景区官网" });
    expect(link).toHaveAttribute("href", "https://example.com/taishan");
    expect(screen.getByText("missing")).toBeInTheDocument();
  });

  it("calls the redraw and edit actions with the day index", () => {
    const onRedraw = vi.fn();
    const onEditDay = vi.fn();
    render(
      <DayCard
        card={{ ...card, svg: undefined, svgStatus: "failed" }}
        onRedraw={onRedraw}
        onEditDay={onEditDay}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "重画" }));
    fireEvent.click(screen.getByRole("button", { name: "改这一天" }));
    expect(onRedraw).toHaveBeenCalledWith(1);
    expect(onEditDay).toHaveBeenCalledWith(1);
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

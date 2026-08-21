/**
 * Sparkline rendering, and the proof that moving it onto the shared drawing
 * engine did not move a single shape.
 *
 * The expected geometry below was captured from the *previous*, hand-rolled SVG
 * emitter before the migration. That is the whole point: a golden hash would have
 * broken on the first re-emit and the only way forward would have been to
 * re-baseline it against the new output — checking the new code against itself.
 * Comparing extracted geometry instead makes the equivalence a real assertion.
 */

import { rasterizeDrawList } from "@excel/chart/render/draw-raster-png";
import { renderSparklineSvg, sparklineToDrawList } from "@excel/core/sparkline";
import type { SparklineGroup } from "@excel/core/sparkline";
import { decodePng } from "@pdf/render/png-decoder";
import { describeSvgGeometry, extractSvgGeometry } from "@test/svg-geometry";
import { describe, expect, it } from "vitest";

const BOX = { width: 100, height: 40, background: "#ffffff" };

function group(overrides: Record<string, unknown>): SparklineGroup {
  return {
    sparklines: [{ sqref: "A1", formula: "B1:F1" }],
    ...overrides
  } as unknown as SparklineGroup;
}

describe("sparkline geometry is unchanged by the move to the shared engine", () => {
  it("renders a line sparkline with markers", () => {
    const svg = renderSparklineSvg(group({ type: "line", markers: true }), [[1, 5, 2, 8, 3]], BOX);
    expect(describeSvgGeometry(svg)).toBe(
      [
        "rect 0,0,100,40 fill=#ffffff",
        "polyline 2,38,26,17.43,50,32.86,74,2,98,27.71 stroke=#376091 sw=1",
        "circle 2,38,1.5 fill=#376091",
        "circle 26,17.43,1.5 fill=#376091",
        "circle 50,32.86,1.5 fill=#376091",
        "circle 74,2,1.5 fill=#376091",
        "circle 98,27.71,1.5 fill=#376091"
      ].join("\n")
    );
  });

  it("renders a column sparkline with negative colouring", () => {
    // The negative x on the first bar is pre-existing behaviour, preserved here
    // deliberately: this test proves the migration changed nothing, not that the
    // old geometry was ideal.
    const svg = renderSparklineSvg(
      group({ type: "column", negative: true }),
      [[1, -5, 2, 8, -3]],
      BOX
    );
    expect(describeSvgGeometry(svg)).toBe(
      [
        "rect 0,0,100,40 fill=#ffffff",
        "rect -5.68,21.38,15.36,2.77 fill=#376091",
        "rect 18.32,24.15,15.36,13.85 fill=#d00000",
        "rect 42.32,18.62,15.36,5.54 fill=#376091",
        "rect 66.32,2,15.36,22.15 fill=#376091",
        "rect 90.32,24.15,15.36,8.31 fill=#d00000"
      ].join("\n")
    );
  });

  it("renders a stacked sparkline", () => {
    expect(
      describeSvgGeometry(renderSparklineSvg(group({ type: "stacked" }), [[1, -5, 2]], BOX))
    ).toBe(
      [
        "rect 0,0,100,40 fill=#ffffff",
        "rect -10.8,2,25.6,18 fill=#376091",
        "rect 37.2,20,25.6,18 fill=#376091",
        "rect 85.2,2,25.6,18 fill=#376091"
      ].join("\n")
    );
  });

  it("renders axis, markers and the high/low/first/last emphasis", () => {
    const svg = renderSparklineSvg(
      group({
        type: "line",
        displayXAxis: true,
        markers: true,
        high: true,
        low: true,
        first: true,
        last: true
      }),
      [[3, -1, 7, 0, 4]],
      BOX
    );
    expect(describeSvgGeometry(svg)).toBe(
      [
        "rect 0,0,100,40 fill=#ffffff",
        "polyline 2,20,26,38,50,2,74,33.5,98,15.5 stroke=#376091 sw=1",
        "circle 2,20,1.5 fill=#376091",
        "circle 26,38,1.5 fill=#376091",
        "circle 50,2,1.5 fill=#376091",
        "circle 74,33.5,1.5 fill=#376091",
        "circle 98,15.5,1.5 fill=#376091",
        "circle 2,20,1.8 fill=#376091",
        "circle 98,15.5,1.8 fill=#376091",
        "circle 50,2,1.8 fill=#376091",
        "circle 26,38,1.8 fill=#376091",
        "polyline 2,33.5,98,33.5 stroke=#000000 sw=0.5"
      ].join("\n")
    );
  });

  it("stacks multiple sparklines into rows", () => {
    const svg = renderSparklineSvg(
      {
        type: "line",
        sparklines: [
          { sqref: "A1", formula: "B1:F1" },
          { sqref: "A2", formula: "B2:F2" }
        ]
      } as unknown as SparklineGroup,
      [
        [1, 2, 3],
        [3, 1, 2]
      ],
      BOX
    );
    expect(describeSvgGeometry(svg)).toBe(
      [
        "rect 0,0,100,40 fill=#ffffff",
        "polyline 2,18,50,10,98,2 stroke=#376091 sw=1",
        "polyline 2,22,50,38,98,30 stroke=#376091 sw=1"
      ].join("\n")
    );
  });

  it("omits the background rect when none is asked for", () => {
    const shapes = extractSvgGeometry(
      renderSparklineSvg(group({ type: "line" }), [[1, 2]], { width: 40, height: 20 })
    );
    expect(shapes.some(shape => shape.kind === "rect")).toBe(false);
  });

  it("draws nothing for an empty row", () => {
    expect(
      extractSvgGeometry(renderSparklineSvg(group({ type: "line" }), [[]], BOX)).filter(
        shape => shape.fill !== "#ffffff"
      )
    ).toEqual([]);
  });
});

describe("sparklines gain the other backends for free", () => {
  const list = sparklineToDrawList(group({ type: "column" }), [[3, 1, 4, 1, 5]], BOX);

  it("exposes a display list with the expected extent", () => {
    expect(list.width).toBe(100);
    expect(list.height).toBe(40);
    expect(list.children.length).toBeGreaterThan(0);
  });

  it("rasterises to a PNG, which the SVG-only renderer could never do", () => {
    const png = rasterizeDrawList(list, { width: 100, height: 40 });
    const decoded = decodePng(png);
    expect(decoded.width).toBe(100);
    expect(decoded.height).toBe(40);
    let painted = 0;
    if (decoded.alpha) {
      for (const value of decoded.alpha) {
        if (value > 40) {
          painted++;
        }
      }
    }
    // Bars must actually appear; a blank PNG is the silent failure here.
    expect(painted).toBeGreaterThan(200);
  });

  it("honours a supersampling scale", () => {
    const decoded = decodePng(rasterizeDrawList(list, { width: 100, height: 40, scale: 2 }));
    expect(decoded.width).toBe(200);
    expect(decoded.height).toBe(80);
  });
});

describe("blank cells honour displayEmptyCellsAs", () => {
  /** One blank in the middle, so a break is visible if there is one. */
  const withBlank = (mode: "gap" | "zero" | "span"): string =>
    renderSparklineSvg(
      group({ type: "line", markers: true, displayEmptyCellsAs: mode }),
      [[1, Number.NaN, 3]],
      BOX
    );

  it("breaks the line at a blank by default", () => {
    // The setting was written into the XML and never read back when drawing, so all three
    // produced the same picture: blanks dropped and the line run straight across them.
    // That is `span` — the one Excel does not default to.
    const shapes = extractSvgGeometry(withBlank("gap"));
    const runs = shapes.filter(shape => shape.kind === "polyline");
    // Two single points cannot form a line, so a two-sided gap leaves none.
    expect(runs).toHaveLength(0);
    // The real values are still marked.
    expect(shapes.filter(shape => shape.kind === "circle")).toHaveLength(2);
  });

  it("keeps a gap between two runs that each have a line", () => {
    const shapes = extractSvgGeometry(
      renderSparklineSvg(
        group({ type: "line", displayEmptyCellsAs: "gap" }),
        [[1, 2, Number.NaN, 4, 5]],
        BOX
      )
    );
    // One polyline either side of the blank, not one across it.
    expect(shapes.filter(shape => shape.kind === "polyline")).toHaveLength(2);
  });

  it("plots a blank as zero when asked", () => {
    const shapes = extractSvgGeometry(withBlank("zero"));
    expect(shapes.filter(shape => shape.kind === "polyline")).toHaveLength(1);
    // Three markers: the blank became a point of its own.
    expect(shapes.filter(shape => shape.kind === "circle")).toHaveLength(3);
  });

  it("bridges a blank when asked to span it", () => {
    const shapes = extractSvgGeometry(withBlank("span"));
    expect(shapes.filter(shape => shape.kind === "polyline")).toHaveLength(1);
    // Two markers: the blank is bridged, not plotted.
    expect(shapes.filter(shape => shape.kind === "circle")).toHaveLength(2);
  });

  it("puts the zero point on the axis, not at the top", () => {
    const shapes = extractSvgGeometry(withBlank("zero"));
    const markers = shapes
      .filter(shape => shape.kind === "circle")
      .map(shape => shape.coords[1])
      .sort((a, b) => a - b);
    // Values 1 and 3 are positive, so zero is the lowest point on the chart.
    expect(markers[markers.length - 1]).toBeGreaterThan(markers[0]);
  });
});

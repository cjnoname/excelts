/**
 * Stroke attributes have to survive the trip to every backend.
 *
 * A dash, a width, a join and a cap are as much a part of a paint as its colour, but
 * they were forwarded per call site rather than converted once. Each site forwarded a
 * different subset, so the same `DrawPaint` lost different things depending on which
 * primitive carried it: a dashed sector came out solid in PDF, a dashed ellipse came
 * out solid in a PNG, and a sector lost its stroke width entirely. SVG, which builds
 * its attributes from the paint in one place, dashed all of them.
 */
import type { DrawList, DrawPaint } from "@draw/index";
import { renderDrawList } from "@draw/render";
import { toSvg } from "@draw/svg";
import { createChartPdfDrawSurface } from "@excel/chart/render/chart-pdf-draw-surface";
import { rasterizeDrawList } from "@excel/chart/render/draw-raster-png";
import { decodePng } from "@pdf/render/png-decoder";
import { describe, expect, it } from "vitest";

const DASHED: DrawPaint = {
  stroke: { r: 0, g: 0, b: 0, a: 1 },
  strokeWidth: 3,
  dash: [6, 6]
};
const SOLID: DrawPaint = { stroke: { r: 0, g: 0, b: 0, a: 1 }, strokeWidth: 3 };

/** What actually reached a `ChartPdfDrawingSurface`, per call. */
function chartPdfOptions(list: DrawList): string[] {
  const seen: string[] = [];
  const note = (kind: string, options: Record<string, unknown>): void => {
    const dash = options.dashPattern as number[] | undefined;
    seen.push(`${kind} lw=${options.lineWidth ?? "-"} dash=${dash ? dash.join(",") : "-"}`);
  };
  const surface = {
    drawRect(options: Record<string, unknown>) {
      note("rect", options);
      return surface;
    },
    drawLine(options: Record<string, unknown>) {
      note("line", options);
      return surface;
    },
    drawText() {
      return surface;
    },
    drawCircle(options: Record<string, unknown>) {
      note("circle", options);
      return surface;
    },
    drawPath(_ops: unknown, options?: Record<string, unknown>) {
      note("path", options ?? {});
      return surface;
    }
  };
  renderDrawList(list, createChartPdfDrawSurface(surface as never, 0, 0, list.height));
  return seen;
}

/** Dark runs along one scanline: a solid edge is one run, a dashed edge is several. */
function darkRuns(list: DrawList, row: number): number {
  const png = decodePng(rasterizeDrawList(list, { width: 120, height: 80 }));
  let runs = 0;
  let previous = false;
  for (let x = 0; x < png.width; x++) {
    const dark = png.pixels[(row * png.width + x) * 3] < 128;
    if (dark && !previous) {
      runs++;
    }
    previous = dark;
  }
  return runs;
}

const white = {
  kind: "rect",
  x: 0,
  y: 0,
  width: 120,
  height: 80,
  paint: { fill: { r: 1, g: 1, b: 1, a: 1 } }
} as const;

describe("a dash reaches the chart PDF surface", () => {
  const cases: Array<[string, DrawList]> = [
    [
      "rounded rect",
      {
        width: 100,
        height: 100,
        children: [{ kind: "rect", x: 10, y: 10, width: 40, height: 30, rx: 6, paint: DASHED }]
      }
    ],
    [
      "sector",
      {
        width: 100,
        height: 100,
        children: [
          {
            kind: "sector",
            cx: 50,
            cy: 50,
            radius: 30,
            innerRadius: 0,
            startAngle: 0,
            endAngle: 2,
            paint: DASHED
          }
        ]
      }
    ],
    [
      "path",
      {
        width: 100,
        height: 100,
        children: [
          {
            kind: "path",
            commands: [
              { op: "move", x: 10, y: 10 },
              { op: "line", x: 60, y: 70 }
            ],
            paint: DASHED
          }
        ]
      }
    ],
    [
      "polyline",
      {
        width: 100,
        height: 100,
        children: [
          {
            kind: "polyline",
            points: [
              { x: 10, y: 10 },
              { x: 60, y: 70 },
              { x: 80, y: 20 }
            ],
            paint: DASHED
          }
        ]
      }
    ]
  ];

  for (const [name, list] of cases) {
    it(`carries width and dash on a ${name}`, () => {
      // The sector used to drop both; the rounded rect and the generic path dropped
      // the dash while the polyline kept it.
      expect(chartPdfOptions(list)).toEqual(["path lw=3 dash=6,6"]);
    });
  }
});

describe("a dash reaches the rasteriser", () => {
  it("dashes an ellipse's outline", () => {
    // Measured across the top of the ellipse, where the outline runs horizontally: at
    // its widest point a scanline crosses twice whether or not the stroke is dashed.
    const ellipse = (paint: DrawPaint): DrawList => ({
      width: 120,
      height: 80,
      children: [white, { kind: "ellipse", cx: 60, cy: 40, rx: 50, ry: 30, paint }]
    });
    expect(darkRuns(ellipse(SOLID), 11)).toBe(1);
    expect(darkRuns(ellipse(DASHED), 11)).toBeGreaterThan(1);
  });

  it("still dashes the primitives that already worked", () => {
    const rect = (rx: number): DrawList => ({
      width: 120,
      height: 80,
      children: [
        white,
        { kind: "rect", x: 10, y: 20, width: 100, height: 40, ...(rx ? { rx } : {}), paint: DASHED }
      ]
    });
    expect(darkRuns(rect(0), 20)).toBeGreaterThan(1);
    expect(darkRuns(rect(8), 20)).toBeGreaterThan(1);
  });
});

describe("a zero-width stroke is not a stroke", () => {
  // SVG has always read `stroke-width="0"` as "paint nothing". The rasteriser floored
  // the width at one pixel and PDF's `0 w` asks for the device's thinnest line, so
  // both drew an outline the author had switched off. The walker now drops it, which
  // is why all three agree without any backend knowing the rule.
  const zero: DrawList = {
    width: 120,
    height: 80,
    children: [
      white,
      {
        kind: "polyline",
        points: [
          { x: 5, y: 20 },
          { x: 115, y: 20 }
        ],
        paint: { stroke: { r: 0, g: 0, b: 0, a: 1 }, strokeWidth: 0 }
      }
    ]
  };

  it("draws nothing in the rasteriser", () => {
    // Any ink at all, not just ink dark enough to read as a line: a hairline in the
    // supersampled buffer downsamples to a pale grey that a mid-tone threshold misses,
    // so this has to look for *any* pixel that is not the background.
    const png = decodePng(rasterizeDrawList(zero, { width: 120, height: 80 }));
    const inked = [...png.pixels].filter(channel => channel < 250).length;
    expect(inked).toBe(0);
  });

  it("emits no stroke in the SVG", () => {
    expect(toSvg(zero)).not.toContain("stroke=");
  });

  it("issues no stroked call to the chart PDF surface", () => {
    // The background rect is a fill; nothing else should reach the surface.
    expect(chartPdfOptions(zero)).toEqual(["rect lw=- dash=-"]);
  });
});

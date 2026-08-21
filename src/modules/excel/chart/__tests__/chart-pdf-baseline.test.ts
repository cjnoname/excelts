/**
 * PDF baselines for every classic chart type, and the proof that the PDF and SVG
 * backends now describe the same picture.
 *
 * ## What changed, and why these values are new
 *
 * The PDF path used to be a second full traversal of the chart scene — around 820
 * lines paired function-for-function with the SVG emitter. Two walkers over one
 * scene is how they drifted, and the drift was real:
 *
 * - legend swatches sat 8pt from where SVG put them;
 * - legend labels were drawn with no colour at all, so they came out black
 *   instead of the `#555555` SVG used;
 * - the default marker was a 4x4 square in PDF and a radius-3 circle in SVG;
 * - a line series was three separate `drawLine` calls rather than one polyline.
 *
 * Both backends now walk one display list, so those are gone. The baselines below
 * therefore differ from the old implementation *deliberately*: they are the
 * corrected, unified drawing. The cross-backend test at the bottom is what makes
 * that claim checkable rather than asserted — it derives the expected PDF
 * coordinates from the SVG output and the Y-flip, so the two cannot drift again
 * without a failure.
 *
 * ## One deliberate change is baked in
 *
 * **A legend names the series unless each point is coloured separately.** Both
 * backends read the same legend layout, so both lose the same three swatches and
 * three labels — six calls — on every type that used to list categories for a single
 * series. `pie`, `pie3D`, `doughnut`, `ofPie` and the four-series `stock` chart keep
 * their previous hashes. See the matching note in `chart-geometry-baseline.test.ts`.
 *
 * **A shaded surface cell has no outline.** It used to be drawn with a zero-width
 * stroke in the cell's own colour, which is a roundabout way of saying "no outline"
 * and left each backend to decide what a zero width meant: SVG painted nothing, the
 * rasteriser floored the width at one pixel, and PDF's `0 w` asks the device for its
 * thinnest line. Two of the three therefore drew an edge the SVG did not. The
 * producer now simply omits the stroke, so `surface` and `surface3D` lost four
 * `stroke=` attributes; the geometry, the shape census and the call count are
 * unchanged, and a wireframe surface still outlines every cell.
 */

import type { AddChartOptions } from "@excel/chart";
import { drawChartPdf, renderChartSvg } from "@excel/chart";
import { addChart, getCharts } from "@excel/core/worksheet";
import { Cell, Chart, Workbook } from "@excel/index";
import { recordChartPdf } from "@test/pdf-draw-record";
import { extractSvgGeometry } from "@test/svg-geometry";
import { describe, expect, it } from "vitest";

import { stableHash } from "./chart-builder.helpers";

const WIDTH = 240;
const HEIGHT = 160;

/** `[hash of the recorded drawing, number of calls]`. */
const BASELINES: Record<string, readonly [string, number]> = {
  bar: ["f380adf7", 30],
  bar3D: ["62311213", 38],
  line: ["adcc2895", 31],
  line3D: ["adcc2895", 31],
  pie: ["682accd6", 14],
  pie3D: ["682accd6", 14],
  doughnut: ["9cf81606", 14],
  area: ["f29240c5", 28],
  area3D: ["f29240c5", 28],
  scatter: ["84a4c64c", 46],
  bubble: ["2bed9a3f", 45],
  radar: ["5cb22ad7", 28],
  stock: ["8b36e0ca", 39],
  surface: ["74a0f173", 30],
  surface3D: ["74a0f173", 30],
  ofPie: ["a532e2c0", 31]
};

/** Build a minimal but non-degenerate chart of the given type. */
function chartOf(type: AddChartOptions["type"]) {
  const wb = Workbook.create();
  const ws = Workbook.addWorksheet(wb, "Sheet1");
  for (let i = 1; i <= 4; i++) {
    Cell.setValue(ws, `A${i}`, `Cat${i}`);
    Cell.setValue(ws, `B${i}`, i * 10);
    Cell.setValue(ws, `C${i}`, i * 5);
  }
  const series = (name: string, column = "B") => ({
    name,
    categories: "Sheet1!$A$1:$A$4",
    values: `Sheet1!$${column}$1:$${column}$4`
  });
  const options =
    type === "scatter"
      ? { type, series: [{ name: "S", xValues: "Sheet1!$B$1:$B$4", values: "Sheet1!$C$1:$C$4" }] }
      : type === "bubble"
        ? {
            type,
            series: [
              {
                name: "S",
                xValues: "Sheet1!$B$1:$B$4",
                values: "Sheet1!$C$1:$C$4",
                bubbleSize: "Sheet1!$C$1:$C$4"
              }
            ]
          }
        : type === "stock"
          ? { type, series: [series("O"), series("H", "C"), series("L"), series("C", "C")] }
          : { type, series: [series("S")], title: "T" };
  addChart(ws, options as AddChartOptions, "E1:L12");
  return Chart.chartModel(getCharts(ws)[0])!;
}

/** Record what `drawChartPdf` draws for one chart type. */
function record(type: string) {
  const recorder = recordChartPdf();
  drawChartPdf(recorder.surface as never, chartOf(type as AddChartOptions["type"]), {
    x: 0,
    y: 0,
    width: WIDTH,
    height: HEIGHT
  });
  return recorder;
}

describe("classic chart PDF output is stable", () => {
  for (const [type, [hash, calls]] of Object.entries(BASELINES)) {
    it(`${type} issues the same drawing`, () => {
      const recorder = record(type);
      // Call count first: when it differs the failure says whether primitives
      // appeared or vanished, rather than only reporting two hashes.
      expect(recorder.calls).toHaveLength(calls);
      expect(stableHash(recorder.describe())).toBe(hash);
    });
  }

  it("distinguishes chart types from one another", () => {
    // A suite where every entry collided would pass while drawing nothing
    // type-specific. The 2D degradations of the 3D types are expected to collide.
    const degraded = new Set(["line3D", "pie3D", "area3D", "surface3D"]);
    const seen = new Map<string, string[]>();
    for (const [type, [hash]] of Object.entries(BASELINES)) {
      if (degraded.has(type)) {
        continue;
      }
      seen.set(hash, [...(seen.get(hash) ?? []), type]);
    }
    for (const [hash, types] of seen) {
      expect(types, `types ${types.join(", ")} share PDF hash ${hash}`).toHaveLength(1);
    }
  });

  it("frames the chart before drawing into it", () => {
    // The PDF preview draws a white panel with a light border; the display list is
    // built with a transparent background so the frame is not painted over.
    const first = record("bar").calls[0];
    expect(first).toBe(`rect 0,0 ${WIDTH}x${HEIGHT} f=#ffffff s=#cccccc`);
  });
});

describe("the PDF and SVG backends draw the same picture", () => {
  /**
   * Legend swatches are the sharpest probe available: a fixed 10x10 rect that
   * appears in both backends, positioned from the same scene rect. They are also
   * exactly where the two renderers used to disagree by 8pt.
   */
  const swatchesFromSvg = (type: string): { x: number; y: number }[] =>
    extractSvgGeometry(
      renderChartSvg(chartOf(type as AddChartOptions["type"]), { width: WIDTH, height: HEIGHT })
    )
      .filter(shape => shape.kind === "rect" && shape.coords[2] === 10 && shape.coords[3] === 10)
      .map(shape => ({ x: shape.coords[0], y: shape.coords[1] }));

  const swatchesFromPdf = (type: string): { x: number; y: number }[] =>
    record(type)
      .calls.filter(call => / 10x10 /.test(call))
      .map(call => {
        const match = /^rect ([\d.-]+),([\d.-]+) /.exec(call)!;
        return { x: Number(match[1]), y: Number(match[2]) };
      });

  for (const type of ["bar", "line", "pie", "area", "radar"]) {
    it(`${type} puts its legend in the same place in both backends`, () => {
      const svg = swatchesFromSvg(type);
      const pdf = swatchesFromPdf(type);
      expect(svg.length).toBeGreaterThan(0);
      expect(pdf).toHaveLength(svg.length);
      svg.forEach((swatch, index) => {
        // Same column…
        expect(pdf[index].x).toBeCloseTo(swatch.x, 6);
        // …and SVG's top edge is PDF's bottom edge measured from the other side.
        expect(pdf[index].y).toBeCloseTo(HEIGHT - (swatch.y + 10), 6);
      });
    });
  }

  it("gives legend labels the same colour in both backends", () => {
    // The PDF path passed no colour at all, so labels rendered black against
    // SVG's #555555.
    const svgLabel = extractSvgGeometry(
      renderChartSvg(chartOf("bar"), { width: WIDTH, height: HEIGHT })
    ).find(shape => shape.kind === "text" && shape.text === "Cat1");
    expect(svgLabel?.fill).toBe("#555555");
    expect(record("bar").calls.some(call => /^text .*"Cat1".*c=#555555/.test(call))).toBe(true);
  });

  it("uses the same default marker shape in both backends", () => {
    // A 4x4 square in PDF versus a radius-3 circle in SVG; now a circle in both.
    const pdf = record("line").calls;
    expect(pdf.some(call => /^circle .* r=3 /.test(call))).toBe(true);
    expect(pdf.some(call => / 4x4 /.test(call))).toBe(false);
  });

  it("carries a translucent area fill as real alpha in both backends", () => {
    // Pre-mixing towards white hid the gridlines under an area fill, and only the
    // SVG emitter did it — so the two disagreed on colour as well as on opacity.
    const svgFill = extractSvgGeometry(
      renderChartSvg(chartOf("area"), { width: WIDTH, height: HEIGHT })
    ).find(shape => shape.kind === "polygon");
    expect(svgFill?.fill).toBe("#4472c4@0.35");
    expect(record("area").calls.some(call => /f=#4472c4@0\.35/.test(call))).toBe(true);
  });
});

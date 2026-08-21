/**
 * Geometry baselines for every classic chart type.
 *
 * ## Why a *geometry* baseline and not an SVG hash
 *
 * Hashing the markup cannot survive a re-implementation: change the attribute
 * order, emit `<polyline>` where a `<path>` used to be, drop a redundant
 * `stroke-width="1"`, and the hash breaks even though the picture is identical.
 * The only way past a broken markup hash is to re-baseline it — which checks the
 * new output against itself and proves nothing.
 *
 * These hashes are taken over {@link describeSvgGeometry}, which normalises those
 * representational differences away and keeps everything a viewer would notice:
 * which shapes exist, in what order, at what coordinates, in what colour. A
 * renderer rewritten to draw the same picture reproduces the same hash; one that
 * moves a shape does not. That is what makes migrating the emitter provable
 * rather than a leap of faith.
 *
 * The shape census beside each hash is the diagnostic: when a hash changes, the
 * counts say whether shapes appeared, vanished or merely moved.
 *
 * `area`, `area3D` and `bubble` carry a **deliberate** change: their translucent
 * fills are now real alpha (`#4472c4@0.35`) instead of a colour pre-mixed towards
 * white. The old SVG emitter faked transparency by blending with the background,
 * so an area fill hid the gridlines beneath it — and the PDF emitter, which passed
 * genuine alpha, disagreed with it. Every backend can express alpha properly, so
 * unifying upward rather than down was the right direction; the coordinates are
 * unchanged. 3D face shading still pre-mixes, because there it is a lighting cue
 * and letting the background through would be wrong.
 *
 * The rest were re-derived from the string emitter after the oracle learnt to
 * resolve percentage lengths — `width="100%"` on a 240-unit canvas is the same
 * edge as `width="240"`, and not resolving it was a gap in the oracle rather than
 * a difference in the picture. They are *not* re-derived from the display-list
 * renderer, which is the whole point: the migration had to reproduce them.
 *
 * ## One deliberate change is baked in
 *
 * **A shaded surface cell has no outline.** It used to be drawn with a zero-width
 * stroke in the cell's own colour, which is a roundabout way of saying "no outline"
 * and left each backend to decide what a zero width meant: SVG painted nothing, the
 * rasteriser floored the width at one pixel, and PDF's `0 w` asks the device for its
 * thinnest line. Two of the three therefore drew an edge the SVG did not. The
 * producer now simply omits the stroke, so `surface` and `surface3D` lost four
 * `stroke=` attributes; the geometry, the shape census and the call count are
 * unchanged, and a wireframe surface still outlines every cell.
 *
 * **A legend names the series unless each point is coloured separately.** The
 * per-category branch used to fire for any chart with one series and more than one
 * category, ignoring the chart type, so a single-series bar, line, area, scatter,
 * bubble, radar or surface chart listed `A B C D` and never showed its own name —
 * and `varyColors`, the flag by which an author asks for per-point colours, was not
 * read anywhere in the renderer. It now fires for the pie family and for
 * `varyColors` only.
 *
 * The counts are the evidence that the change is exactly that: every affected type
 * loses three swatches and three labels — four category entries becoming one series
 * entry — while `pie`, `pie3D`, `doughnut`, `ofPie` and the four-series `stock`
 * chart keep their previous hashes untouched.
 */

import type { AddChartOptions } from "@excel/chart";
import { renderChartSvg } from "@excel/chart";
import { addChart, getCharts } from "@excel/core/worksheet";
import { Cell, Chart, Workbook } from "@excel/index";
import { describeSvgGeometry, extractSvgGeometry } from "@test/svg-geometry";
import { describe, expect, it } from "vitest";

import { stableHash } from "./chart-builder.helpers";

const SIZE = { width: 240, height: 160 };

/** `[geometry hash, shape count, shape census]` captured from the emitter. */
type Baseline = readonly [string, number, string];

const BASELINES: Record<string, Baseline> = {
  bar: ["399419c1", 30, "polyline:9 rect:6 text:15"],
  bar3D: ["72fe13c6", 38, "polygon:8 polyline:9 rect:6 text:15"],
  line: ["1110363f", 31, "circle:4 polyline:10 rect:2 text:15"],
  // line3D is a documented 2D degradation, so it is expected to match `line`.
  line3D: ["1110363f", 31, "circle:4 polyline:10 rect:2 text:15"],
  pie: ["4b2bace6", 14, "path:4 rect:5 text:5"],
  pie3D: ["4b2bace6", 14, "path:4 rect:5 text:5"],
  doughnut: ["c1e6fed0", 14, "path:4 rect:5 text:5"],
  area: ["15d2d80b", 28, "polygon:1 polyline:10 rect:2 text:15"],
  area3D: ["15d2d80b", 28, "polygon:1 polyline:10 rect:2 text:15"],
  scatter: ["8915a90c", 46, "circle:4 polyline:12 rect:2 text:28"],
  bubble: ["af401bca", 45, "circle:4 polyline:11 rect:2 text:28"],
  radar: ["121f2fd2", 28, "circle:1 polygon:1 polyline:9 rect:2 text:15"],
  stock: ["25d614b1", 39, "polyline:13 rect:9 text:17"],
  surface: ["d3864373", 30, "polyline:9 rect:6 text:15"],
  surface3D: ["d3864373", 30, "polyline:9 rect:6 text:15"],
  ofPie: ["2003d49a", 31, "path:4 polyline:4 rect:5 text:18"]
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

/** Census of shape kinds, e.g. `"rect:9 text:18"`. */
function census(svg: string): string {
  const counts = new Map<string, number>();
  for (const shape of extractSvgGeometry(svg)) {
    counts.set(shape.kind, (counts.get(shape.kind) ?? 0) + 1);
  }
  return [...counts.keys()]
    .sort()
    .map(kind => `${kind}:${counts.get(kind)!}`)
    .join(" ");
}

describe("classic chart geometry is stable", () => {
  for (const [type, [hash, count, kinds]] of Object.entries(BASELINES)) {
    it(`${type} draws the same picture`, () => {
      const svg = renderChartSvg(chartOf(type as AddChartOptions["type"]), SIZE);
      const shapes = extractSvgGeometry(svg);
      // Assert the census first: when it differs, the failure names what changed
      // instead of just reporting two hashes.
      expect(census(svg)).toBe(kinds);
      expect(shapes).toHaveLength(count);
      expect(stableHash(describeSvgGeometry(svg))).toBe(hash);
    });
  }

  it("distinguishes chart types from one another", () => {
    // A baseline suite where every entry collided would pass while rendering
    // nothing type-specific. The 2D degradations of the 3D types are expected to
    // collide, and are excluded.
    const degraded = new Set(["line3D", "pie3D", "area3D", "surface3D"]);
    const hashes = new Map<string, string[]>();
    for (const type of Object.keys(BASELINES)) {
      if (degraded.has(type)) {
        continue;
      }
      const hash = BASELINES[type][0];
      hashes.set(hash, [...(hashes.get(hash) ?? []), type]);
    }
    for (const [hash, types] of hashes) {
      expect(types, `types ${types.join(", ")} share geometry hash ${hash}`).toHaveLength(1);
    }
  });

  it("renders every type into a non-empty scene", () => {
    for (const type of Object.keys(BASELINES)) {
      const shapes = extractSvgGeometry(
        renderChartSvg(chartOf(type as AddChartOptions["type"]), SIZE)
      );
      // More than just the background rect.
      expect(shapes.length, type).toBeGreaterThan(5);
    }
  });

  it("scales the whole scene with the requested size", () => {
    const small = extractSvgGeometry(renderChartSvg(chartOf("bar"), { width: 240, height: 160 }));
    const large = extractSvgGeometry(renderChartSvg(chartOf("bar"), { width: 480, height: 320 }));
    expect(large).toHaveLength(small.length);
    // The rightmost coordinate must grow with the canvas rather than staying put.
    const rightmost = (shapes: typeof small): number =>
      Math.max(...shapes.flatMap(shape => shape.coords));
    expect(rightmost(large)).toBeGreaterThan(rightmost(small) * 1.5);
  });
});

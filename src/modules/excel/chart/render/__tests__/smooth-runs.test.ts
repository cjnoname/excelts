/**
 * Smooth line series across a gap.
 *
 * `c:smooth` asks for a spline, but a spline needs neighbours: `catmullRomPath` reads
 * `points[0]` and leans on `points[i ± 1]` for its tangents, so it has to be handed at
 * least three points. A blank cell splits a series into runs of arbitrary length —
 * including one and two — and it is the caller's guard, not the spline, that keeps the
 * short ones away from it. These tests pin that guard, and pin that a short run is still
 * drawn rather than dropped.
 */
import type { ChartScene } from "@excel/chart/render/chart-renderer";
import { sceneToDrawList } from "@excel/chart/render/scene-to-draw";
import { describe, expect, it } from "vitest";

/** A minimal scene carrying one smooth line series. */
function lineScene(points: { x: number; y: number }[]): ChartScene {
  return {
    width: 200,
    height: 100,
    plot: { x: 10, y: 10, width: 180, height: 80 },
    axes: {},
    gridlines: [],
    xLabels: [],
    yLabels: [],
    secondaryXLabels: [],
    secondaryYLabels: [],
    axisTitles: [],
    legend: { entries: [] },
    effectFilters: [],
    series: [{ type: "line", color: "#336699", points, smooth: true }]
  } as unknown as ChartScene;
}

/** Node kinds other than the background rect and the round data markers. */
function lineKinds(points: { x: number; y: number }[]): string[] {
  const children = sceneToDrawList(lineScene(points)).children;
  return children.filter(node => node.kind === "path" || node.kind === "polyline").map(n => n.kind);
}

const gap = { x: 20, y: Number.NaN };

describe("a smooth series broken by a blank", () => {
  it("splines the long run and draws the two-point run straight", () => {
    // A spline through two points *is* the straight line between them, so the polyline is
    // the right shape and not a degradation. What matters is that the two-point run never
    // reaches `catmullRomPath`.
    expect(
      lineKinds([
        { x: 0, y: 10 },
        { x: 10, y: 20 },
        gap,
        { x: 30, y: 40 },
        { x: 40, y: 30 },
        { x: 50, y: 50 }
      ])
    ).toEqual(["polyline", "path"]);
  });

  it("drops a run of one point but keeps the rest", () => {
    // One point has no segment to draw. Emitting a zero-length polyline would put a round
    // cap on the canvas at full stroke width — a dot the data does not have.
    expect(
      lineKinds([{ x: 0, y: 10 }, gap, { x: 30, y: 40 }, { x: 40, y: 30 }, { x: 50, y: 50 }])
    ).toEqual(["path"]);
  });

  it("draws nothing but still returns a list when every run is too short", () => {
    expect(lineKinds([{ x: 0, y: 10 }, gap, { x: 30, y: 40 }])).toEqual([]);
  });

  it("splines a run of exactly three", () => {
    expect(
      lineKinds([
        { x: 0, y: 10 },
        { x: 10, y: 20 },
        { x: 20, y: 5 }
      ])
    ).toEqual(["path"]);
  });
});

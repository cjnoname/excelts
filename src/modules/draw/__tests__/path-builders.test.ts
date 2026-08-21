/**
 * Contracts for the shared path builders.
 *
 * `sectorToPath` and `roundedRectToPath` each replaced a per-backend copy: the sector
 * lowering lived in the chart PDF adapter, and rounded corners existed only where the
 * surface had a native rounded rect. Now three backends lower through these, so a
 * mistake here is a mistake everywhere at once — including in the rasteriser, where the
 * result is also what a stroke's outline is traced from.
 *
 * Tested on the commands rather than on rendered pixels: the geometric properties that
 * matter — closure, extent, winding — are exact statements about the output, and reading
 * them back out of an image only re-tests the rasteriser.
 */

import { flattenPath, roundedRectToPath, sectorToPath } from "@draw/index";
import type { DrawPathCommand } from "@draw/index";
import { describe, expect, it } from "vitest";

/** Every on-curve point a path passes through. */
function anchors(commands: readonly DrawPathCommand[]): Array<{ x: number; y: number }> {
  return commands
    .filter(command => command.op !== "close")
    .map(command => ({ x: command.x, y: command.y }));
}

/** Axis-aligned bounds of a path's flattened outline. */
function bounds(commands: readonly DrawPathCommand[]): {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
} {
  const points = flattenPath(commands).flatMap(run => [...run.points]);
  return {
    minX: Math.min(...points.map(p => p.x)),
    maxX: Math.max(...points.map(p => p.x)),
    minY: Math.min(...points.map(p => p.y)),
    maxY: Math.max(...points.map(p => p.y))
  };
}

describe("lowering a sector to a path", () => {
  it("draws a wedge from the centre for a solid slice", () => {
    // A pie slice, which is what the classic renderer has always drawn: move to the
    // centre, out to the rim, round, and closed. The ChartEx emitter used to write a
    // ring path with a zero-radius inner arc for the same shape — the same region,
    // described with a command that does nothing.
    const commands = sectorToPath(0, 0, 50, 0, 0, Math.PI / 2);
    expect(commands[0]).toEqual({ op: "move", x: 0, y: 0 });
    expect(commands.at(-1)).toEqual({ op: "close" });
    const start = anchors(commands)[1];
    expect(start.x).toBeCloseTo(50, 6);
    expect(start.y).toBeCloseTo(0, 6);
    const end = anchors(commands).at(-1)!;
    expect(end.x).toBeCloseTo(0, 6);
    expect(end.y).toBeCloseTo(50, 6);
  });

  it("draws an annulus with two arcs and no centre point", () => {
    // A doughnut slice never touches the middle.
    const commands = sectorToPath(0, 0, 50, 20, 0, Math.PI / 2);
    const points = anchors(commands);
    expect(points.some(p => Math.abs(p.x) < 1e-9 && Math.abs(p.y) < 1e-9)).toBe(false);
    const radii = points.map(p => Math.hypot(p.x, p.y));
    expect(Math.min(...radii)).toBeGreaterThan(19);
    expect(Math.max(...radii)).toBeLessThan(51);
  });

  it("stays within the circle it was asked for", () => {
    const box = bounds(sectorToPath(100, 100, 40, 0, 0.3, 2.4));
    expect(box.minX).toBeGreaterThanOrEqual(60 - 1e-6);
    expect(box.maxX).toBeLessThanOrEqual(140 + 1e-6);
    expect(box.minY).toBeGreaterThanOrEqual(60 - 1e-6);
    expect(box.maxY).toBeLessThanOrEqual(140 + 1e-6);
  });

  it("walks a whole circle as two halves", () => {
    // One arc spanning a full turn is degenerate — its start and end coincide, so the
    // sweep is ambiguous. Splitting it keeps both halves well defined.
    const commands = sectorToPath(0, 0, 30, 0, 0, Math.PI * 2);
    const box = bounds(commands);
    expect(box.maxX - box.minX).toBeCloseTo(60, 0);
    expect(box.maxY - box.minY).toBeCloseTo(60, 0);
  });

  it("gives a full annulus an inner ring as well as an outer one", () => {
    const runs = flattenPath(sectorToPath(0, 0, 30, 12, 0, Math.PI * 2));
    expect(runs.length).toBeGreaterThanOrEqual(2);
    const radii = runs.map(run =>
      Math.max(...run.points.map(point => Math.hypot(point.x, point.y)))
    );
    expect(Math.min(...radii)).toBeLessThan(13);
    expect(Math.max(...radii)).toBeGreaterThan(29);
  });
});

describe("lowering a rounded rectangle to a path", () => {
  it("closes, and stays inside the box", () => {
    const commands = roundedRectToPath(10, 20, 60, 40, 8);
    expect(commands.at(-1)).toEqual({ op: "close" });
    const box = bounds(commands);
    expect(box.minX).toBeGreaterThanOrEqual(10 - 1e-6);
    expect(box.maxX).toBeLessThanOrEqual(70 + 1e-6);
    expect(box.minY).toBeGreaterThanOrEqual(20 - 1e-6);
    expect(box.maxY).toBeLessThanOrEqual(60 + 1e-6);
  });

  it("reaches every edge of the box", () => {
    // Rounded corners must not shrink the rectangle.
    const box = bounds(roundedRectToPath(10, 20, 60, 40, 8));
    expect(box.minX).toBeCloseTo(10, 1);
    expect(box.maxX).toBeCloseTo(70, 1);
    expect(box.minY).toBeCloseTo(20, 1);
    expect(box.maxY).toBeCloseTo(60, 1);
  });

  it("keeps the corners clear of the box's own corners", () => {
    // The point of the radius: no anchor sits at (10, 20).
    const points = anchors(roundedRectToPath(10, 20, 60, 40, 8));
    expect(points.some(p => Math.abs(p.x - 10) < 1e-9 && Math.abs(p.y - 20) < 1e-9)).toBe(false);
  });

  it("degrades to a plain rectangle at zero radius", () => {
    const commands = roundedRectToPath(0, 0, 10, 10, 0);
    expect(commands.every(command => command.op !== "cubic")).toBe(true);
    expect(anchors(commands)).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 }
    ]);
  });

  it("clamps a radius larger than the shorter side, as SVG does", () => {
    // Asking for 40 on a 20-tall box would otherwise make the corners cross.
    const box = bounds(roundedRectToPath(0, 0, 60, 20, 40));
    expect(box.minY).toBeGreaterThanOrEqual(-1e-6);
    expect(box.maxY).toBeLessThanOrEqual(20 + 1e-6);
    expect(box.maxX - box.minX).toBeCloseTo(60, 0);
  });

  it("treats a negative radius as none", () => {
    const commands = roundedRectToPath(0, 0, 10, 10, -5);
    expect(commands.every(command => command.op !== "cubic")).toBe(true);
  });
});

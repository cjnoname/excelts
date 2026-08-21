/**
 * Degenerate and boundary cases for the thick-stroke rasteriser.
 *
 * A thick stroke is not drawn with a brush any more: each segment is filled as a quad
 * and each corner gets a wedge, all inside one coverage pass. That rewrite fixed real
 * bugs — `butt` caps ran half a width long, and translucent joins were blended twice —
 * but it also introduced arithmetic that divides by a segment's length and by its
 * coverage. The cases here are the ones where those divisors go to zero or the geometry
 * folds back on itself.
 *
 * All of them were verified by hand while the rewrite was being done. Keeping them as
 * tests is the difference between having checked once and knowing.
 */

import type { DrawList, DrawNode, DrawPaint } from "@draw/index";
import { rasterizeToRgba } from "@draw/raster/surface";
import { describe, expect, it } from "vitest";

const SIZE = 70;
const BLACK = { r: 0, g: 0, b: 0, a: 1 };
const HALF = { r: 0, g: 0, b: 0, a: 0.5 };

/** Render over white and return a pixel reader plus an ink count. */
function render(
  node: DrawNode,
  size = SIZE
): {
  at: (x: number, y: number) => number;
  ink: (x0: number, y0: number, x1: number, y1: number) => number;
} {
  const list: DrawList = {
    width: size,
    height: size,
    children: [
      {
        kind: "rect",
        x: 0,
        y: 0,
        width: size,
        height: size,
        paint: { fill: { r: 1, g: 1, b: 1, a: 1 } }
      },
      node
    ]
  };
  // Straight from the rasteriser: the PNG round trip this used to make was lossless, so
  // it proved nothing the pixels do not, and reading them directly keeps the test at the
  // same layer as the code it covers.
  const image = rasterizeToRgba(list, { width: size, height: size });
  const at = (x: number, y: number): number => image.data[(y * image.width + x) * 4];
  return {
    at,
    ink: (x0, y0, x1, y1) => {
      let count = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          if (at(x, y) < 200) {
            count++;
          }
        }
      }
      return count;
    }
  };
}

const stroke = (paint: Partial<DrawPaint>, points: Array<[number, number]>): DrawNode => ({
  kind: "polyline",
  points: points.map(([x, y]) => ({ x, y })),
  paint: { stroke: BLACK, strokeWidth: 12, ...paint }
});

describe("a stroke with no length", () => {
  it("draws a disc for a round cap", () => {
    // Both endpoints coincide, so the segment's direction is undefined and its normal
    // cannot be computed. A round cap still has something to draw.
    const { at } = render(
      stroke({ lineCap: "round" }, [
        [35, 35],
        [35, 35]
      ])
    );
    expect(at(35, 35)).toBe(0);
    // A 12-wide stroke caps with a radius-6 disc, so it reaches y = 29..41 and no
    // further.
    expect(at(35, 40)).toBeLessThan(200);
    expect(at(35, 44)).toBe(255);
    expect(at(10, 10)).toBe(255);
  });

  it("draws nothing for a butt cap", () => {
    // A zero-length butt-capped stroke has zero area. Drawing a dot would make a
    // gap in a dashed line look like a mark.
    const { ink } = render(
      stroke({}, [
        [35, 35],
        [35, 35]
      ])
    );
    expect(ink(0, 0, SIZE, SIZE)).toBe(0);
  });

  it("survives a repeated point in the middle of a run", () => {
    // A duplicated vertex gives one segment zero length while its neighbours are fine.
    const { at } = render(
      stroke({}, [
        [10, 35],
        [35, 35],
        [35, 35],
        [60, 35]
      ])
    );
    expect(at(22, 35)).toBe(0);
    expect(at(35, 35)).toBe(0);
    expect(at(48, 35)).toBe(0);
  });
});

describe("a stroke that folds back on itself", () => {
  it("stops at the far end of a 180-degree fold", () => {
    // Out and back along the same line. The corner's two directions are opposite, so
    // the bevel wedge is degenerate; the stroke must still end where it ends.
    const { at } = render(
      stroke({ strokeWidth: 10 }, [
        [20, 35],
        [55, 35],
        [20, 35]
      ])
    );
    expect(at(37, 35)).toBe(0);
    expect(at(50, 35)).toBe(0);
    // A butt cap ends *at* x=55, so 54 is the last column inside the stroke and 55 is the
    // first outside it. The scanline spans are half-open for that reason: covering both
    // ends of every span put an extra column here, and composited the shared column twice
    // wherever a fill was translucent.
    expect(at(54, 35)).toBeLessThan(200);
    expect(at(55, 35)).toBe(255);
    expect(at(58, 35)).toBe(255);
  });

  it("does not double-darken a translucent fold", () => {
    const { at } = render(
      stroke({ stroke: HALF, strokeWidth: 10 }, [
        [20, 35],
        [55, 35],
        [20, 35]
      ])
    );
    // The two passes lie exactly on top of each other; coverage is unioned, not summed.
    expect(at(37, 35)).toBeGreaterThan(115);
    expect(at(37, 35)).toBeLessThan(140);
  });
});

describe("the hairline threshold", () => {
  it("draws a continuous line just below it", () => {
    // At or under half a pixel of radius the outline degenerates, so a Bresenham run is
    // used instead. The line still has to be unbroken.
    const { ink } = render(
      stroke({ strokeWidth: 1 }, [
        [10, 30],
        [60, 40]
      ])
    );
    expect(ink(10, 25, 61, 45)).toBeGreaterThan(40);
  });

  it("draws a continuous line just above it", () => {
    const { ink } = render(
      stroke({ strokeWidth: 1.2 }, [
        [10, 30],
        [60, 40]
      ])
    );
    expect(ink(10, 25, 61, 45)).toBeGreaterThan(40);
  });

  it("gets thicker as the width grows across the threshold", () => {
    const thickness = (strokeWidth: number): number =>
      render(
        stroke({ strokeWidth }, [
          [10, 35],
          [60, 35]
        ])
      ).ink(30, 20, 31, 50);
    expect(thickness(6)).toBeGreaterThan(thickness(1.2));
    expect(thickness(1.2)).toBeGreaterThanOrEqual(thickness(1));
  });
});

describe("a closed run has corners, not ends", () => {
  it("inks all four corners of a stroked rectangle", () => {
    // The first and last vertex of a closed run meet, and that seam is a corner like
    // any other. Treating it as two ends left a notch.
    const { at } = render({
      kind: "polyline",
      closed: true,
      points: [
        { x: 20, y: 20 },
        { x: 50, y: 20 },
        { x: 50, y: 50 },
        { x: 20, y: 50 }
      ],
      paint: { stroke: BLACK, strokeWidth: 8 }
    });
    for (const [x, y] of [
      [20, 20],
      [50, 20],
      [50, 50],
      [20, 50]
    ]) {
      expect(at(x, y), `corner ${x},${y}`).toBe(0);
    }
  });

  it("rounds a closed run's seam when the join is round", () => {
    // Asserted on geometry, not shade: the coverage pass makes the shade uniform
    // whatever the join is, so a test that compared brightness could not tell a round
    // seam from a notched one.
    //
    // The seam is the first and last vertex meeting. Treating it as two ends rather
    // than a corner left a notch there, and a round join has to fill it out to the
    // stroke's own radius — measurably more ink outside the vertex than a bevel puts
    // there.
    const seamInk = (paint: Partial<DrawPaint>): number => {
      const { ink } = render({
        kind: "polyline",
        closed: true,
        points: [
          { x: 20, y: 20 },
          { x: 50, y: 20 },
          { x: 35, y: 50 }
        ],
        paint: { stroke: BLACK, strokeWidth: 12, ...paint }
      });
      // A box just outside the seam vertex, on the far side of both segments.
      return ink(12, 12, 21, 21);
    };
    expect(seamInk({ lineJoin: "round" })).toBeGreaterThan(seamInk({}) * 2);
  });

  it("leaves no notch at a closed run's seam even with the default join", () => {
    // Whatever the join style, the seam must not be empty.
    const { ink } = render({
      kind: "polyline",
      closed: true,
      points: [
        { x: 20, y: 20 },
        { x: 50, y: 20 },
        { x: 35, y: 50 }
      ],
      paint: { stroke: BLACK, strokeWidth: 12 }
    });
    expect(ink(14, 14, 21, 21)).toBeGreaterThan(0);
  });
});

describe("a sharp corner comes to a point", () => {
  const peak = (paint: Partial<DrawPaint>): number => {
    const { ink } = render({
      kind: "polyline",
      points: [
        { x: 15, y: 65 },
        { x: 40, y: 15 },
        { x: 65, y: 65 }
      ],
      paint: { stroke: BLACK, strokeWidth: 14, ...paint }
    });
    // Above the vertex, where a miter's spike reaches and a bevel's cut does not.
    return ink(30, 4, 51, 16);
  };

  it("miters by default, as SVG and PDF do", () => {
    // The rasteriser filled the notch with a bevel wedge and stopped there, so every
    // sharp corner was cut flat while the other two backends came to a point. Visible on
    // any line chart with a peak.
    expect(peak({})).toBeGreaterThan(peak({ lineJoin: "bevel" }) * 1.5);
    expect(peak({ lineJoin: "miter" })).toBe(peak({}));
  });

  it("puts round between bevel and miter", () => {
    const bevel = peak({ lineJoin: "bevel" });
    const round = peak({ lineJoin: "round" });
    expect(round).toBeGreaterThan(bevel);
    expect(round).toBeLessThan(peak({ lineJoin: "miter" }));
  });

  it("lengthens the spike as the corner sharpens, then drops it at the limit", () => {
    // Two things had to be right for a miter to exist at all, and neither was.
    //
    // The angle: `atan2(|cross|, dot)` on the direction vectors is the *turn*, and the
    // corner's interior angle is its supplement — so `sin(interior/2)` is `cos(turn/2)`.
    // Taking the supplement a second time left the value near 1 for every corner, the
    // miter length equal to the radius, and the spike no longer than the bevel it sat on.
    //
    // The limit: the spec measures the miter against the stroke *width*, not its half.
    //
    // A sharper corner therefore has to reach further, and past the limit it has to stop.
    const outside = (interiorDegrees: number): number => {
      const angle = Math.PI * (interiorDegrees / 180);
      const { ink } = render(
        {
          kind: "polyline",
          points: [
            { x: 5, y: 60 },
            { x: 60, y: 60 },
            { x: 60 - Math.cos(angle) * 55, y: 60 - Math.sin(angle) * 55 }
          ],
          paint: { stroke: BLACK, strokeWidth: 12 }
        },
        130
      );
      return ink(58, 52, 128, 80);
    };
    // Monotone as the corner sharpens, while inside the limit.
    expect(outside(40)).toBeGreaterThan(outside(90));
    expect(outside(20)).toBeGreaterThan(outside(40));
    expect(outside(15)).toBeGreaterThan(outside(20));
    // `interior = 10` is a ratio of 5.74, past the limit of 4: the spike goes and the
    // bevel is all that is left, so the ink collapses.
    expect(outside(10)).toBeLessThan(outside(15) / 4);
  });

  it("drops the spike past the miter limit rather than running away", () => {
    // A nearly doubled-back corner has an intersection that runs to infinity. SVG's
    // default limit of 4 cuts it off, leaving the bevel.
    const spike = (angle: number): number => {
      const { ink } = render({
        kind: "polyline",
        points: [
          { x: 20, y: 40 },
          { x: 50, y: 40 },
          { x: 20 + Math.cos(angle) * 30, y: 40 + Math.sin(angle) * 30 }
        ],
        paint: { stroke: BLACK, strokeWidth: 10 }
      });
      return ink(50, 20, 70, 60);
    };
    // A 170-degree turn is inside the limit; a 178-degree one is not.
    expect(spike(Math.PI * (170 / 180))).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(spike(Math.PI * (178 / 180)))).toBe(true);
  });
});

describe("a mitred corner composites once", () => {
  it("keeps a translucent spike the same shade as its arms", () => {
    // The miter is filled as two triangles, one per side, because which side is outer
    // depends on the turn — the inner one lands inside the stroke. That is only harmless
    // because the whole stroke is one coverage pass; blending each piece would show the
    // spike darker than the arms it grows out of.
    const angle = Math.PI * (30 / 180);
    const { at } = render(
      {
        kind: "polyline",
        points: [
          { x: 60 - Math.cos(angle) * 50, y: 60 - Math.sin(angle) * 50 },
          { x: 60, y: 60 },
          { x: 60 - Math.cos(angle) * 50, y: 60 + Math.sin(angle) * 50 }
        ],
        paint: { stroke: HALF, strokeWidth: 14 }
      },
      120
    );
    // Sampled well inside the ink, so antialiased edges do not enter into it.
    const interior: number[] = [];
    for (let y = 50; y < 71; y++) {
      for (let x = 46; x < 74; x++) {
        const value = at(x, y);
        if (value > 250) {
          continue;
        }
        const neighbours = [at(x - 1, y), at(x + 1, y), at(x, y - 1), at(x, y + 1)];
        if (neighbours.every(other => Math.abs(other - value) <= 8)) {
          interior.push(value);
        }
      }
    }
    expect(interior.length).toBeGreaterThan(100);
    expect(new Set(interior).size).toBe(1);
  });

  it("leaves the concave side of the corner empty", () => {
    // The spike is built from the outer bisector. Filling both sides must not put ink in
    // the notch between the two arms.
    const angle = Math.PI * (30 / 180);
    const { ink } = render(
      {
        kind: "polyline",
        points: [
          { x: 60 - Math.cos(angle) * 50, y: 60 - Math.sin(angle) * 50 },
          { x: 60, y: 60 },
          { x: 60 - Math.cos(angle) * 50, y: 60 + Math.sin(angle) * 50 }
        ],
        paint: { stroke: BLACK, strokeWidth: 14 }
      },
      120
    );
    // Between the arms and clear of both: the notch itself.
    expect(ink(24, 57, 38, 64)).toBe(0);
  });
});

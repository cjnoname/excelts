import { relativeLuminance } from "@draw/colour";
import {
  IDENTITY,
  apply,
  arcToCubics,
  flattenPath,
  multiply,
  renderDrawList,
  rotate,
  rotationOf,
  scale,
  SvgSurface,
  toSvg,
  translate,
  uniformScale
} from "@draw/index";
import type {
  DrawList,
  DrawMatrix,
  DrawNode,
  DrawPaint,
  DrawPathCommand,
  DrawSurface
} from "@draw/index";
import { describe, expect, it } from "vitest";

const BLUE = { r: 0.2, g: 0.4, b: 0.8, a: 1 };
const RED = { r: 1, g: 0, b: 0, a: 1 };

/** Records every surface call so tests can assert on final geometry. */
function recorder() {
  const calls: string[] = [];
  const n = (value: number): string => String(Math.round(value * 1000) / 1000);
  const surface: DrawSurface = {
    rect: (x, y, w, h, rx) => calls.push(`rect ${n(x)} ${n(y)} ${n(w)} ${n(h)} rx=${n(rx)}`),
    ellipse: (cx, cy, rx, ry) => calls.push(`ellipse ${n(cx)} ${n(cy)} ${n(rx)} ${n(ry)}`),
    sector: (cx, cy, r, ir, a0, a1) =>
      calls.push(`sector ${n(cx)} ${n(cy)} ${n(r)} ${n(ir)} ${n(a0)} ${n(a1)}`),
    polyline: (points, closed) =>
      calls.push(
        `${closed ? "polygon" : "polyline"} ${points.map(p => `${n(p.x)},${n(p.y)}`).join(" ")}`
      ),
    path: commands =>
      calls.push(
        `path ${commands
          .map(c =>
            c.op === "close"
              ? "Z"
              : c.op === "cubic"
                ? `C${n(c.x)},${n(c.y)}`
                : `${c.op[0].toUpperCase()}${n(c.x)},${n(c.y)}`
          )
          .join(" ")}`
      ),
    text: (x, y, lines, style, rot) =>
      calls.push(
        `text ${n(x)} ${n(y)} rot=${n(rot)} size=${n(style.size)} ${lines.map(l => `${l.text}@${n(l.dy)}`).join("|")}`
      )
  };
  return { surface, calls };
}

function list(children: DrawNode[], width = 100, height = 100): DrawList {
  return { width, height, children };
}

const fill = (paint: Partial<DrawPaint> = {}): DrawPaint => ({ fill: BLUE, ...paint });

describe("matrix helpers", () => {
  it("composes outer after inner", () => {
    const m = multiply(translate(10, 20), scale(2));
    expect(apply(m, 3, 4)).toEqual({ x: 16, y: 28 });
  });

  it("rotates clockwise about a centre in Y-down space", () => {
    const point = apply(rotate(90, 0, 0), 1, 0);
    expect(point.x).toBeCloseTo(0, 9);
    expect(point.y).toBeCloseTo(1, 9);
  });

  it("keeps a rotation centre fixed", () => {
    const point = apply(rotate(37, 5, -3), 5, -3);
    expect(point.x).toBeCloseTo(5, 9);
    expect(point.y).toBeCloseTo(-3, 9);
  });

  it("reports the uniform-equivalent scale", () => {
    expect(uniformScale(scale(3))).toBeCloseTo(3, 9);
    expect(uniformScale(scale(4, 1))).toBeCloseTo(2, 9);
    expect(uniformScale(IDENTITY)).toBe(1);
    // A degenerate transform must not report a zero factor and collapse strokes.
    expect(uniformScale(scale(0))).toBe(1);
  });

  it("recovers a rotation angle", () => {
    expect(rotationOf(rotate(-90))).toBeCloseTo(-90, 6);
    expect(rotationOf(IDENTITY)).toBe(0);
  });
});

describe("the walker folds transforms into geometry", () => {
  it("flattens nested groups", () => {
    const { surface, calls } = recorder();
    renderDrawList(
      list([
        {
          kind: "group",
          transform: translate(10, 10),
          children: [
            {
              kind: "group",
              transform: scale(2),
              children: [{ kind: "rect", x: 1, y: 2, width: 3, height: 4, paint: fill() }]
            }
          ]
        }
      ]),
      surface
    );
    // (1,2) → ×2 → (2,4) → +10 → (12,14); size 3×4 → 6×8.
    expect(calls).toEqual(["rect 12 14 6 8 rx=0"]);
  });

  it("scales stroke width and dash lengths with the transform", () => {
    const seen: DrawPaint[] = [];
    const surface: DrawSurface = {
      rect: (_x, _y, _w, _h, _rx, paint) => seen.push(paint),
      ellipse: () => {},
      sector: () => {},
      polyline: () => {},
      path: () => {},
      text: () => {}
    };
    renderDrawList(
      list([
        {
          kind: "group",
          transform: scale(3),
          children: [
            {
              kind: "rect",
              x: 0,
              y: 0,
              width: 1,
              height: 1,
              paint: { stroke: RED, strokeWidth: 2, dash: [4, 2] }
            }
          ]
        }
      ]),
      surface
    );
    expect(seen[0].strokeWidth).toBeCloseTo(6, 9);
    expect(seen[0].dash).toEqual([12, 6]);
  });

  it("turns a rotated rect into a polygon so corners cannot land wrong", () => {
    const { surface, calls } = recorder();
    renderDrawList(
      list([
        {
          kind: "group",
          transform: rotate(90, 0, 0),
          children: [{ kind: "rect", x: 0, y: 0, width: 2, height: 4, paint: fill() }]
        }
      ]),
      surface
    );
    expect(calls[0].startsWith("polygon ")).toBe(true);
    expect(calls[0]).toBe("polygon 0,0 0,2 -4,2 -4,0");
  });

  it("keeps an axis-aligned rect a rect and scales its corner radius", () => {
    const { surface, calls } = recorder();
    renderDrawList(
      list([
        {
          kind: "group",
          transform: scale(2),
          children: [{ kind: "rect", x: 0, y: 0, width: 5, height: 5, rx: 1, paint: fill() }]
        }
      ]),
      surface
    );
    expect(calls).toEqual(["rect 0 0 10 10 rx=2"]);
  });

  it("normalises a mirrored rect to a positive extent", () => {
    const { surface, calls } = recorder();
    renderDrawList(
      list([
        {
          kind: "group",
          transform: scale(-1, 1),
          children: [{ kind: "rect", x: 1, y: 0, width: 4, height: 2, paint: fill() }]
        }
      ]),
      surface
    );
    expect(calls).toEqual(["rect -5 0 4 2 rx=0"]);
  });

  it("lowers a rotated ellipse to a path", () => {
    const { surface, calls } = recorder();
    renderDrawList(
      list([
        {
          kind: "group",
          transform: rotate(30),
          children: [{ kind: "ellipse", cx: 0, cy: 0, rx: 4, ry: 2, paint: fill() }]
        }
      ]),
      surface
    );
    expect(calls[0].startsWith("path M")).toBe(true);
    expect(calls[0].endsWith("Z")).toBe(true);
  });

  it("hands text an absolute origin, a scaled size and a combined rotation", () => {
    const { surface, calls } = recorder();
    renderDrawList(
      list([
        {
          kind: "group",
          transform: multiply(translate(5, 5), scale(2)),
          children: [
            {
              kind: "text",
              x: 1,
              y: 1,
              rotate: -90,
              lines: [
                { text: "A", dy: 0 },
                { text: "B", dy: 10 }
              ],
              style: { size: 6, fill: RED }
            }
          ]
        }
      ]),
      surface
    );
    // Origin (1,1)→(7,7); size 6→12; dy 10→20; rotation −90 plus the group's 0.
    expect(calls).toEqual(["text 7 7 rot=-90 size=12 A@0|B@20"]);
  });
});

describe("a sector under a transform it cannot survive", () => {
  /**
   * A quarter sector at the origin, sweeping into the +x/+y quadrant — which is
   * down-and-right, since this space is Y-down.
   */
  const quarter = (transform: DrawMatrix): DrawNode => ({
    kind: "group",
    transform,
    children: [
      {
        kind: "sector",
        cx: 0,
        cy: 0,
        radius: 50,
        innerRadius: 0,
        startAngle: 0,
        endAngle: Math.PI / 2,
        paint: fill()
      }
    ]
  });

  /** The last on-curve point the surface was given. */
  const endsAt = (calls: string[]): { x: number; y: number } => {
    const tokens = calls[0].split(" ");
    const last = tokens[tokens.length - 2];
    const [x, y] = last
      .replace(/^[A-Z]/, "")
      .split(",")
      .map(Number);
    return { x, y };
  };

  it("stays a sector under rotation and uniform scale", () => {
    // The whole reason the primitive exists: the backends each draw a circular
    // sector better than they draw an approximation of one.
    for (const transform of [IDENTITY, rotate(30), scale(2, 2), translate(10, 5)]) {
      const { surface, calls } = recorder();
      renderDrawList(list([quarter(transform)]), surface);
      expect(calls[0].startsWith("sector "), `${JSON.stringify(transform)}`).toBe(true);
    }
  });

  it("mirrors into the opposite quadrant, not the opposite corner", () => {
    // Reflecting across the Y axis has to put the wedge bottom-left: x negates,
    // y does not. Keeping the sector primitive here sent it top-left instead,
    // because a reflection reverses the direction the arc sweeps and the angles
    // were only being shifted by `rotationOf`, which cannot express that.
    const { surface, calls } = recorder();
    renderDrawList(list([quarter(scale(-1, 1))]), surface);
    expect(calls[0].startsWith("path ")).toBe(true);
    const end = endsAt(calls);
    expect(end.x).toBeCloseTo(0, 6);
    expect(end.y).toBeCloseTo(50, 6);
    // The wedge's straight edge runs to the mirrored radius.
    expect(calls[0]).toContain("L-50,0");
  });

  it("becomes an elliptical wedge under a non-uniform scale", () => {
    // `scale(2, 1)` on a radius-50 sector is an ellipse with rx=100, ry=50. The
    // sector primitive can only carry one radius, so it used to emit a circular
    // arc of radius sqrt(2)*50 ending at (0, 70.71) — a point the transform never
    // maps anything to.
    const { surface, calls } = recorder();
    renderDrawList(list([quarter(scale(2, 1))]), surface);
    expect(calls[0].startsWith("path ")).toBe(true);
    expect(calls[0]).toContain("L100,0");
    const end = endsAt(calls);
    expect(end.x).toBeCloseTo(0, 6);
    expect(end.y).toBeCloseTo(50, 6);
  });

  it("keeps an annular sector's hole under a reflection", () => {
    // The inner arc has to reflect with the outer one, or the ring is drawn with
    // its hole on the wrong side.
    const { surface, calls } = recorder();
    renderDrawList(
      list([
        {
          kind: "group",
          transform: scale(-1, 1),
          children: [
            {
              kind: "sector",
              cx: 0,
              cy: 0,
              radius: 50,
              innerRadius: 20,
              startAngle: 0,
              endAngle: Math.PI / 2,
              paint: fill()
            }
          ]
        }
      ]),
      surface
    );
    // Outer edge starts at the mirrored outer radius, the outer arc reaches
    // (0, 50), a straight edge crosses to the inner arc's start at (0, 20), and the
    // inner arc returns to the mirrored inner radius — the ring quadrant, mirrored
    // whole. The recorder prints only each cubic's endpoint.
    expect(calls[0]).toBe("path M-50,0 C0,50 L0,20 C-20,0 Z");
  });
});

describe("flattening a path for a backend that has none", () => {
  const square = (x: number, y: number): DrawPathCommand[] => [
    { op: "move", x, y },
    { op: "line", x: x + 10, y },
    { op: "line", x: x + 10, y: y + 10 },
    { op: "close" }
  ];

  it("keeps two rings apart and closes each", () => {
    // A feature with an island, or an outline with a hole, is one path with two
    // subpaths. Collecting every command into a single point list drew a connector
    // from the end of the first ring to the start of the second — on a region map,
    // a line across the ocean — and dropped both closing edges.
    const runs = flattenPath([...square(0, 0), ...square(20, 20)]);
    expect(runs).toHaveLength(2);
    expect(runs.every(run => run.closed)).toBe(true);
    expect(runs[0].points).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 }
    ]);
    expect(runs[1].points[0]).toEqual({ x: 20, y: 20 });
  });

  it("marks a run that never closed as open", () => {
    const runs = flattenPath([
      { op: "move", x: 0, y: 0 },
      { op: "line", x: 5, y: 5 }
    ]);
    expect(runs).toHaveLength(1);
    expect(runs[0].closed).toBe(false);
  });

  it("drops a subpath with nothing to draw", () => {
    // A lone `move` has no length; emitting it as a run would make backends guard
    // against one-point polylines.
    expect(flattenPath([{ op: "move", x: 1, y: 1 }, { op: "close" }])).toHaveLength(0);
  });

  it("subdivides a cubic by its own size", () => {
    const short = flattenPath([
      { op: "move", x: 0, y: 0 },
      { op: "cubic", x1: 1, y1: 0, x2: 2, y2: 0, x: 3, y: 0 }
    ]);
    const long = flattenPath([
      { op: "move", x: 0, y: 0 },
      { op: "cubic", x1: 100, y1: 0, x2: 200, y2: 0, x: 300, y: 0 }
    ]);
    expect(long[0].points.length).toBeGreaterThan(short[0].points.length);
  });
});

describe("arc lowering", () => {
  it("degrades a zero-radius arc to a line", () => {
    expect(arcToCubics({ x: 0, y: 0 }, 0, 5, 0, false, true, { x: 10, y: 0 })).toEqual([
      { op: "line", x: 10, y: 0 }
    ]);
  });

  it("ends a semicircle at the requested point", () => {
    const commands = arcToCubics({ x: -5, y: 0 }, 5, 5, 0, false, true, { x: 5, y: 0 });
    expect(commands.length).toBeGreaterThan(0);
    const last = commands.at(-1)!;
    expect(last.op).toBe("cubic");
    if (last.op === "cubic") {
      expect(last.x).toBeCloseTo(5, 6);
      expect(last.y).toBeCloseTo(0, 6);
    }
  });

  it("stays on the circle at the midpoint of a sweep", () => {
    // Sampling the lowered curve is the only real check that the approximation is
    // the arc and not merely a curve with the right endpoints.
    const commands = arcToCubics({ x: 10, y: 0 }, 10, 10, 0, false, true, { x: 0, y: 10 });
    const first = commands[0];
    expect(first.op).toBe("cubic");
    if (first.op === "cubic") {
      const t = 0.5;
      const u = 1 - t;
      const x =
        u * u * u * 10 + 3 * u * u * t * first.x1 + 3 * u * t * t * first.x2 + t * t * t * first.x;
      const y =
        u * u * u * 0 + 3 * u * u * t * first.y1 + 3 * u * t * t * first.y2 + t * t * t * first.y;
      expect(Math.hypot(x, y)).toBeCloseTo(10, 2);
    }
  });

  it("respects the sweep flag", () => {
    const cw = arcToCubics({ x: 0, y: -5 }, 5, 5, 0, false, true, { x: 0, y: 5 });
    const ccw = arcToCubics({ x: 0, y: -5 }, 5, 5, 0, false, false, { x: 0, y: 5 });
    const midX = (commands: ReturnType<typeof arcToCubics>): number => {
      const c = commands[0];
      return c.op === "cubic" ? c.x1 : 0;
    };
    expect(Math.sign(midX(cw))).toBe(-Math.sign(midX(ccw)));
  });

  it("enlarges radii that cannot span the chord", () => {
    // rx=1 cannot reach from (0,0) to (10,0); the spec says scale it up, not fail.
    const commands = arcToCubics({ x: 0, y: 0 }, 1, 1, 0, false, true, { x: 10, y: 0 });
    const last = commands.at(-1)!;
    if (last.op === "cubic") {
      expect(last.x).toBeCloseTo(10, 6);
      expect(last.y).toBeCloseTo(0, 6);
    }
  });
});

describe("SVG output", () => {
  it("emits a viewBox so a different output size scales", () => {
    const svg = toSvg(list([]), { width: 200, height: 200 });
    expect(svg).toContain('width="200" height="200"');
    expect(svg).toContain('viewBox="0 0 100 100"');
  });

  it("writes fill:none for an open polyline", () => {
    // SVG's initial fill is black, so omitting this fills the area under a line.
    const svg = toSvg(
      list([
        {
          kind: "polyline",
          points: [
            { x: 0, y: 0 },
            { x: 5, y: 5 }
          ],
          paint: { fill: BLUE, stroke: RED }
        }
      ])
    );
    expect(svg).toContain("<polyline");
    expect(svg).toContain('fill="none"');
  });

  it("emits a circle rather than an ellipse when the radii match", () => {
    // The Excel raster fallback understands `<circle>` but not `<ellipse>`, so
    // staying in the shared subset keeps this output consumable everywhere.
    expect(toSvg(list([{ kind: "ellipse", cx: 5, cy: 5, rx: 3, ry: 3, paint: fill() }]))).toContain(
      "<circle"
    );
    expect(toSvg(list([{ kind: "ellipse", cx: 5, cy: 5, rx: 3, ry: 2, paint: fill() }]))).toContain(
      "<ellipse"
    );
  });

  it("carries alpha as a separate opacity attribute", () => {
    const svg = toSvg(
      list([
        {
          kind: "rect",
          x: 0,
          y: 0,
          width: 4,
          height: 4,
          paint: { fill: { r: 1, g: 0, b: 0, a: 0.5 } }
        }
      ])
    );
    expect(svg).toContain('fill="#ff0000"');
    expect(svg).toContain('fill-opacity="0.5"');
  });

  it("emits dash and stroke width only when meaningful", () => {
    const svg = toSvg(
      list([
        {
          kind: "line",
          x1: 0,
          y1: 0,
          x2: 9,
          y2: 0,
          paint: { stroke: RED, strokeWidth: 3, dash: [2, 2] }
        }
      ])
    );
    expect(svg).toContain('stroke-width="3"');
    expect(svg).toContain('stroke-dasharray="2 2"');
  });

  it("escapes text content and attribute values", () => {
    const svg = toSvg(
      list([
        {
          kind: "text",
          x: 0,
          y: 10,
          lines: [{ text: "a & b < c", dy: 0 }],
          style: { size: 10, fill: RED, family: 'My "Font"' }
        }
      ])
    );
    expect(svg).toContain("a &amp; b &lt; c");
    expect(svg).toContain("&quot;Font&quot;");
  });

  it("positions multi-line text with absolute tspans", () => {
    // Absolute rather than `dy`, so no consumer has to resolve `em` units.
    const svg = toSvg(
      list([
        {
          kind: "text",
          x: 10,
          y: 20,
          lines: [
            { text: "one", dy: 0 },
            { text: "two", dy: 12 }
          ],
          style: { size: 10, fill: RED, anchor: "middle" }
        }
      ])
    );
    expect(svg).toContain('<tspan x="10" y="20">one</tspan>');
    expect(svg).toContain('<tspan x="10" y="32">two</tspan>');
    expect(svg).toContain('text-anchor="middle"');
  });

  it("omits text with no fill rather than defaulting it to black", () => {
    expect(
      toSvg(
        list([{ kind: "text", x: 0, y: 0, lines: [{ text: "x", dy: 0 }], style: { size: 10 } }])
      )
    ).not.toContain("<text");
  });

  it("never emits exponent notation for tiny coordinates", () => {
    const svg = toSvg(list([{ kind: "rect", x: 1e-8, y: 0, width: 1, height: 1, paint: fill() }]));
    expect(svg).not.toMatch(/e-\d/);
  });
});

describe("clip rectangles", () => {
  it("balances pushClip and popClip around a group", () => {
    const events: string[] = [];
    const surface: DrawSurface = {
      rect: () => events.push("rect"),
      ellipse: () => {},
      sector: () => {},
      polyline: () => {},
      path: () => {},
      text: () => {},
      pushClip: clip => events.push(`push ${clip.x},${clip.y},${clip.width},${clip.height}`),
      popClip: () => events.push("pop")
    };
    renderDrawList(
      list([
        {
          kind: "group",
          clip: { x: 1, y: 2, width: 3, height: 4 },
          children: [{ kind: "rect", x: 0, y: 0, width: 9, height: 9, paint: fill() }]
        },
        { kind: "rect", x: 0, y: 0, width: 1, height: 1, paint: fill() }
      ]),
      surface
    );
    expect(events).toEqual(["push 1,2,3,4", "rect", "pop", "rect"]);
  });

  it("draws unclipped rather than refusing when a surface cannot clip", () => {
    // A backend may omit pushClip/popClip entirely; losing the content would be
    // the worse failure.
    const { surface, calls } = recorder();
    renderDrawList(
      list([
        {
          kind: "group",
          clip: { x: 0, y: 0, width: 1, height: 1 },
          children: [{ kind: "rect", x: 0, y: 0, width: 9, height: 9, paint: fill() }]
        }
      ]),
      surface
    );
    expect(calls).toEqual(["rect 0 0 9 9 rx=0"]);
  });

  it("uses the bounding box for a rotated clip so nothing is lost", () => {
    const seen: string[] = [];
    const surface: DrawSurface = {
      rect: () => {},
      ellipse: () => {},
      sector: () => {},
      polyline: () => {},
      path: () => {},
      text: () => {},
      pushClip: clip =>
        seen.push(
          [clip.x, clip.y, clip.width, clip.height].map(v => Math.round(v * 100) / 100).join(",")
        ),
      popClip: () => {}
    };
    renderDrawList(
      list([
        {
          kind: "group",
          transform: rotate(45),
          clip: { x: 0, y: 0, width: 10, height: 10 },
          children: []
        }
      ]),
      surface
    );
    // A 10x10 square rotated 45° spans 10*sqrt(2) ≈ 14.14 on each axis.
    expect(seen).toHaveLength(1);
    const [, , width] = seen[0].split(",").map(Number);
    expect(width).toBeCloseTo(14.14, 1);
  });
});

describe("SvgSurface used directly", () => {
  it("closes a clip group the caller left open", () => {
    // The walker always balances its own pushes, but `SvgSurface` is public, so a
    // caller can leave one open. Emitting unbalanced markup would be worse than
    // closing it here.
    const surface = new SvgSurface();
    surface.pushClip({ x: 0, y: 0, width: 5, height: 5 });
    surface.rect(0, 0, 9, 9, 0, { fill: BLUE });
    const markup = surface.markup();
    expect((markup.match(/<g /g) ?? []).length).toBe(1);
    expect((markup.match(/<\/g>/g) ?? []).length).toBe(1);
  });

  it("ignores an unmatched popClip", () => {
    const surface = new SvgSurface();
    surface.popClip();
    surface.rect(0, 0, 1, 1, 0, { fill: BLUE });
    expect(surface.markup()).not.toContain("</g>");
  });

  it("gives each clip its own id", () => {
    const surface = new SvgSurface();
    surface.pushClip({ x: 0, y: 0, width: 5, height: 5 });
    surface.popClip();
    surface.pushClip({ x: 1, y: 1, width: 5, height: 5 });
    surface.popClip();
    const markup = surface.markup();
    expect(markup).toContain('id="dc0"');
    expect(markup).toContain('id="dc1"');
  });
});

describe("the SVG-only filter channel", () => {
  it("emits defs and wraps the group in a filter reference", () => {
    const svg = toSvg({
      width: 10,
      height: 10,
      svgDefs: ['<filter id="f1"><feGaussianBlur stdDeviation="2"/></filter>'],
      children: [
        {
          kind: "group",
          svgFilterId: "f1",
          children: [{ kind: "rect", x: 0, y: 0, width: 5, height: 5, paint: { fill: BLUE } }]
        }
      ]
    });
    expect(svg).toContain('<defs><filter id="f1">');
    expect(svg).toContain('<g filter="url(#f1)">');
    expect((svg.match(/<\/g>/g) ?? []).length).toBe(1);
  });

  it("is ignored by a surface that does not implement it", () => {
    // Every non-SVG backend simply draws the content unfiltered, which is what
    // the old per-backend renderers did.
    const { surface, calls } = recorder();
    renderDrawList(
      {
        width: 10,
        height: 10,
        children: [
          {
            kind: "group",
            svgFilterId: "f1",
            children: [{ kind: "rect", x: 0, y: 0, width: 5, height: 5, paint: fill() }]
          }
        ]
      },
      surface
    );
    expect(calls).toEqual(["rect 0 0 5 5 rx=0"]);
  });

  it("nests a filter inside a clip in the right order", () => {
    const events: string[] = [];
    const surface: DrawSurface = {
      rect: () => events.push("rect"),
      ellipse: () => {},
      sector: () => {},
      polyline: () => {},
      path: () => {},
      text: () => {},
      pushClip: () => events.push("clip"),
      popClip: () => events.push("unclip"),
      pushFilter: id => events.push(`filter ${id}`),
      popFilter: () => events.push("unfilter")
    };
    renderDrawList(
      {
        width: 10,
        height: 10,
        children: [
          {
            kind: "group",
            clip: { x: 0, y: 0, width: 5, height: 5 },
            svgFilterId: "f1",
            children: [{ kind: "rect", x: 0, y: 0, width: 5, height: 5, paint: fill() }]
          }
        ]
      },
      surface
    );
    expect(events).toEqual(["clip", "filter f1", "rect", "unfilter", "unclip"]);
  });

  it("escapes a filter id used as an attribute value", () => {
    const surface = new SvgSurface();
    surface.pushFilter('a"b');
    surface.popFilter();
    expect(surface.markup()).toContain("&quot;");
  });
});

describe("perceived brightness", () => {
  it("weighs green above red above blue", () => {
    // The BT.709 ordering is the whole point: an ink chosen from an unweighted average picks
    // dark text on a mid blue, where it is barely readable.
    const red = relativeLuminance({ r: 1, g: 0, b: 0, a: 1 });
    const green = relativeLuminance({ r: 0, g: 1, b: 0, a: 1 });
    const blue = relativeLuminance({ r: 0, g: 0, b: 1, a: 1 });
    expect(green).toBeGreaterThan(red);
    expect(red).toBeGreaterThan(blue);
    expect(green).toBeCloseTo(0.7152, 6);
    expect(blue).toBeCloseTo(0.0722, 6);
  });

  it("puts black and white at the ends of the range", () => {
    expect(relativeLuminance({ r: 0, g: 0, b: 0, a: 1 })).toBe(0);
    expect(relativeLuminance({ r: 1, g: 1, b: 1, a: 1 })).toBeCloseTo(1, 6);
  });
});

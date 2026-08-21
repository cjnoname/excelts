/**
 * Cross-backend parity for the shared drawing engine.
 *
 * This is the test the old architecture could not have: every backend used to
 * walk its own parse of an SVG string, so "do they agree?" was unanswerable
 * except by eye. With one display list and one walker, agreement is checkable —
 * the same nodes must land at the same places in markup, in pixels and in PDF
 * operators, modulo each backend's coordinate convention.
 */

import {
  DEFAULT_TEXT_FAMILY,
  measureText,
  rotate,
  sectorToPath,
  toSvg,
  translate
} from "@draw/index";
import type { DrawList, DrawNode, DrawPathCommand } from "@draw/index";
import { BasicRasterCanvas } from "@draw/raster/canvas";
import { normalizeSamples } from "@draw/raster/surface";
import { renderDrawList } from "@draw/render";
import { rasterizeDrawList } from "@excel/chart/render/draw-raster-png";
import { PdfDocumentBuilder } from "@pdf/builder/document-builder";
import { createPdfDrawSurface } from "@pdf/render/draw-surface";
import { decodePng } from "@pdf/render/png-decoder";
import { describe, expect, it } from "vitest";

const SIZE = 120;
const BLUE = { r: 0.2, g: 0.4, b: 0.8, a: 1 };
const RED = { r: 1, g: 0, b: 0, a: 1 };

/** A scene using every primitive, at coordinates that are easy to verify. */
const scene: DrawList = {
  width: SIZE,
  height: SIZE,
  children: [
    { kind: "rect", x: 10, y: 10, width: 40, height: 20, paint: { fill: BLUE } },
    { kind: "ellipse", cx: 90, cy: 20, rx: 15, ry: 15, paint: { fill: RED } },
    {
      kind: "line",
      x1: 10,
      y1: 50,
      x2: 110,
      y2: 50,
      paint: { stroke: RED, strokeWidth: 2 }
    },
    {
      kind: "polyline",
      points: [
        { x: 10, y: 70 },
        { x: 40, y: 90 },
        { x: 70, y: 70 }
      ],
      paint: { stroke: BLUE, strokeWidth: 2 }
    },
    {
      kind: "path",
      commands: [
        { op: "move", x: 80, y: 70 },
        { op: "cubic", x1: 90, y1: 60, x2: 100, y2: 80, x: 110, y: 70 },
        { op: "close" }
      ],
      paint: { fill: BLUE }
    },
    {
      kind: "text",
      x: 60,
      y: 110,
      lines: [{ text: "Parity", dy: 0 }],
      style: { size: 10, fill: RED, anchor: "middle" }
    }
  ]
};

/** Render the scene to a PDF page and return the content stream text. */
function pdfStream(list: DrawList, box = { x: 0, y: 0, width: SIZE, height: SIZE }): string {
  const page = new PdfDocumentBuilder().addPage({ width: 200, height: 200 });
  renderDrawList(list, createPdfDrawSurface(page, box));
  return page.getContentStream().toString();
}

describe("every primitive reaches every backend", () => {
  const svg = toSvg(scene);
  const stream = pdfStream(scene);

  it("emits each primitive in the SVG", () => {
    expect(svg).toContain("<rect");
    expect(svg).toContain("<circle");
    expect(svg).toContain("<polyline");
    expect(svg).toContain("<path");
    expect(svg).toContain("<text");
    // The straight line is a two-point polyline, emitted as such.
    expect((svg.match(/<polyline/g) ?? []).length).toBe(2);
  });

  it("emits each primitive in the PDF", () => {
    expect(stream).toMatch(/ re$/m); // rect
    expect(stream).toMatch(/ c$/m); // ellipse + cubic path
    expect(stream).toMatch(/ l$/m); // polyline segments
    expect(stream).toContain("(Parity) Tj");
  });

  it("paints something in the raster", () => {
    const decoded = decodePng(rasterizeDrawList(scene, { width: SIZE, height: SIZE }));
    expect(decoded.width).toBe(SIZE);
    let painted = 0;
    if (decoded.alpha) {
      for (const value of decoded.alpha) {
        if (value > 40) {
          painted++;
        }
      }
    }
    // A blank canvas would be the classic silent failure here.
    expect(painted).toBeGreaterThan(500);
  });
});

describe("geometry agrees across backends", () => {
  it("places a rect at the same spot in SVG and PDF, allowing for the Y flip", () => {
    const list: DrawList = {
      width: SIZE,
      height: SIZE,
      children: [{ kind: "rect", x: 10, y: 20, width: 40, height: 30, paint: { fill: BLUE } }]
    };
    const svgRect = /<rect x="([\d.-]+)" y="([\d.-]+)" width="([\d.-]+)" height="([\d.-]+)"/.exec(
      toSvg(list)
    );
    expect(svgRect).not.toBeNull();
    const pdfRect = /^([\d.-]+) ([\d.-]+) ([\d.-]+) ([\d.-]+) re$/m.exec(pdfStream(list));
    expect(pdfRect).not.toBeNull();

    // Same left edge and same size.
    expect(Number(pdfRect![1])).toBeCloseTo(Number(svgRect![1]), 6);
    expect(Number(pdfRect![3])).toBeCloseTo(Number(svgRect![3]), 6);
    expect(Number(pdfRect![4])).toBeCloseTo(Number(svgRect![4]), 6);
    // SVG's y is the top edge; PDF's is the bottom. top + height + bottom = SIZE.
    expect(Number(svgRect![2]) + Number(svgRect![4]) + Number(pdfRect![2])).toBeCloseTo(SIZE, 6);
  });

  it("places a raster pixel where the SVG says the shape is", () => {
    const list: DrawList = {
      width: 40,
      height: 40,
      children: [{ kind: "rect", x: 5, y: 5, width: 10, height: 10, paint: { fill: BLUE } }]
    };
    const decoded = decodePng(rasterizeDrawList(list, { width: 40, height: 40 }));
    const alphaAt = (x: number, y: number): number =>
      decoded.alpha ? decoded.alpha[y * decoded.width + x] : 255;
    // Inside the rect is painted; just outside it is not.
    expect(alphaAt(10, 10)).toBeGreaterThan(200);
    expect(alphaAt(2, 2)).toBeLessThan(40);
    expect(alphaAt(20, 20)).toBeLessThan(40);
  });

  it("keeps a rotated label reading the same way in SVG and PDF", () => {
    // The one convention that genuinely differs: a Y flip reverses a rotation's
    // sense, so the PDF text matrix must advance up the page for an SVG
    // `rotate(-90)`. Each backend used to rediscover this — or not.
    const list: DrawList = {
      width: SIZE,
      height: SIZE,
      children: [
        {
          kind: "text",
          x: 20,
          y: 80,
          rotate: -90,
          lines: [{ text: "Axis", dy: 0 }],
          style: { size: 10, fill: RED }
        }
      ]
    };
    expect(toSvg(list)).toContain("rotate(-90 20 80)");

    const matrix = /(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) Tm/.exec(
      pdfStream(list)
    );
    expect(matrix).not.toBeNull();
    expect(Number(matrix![1])).toBeCloseTo(0, 6);
    expect(Number(matrix![2])).toBeCloseTo(1, 6);
  });

  it("stacks multi-line text downwards in both backends", () => {
    const list: DrawList = {
      width: SIZE,
      height: SIZE,
      children: [
        {
          kind: "text",
          x: 30,
          y: 30,
          lines: [
            { text: "one", dy: 0 },
            { text: "two", dy: 12 }
          ],
          style: { size: 10, fill: RED }
        }
      ]
    };
    // SVG: the second baseline is 12 units lower (larger y).
    const svgOut = toSvg(list);
    expect(svgOut).toContain('<tspan x="30" y="30">one</tspan>');
    expect(svgOut).toContain('<tspan x="30" y="42">two</tspan>');

    // PDF: lower on the page means a smaller y.
    const matrices = [
      ...pdfStream(list).matchAll(
        /(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) Tm/g
      )
    ];
    expect(matrices).toHaveLength(2);
    expect(Number(matrices[1][6])).toBeCloseTo(Number(matrices[0][6]) - 12, 6);
  });

  it("scales into a destination box consistently", () => {
    const list: DrawList = {
      width: 50,
      height: 50,
      children: [{ kind: "rect", x: 0, y: 0, width: 50, height: 50, paint: { fill: BLUE } }]
    };
    // A 50-unit square drawn into a 100pt box doubles.
    const pdfRect = /^([\d.-]+) ([\d.-]+) ([\d.-]+) ([\d.-]+) re$/m.exec(pdfStreamScaled(list, 2));
    expect(Number(pdfRect![3])).toBeCloseTo(100, 6);
    expect(Number(pdfRect![4])).toBeCloseTo(100, 6);
  });
});

/** Render with an explicit uniform scale into a matching box. */
function pdfStreamScaled(list: DrawList, scale: number): string {
  const page = new PdfDocumentBuilder().addPage({ width: 400, height: 400 });
  renderDrawList(
    list,
    createPdfDrawSurface(
      page,
      { x: 0, y: 0, width: list.width * scale, height: list.height * scale },
      scale
    )
  );
  return page.getContentStream().toString();
}

describe("a paint that asks for nothing", () => {
  // `PdfPageBuilder` defaults "no fill, no stroke" to a 1pt black stroke, which is a
  // fair reading of a *builder* call and the wrong reading of a display list: SVG
  // writes `fill="none"` and the rasteriser leaves the pixels alone, so PDF drew an
  // outline that the other two backends agree is not there.
  const empty = (child: DrawNode): DrawList => ({ width: 60, height: 60, children: [child] });

  const cases: Array<[string, DrawNode]> = [
    ["rect", { kind: "rect", x: 10, y: 10, width: 20, height: 20, paint: {} }],
    ["ellipse", { kind: "ellipse", cx: 30, cy: 30, rx: 10, ry: 10, paint: {} }],
    [
      "sector",
      {
        kind: "sector",
        cx: 30,
        cy: 30,
        radius: 12,
        innerRadius: 0,
        startAngle: 0,
        endAngle: 1,
        paint: {}
      }
    ],
    [
      "closed polyline",
      {
        kind: "polyline",
        points: [
          { x: 10, y: 10 },
          { x: 30, y: 10 },
          { x: 30, y: 30 }
        ],
        closed: true,
        paint: {}
      }
    ],
    [
      "path",
      {
        kind: "path",
        commands: [{ op: "move", x: 10, y: 10 }, { op: "line", x: 30, y: 30 }, { op: "close" }],
        paint: {}
      }
    ]
  ];

  for (const [name, child] of cases) {
    it(`draws no ${name} in any backend`, () => {
      // No painting operator at all: not `S` (stroke), `f` (fill) or `B` (both).
      const stream = pdfStream(empty(child), { x: 0, y: 0, width: 60, height: 60 });
      expect(stream, `pdf ${name}`).not.toMatch(/^[SsfFbB]\*?$/m);
      // And nothing that would paint in the other two, for the same input.
      const decoded = decodePng(rasterizeDrawList(empty(child), { width: 60, height: 60 }));
      expect(
        [...decoded.pixels].every(channel => channel === 0),
        `raster ${name}`
      ).toBe(true);
    });
  }
});

describe("paint semantics agree across backends", () => {
  it("draws nothing for an unpainted shape in any backend", () => {
    const list: DrawList = {
      width: 20,
      height: 20,
      children: [{ kind: "rect", x: 0, y: 0, width: 20, height: 20, paint: {} }]
    };
    // No implicit black: the display list is explicit, unlike SVG's initial values.
    expect(toSvg(list)).toContain('fill="none"');
    expect(pdfStream(list)).not.toContain(" rg");
    const decoded = decodePng(rasterizeDrawList(list, { width: 20, height: 20 }));
    let painted = 0;
    if (decoded.alpha) {
      for (const value of decoded.alpha) {
        if (value > 40) {
          painted++;
        }
      }
    }
    expect(painted).toBe(0);
  });

  it("carries alpha into the raster", () => {
    const list: DrawList = {
      width: 20,
      height: 20,
      children: [
        {
          kind: "rect",
          x: 0,
          y: 0,
          width: 20,
          height: 20,
          paint: { fill: { r: 1, g: 0, b: 0, a: 0.4 } }
        }
      ]
    };
    const decoded = decodePng(rasterizeDrawList(list, { width: 20, height: 20 }));
    const index = 10 * decoded.width + 10;
    expect(decoded.alpha?.[index]).toBeGreaterThan(80);
    expect(decoded.alpha?.[index]).toBeLessThan(130);
    // Colour must stay pure rather than darkening towards black.
    expect(decoded.pixels[index * 3]).toBeGreaterThan(240);
  });
});

describe("a stroked sector reaches every backend", () => {
  /** A quarter slice with a thick white separator, like a pie or sunburst wedge. */
  const list: DrawList = {
    width: 60,
    height: 60,
    children: [
      {
        kind: "sector",
        cx: 30,
        cy: 30,
        radius: 25,
        innerRadius: 0,
        startAngle: 0,
        endAngle: Math.PI / 2,
        paint: {
          fill: { r: 0.27, g: 0.45, b: 0.77, a: 1 },
          stroke: { r: 1, g: 1, b: 1, a: 1 },
          strokeWidth: 3
        }
      }
    ]
  };

  it("strokes the slice separator in markup and in the page", () => {
    expect(toSvg(list)).toContain('stroke="#ffffff"');
    // `S` / `B` mean the content stream actually strokes rather than only filling.
    expect(pdfStream(list)).toMatch(/\bRG\b/);
  });

  it("strokes the slice separator in the raster too", () => {
    // The rasteriser fills a sector per pixel, which is exact but carries no
    // outline. Filling only meant a pie kept its white dividers in SVG and PDF and
    // silently lost them in a PNG — the one backend where nothing would tell you.
    const decoded = decodePng(rasterizeDrawList(list, { width: 60, height: 60 }));
    let white = 0;
    for (let index = 0; index < decoded.width * decoded.height; index++) {
      const [r, g, b] = [
        decoded.pixels[index * 3],
        decoded.pixels[index * 3 + 1],
        decoded.pixels[index * 3 + 2]
      ];
      if (r > 240 && g > 240 && b > 240 && (decoded.alpha?.[index] ?? 255) > 200) {
        white++;
      }
    }
    // The two radial edges plus the outer arc, three units wide.
    expect(white).toBeGreaterThan(60);
  });
});

describe("an odd-length dash array agrees across backends", () => {
  /** Which pixels along the stroke are painted, as a readable on/off string. */
  const rasterRun = (dash: number[]): string => {
    const decoded = decodePng(
      rasterizeDrawList(
        {
          width: 40,
          height: 10,
          children: [
            {
              kind: "polyline",
              points: [
                { x: 0, y: 5 },
                { x: 40, y: 5 }
              ],
              paint: { stroke: { r: 0, g: 0, b: 0, a: 1 }, strokeWidth: 1, dash }
            }
          ]
        },
        { width: 40, height: 10 }
      )
    );
    let run = "";
    for (let x = 0; x < decoded.width; x++) {
      run += (decoded.alpha?.[5 * decoded.width + x] ?? 0) > 128 ? "#" : ".";
    }
    return run;
  };

  it("repeats a single-entry array into an even cycle", () => {
    // `[2]` is an ordinary "2 on, 2 off", and the IR says an odd-length array
    // repeats. The rasteriser indexed the author's array directly and decided
    // on/off by index parity, so a one-entry array never left index 0 and the line
    // came out solid — while the SVG backend dashed it correctly.
    expect(rasterRun([2])).toBe(rasterRun([2, 2]));
    expect(rasterRun([2])).toContain(".");
  });

  it("gives a three-entry array the six-unit cycle the spec defines", () => {
    // `[4, 2, 1]` means on4 off2 on1 off4 on2 off1 — a six-entry cycle. Indexing a
    // three-entry array produced a seven-unit period found in no specification.
    expect(rasterRun([4, 2, 1])).toBe(rasterRun([4, 2, 1, 4, 2, 1]));
  });

  it("normalises before the backends, not inside them", () => {
    // The walker doubles the array, so every surface — including any added later —
    // receives an even cycle and none has to rediscover the rule.
    const list: DrawList = {
      width: 40,
      height: 10,
      children: [
        {
          kind: "polyline",
          points: [
            { x: 0, y: 5 },
            { x: 40, y: 5 }
          ],
          paint: { stroke: { r: 0, g: 0, b: 0, a: 1 }, dash: [3] }
        }
      ]
    };
    expect(toSvg(list)).toContain('stroke-dasharray="3 3"');
    expect(pdfStream(list)).toContain("[3 3]");
  });
});

describe("a rounded rect keeps its corners in every backend", () => {
  const list = (rx: number): DrawList => ({
    width: 60,
    height: 60,
    children: [
      {
        kind: "rect",
        x: 8,
        y: 8,
        width: 44,
        height: 44,
        ...(rx > 0 ? { rx } : {}),
        paint: {
          fill: { r: 0.2, g: 0.4, b: 0.8, a: 1 },
          stroke: { r: 1, g: 0, b: 0, a: 1 },
          strokeWidth: 3
        }
      }
    ]
  });

  /**
   * How much ink sits in the box's extreme corner.
   *
   * Counting stroke-coloured pixels over the whole image cannot tell the two apart
   * once edges are antialiased — partial coverage moves pixels across any colour
   * threshold, and the totals land within a percent of each other. The corner is the
   * thing that actually differs: a square outline turns there, a rounded one has
   * already curved away, so the corner is empty.
   */
  const cornerInk = (rx: number): number => {
    const decoded = decodePng(rasterizeDrawList(list(rx), { width: 60, height: 60 }));
    let ink = 0;
    // The box starts at (8, 8) and the stroke is 3 wide, so a square corner covers
    // roughly x,y = 6..9. A radius-10 corner has curved away by then and leaves this
    // block empty. Staying at the extreme corner matters: a few pixels further in and
    // the arc itself passes through the sample.
    for (let y = 6; y < 9; y++) {
      for (let x = 6; x < 9; x++) {
        ink += decoded.alpha?.[y * decoded.width + x] ?? 255;
      }
    }
    return ink;
  };

  it("rounds the outline, not just the fill", () => {
    // `strokeRect` draws four straight edges and takes no radius, so the rasteriser
    // used to put a rounded fill inside a square outline — and the stroke was
    // pixel-for-pixel identical to a sharp-cornered rect, which is what gave it
    // away.
    const square = cornerInk(0);
    const rounded = cornerInk(10);
    expect(square).toBeGreaterThan(0);
    // The rounded corner leaves that block essentially empty.
    expect(rounded).toBeLessThan(square / 4);
  });

  it("agrees with the markup about the radius", () => {
    expect(toSvg(list(10))).toContain('rx="10"');
    // The PDF path has a native rounded rect, so its corners were never in doubt.
    expect(pdfStream(list(10))).toMatch(/\bc\b/);
  });
});

describe("the raster antialiases its edges", () => {
  const circle: DrawList = {
    width: 60,
    height: 60,
    children: [
      {
        kind: "rect",
        x: 0,
        y: 0,
        width: 60,
        height: 60,
        paint: { fill: { r: 1, g: 1, b: 1, a: 1 } }
      },
      {
        kind: "ellipse",
        cx: 30,
        cy: 30,
        rx: 22,
        ry: 22,
        paint: { fill: { r: 0, g: 0, b: 0, a: 1 } }
      }
    ]
  };

  /** Pixels that are neither the background nor the fill — the graded edge. */
  const gradedPixels = (samples: number): number => {
    const decoded = decodePng(rasterizeDrawList(circle, { width: 60, height: 60, samples }));
    let graded = 0;
    for (let index = 0; index < decoded.width * decoded.height; index++) {
      const value = decoded.pixels[index * 3];
      if (value > 12 && value < 243) {
        graded++;
      }
    }
    return graded;
  };

  it("grades the pixels along a curve instead of stepping them", () => {
    // Only glyphs used to carry coverage; every geometric primitive decided each
    // pixel in or out, so a circle's edge was a visible staircase. There is no
    // middle grey anywhere in such an image.
    expect(gradedPixels(1)).toBe(0);
    // A radius-22 circle has a circumference of ~138 px, so a one-pixel graded band
    // is of that order.
    expect(gradedPixels(3)).toBeGreaterThan(80);
  });

  it("antialiases by default, without being asked", () => {
    // The complaint that started this was about ordinary output, so the default is
    // the thing under test. Pinning only explicit sample counts would leave the
    // default free to be 1 — which is what it was.
    const decoded = decodePng(rasterizeDrawList(circle, { width: 60, height: 60 }));
    let graded = 0;
    for (let index = 0; index < decoded.width * decoded.height; index++) {
      const value = decoded.pixels[index * 3];
      if (value > 12 && value < 243) {
        graded++;
      }
    }
    expect(graded).toBeGreaterThan(80);
  });

  it("keeps the interior flat", () => {
    // Anti-aliasing must touch the boundary only. A supersampled fill that leaked
    // into the middle would show up as noise here.
    const decoded = decodePng(rasterizeDrawList(circle, { width: 60, height: 60 }));
    for (const [x, y] of [
      [30, 30],
      [26, 30],
      [30, 34]
    ]) {
      expect(decoded.pixels[(y * decoded.width + x) * 3]).toBe(0);
    }
    // And the far corner stays pure background.
    expect(decoded.pixels[(2 * decoded.width + 2) * 3]).toBe(255);
  });

  it("keeps a translucent edge the colour it was painted", () => {
    // The buffer holds straight alpha, so the box filter weights each channel by its
    // sample's alpha before averaging and divides the weight back out. Averaging the
    // channels unweighted is only equivalent while every covered sample in a pixel
    // shares one alpha; where a pixel straddles two coverages — here a translucent
    // disc over an opaque bar — it shifts the hue instead of the transparency.
    const layered: DrawList = {
      width: 40,
      height: 40,
      children: [
        {
          kind: "rect",
          x: 0,
          y: 16,
          width: 40,
          height: 8,
          paint: { fill: { r: 0, g: 0, b: 1, a: 1 } }
        },
        {
          kind: "ellipse",
          cx: 20,
          cy: 20,
          rx: 12,
          ry: 12,
          paint: { fill: { r: 1, g: 0, b: 0, a: 0.5 } }
        }
      ]
    };
    const decoded = decodePng(rasterizeDrawList(layered, { width: 40, height: 40 }));
    // Where the half-alpha disc covers the opaque blue bar the result is the two
    // mixed, so red and blue are both present and green never is.
    const centre = (20 * decoded.width + 20) * 3;
    expect(decoded.pixels[centre]).toBeGreaterThan(90);
    expect(decoded.pixels[centre + 2]).toBeGreaterThan(90);
    expect(decoded.pixels[centre + 1]).toBeLessThan(30);
  });
});

describe("stroke ends and corners reach every backend", () => {
  const bar = (paint: Record<string, unknown>): DrawList => ({
    width: 60,
    height: 40,
    children: [
      {
        kind: "polyline",
        points: [
          { x: 15, y: 20 },
          { x: 45, y: 20 }
        ],
        paint: { stroke: { r: 0, g: 0, b: 0, a: 1 }, strokeWidth: 12, ...paint }
      }
    ]
  });

  /** Where the painted run starts and ends along the stroke's centre line. */
  const extent = (paint: Record<string, unknown>): [number, number] => {
    const decoded = decodePng(rasterizeDrawList(bar(paint), { width: 60, height: 40 }));
    let first = -1;
    let last = -1;
    for (let x = 0; x < decoded.width; x++) {
      if ((decoded.alpha?.[20 * decoded.width + x] ?? 0) > 128) {
        if (first < 0) {
          first = x;
        }
        last = x;
      }
    }
    return [first, last];
  };

  it("stops a butt cap at the endpoint", () => {
    // The rasteriser used to draw a thick line by stamping a square brush along it,
    // so every stroke ran half a width past both ends and `butt` — the default —
    // was unreachable.
    const [first, last] = extent({});
    expect(first).toBeGreaterThanOrEqual(15);
    expect(last).toBeLessThanOrEqual(45);
  });

  it("extends round and square caps beyond it", () => {
    const [roundFirst, roundLast] = extent({ lineCap: "round" });
    const [squareFirst, squareLast] = extent({ lineCap: "square" });
    // Half of the 12-unit width, at each end.
    expect(roundFirst).toBeLessThan(12);
    expect(roundLast).toBeGreaterThan(48);
    expect(squareFirst).toBeLessThan(12);
    expect(squareLast).toBeGreaterThan(48);
  });

  it("fills a square cap's corners that a round one leaves open", () => {
    const ink = (paint: Record<string, unknown>): number => {
      const decoded = decodePng(rasterizeDrawList(bar(paint), { width: 60, height: 40 }));
      let total = 0;
      for (let y = 14; y < 27; y++) {
        for (let x = 9; x < 15; x++) {
          total += decoded.alpha?.[y * decoded.width + x] ?? 0;
        }
      }
      return total;
    };
    expect(ink({})).toBe(0);
    expect(ink({ lineCap: "square" })).toBeGreaterThan(ink({ lineCap: "round" }));
  });

  it("carries the shapes into the markup and the page", () => {
    const list = bar({ lineJoin: "round", lineCap: "round" });
    expect(toSvg(list)).toContain('stroke-linejoin="round"');
    expect(toSvg(list)).toContain('stroke-linecap="round"');
    // `1 j` and `1 J` are the content stream's round join and round cap. The builder
    // had no way to set either until this field existed.
    const stream = pdfStream(list, { x: 0, y: 0, width: 60, height: 40 });
    expect(stream).toMatch(/\b1 j\b/);
    expect(stream).toMatch(/\b1 J\b/);
  });

  it("closes the notch on the outside of a corner", () => {
    // Butt-ended segments meeting at an angle leave a wedge open. Whether it is
    // filled with a disc or a bevel, it must not stay empty.
    const corner = (paint: Record<string, unknown>): number => {
      const list: DrawList = {
        width: 60,
        height: 60,
        children: [
          {
            kind: "polyline",
            points: [
              { x: 10, y: 46 },
              { x: 30, y: 14 },
              { x: 50, y: 46 }
            ],
            paint: { stroke: { r: 0, g: 0, b: 0, a: 1 }, strokeWidth: 10, ...paint }
          }
        ]
      };
      const decoded = decodePng(rasterizeDrawList(list, { width: 60, height: 60 }));
      let total = 0;
      for (let y = 9; y < 14; y++) {
        for (let x = 27; x < 34; x++) {
          total += decoded.alpha?.[y * decoded.width + x] ?? 0;
        }
      }
      return total;
    };
    expect(corner({})).toBeGreaterThan(0);
    expect(corner({ lineJoin: "round" })).toBeGreaterThan(0);
  });
});

describe("supersampling stays within its budget", () => {
  it("antialiases a small chart even at a high device pixel ratio", () => {
    // A rule keyed to `scale` alone would strip the antialiasing here to protect
    // against a case this size never reaches.
    const decoded = decodePng(
      rasterizeDrawList(
        {
          width: 60,
          height: 60,
          children: [
            {
              kind: "rect",
              x: 0,
              y: 0,
              width: 60,
              height: 60,
              paint: { fill: { r: 1, g: 1, b: 1, a: 1 } }
            },
            {
              kind: "ellipse",
              cx: 30,
              cy: 30,
              rx: 22,
              ry: 22,
              paint: { fill: { r: 0, g: 0, b: 0, a: 1 } }
            }
          ]
        },
        { width: 60, height: 60, scale: 4 }
      )
    );
    expect(decoded.width).toBe(240);
    let graded = 0;
    for (let index = 0; index < decoded.width * decoded.height; index++) {
      const value = decoded.pixels[index * 3];
      if (value > 12 && value < 243) {
        graded++;
      }
    }
    expect(graded).toBeGreaterThan(200);
  });

  it("cuts the sample count down as the output grows", () => {
    // Asserted on the decision rather than through a render: a machine with the
    // memory to spare completes the 2.2 GB buffer, slowly, and reports success
    // whether or not the ceiling exists.
    //
    // 256 MB at four bytes a pixel is 64 M pixels, and supersampling squares the
    // buffer.
    expect(normalizeSamples(undefined, 240, 240)).toBe(3);
    // 2400x1600 at three samples is 35 M pixels, still inside the ceiling.
    expect(normalizeSamples(undefined, 2400, 1600)).toBe(3);
    // 4800x3200 would be 138 M at three, 61 M at two.
    expect(normalizeSamples(undefined, 4800, 3200)).toBe(2);
    // 9600x6400 — a 1200x800 chart at `scale: 8` — has room for one: 246 M at two.
    expect(normalizeSamples(undefined, 9600, 6400)).toBe(1);
  });

  it("honours an explicit sample count within the ceiling", () => {
    expect(normalizeSamples(1, 240, 240)).toBe(1);
    expect(normalizeSamples(4, 240, 240)).toBe(4);
    // Above the cap, and above what memory allows.
    expect(normalizeSamples(9, 240, 240)).toBe(4);
    expect(normalizeSamples(4, 9600, 6400)).toBe(1);
  });

  it("rejects a sample count that is not a count", () => {
    expect(() => normalizeSamples(0, 240, 240)).toThrow(/samples/);
    expect(() => normalizeSamples(Number.NaN, 240, 240)).toThrow(/samples/);
  });

  it("refuses an output too large to allocate, instead of being killed for it", () => {
    // Supersampling can be turned down to nothing, but the output buffer cannot. A
    // 40000x40000 request asks for 6.4 GB of canvas before the encoder allocates
    // anything, and the process dies without saying why — the least useful way for a
    // library to fail.
    const list: DrawList = {
      width: 100,
      height: 100,
      children: [
        {
          kind: "rect",
          x: 0,
          y: 0,
          width: 100,
          height: 100,
          paint: { fill: { r: 0, g: 0, b: 0, a: 1 } }
        }
      ]
    };
    expect(() => rasterizeDrawList(list, { width: 40_000, height: 40_000 })).toThrow(
      /over the .* limit/
    );
    // And the numbers are in the message, so a caller can see what they asked for.
    expect(() => rasterizeDrawList(list, { width: 9000, height: 9000 })).toThrow(/9000x9000/);
  });

  it("still renders an output at the top of the range", () => {
    const list: DrawList = {
      width: 100,
      height: 100,
      children: [
        {
          kind: "rect",
          x: 0,
          y: 0,
          width: 100,
          height: 100,
          paint: { fill: { r: 0, g: 0, b: 0, a: 1 } }
        }
      ]
    };
    expect(decodePng(rasterizeDrawList(list, { width: 8000, height: 8000 })).width).toBe(8000);
  });

  it("still emits the requested output size at a high ratio", () => {
    const list: DrawList = {
      width: 300,
      height: 200,
      children: [
        {
          kind: "ellipse",
          cx: 150,
          cy: 100,
          rx: 120,
          ry: 80,
          paint: { fill: { r: 0.2, g: 0.4, b: 0.8, a: 1 } }
        }
      ]
    };
    const decoded = decodePng(rasterizeDrawList(list, { width: 300, height: 200, scale: 4 }));
    expect(decoded.width).toBe(1200);
    expect(decoded.height).toBe(800);
  });
});

describe("a dashed thick stroke keeps its gaps", () => {
  it("does not let each dash grow into the next", () => {
    // Dashes were stamped with a square brush while solid strokes were filled as
    // outlines, so every dash ran half a stroke width past both of its ends: a
    // 12-wide `[10, 6]` pattern drew 22-long dashes across 6-long gaps and came out
    // solid.
    const decoded = decodePng(
      rasterizeDrawList(
        {
          width: 60,
          height: 40,
          children: [
            {
              kind: "polyline",
              points: [
                { x: 15, y: 20 },
                { x: 45, y: 20 }
              ],
              paint: {
                stroke: { r: 0, g: 0, b: 0, a: 1 },
                strokeWidth: 12,
                dash: [10, 6]
              }
            }
          ]
        },
        { width: 60, height: 40 }
      )
    );
    // Walk the stroke's centre line and count the runs of ink.
    let runs = 0;
    let inside = false;
    for (let x = 0; x < decoded.width; x++) {
      const painted = (decoded.alpha?.[20 * decoded.width + x] ?? 255) > 128;
      if (painted && !inside) {
        runs++;
      }
      inside = painted;
    }
    // 10 on, 6 off, 10 on across a 30-unit line: two dashes.
    expect(runs).toBe(2);
  });
});

describe("a translucent stroke blends once, not once per piece", () => {
  /** The rendered value at a point, over white. */
  const at = (node: DrawNode, x: number, y: number): number => {
    const decoded = decodePng(
      rasterizeDrawList(
        {
          width: 80,
          height: 60,
          children: [
            {
              kind: "rect",
              x: 0,
              y: 0,
              width: 80,
              height: 60,
              paint: { fill: { r: 1, g: 1, b: 1, a: 1 } }
            },
            node
          ]
        },
        { width: 80, height: 60 }
      )
    );
    return decoded.pixels[(y * decoded.width + x) * 3];
  };

  const half = { r: 0, g: 0, b: 0, a: 0.5 };

  it("keeps a joint the same shade as the segments it joins", () => {
    // A thick stroke is a quad per segment plus a wedge at each corner, and those
    // pieces overlap. Blending each in turn is invisible while the paint is opaque and
    // obvious once it is not: the corner of a half-transparent polyline came out at
    // 63 where its arms were at 127, a second full composite.
    const bent: DrawNode = {
      kind: "polyline",
      points: [
        { x: 10, y: 50 },
        { x: 40, y: 14 },
        { x: 70, y: 50 }
      ],
      paint: { stroke: half, strokeWidth: 14 }
    };
    expect(at(bent, 40, 22)).toBeCloseTo(at(bent, 22, 32), -0.5);
  });

  it("keeps a redundant vertex invisible", () => {
    // Three collinear points describe the same line as two. It must render the same.
    const straight: DrawNode = {
      kind: "polyline",
      points: [
        { x: 10, y: 30 },
        { x: 40, y: 30 },
        { x: 70, y: 30 }
      ],
      paint: { stroke: half, strokeWidth: 14 }
    };
    expect(at(straight, 40, 30)).toBe(at(straight, 25, 30));
  });

  it("does not darken where a stroke crosses itself", () => {
    // Coverage accumulation handles this for free; no amount of care in the outline
    // geometry would, because the overlap is not at a joint.
    const bowtie: DrawNode = {
      kind: "polyline",
      points: [
        { x: 10, y: 20 },
        { x: 70, y: 40 },
        { x: 10, y: 40 },
        { x: 70, y: 20 }
      ],
      paint: { stroke: half, strokeWidth: 12 }
    };
    expect(at(bowtie, 40, 30)).toBeCloseTo(at(bowtie, 18, 22), -0.5);
  });

  it("blends a round cap to the same shade as the body", () => {
    const capped: DrawNode = {
      kind: "polyline",
      points: [
        { x: 10, y: 30 },
        { x: 70, y: 30 }
      ],
      paint: { stroke: half, strokeWidth: 14, lineCap: "round" }
    };
    expect(at(capped, 8, 30)).toBeCloseTo(at(capped, 40, 30), -0.5);
  });

  it("still puts a half-transparent stroke at half strength", () => {
    // The coverage pass must divide the paint's alpha out of the mask and apply it
    // once at the end. Storing the alpha itself applied it twice — the stroke came out
    // at 191 over white instead of 127, uniformly wrong instead of wrong at the
    // joints.
    const plain: DrawNode = {
      kind: "polyline",
      points: [
        { x: 10, y: 30 },
        { x: 70, y: 30 }
      ],
      paint: { stroke: half, strokeWidth: 14 }
    };
    expect(at(plain, 40, 30)).toBeGreaterThan(120);
    expect(at(plain, 40, 30)).toBeLessThan(135);
  });
});

describe("every primitive strokes translucently at the same strength", () => {
  /**
   * A half-transparent outline over white should read 127 wherever it lands,
   * whichever primitive drew it. Anything darker means the same pixel was blended
   * more than once.
   */
  const outline = { stroke: { r: 0, g: 0, b: 0, a: 0.5 }, strokeWidth: 10 };

  const at = (node: DrawNode, x: number, y: number): number => {
    const decoded = decodePng(
      rasterizeDrawList(
        {
          width: 70,
          height: 70,
          children: [
            {
              kind: "rect",
              x: 0,
              y: 0,
              width: 70,
              height: 70,
              paint: { fill: { r: 1, g: 1, b: 1, a: 1 } }
            },
            node
          ]
        },
        { width: 70, height: 70 }
      )
    );
    return decoded.pixels[(y * decoded.width + x) * 3];
  };

  const cases: Array<[string, DrawNode, [number, number]]> = [
    ["rect", { kind: "rect", x: 15, y: 15, width: 40, height: 40, paint: outline }, [35, 15]],
    [
      "rect corner",
      { kind: "rect", x: 15, y: 15, width: 40, height: 40, paint: outline },
      [15, 15]
    ],
    [
      "rounded rect",
      { kind: "rect", x: 15, y: 15, width: 40, height: 40, rx: 12, paint: outline },
      [35, 15]
    ],
    ["ellipse", { kind: "ellipse", cx: 35, cy: 35, rx: 22, ry: 22, paint: outline }, [35, 13]],
    [
      "sector",
      {
        kind: "sector",
        cx: 35,
        cy: 35,
        radius: 24,
        innerRadius: 0,
        startAngle: 0.2,
        endAngle: 2.4,
        paint: outline
      },
      [35, 58]
    ],
    [
      "polygon",
      {
        kind: "polyline",
        closed: true,
        points: [
          { x: 15, y: 15 },
          { x: 55, y: 15 },
          { x: 55, y: 55 },
          { x: 15, y: 55 }
        ],
        paint: outline
      },
      [35, 15]
    ],
    [
      "path",
      {
        kind: "path",
        commands: [
          { op: "move", x: 15, y: 15 },
          { op: "line", x: 55, y: 15 },
          { op: "line", x: 55, y: 55 },
          { op: "close" }
        ],
        paint: outline
      },
      [35, 15]
    ]
  ];

  for (const [label, node, [x, y]] of cases) {
    it(`${label} blends its outline once`, () => {
      // A sharp-cornered rect was the one that did not: `strokeRect` stamps a square
      // brush along each of the four edges, so its outline saturated to fully opaque
      // while every other primitive, all of which route through the polyline stroker,
      // came out at half strength.
      expect(at(node, x, y)).toBeGreaterThan(115);
      expect(at(node, x, y)).toBeLessThan(140);
    });
  }
});

describe("a compound path resolves its rings together", () => {
  /** An outer square with an inner one, wound either the same way or opposite. */
  const rings = (innerReversed: boolean): DrawPathCommand[] => [
    { op: "move", x: 10, y: 10 },
    { op: "line", x: 50, y: 10 },
    { op: "line", x: 50, y: 50 },
    { op: "line", x: 10, y: 50 },
    { op: "close" },
    ...(innerReversed
      ? [
          { op: "move" as const, x: 20, y: 20 },
          { op: "line" as const, x: 20, y: 40 },
          { op: "line" as const, x: 40, y: 40 },
          { op: "line" as const, x: 40, y: 20 },
          { op: "close" as const }
        ]
      : [
          { op: "move" as const, x: 20, y: 20 },
          { op: "line" as const, x: 40, y: 20 },
          { op: "line" as const, x: 40, y: 40 },
          { op: "line" as const, x: 20, y: 40 },
          { op: "close" as const }
        ])
  ];

  const list = (innerReversed: boolean, fillRule?: "nonzero" | "evenodd"): DrawList => ({
    width: 60,
    height: 60,
    children: [
      {
        kind: "rect",
        x: 0,
        y: 0,
        width: 60,
        height: 60,
        paint: { fill: { r: 1, g: 1, b: 1, a: 1 } }
      },
      {
        kind: "path",
        commands: rings(innerReversed),
        paint: { fill: { r: 0, g: 0, b: 0, a: 1 }, ...(fillRule ? { fillRule } : {}) }
      }
    ]
  });

  /** The centre pixel: white means the inner ring is a hole. */
  const centre = (innerReversed: boolean, fillRule?: "nonzero" | "evenodd"): number => {
    const decoded = decodePng(
      rasterizeDrawList(list(innerReversed, fillRule), { width: 60, height: 60 })
    );
    return decoded.pixels[(30 * decoded.width + 30) * 3];
  };

  it("leaves a hole where a reversed ring cuts one", () => {
    // Filling ring by ring painted the hole straight back in, so a country with a lake
    // or a doughnut lowered to a path came out solid in a PNG while SVG and PDF cut it.
    expect(centre(true)).toBe(255);
    expect(centre(true, "nonzero")).toBe(255);
  });

  it("honours nonzero against evenodd on rings wound the same way", () => {
    // The rule has to be read, not assumed. Pairing crossings two at a time is even-odd
    // whatever the caller asked for, which is what the rasteriser used to do.
    expect(centre(false, "nonzero")).toBe(0);
    expect(centre(false, "evenodd")).toBe(255);
  });

  it("composites a translucent overlap once, not once per span", () => {
    // Two rings wound the same way and overlapping: nonzero makes their union, and a
    // union is painted *once*. The scanline walk emits one span per pair of adjacent
    // crossings, so the overlap arrives as three abutting spans rather than one, and a
    // closed interval in x gave the two columns where they meet a second helping of
    // paint — invisible at full opacity, a pair of dark seams through a translucent
    // shape. The rings share edges at x=15 and x=20; every covered column must read the
    // same alpha as a column covered by one ring alone.
    const canvas = new BasicRasterCanvas(40, 10);
    const box = (x0: number, x1: number) => [
      { x: x0, y: 2 },
      { x: x1, y: 2 },
      { x: x1, y: 8 },
      { x: x0, y: 8 }
    ];
    canvas.fillRings([box(5, 20), box(15, 30)], "#00000080", "nonzero");
    const alphaAt = (x: number) => canvas.data[(5 * 40 + x) * 4 + 3];
    // Sanity: the probe is reading the right row, and outside the union is untouched.
    expect(alphaAt(35)).toBe(0);
    // 0x80 over a transparent destination. Twice would be 191.
    for (const x of [10, 15, 17, 19, 20, 25]) {
      expect(alphaAt(x), `column ${x}`).toBe(128);
    }
  });

  it("defaults to nonzero, as SVG and PDF do", () => {
    expect(centre(false)).toBe(centre(false, "nonzero"));
  });

  it("carries the rule into the markup", () => {
    expect(toSvg(list(false, "evenodd"))).toContain('fill-rule="evenodd"');
    expect(toSvg(list(false, "nonzero"))).not.toContain("fill-rule");
  });

  it("still strokes each ring separately", () => {
    // One outline per ring: joining them would draw a line from one to the other.
    const decoded = decodePng(
      rasterizeDrawList(
        {
          width: 60,
          height: 60,
          children: [
            {
              kind: "rect",
              x: 0,
              y: 0,
              width: 60,
              height: 60,
              paint: { fill: { r: 1, g: 1, b: 1, a: 1 } }
            },
            {
              kind: "path",
              commands: rings(true),
              paint: { stroke: { r: 0, g: 0, b: 0, a: 1 }, strokeWidth: 2 }
            }
          ]
        },
        { width: 60, height: 60 }
      )
    );
    // Ink on both rings, clear between them.
    expect(decoded.pixels[(10 * decoded.width + 30) * 3]).toBeLessThan(128);
    expect(decoded.pixels[(20 * decoded.width + 30) * 3]).toBeLessThan(128);
    expect(decoded.pixels[(15 * decoded.width + 30) * 3]).toBe(255);
  });
});

describe("the PDF surface carries the whole paint", () => {
  const stream = (list: DrawList): string => pdfStream(list, { x: 0, y: 0, width: 80, height: 80 });
  const INK = { r: 0, g: 0, b: 0, a: 1 };

  it("cuts a full doughnut's hole", () => {
    // The adapter had its own copy of the sector lowering, and that copy wound an
    // annulus's two rings the same way. PDF fills nonzero, so the hole closed up while
    // SVG and the rasteriser cut it. Using the shared builder is what fixes it — the
    // rings come back with opposite signed areas.
    const rings = sectorToPath(0, 0, 30, 12, 0, Math.PI * 2);
    const areas: number[] = [];
    let current: Array<{ x: number; y: number }> = [];
    for (const command of rings) {
      if (command.op === "close") {
        let sum = 0;
        for (let i = 0, j = current.length - 1; i < current.length; j = i++) {
          sum += current[j].x * current[i].y - current[i].x * current[j].y;
        }
        areas.push(sum / 2);
        current = [];
        continue;
      }
      current.push({ x: command.x, y: command.y });
    }
    expect(areas).toHaveLength(2);
    expect(Math.sign(areas[0])).not.toBe(Math.sign(areas[1]));
  });

  it("emits the even-odd operator when the paint asks for it", () => {
    const list: DrawList = {
      width: 80,
      height: 80,
      children: [
        {
          kind: "path",
          commands: [
            { op: "move", x: 10, y: 10 },
            { op: "line", x: 70, y: 10 },
            { op: "line", x: 70, y: 70 },
            { op: "close" }
          ],
          paint: { fill: INK, fillRule: "evenodd" }
        }
      ]
    };
    expect(stream(list)).toMatch(/f\*/);
  });

  it("dashes a polyline of more than two points", () => {
    // `drawLine` always carried a dash, but a path had no way to express one, so a dashed
    // connector of three points came out solid in a PDF alone.
    const list: DrawList = {
      width: 80,
      height: 80,
      children: [
        {
          kind: "polyline",
          points: [
            { x: 5, y: 5 },
            { x: 40, y: 40 },
            { x: 75, y: 5 }
          ],
          paint: { stroke: INK, strokeWidth: 2, dash: [6, 3] }
        }
      ]
    };
    expect(stream(list)).toMatch(/\[\s*6\s+3\s*\]\s*0\s+d/);
  });

  it("sets a path's join and cap", () => {
    const list: DrawList = {
      width: 80,
      height: 80,
      children: [
        {
          kind: "polyline",
          points: [
            { x: 5, y: 60 },
            { x: 40, y: 10 },
            { x: 75, y: 60 }
          ],
          paint: { stroke: INK, strokeWidth: 8, lineJoin: "round", lineCap: "round" }
        }
      ]
    };
    expect(stream(list)).toMatch(/\b1 j\b/);
    expect(stream(list)).toMatch(/\b1 J\b/);
  });

  it("paints fill and stroke separately when their alphas differ", () => {
    // `ca` and `CA` live in one graphics state, so one pass could only carry one alpha —
    // the second `gs` overwrote the first and the whole shape came out at the stroke's
    // transparency. The path has to be rebuilt for the second pass, because painting
    // consumes it.
    const list: DrawList = {
      width: 80,
      height: 80,
      children: [
        {
          kind: "rect",
          x: 10,
          y: 10,
          width: 60,
          height: 60,
          paint: {
            fill: { r: 1, g: 0, b: 0, a: 0.3 },
            stroke: { r: 0, g: 0, b: 1, a: 0.9 },
            strokeWidth: 4
          }
        }
      ]
    };
    const content = stream(list);
    // Two passes: a fill and a stroke, each with its own graphics state.
    expect(content).toMatch(/\bf\b/);
    expect(content).toMatch(/\bS\b/);
    expect((content.match(/gs/g) ?? []).length).toBeGreaterThanOrEqual(2);
    // And not the single combined operator, which could only carry one alpha.
    expect(content).not.toMatch(/\bB\b/);
  });

  it("still uses one pass when the alphas match", () => {
    const list: DrawList = {
      width: 80,
      height: 80,
      children: [
        {
          kind: "rect",
          x: 10,
          y: 10,
          width: 60,
          height: 60,
          paint: {
            fill: { r: 1, g: 0, b: 0, a: 0.5 },
            stroke: { r: 0, g: 0, b: 1, a: 0.5 },
            strokeWidth: 4
          }
        }
      ]
    };
    expect(stream(list)).toMatch(/\bB\b/);
  });
});

describe("the raster measures text in the style it was asked for", () => {
  /** Horizontal extent of the ink, for centred text. */
  const span = (style: Record<string, unknown>): number => {
    const decoded = decodePng(
      rasterizeDrawList(
        {
          width: 220,
          height: 40,
          children: [
            {
              kind: "rect",
              x: 0,
              y: 0,
              width: 220,
              height: 40,
              paint: { fill: { r: 1, g: 1, b: 1, a: 1 } }
            },
            {
              kind: "text",
              x: 110,
              y: 28,
              lines: [{ text: "Widget Wm", dy: 0 }],
              style: { size: 20, fill: { r: 0, g: 0, b: 0, a: 1 }, anchor: "middle", ...style }
            }
          ]
        },
        { width: 220, height: 40 }
      )
    );
    let first = -1;
    let last = -1;
    for (let x = 0; x < decoded.width; x++) {
      for (let y = 0; y < decoded.height; y++) {
        if (decoded.pixels[(y * decoded.width + x) * 3] < 128) {
          if (first < 0) {
            first = x;
          }
          last = x;
          break;
        }
      }
    }
    return last - first;
  };

  it("measures bold wider than regular", () => {
    // The display list carried the whole text style but only the size reached the canvas,
    // so bold text was measured as regular — and the width is what decides where centred
    // and right-anchored text starts, so every such label sat off by the difference.
    expect(span({ family: "arial", bold: true })).toBeGreaterThan(span({ family: "arial" }));
  });

  it("measures a different family differently", () => {
    expect(span({ family: "times new roman" })).not.toBe(span({ family: "arial" }));
  });
});

describe("a dash carries the stroke's cap", () => {
  const ink = (paint: Record<string, unknown>): number => {
    const decoded = decodePng(
      rasterizeDrawList(
        {
          width: 60,
          height: 40,
          children: [
            {
              kind: "polyline",
              points: [
                { x: 15, y: 20 },
                { x: 45, y: 20 }
              ],
              paint: {
                stroke: { r: 0, g: 0, b: 0, a: 1 },
                strokeWidth: 12,
                dash: [10, 8],
                ...paint
              }
            }
          ]
        },
        { width: 60, height: 40 }
      )
    );
    let total = 0;
    for (let index = 0; index < decoded.width * decoded.height; index++) {
      if ((decoded.alpha?.[index] ?? 255) > 128) {
        total++;
      }
    }
    return total;
  };

  it("shapes each dash rather than leaving them all square-ended", () => {
    // Each dash is a stroke of its own, so a dashed line with round caps is a row of
    // lozenges. The rasteriser hard-coded butt, which made the three settings
    // indistinguishable while SVG and PDF shaped every dash.
    const butt = ink({});
    expect(ink({ lineCap: "round" })).toBeGreaterThan(butt);
    expect(ink({ lineCap: "square" })).toBeGreaterThan(ink({ lineCap: "round" }));
  });
});

describe("text names the face it was measured in", () => {
  const list: DrawList = {
    width: 120,
    height: 30,
    children: [
      {
        kind: "text",
        x: 5,
        y: 20,
        lines: [{ text: "Widget", dy: 0 }],
        style: { size: 12, fill: { r: 0, g: 0, b: 0, a: 1 } }
      }
    ]
  };

  it("writes a font-family even when the style names none", () => {
    // Omitting it left the choice to the viewer's default while the width had been
    // measured as Arial, so anything positioned from that width — a centred title, a
    // wrapped label — was placed for a font the viewer was not using.
    expect(toSvg(list)).toContain('font-family="arial"');
  });

  it("measures the default face as the same face it draws", () => {
    expect(measureText("Widget", { size: 12 })).toBe(
      measureText("Widget", { size: 12, family: DEFAULT_TEXT_FAMILY })
    );
  });
});

describe("a translucent compound fill has no seams", () => {
  /** One scanline through two rings that share an edge. */
  const scanline = (paint: Record<string, unknown>): number[] => {
    const decoded = decodePng(
      rasterizeDrawList(
        {
          width: 60,
          height: 60,
          children: [
            {
              kind: "rect",
              x: 0,
              y: 0,
              width: 60,
              height: 60,
              paint: { fill: { r: 1, g: 1, b: 1, a: 1 } }
            },
            {
              kind: "path",
              commands: [
                { op: "move", x: 5, y: 10 },
                { op: "line", x: 25, y: 10 },
                { op: "line", x: 25, y: 50 },
                { op: "line", x: 5, y: 50 },
                { op: "close" },
                { op: "move", x: 25, y: 10 },
                { op: "line", x: 45, y: 10 },
                { op: "line", x: 45, y: 50 },
                { op: "line", x: 25, y: 50 },
                { op: "close" }
              ],
              paint
            }
          ]
        },
        { width: 60, height: 60 }
      )
    );
    return Array.from(
      { length: 37 },
      (_, index) => decoded.pixels[(30 * decoded.width + index + 7) * 3]
    );
  };

  it("does not darken the edge two rings share", () => {
    // The pixel a scanline span ends on is the one the next span begins on. Covering both
    // ends composited that column twice — invisible while the paint is opaque, a darker
    // seam as soon as it is not. Spans are half-open for that reason.
    const values = new Set(scanline({ fill: { r: 0, g: 0, b: 0, a: 0.5 } }));
    expect(values.size).toBe(1);
  });

  it("matches a single ring covering the same area", () => {
    const compound = new Set(scanline({ fill: { r: 0, g: 0, b: 0, a: 0.5 } }));
    const decoded = decodePng(
      rasterizeDrawList(
        {
          width: 60,
          height: 60,
          children: [
            {
              kind: "rect",
              x: 0,
              y: 0,
              width: 60,
              height: 60,
              paint: { fill: { r: 1, g: 1, b: 1, a: 1 } }
            },
            {
              kind: "polyline",
              closed: true,
              points: [
                { x: 5, y: 10 },
                { x: 45, y: 10 },
                { x: 45, y: 50 },
                { x: 5, y: 50 }
              ],
              paint: { fill: { r: 0, g: 0, b: 0, a: 0.5 } }
            }
          ]
        },
        { width: 60, height: 60 }
      )
    );
    expect([...compound][0]).toBe(decoded.pixels[(30 * decoded.width + 20) * 3]);
  });
});

describe("clipping agrees across backends", () => {
  /** A 40x40 list whose 40x40 blue square is clipped to its top-left quarter. */
  const clipped: DrawList = {
    width: 40,
    height: 40,
    children: [
      {
        kind: "group",
        clip: { x: 0, y: 0, width: 20, height: 20 },
        children: [{ kind: "rect", x: 0, y: 0, width: 40, height: 40, paint: { fill: BLUE } }]
      }
    ]
  };

  it("scopes the clip in the SVG and closes the group", () => {
    const svg = toSvg(clipped);
    expect(svg).toContain("<clipPath");
    expect(svg).toContain('<rect x="0" y="0" width="20" height="20"/></clipPath>');
    expect(svg).toContain('clip-path="url(#dc0)"');
    // Balanced: one opening group, one closing.
    expect((svg.match(/<g /g) ?? []).length).toBe(1);
    expect((svg.match(/<\/g>/g) ?? []).length).toBe(1);
  });

  it("scopes the clip in the PDF with q / W n / Q", () => {
    const stream = pdfStream(clipped, { x: 0, y: 0, width: 40, height: 40 });
    expect(stream).toMatch(/^q$/m);
    expect(stream).toMatch(/^W$/m);
    expect(stream).toMatch(/^n$/m);
    expect(stream).toMatch(/^Q$/m);
    // The clip rect is the top-left quarter, which in PDF's Y-up space is the
    // upper half: y from 20 to 40.
    expect(stream).toMatch(/^0 20 20 20 re$/m);
  });

  it("actually removes pixels outside the clip in the raster", () => {
    const decoded = decodePng(rasterizeDrawList(clipped, { width: 40, height: 40 }));
    const alphaAt = (x: number, y: number): number =>
      decoded.alpha ? decoded.alpha[y * decoded.width + x] : 255;
    // Inside the clip: painted. Outside: untouched, even though the rect covers it.
    expect(alphaAt(5, 5)).toBeGreaterThan(200);
    expect(alphaAt(30, 5)).toBeLessThan(40);
    expect(alphaAt(5, 30)).toBeLessThan(40);
    expect(alphaAt(30, 30)).toBeLessThan(40);
  });

  it("intersects nested clips", () => {
    const nested: DrawList = {
      width: 40,
      height: 40,
      children: [
        {
          kind: "group",
          clip: { x: 0, y: 0, width: 30, height: 30 },
          children: [
            {
              kind: "group",
              clip: { x: 10, y: 10, width: 30, height: 30 },
              children: [{ kind: "rect", x: 0, y: 0, width: 40, height: 40, paint: { fill: BLUE } }]
            }
          ]
        }
      ]
    };
    const decoded = decodePng(rasterizeDrawList(nested, { width: 40, height: 40 }));
    const alphaAt = (x: number, y: number): number =>
      decoded.alpha ? decoded.alpha[y * decoded.width + x] : 255;
    // Only the 10..30 overlap survives.
    expect(alphaAt(20, 20)).toBeGreaterThan(200);
    expect(alphaAt(5, 5)).toBeLessThan(40);
    expect(alphaAt(35, 35)).toBeLessThan(40);
  });

  it("clips glyphs too, not just shapes", () => {
    // Text goes through the same per-pixel path, so a label overflowing a plot
    // area is cut rather than drawn over the axis titles.
    const list: DrawList = {
      width: 60,
      height: 30,
      children: [
        {
          kind: "group",
          clip: { x: 0, y: 0, width: 15, height: 30 },
          children: [
            {
              kind: "text",
              x: 2,
              y: 22,
              lines: [{ text: "WWWWWWWW", dy: 0 }],
              style: { size: 16, fill: RED }
            }
          ]
        }
      ]
    };
    const decoded = decodePng(rasterizeDrawList(list, { width: 60, height: 30 }));
    let rightOfClip = 0;
    if (decoded.alpha) {
      for (let y = 0; y < decoded.height; y++) {
        for (let x = 16; x < decoded.width; x++) {
          if (decoded.alpha[y * decoded.width + x] > 40) {
            rightOfClip++;
          }
        }
      }
    }
    expect(rightOfClip).toBe(0);
  });

  it("translates the clip with its group", () => {
    const list: DrawList = {
      width: 40,
      height: 40,
      children: [
        {
          kind: "group",
          transform: translate(20, 0),
          clip: { x: 0, y: 0, width: 20, height: 20 },
          children: [{ kind: "rect", x: 0, y: 0, width: 40, height: 40, paint: { fill: BLUE } }]
        }
      ]
    };
    const decoded = decodePng(rasterizeDrawList(list, { width: 40, height: 40 }));
    const alphaAt = (x: number, y: number): number =>
      decoded.alpha ? decoded.alpha[y * decoded.width + x] : 255;
    // The clip moved with the group: the top-right quarter is now the live area.
    expect(alphaAt(30, 5)).toBeGreaterThan(200);
    expect(alphaAt(5, 5)).toBeLessThan(40);
  });
});

describe("ellipses are exact in every backend", () => {
  const list: DrawList = {
    width: 60,
    height: 40,
    children: [{ kind: "ellipse", cx: 30, cy: 20, rx: 25, ry: 10, paint: { fill: BLUE } }]
  };

  it("emits a real ellipse element and PDF curves", () => {
    expect(toSvg(list)).toContain('<ellipse cx="30" cy="20" rx="25" ry="10"');
    expect(pdfStream(list, { x: 0, y: 0, width: 60, height: 40 })).toMatch(/ c$/m);
  });

  it("fills the raster ellipse exactly rather than as a faceted polygon", () => {
    // The raster surface used to approximate a non-circular ellipse with a
    // 64-gon. A per-pixel test is exact, so the extreme points on both axes are
    // inside and the corners of the bounding box are not.
    const decoded = decodePng(rasterizeDrawList(list, { width: 60, height: 40 }));
    const alphaAt = (x: number, y: number): number =>
      decoded.alpha ? decoded.alpha[y * decoded.width + x] : 255;
    expect(alphaAt(30, 20)).toBeGreaterThan(200); // centre
    expect(alphaAt(6, 20)).toBeGreaterThan(200); // just inside the left extreme
    expect(alphaAt(30, 11)).toBeGreaterThan(200); // just inside the top extreme
    expect(alphaAt(1, 1)).toBeLessThan(40); // bounding-box corner
    expect(alphaAt(58, 38)).toBeLessThan(40);
  });
});

describe("sectors are first-class in every backend", () => {
  const quarter = (innerRadius = 0): DrawList => ({
    width: 80,
    height: 80,
    children: [
      {
        kind: "sector",
        cx: 40,
        cy: 40,
        radius: 30,
        innerRadius,
        startAngle: 0,
        endAngle: Math.PI / 2,
        paint: { fill: BLUE }
      }
    ]
  });

  it("uses a native arc in the SVG", () => {
    // Lowering to cubics upstream would cost SVG its exact arc for nothing.
    const svg = toSvg(quarter());
    expect(svg).toMatch(/<path d="M 40 40 L 70 40 A 30 30 0 0 1 40 70 Z"/);
  });

  it("lowers to cubics in the PDF, which has no arc operator", () => {
    const stream = pdfStream(quarter(), { x: 0, y: 0, width: 80, height: 80 });
    expect(stream).toMatch(/ c$/m);
    expect(stream).toMatch(/^40 40 m$/m);
  });

  it("fills exactly in the raster, with no polygon facets", () => {
    // The pixel-level radius and angle test is the whole reason the sector is a
    // primitive: the old pipeline smuggled these parameters past the SVG string in
    // a `data-sector` attribute to reach this code path.
    const decoded = decodePng(rasterizeDrawList(quarter(), { width: 80, height: 80 }));
    const alphaAt = (x: number, y: number): number =>
      decoded.alpha ? decoded.alpha[y * decoded.width + x] : 255;
    // Inside the first quadrant of the disc.
    expect(alphaAt(50, 50)).toBeGreaterThan(200);
    // Same radius, wrong quadrant.
    expect(alphaAt(30, 30)).toBeLessThan(40);
    // Right angle, beyond the radius.
    expect(alphaAt(75, 75)).toBeLessThan(40);
  });

  it("punches the hole of an annular sector in every backend", () => {
    const svg = toSvg(quarter(15));
    // Outer arc, a line across to the inner radius, then the inner arc back.
    expect(svg).toContain("A 30 30 0 0 1");
    expect(svg).toContain("A 15 15 0 0 0");

    const decoded = decodePng(rasterizeDrawList(quarter(15), { width: 80, height: 80 }));
    const alphaAt = (x: number, y: number): number =>
      decoded.alpha ? decoded.alpha[y * decoded.width + x] : 255;
    expect(alphaAt(56, 56)).toBeGreaterThan(200); // in the band
    expect(alphaAt(45, 45)).toBeLessThan(40); // inside the hole
  });

  it("draws a full sweep as a circle rather than a degenerate arc", () => {
    // A single `A` whose start and end coincide renders nothing at all.
    const full: DrawList = {
      width: 80,
      height: 80,
      children: [
        {
          kind: "sector",
          cx: 40,
          cy: 40,
          radius: 30,
          innerRadius: 0,
          startAngle: 0,
          endAngle: Math.PI * 2,
          paint: { fill: BLUE }
        }
      ]
    };
    expect(toSvg(full)).toContain('<circle cx="40" cy="40" r="30"');
    const decoded = decodePng(rasterizeDrawList(full, { width: 80, height: 80 }));
    const alphaAt = (x: number, y: number): number =>
      decoded.alpha ? decoded.alpha[y * decoded.width + x] : 255;
    // Every quadrant is painted.
    for (const [x, y] of [
      [50, 50],
      [30, 30],
      [50, 30],
      [30, 50]
    ]) {
      expect(alphaAt(x, y)).toBeGreaterThan(200);
    }
  });

  it("keeps a full ring hollow", () => {
    const ring: DrawList = {
      width: 80,
      height: 80,
      children: [
        {
          kind: "sector",
          cx: 40,
          cy: 40,
          radius: 30,
          innerRadius: 15,
          startAngle: 0,
          endAngle: Math.PI * 2,
          paint: { fill: BLUE }
        }
      ]
    };
    expect(toSvg(ring)).toContain('fill-rule="evenodd"');
    const decoded = decodePng(rasterizeDrawList(ring, { width: 80, height: 80 }));
    const alphaAt = (x: number, y: number): number =>
      decoded.alpha ? decoded.alpha[y * decoded.width + x] : 255;
    expect(alphaAt(40, 18)).toBeGreaterThan(200); // on the ring
    expect(alphaAt(40, 40)).toBeLessThan(40); // the hole
  });

  it("rotates a sector by shifting its angles, not by lowering it", () => {
    const rotated: DrawList = {
      width: 80,
      height: 80,
      children: [
        {
          kind: "group",
          transform: rotate(90, 40, 40),
          children: [
            {
              kind: "sector",
              cx: 40,
              cy: 40,
              radius: 30,
              innerRadius: 0,
              startAngle: 0,
              endAngle: Math.PI / 2,
              paint: { fill: BLUE }
            }
          ]
        }
      ]
    };
    // Still an arc in the SVG — a sector survives rotation as a sector.
    expect(toSvg(rotated)).toContain("A 30 30 0 0 1");
    const decoded = decodePng(rasterizeDrawList(rotated, { width: 80, height: 80 }));
    const alphaAt = (x: number, y: number): number =>
      decoded.alpha ? decoded.alpha[y * decoded.width + x] : 255;
    // The quadrant moved from bottom-right to bottom-left.
    expect(alphaAt(30, 50)).toBeGreaterThan(200);
    expect(alphaAt(50, 50)).toBeLessThan(40);
  });
});

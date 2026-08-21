/**
 * `PdfPageBuilder.drawSvg` — the SVG-subset importer.
 *
 * Chart SVG is the documented input for this API, so these tests use the shapes
 * and attributes the chart emitters actually produce.
 */

import { PdfDocumentBuilder } from "@pdf/builder/document-builder";
import { describe, expect, it } from "vitest";

/** Draw one SVG onto a fresh page and return its content stream text. */
function draw(svg: string, box?: { width?: number; height?: number }): string {
  const page = new PdfDocumentBuilder().addPage({ width: 500, height: 500 });
  page.drawSvg({ svg, x: 0, y: 0, ...box });
  return page.getContentStream().toString();
}

/** The operands of every `re` (rectangle) operator, in order. */
function rects(stream: string): string[] {
  return stream
    .split("\n")
    .filter(line => line.trim().endsWith(" re"))
    .map(line => line.trim().replace(/ re$/, ""));
}

/** Every `Tj`-shown string literal, in order. */
function shownText(stream: string): string[] {
  return [...stream.matchAll(/\((.*?)\)\s*Tj/g)].map(match => match[1]);
}

describe("drawSvg viewBox mapping", () => {
  it("scales element coordinates from viewBox user space to the destination box", () => {
    // The rect covers the whole viewBox, so it must cover the whole destination.
    // Previously the scale was destination-over-*root*, so a viewBox smaller
    // than the root width drew at a fraction of the requested size.
    const stream = draw(
      '<svg width="200" height="100" viewBox="0 0 100 50">' +
        '<rect x="0" y="0" width="100" height="50" fill="#ff0000"/></svg>',
      { width: 200, height: 100 }
    );
    expect(rects(stream)).toEqual(["0 0 200 100"]);
  });

  it("subtracts a non-zero viewBox origin", () => {
    // Content starting at the viewBox origin belongs at the destination origin.
    const stream = draw(
      '<svg width="100" height="50" viewBox="10 20 100 50">' +
        '<rect x="10" y="20" width="100" height="50" fill="#00ff00"/></svg>',
      { width: 100, height: 50 }
    );
    expect(rects(stream)).toEqual(["0 0 100 50"]);
  });

  it("falls back to the root size when there is no viewBox", () => {
    const stream = draw(
      '<svg width="80" height="40"><rect width="80" height="40" fill="#000"/></svg>'
    );
    expect(rects(stream)).toEqual(["0 0 80 40"]);
  });

  it("ignores a degenerate viewBox instead of dividing by zero", () => {
    const stream = draw(
      '<svg width="60" height="30" viewBox="0 0 0 0"><rect width="60" height="30" fill="#000"/></svg>'
    );
    expect(rects(stream)).toEqual(["0 0 60 30"]);
  });
});

describe("drawSvg colour", () => {
  it("reads an 8-digit hex as #RRGGBBAA per CSS", () => {
    // Regression: the hex branch delegated to the OOXML `#AARRGGBB` reader, so
    // this arrived as opaque dark blue (0 0 0.5 rg) instead of translucent red.
    const stream = draw(
      '<svg width="10" height="10"><rect width="10" height="10" fill="#FF000080"/></svg>'
    );
    expect(stream).toContain("1 0 0 rg");
    // A non-opaque alpha has to reach the page as an /ExtGState.
    expect(stream).toMatch(/\/GS\d+ gs/);
  });

  it("reads a 4-digit hex shorthand", () => {
    const stream = draw(
      '<svg width="10" height="10"><rect width="10" height="10" fill="#0f08"/></svg>'
    );
    expect(stream).toContain("0 1 0 rg");
    expect(stream).toMatch(/\/GS\d+ gs/);
  });

  it("still reads rgb() and 6-digit hex", () => {
    expect(
      draw('<svg width="10" height="10"><rect width="10" height="10" fill="rgb(255,0,0)"/></svg>')
    ).toContain("1 0 0 rg");
    expect(
      draw('<svg width="10" height="10"><rect width="10" height="10" fill="#00ff00"/></svg>')
    ).toContain("0 1 0 rg");
  });

  it("does not fill an element painted with none", () => {
    // Geometry alone is not evidence — assert the paint operator.
    const stream = draw(
      '<svg width="10" height="10"><rect width="10" height="10" fill="none"/></svg>'
    );
    expect(stream).not.toContain(" rg");
    expect(stream.split("\n").map(line => line.trim())).not.toContain("f");
  });
});

describe("drawSvg shapes", () => {
  it("turns a circle into an ellipse only when the scale is non-uniform", () => {
    // With the spec default (`xMidYMid meet`) the scale is uniform, so a circle
    // stays a circle and is centred: uniform = min(2, 1) = 1, slack 100 → x+50.
    const met = draw(
      '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="20" fill="#00f"/></svg>',
      {
        width: 200,
        height: 100
      }
    );
    const metCurves = met.split("\n").filter(line => line.trim().endsWith(" c"));
    expect(metCurves).toHaveLength(4);
    // cx maps to 50 + 50 = 100, rx stays 20, so the rightmost extent is 120.
    expect(metCurves[0].trim().startsWith("120 ")).toBe(true);

    // Only an explicit `none` stretches, and then the circle really is an
    // ellipse: rx = 20 * 2 = 40 from cx = 100, so the extent is 140.
    const stretched = draw(
      '<svg viewBox="0 0 100 100" preserveAspectRatio="none"><circle cx="50" cy="50" r="20" fill="#00f"/></svg>',
      { width: 200, height: 100 }
    );
    const stretchedCurves = stretched.split("\n").filter(line => line.trim().endsWith(" c"));
    expect(stretchedCurves[0].trim().startsWith("140 ")).toBe(true);
  });

  it("honours an explicit ellipse", () => {
    const stream = draw(
      '<svg width="100" height="100"><ellipse cx="50" cy="50" rx="30" ry="10" fill="#000"/></svg>'
    );
    expect(stream.split("\n").filter(line => line.trim().endsWith(" c"))).toHaveLength(4);
  });
});

describe("drawSvg text", () => {
  it("stacks tspan paragraphs instead of drawing their markup", () => {
    // Regression: the element's inner markup went to `drawText` verbatim, so the
    // tags themselves were rendered as glyphs.
    const stream = draw(
      '<svg width="200" height="100"><text x="100" y="20" text-anchor="middle" font-size="10">' +
        '<tspan x="100">Quarterly</tspan><tspan x="100" dy="1.2em">Revenue</tspan></text></svg>'
    );
    expect(stream).not.toContain("tspan");
    expect(shownText(stream)).toEqual(["Quarterly", "Revenue"]);
  });

  it("keeps plain text on a single show operation", () => {
    const stream = draw(
      '<svg width="100" height="50"><text x="10" y="20" font-size="10">Sales</text></svg>'
    );
    expect(shownText(stream)).toEqual(["Sales"]);
  });

  it("decodes entities in text content", () => {
    const stream = draw('<svg width="100" height="50"><text x="10" y="20">A &amp; B</text></svg>');
    expect(shownText(stream)).toEqual(["A & B"]);
  });

  it("applies a rotate transform in the correct direction", () => {
    // `rotate(-90)` reads bottom-to-top on screen. Mapping SVG's Y-down space
    // into PDF's Y-up space is a reflection, which reverses the sense of a
    // rotation, so the emitted text matrix must advance *up* the page:
    // `[a b c d e f]` needs `(a, b) = (0, 1)`. Forwarding the SVG angle
    // unchanged produced `(0, -1)` — a mirrored label.
    const stream = draw(
      '<svg width="100" height="100"><text x="20" y="80" transform="rotate(-90 20 80)" font-size="10">Axis</text></svg>'
    );
    expect(shownText(stream)).toEqual(["Axis"]);
    const matrix = /(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) Tm/.exec(
      stream
    );
    expect(matrix).not.toBeNull();
    expect(Number(matrix![1])).toBeCloseTo(0, 6);
    expect(Number(matrix![2])).toBeCloseTo(1, 6);
  });

  it("leaves unrotated text on an axis-aligned matrix", () => {
    const stream = draw(
      '<svg width="100" height="100"><text x="20" y="80" font-size="10">Flat</text></svg>'
    );
    const matrix = /(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) Tm/.exec(
      stream
    );
    expect(Number(matrix![1])).toBeCloseTo(1, 6);
    expect(Number(matrix![2])).toBeCloseTo(0, 6);
  });

  it("stacks a rotated multi-paragraph label along its own down axis", () => {
    const stream = draw(
      '<svg width="200" height="200"><text x="20" y="100" transform="rotate(-90 20 100)" font-size="10">' +
        '<tspan x="20">Quarterly</tspan><tspan x="20" dy="1.2em">Revenue</tspan></text></svg>'
    );
    expect(shownText(stream)).toEqual(["Quarterly", "Revenue"]);
  });
});

describe("drawSvg attribute syntax", () => {
  it("accepts single-quoted attributes", () => {
    // Legal XML that the previous hand-rolled parser dropped entirely, so the
    // whole element silently disappeared.
    expect(
      rects(draw("<svg width='40' height='20'><rect width='40' height='20' fill='#f00'/></svg>"))
    ).toEqual(["0 0 40 20"]);
  });

  it("accepts whitespace around the equals sign", () => {
    expect(
      rects(
        draw(
          '<svg width = "40" height = "20"><rect width = "40" height = "20" fill = "#f00"/></svg>'
        )
      )
    ).toEqual(["0 0 40 20"]);
  });
});

describe("drawSvg stroke width", () => {
  /** Every `w` (line width) operand, in order. */
  function widths(stream: string): number[] {
    return [...stream.matchAll(/^([\d.]+) w$/gm)].map(match => Number(match[1]));
  }

  it("honours stroke-width", () => {
    // Regression: `stroke-width` was ignored outright, so every stroked element
    // came out at the PDF default width while the raster backend scaled it —
    // the same chart SVG had different stroke weights in a PNG and a PDF.
    const stream = draw(
      '<svg width="100" height="100"><rect width="50" height="50" stroke="#000" stroke-width="3"/></svg>'
    );
    expect(widths(stream)).toContain(3);
  });

  it("scales stroke-width with the destination box", () => {
    const stream = draw(
      '<svg viewBox="0 0 100 100"><rect width="50" height="50" stroke="#000" stroke-width="2"/></svg>',
      { width: 200, height: 200 }
    );
    expect(widths(stream)).toContain(4);
  });

  it("keeps stroke-width uniform under the default aspect-ratio handling", () => {
    // `meet` scales by min(4, 1) = 1, so a 1-unit stroke stays 1pt.
    expect(
      widths(
        draw(
          '<svg viewBox="0 0 100 100"><line x1="0" y1="0" x2="100" y2="100" stroke="#000" stroke-width="1"/></svg>',
          { width: 400, height: 100 }
        )
      )
    ).toContain(1);
  });

  it("uses the uniform-equivalent factor when the caller asks for a stretch", () => {
    // With `preserveAspectRatio="none"` the axes differ, and a PDF line width is
    // a single scalar: sqrt(4 * 1) = 2.
    expect(
      widths(
        draw(
          '<svg viewBox="0 0 100 100" preserveAspectRatio="none">' +
            '<line x1="0" y1="0" x2="100" y2="100" stroke="#000" stroke-width="1"/></svg>',
          { width: 400, height: 100 }
        )
      )
    ).toContain(2);
  });

  it("applies stroke-width to paths and ellipses too", () => {
    expect(
      widths(
        draw(
          '<svg width="100" height="100"><path d="M0 0 L50 50" stroke="#000" stroke-width="5"/></svg>'
        )
      )
    ).toContain(5);
    expect(
      widths(
        draw(
          '<svg width="100" height="100"><ellipse cx="50" cy="50" rx="20" ry="10" stroke="#000" stroke-width="4"/></svg>'
        )
      )
    ).toContain(4);
  });

  it("ignores a malformed stroke-width instead of emitting NaN", () => {
    const stream = draw(
      '<svg width="100" height="100"><rect width="50" height="50" stroke="#000" stroke-width="abc"/></svg>'
    );
    expect(stream).not.toContain("NaN");
  });
});

describe("drawSvg initial paint values", () => {
  it("fills an unpainted shape with black, per SVG's initial fill", () => {
    // A missing `fill` is not the same as `fill="none"`: the initial value is
    // black. A bare rect used to come out as a black *outline* and a bare path
    // vanished outright, because both fell through to the PDF primitives' own
    // defaults instead of SVG's.
    const rect = draw('<svg width="10" height="10"><rect width="10" height="10"/></svg>');
    expect(rect).toContain("0 0 0 rg");
    expect(rect).not.toContain(" RG");

    const path = draw('<svg width="10" height="10"><path d="M0 0 L5 5 L0 5 Z"/></svg>');
    expect(path).toContain("0 0 0 rg");
    expect(path).toContain(" m");
  });

  it("draws nothing for a line with no stroke", () => {
    // `stroke` is a line's only paint and its initial value is `none`, so an
    // unstroked line is invisible — it must not inherit drawLine's black.
    expect(
      draw('<svg width="10" height="10"><line x1="0" y1="0" x2="9" y2="9" stroke="none"/></svg>')
    ).toBe("");
    expect(draw('<svg width="10" height="10"><line x1="0" y1="0" x2="9" y2="9"/></svg>')).toBe("");
  });

  it("draws nothing for text with fill:none", () => {
    expect(draw('<svg width="40" height="20"><text x="1" y="10" fill="none">Hi</text></svg>')).toBe(
      ""
    );
  });

  it("still draws unpainted text in black", () => {
    const stream = draw('<svg width="40" height="20"><text x="1" y="10">Hi</text></svg>');
    expect(stream).toContain("0 0 0 rg");
    expect(shownText(stream)).toEqual(["Hi"]);
  });

  it("keeps an explicitly stroked line", () => {
    expect(
      draw('<svg width="10" height="10"><line x1="0" y1="0" x2="9" y2="9" stroke="#f00"/></svg>')
    ).toContain("1 0 0 RG");
  });
});

describe("drawSvg preserveAspectRatio", () => {
  it("centres the content by default (xMidYMid meet)", () => {
    // A 100x100 viewBox in a 300x100 box scales by 1 and gets 100pt of slack on
    // each side. The previous behaviour stretched it to 300x100.
    const stream = draw(
      '<svg viewBox="0 0 100 100"><rect width="100" height="100" fill="#f00"/></svg>',
      {
        width: 300,
        height: 100
      }
    );
    expect(rects(stream)).toEqual(["100 0 100 100"]);
  });

  it("honours xMin / xMax alignment", () => {
    expect(
      rects(
        draw(
          '<svg viewBox="0 0 100 100" preserveAspectRatio="xMinYMin meet">' +
            '<rect width="100" height="100" fill="#f00"/></svg>',
          { width: 300, height: 100 }
        )
      )
    ).toEqual(["0 0 100 100"]);
    expect(
      rects(
        draw(
          '<svg viewBox="0 0 100 100" preserveAspectRatio="xMaxYMax meet">' +
            '<rect width="100" height="100" fill="#f00"/></svg>',
          { width: 300, height: 100 }
        )
      )
    ).toEqual(["200 0 100 100"]);
  });

  it("stretches only for an explicit none", () => {
    expect(
      rects(
        draw(
          '<svg viewBox="0 0 100 100" preserveAspectRatio="none">' +
            '<rect width="100" height="100" fill="#f00"/></svg>',
          { width: 300, height: 100 }
        )
      )
    ).toEqual(["0 0 300 100"]);
  });

  it("covers the viewport for slice", () => {
    // `slice` scales by max(3, 1) = 3, so the 100-unit square becomes 300pt and
    // overflows the 100pt height — vertically centred, hence the negative y.
    expect(
      rects(
        draw(
          '<svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice">' +
            '<rect width="100" height="100" fill="#f00"/></svg>',
          { width: 300, height: 100 }
        )
      )
    ).toEqual(["0 -100 300 300"]);
  });

  it("accepts and ignores the defer prefix", () => {
    expect(
      rects(
        draw(
          '<svg viewBox="0 0 100 100" preserveAspectRatio="defer xMinYMin meet">' +
            '<rect width="100" height="100" fill="#f00"/></svg>',
          { width: 300, height: 100 }
        )
      )
    ).toEqual(["0 0 100 100"]);
  });
});

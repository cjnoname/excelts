import { describe, expect, it } from "vitest";

import {
  parseCssColor,
  parseSvgAttributes,
  parseSvgNumberList,
  parseSvgPointPairs,
  parseSvgRotate,
  parseSvgTextRuns,
  stripSvgMarkup
} from "../svg-lex";

describe("parseSvgAttributes", () => {
  it("reads double-quoted attributes off a whole start tag", () => {
    expect(parseSvgAttributes('<rect x="1" y="2" fill="#f00"/>')).toEqual({
      x: "1",
      y: "2",
      fill: "#f00"
    });
  });

  it("accepts single quotes and whitespace around the equals sign", () => {
    // Both legal XML; the duplicated hand-rolled parsers this replaces dropped
    // the attribute entirely, so `<rect fill = 'red'/>` drew nothing.
    expect(parseSvgAttributes("<rect fill = 'red' width ='3'/>")).toEqual({
      fill: "red",
      width: "3"
    });
  });

  it("keeps hyphenated and namespaced names", () => {
    expect(parseSvgAttributes('<text text-anchor="middle" xml:space="preserve">')).toEqual({
      "text-anchor": "middle",
      "xml:space": "preserve"
    });
  });

  it("ignores a valueless name without looping on it", () => {
    expect(parseSvgAttributes('<path d="M0 0" hidden/>')).toEqual({ d: "M0 0" });
  });

  it("tolerates an unterminated value", () => {
    expect(parseSvgAttributes('<rect fill="#f00')).toEqual({ fill: "#f00" });
  });
});

describe("parseSvgNumberList", () => {
  it("splits on whitespace and commas and keeps exponents", () => {
    expect(parseSvgNumberList("1, 2  3,-4 1e2")).toEqual([1, 2, 3, -4, 100]);
  });

  it("drops non-finite tokens", () => {
    expect(parseSvgNumberList("1 abc 2")).toEqual([1, 2]);
  });

  it("returns nothing for undefined", () => {
    expect(parseSvgNumberList(undefined)).toEqual([]);
  });
});

describe("parseSvgPointPairs", () => {
  it("pairs coordinates", () => {
    expect(parseSvgPointPairs("0,0 10,5")).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 5 }
    ]);
  });

  it("discards a dangling coordinate", () => {
    expect(parseSvgPointPairs("0,0 10")).toEqual([{ x: 0, y: 0 }]);
  });
});

describe("parseCssColor", () => {
  it("treats an 8-digit hex as #RRGGBBAA, per CSS", () => {
    // The regression this guards: the PDF SVG importer delegated to the OOXML
    // `AARRGGBB` reader, turning translucent red into opaque dark blue.
    const color = parseCssColor("#FF000080");
    expect(color?.r).toBeCloseTo(1, 6);
    expect(color?.g).toBeCloseTo(0, 6);
    expect(color?.b).toBeCloseTo(0, 6);
    expect(color?.a).toBeCloseTo(0x80 / 255, 6);
  });

  it("expands #RGB and #RGBA shorthands", () => {
    expect(parseCssColor("#f00")).toEqual({ r: 1, g: 0, b: 0, a: 1 });
    const short = parseCssColor("#f008");
    expect(short?.r).toBeCloseTo(1, 6);
    expect(short?.a).toBeCloseTo(0x88 / 255, 6);
  });

  it("reads #RRGGBB", () => {
    const color = parseCssColor("#4472C4");
    expect(color?.r).toBeCloseTo(0x44 / 255, 6);
    expect(color?.g).toBeCloseTo(0x72 / 255, 6);
    expect(color?.b).toBeCloseTo(0xc4 / 255, 6);
    expect(color?.a).toBe(1);
  });

  it("accepts hex without the leading hash", () => {
    expect(parseCssColor("00ff00")).toEqual({ r: 0, g: 1, b: 0, a: 1 });
  });

  it("reads rgb() and rgba() with 0..255 channels", () => {
    expect(parseCssColor("rgb(255, 0, 0)")).toEqual({ r: 1, g: 0, b: 0, a: 1 });
    const rgba = parseCssColor("rgba(0, 0, 255, 0.5)");
    expect(rgba?.b).toBeCloseTo(1, 6);
    expect(rgba?.a).toBeCloseTo(0.5, 6);
  });

  it("reads percentage channels", () => {
    const color = parseCssColor("rgb(100%, 0%, 50%)");
    expect(color?.r).toBeCloseTo(1, 6);
    expect(color?.b).toBeCloseTo(0.5, 6);
  });

  it("clamps out-of-range channels", () => {
    expect(parseCssColor("rgb(300, -20, 0)")).toEqual({ r: 1, g: 0, b: 0, a: 1 });
  });

  it("rejects an unreadable alpha instead of becoming opaque", () => {
    // `rgba(255,0,0,junk)` is not red — a browser drops the whole declaration.
    expect(parseCssColor("rgba(255,0,0,junk)")).toBeUndefined();
  });

  it("rejects rgb() with the wrong number of components", () => {
    expect(parseCssColor("rgb(1,2,3,4,5)")).toBeUndefined();
    expect(parseCssColor("rgb(1,2)")).toBeUndefined();
  });

  it("returns undefined for no-paint keywords and junk", () => {
    expect(parseCssColor("none")).toBeUndefined();
    expect(parseCssColor("transparent")).toBeUndefined();
    expect(parseCssColor("")).toBeUndefined();
    expect(parseCssColor(undefined)).toBeUndefined();
    expect(parseCssColor("#12345")).toBeUndefined();
    expect(parseCssColor("rebeccapurple")).toBeUndefined();
  });
});

describe("parseSvgRotate", () => {
  it("reads the angle and optional centre", () => {
    expect(parseSvgRotate("rotate(-90 20 80)")).toEqual({ angle: -90, cx: 20, cy: 80 });
    expect(parseSvgRotate("rotate(45)")).toEqual({ angle: 45, cx: 0, cy: 0 });
  });

  it("returns undefined when there is no rotate", () => {
    expect(parseSvgRotate("translate(4 5)")).toBeUndefined();
    expect(parseSvgRotate(undefined)).toBeUndefined();
  });
});

describe("parseSvgTextRuns", () => {
  it("returns one run for text without tspans", () => {
    expect(parseSvgTextRuns("Hello", 10)).toEqual([{ text: "Hello", dy: 0 }]);
  });

  it("resolves an em dy against the font size", () => {
    expect(parseSvgTextRuns('<tspan>A</tspan><tspan dy="1.2em">B</tspan>', 10)).toEqual([
      { text: "A", dy: 0 },
      { text: "B", dy: 12 }
    ]);
  });

  it("treats a unitless dy as user units, not ems", () => {
    // Regression: every `dy` was reported as ems, so `dy="12"` displaced the
    // line by twelve ems instead of twelve user units.
    expect(parseSvgTextRuns('<tspan>A</tspan><tspan dy="12">B</tspan>', 10)).toEqual([
      { text: "A", dy: 0 },
      { text: "B", dy: 12 }
    ]);
    expect(parseSvgTextRuns('<tspan>A</tspan><tspan dy="1.2em">B</tspan>', 100)).toEqual([
      { text: "A", dy: 0 },
      { text: "B", dy: 120 }
    ]);
  });

  it("resolves a percentage dy against the font size", () => {
    expect(parseSvgTextRuns('<tspan>A</tspan><tspan dy="50%">B</tspan>', 20)).toEqual([
      { text: "A", dy: 0 },
      { text: "B", dy: 10 }
    ]);
  });

  it("accumulates successive dy values", () => {
    expect(
      parseSvgTextRuns('<tspan>A</tspan><tspan dy="1em">B</tspan><tspan dy="1em">C</tspan>', 10)
    ).toEqual([
      { text: "A", dy: 0 },
      { text: "B", dy: 10 },
      { text: "C", dy: 20 }
    ]);
  });

  it("keeps text that sits outside the tspans", () => {
    // Regression: only the tspan contents survived, so `Head<tspan>A</tspan>Tail`
    // rendered as just "A".
    expect(parseSvgTextRuns("Head<tspan>A</tspan>Tail", 10).map(run => run.text)).toEqual([
      "Head",
      "A",
      "Tail"
    ]);
  });

  it("records an overriding x", () => {
    expect(parseSvgTextRuns('<tspan x="40">A</tspan>', 10)).toEqual([{ text: "A", x: 40, dy: 0 }]);
  });

  it("decodes entities inside runs", () => {
    expect(parseSvgTextRuns("<tspan>A &amp; B</tspan>", 10)[0].text).toBe("A & B");
  });
});

describe("stripSvgMarkup", () => {
  it("removes tags and decodes the predefined entities", () => {
    expect(stripSvgMarkup("<tspan>A &amp; B</tspan>")).toBe("A & B");
    expect(stripSvgMarkup("&lt;x&gt; &quot;q&quot; &apos;a&apos;")).toBe(`<x> "q" 'a'`);
  });

  it("decodes numeric references", () => {
    expect(stripSvgMarkup("&#65;&#x42;")).toBe("AB");
  });

  it("leaves a lone-surrogate reference as written", () => {
    // Splicing in a lone surrogate would make the output ill-formed.
    expect(stripSvgMarkup("A&#xD800;B")).toBe("A&#xD800;B");
  });

  it("leaves an out-of-range reference as written", () => {
    expect(stripSvgMarkup("A&#x110000;B")).toBe("A&#x110000;B");
  });

  it("leaves an unknown named entity as written", () => {
    expect(stripSvgMarkup("A&nbsp;B")).toBe("A&nbsp;B");
  });
});

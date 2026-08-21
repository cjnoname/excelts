/**
 * DOCX Module - Page Renderer (SVG Output) Tests
 */

import { describe, it, expect } from "vitest";

import { renderPageToSvg, renderDocumentToSvg } from "../layout/render-page";
import type { DocxDocument, Paragraph, Run, Table } from "../types";

// =============================================================================
// Test Helpers
// =============================================================================

/** Create a simple text run. */
function makeRun(text: string, props?: Run["properties"]): Run {
  return {
    ...(props ? { properties: props } : {}),
    content: [{ type: "text", text }]
  };
}

/** Create a simple paragraph with text. */
function makeParagraph(text: string, props?: Paragraph["properties"]): Paragraph {
  return {
    type: "paragraph",
    ...(props ? { properties: props } : {}),
    children: [makeRun(text)]
  };
}

/** Create a minimal DocxDocument with paragraphs. */
function makeDoc(body: DocxDocument["body"]): DocxDocument {
  return { body };
}

// =============================================================================
// Tests
// =============================================================================

describe("renderPageToSvg", () => {
  it("renders a simple single-paragraph document", () => {
    const doc = makeDoc([makeParagraph("Hello World")]);
    const svg = renderPageToSvg(doc, 1);

    expect(svg).toContain("<svg");
    expect(svg).toContain("<text");
    expect(svg).toContain("Hello World");
    expect(svg).toContain("</svg>");
  });

  it("renders heading text with larger font-size", () => {
    const normalDoc = makeDoc([makeParagraph("Normal text")]);
    const headingDoc = makeDoc([makeParagraph("Heading text", { style: "Heading1" })]);

    const normalSvg = renderPageToSvg(normalDoc, 1);
    const headingSvg = renderPageToSvg(headingDoc, 1);

    // Extract font-size values
    const normalFontSize = normalSvg.match(/font-size="([^"]+)"/);
    const headingFontSize = headingSvg.match(/font-size="([^"]+)"/);

    expect(normalFontSize).not.toBeNull();
    expect(headingFontSize).not.toBeNull();

    const normalSize = parseFloat(normalFontSize![1]);
    const headingSize = parseFloat(headingFontSize![1]);
    // Heading1 uses a scale of 2.0, so heading text should be larger
    expect(headingSize).toBeGreaterThan(normalSize);
  });

  it("renders multiple paragraphs with multiple <text> elements", () => {
    const doc = makeDoc([
      makeParagraph("First paragraph"),
      makeParagraph("Second paragraph"),
      makeParagraph("Third paragraph")
    ]);
    const svg = renderPageToSvg(doc, 1);

    expect(svg).toContain("First paragraph");
    expect(svg).toContain("Second paragraph");
    expect(svg).toContain("Third paragraph");

    // Count <text elements
    const textElements = svg.match(/<text /g);
    expect(textElements).not.toBeNull();
    expect(textElements!.length).toBeGreaterThanOrEqual(3);
  });

  it("renders bold text with font-weight='bold'", () => {
    const doc = makeDoc([
      {
        type: "paragraph",
        children: [makeRun("Bold text", { bold: true })]
      }
    ]);
    const svg = renderPageToSvg(doc, 1);

    expect(svg).toContain('font-weight="bold"');
    expect(svg).toContain("Bold text");
  });

  it("renders italic text with font-style='italic'", () => {
    const doc = makeDoc([
      {
        type: "paragraph",
        children: [makeRun("Italic text", { italic: true })]
      }
    ]);
    const svg = renderPageToSvg(doc, 1);

    expect(svg).toContain('font-style="italic"');
    expect(svg).toContain("Italic text");
  });

  it("renders colored text with fill attribute", () => {
    const doc = makeDoc([
      {
        type: "paragraph",
        children: [makeRun("Red text", { color: "FF0000" })]
      }
    ]);
    const svg = renderPageToSvg(doc, 1);

    expect(svg).toContain('fill="#FF0000"');
    expect(svg).toContain("Red text");
  });

  it("renders a table with <rect> and <line> elements", () => {
    const table: Table = {
      type: "table",
      rows: [
        {
          cells: [{ content: [makeParagraph("Cell A1")] }, { content: [makeParagraph("Cell B1")] }]
        },
        {
          cells: [{ content: [makeParagraph("Cell A2")] }, { content: [makeParagraph("Cell B2")] }]
        }
      ]
    };
    const doc = makeDoc([table]);
    const svg = renderPageToSvg(doc, 1);

    // Table outer border is drawn as a <rect>
    expect(svg).toContain("<rect");
    // Row/column separators drawn as <line>
    expect(svg).toContain("<line");
    // Cell text should be present
    expect(svg).toContain("Cell A1");
    expect(svg).toContain("Cell B1");
  });

  it("throws RangeError for page number out of range", () => {
    const doc = makeDoc([makeParagraph("Single page")]);

    expect(() => renderPageToSvg(doc, 0)).toThrow(RangeError);
    expect(() => renderPageToSvg(doc, 999)).toThrow(RangeError);
  });

  it("applies custom background color", () => {
    const doc = makeDoc([makeParagraph("Hello")]);
    const svg = renderPageToSvg(doc, 1, { backgroundColor: "#EEEEEE" });

    expect(svg).toContain('fill="#EEEEEE"');
  });

  it("applies custom scale factor to output dimensions", () => {
    const doc = makeDoc([makeParagraph("Scaled")]);
    const svg1x = renderPageToSvg(doc, 1, { scale: 1.0 });
    const svg2x = renderPageToSvg(doc, 1, { scale: 2.0 });

    // Extract width from both SVGs
    const width1x = svg1x.match(/width="([^"]+)"/);
    const width2x = svg2x.match(/width="([^"]+)"/);

    expect(width1x).not.toBeNull();
    expect(width2x).not.toBeNull();

    const w1 = parseFloat(width1x![1]);
    const w2 = parseFloat(width2x![1]);
    // 2x scale should produce double the width
    expect(w2).toBeCloseTo(w1 * 2, 0);
  });
});

describe("renderDocumentToSvg", () => {
  it("returns an array of SVG strings", () => {
    const doc = makeDoc([makeParagraph("Page content")]);
    const pages = renderDocumentToSvg(doc);

    expect(Array.isArray(pages)).toBe(true);
    expect(pages.length).toBeGreaterThanOrEqual(1);
    expect(pages[0]).toContain("<svg");
    expect(pages[0]).toContain("Page content");
  });

  it("respects rendering options", () => {
    const doc = makeDoc([makeParagraph("Content")]);
    const pages = renderDocumentToSvg(doc, { backgroundColor: "lightblue" });

    expect(pages.length).toBeGreaterThanOrEqual(1);
    expect(pages[0]).toContain('fill="lightblue"');
  });

  it("renders an empty document body with at least one page", () => {
    const doc = makeDoc([]);
    const pages = renderDocumentToSvg(doc);

    expect(Array.isArray(pages)).toBe(true);
    // Even an empty document should produce at least one page
    expect(pages.length).toBeGreaterThanOrEqual(1);
    expect(pages[0]).toContain("<svg");
  });

  describe("color sanitisation", () => {
    it("ignores non-hex run colors instead of injecting them as raw fill", () => {
      // A malicious color carrying additional attributes/script must not
      // make it into the SVG fill attribute.
      const malicious = makeRun("hi", {
        color: 'red" onclick="alert(1)'
      } as Run["properties"]);
      const para: Paragraph = { type: "paragraph", children: [malicious] };
      const doc = makeDoc([para]);

      const svg = renderPageToSvg(doc, 1);

      // Must not contain the injected attribute.
      expect(svg).not.toContain("onclick");
      // Must not contain a fill attribute with the bogus value.
      expect(svg).not.toMatch(/fill="#red" onclick="alert\(1\)"/);
    });

    it("accepts a valid 6-digit hex color", () => {
      const colored = makeRun("hi", { color: "FF0000" } as Run["properties"]);
      const para: Paragraph = { type: "paragraph", children: [colored] };
      const doc = makeDoc([para]);

      const svg = renderPageToSvg(doc, 1);
      expect(svg).toContain('fill="#FF0000"');
    });
  });

  describe("style resolution", () => {
    /** A document whose Heading1 style defines size/colour/font (like Word's). */
    function docWithHeadingStyle(): DocxDocument {
      return {
        body: [makeParagraph("Title", { style: "Heading1" })],
        styles: [
          {
            type: "paragraph",
            styleId: "Heading1",
            name: "heading 1",
            runProperties: { size: 32, color: "2F5496", font: "Calibri Light" }
          }
        ]
      } as DocxDocument;
    }

    it("renders a styled heading using the style's size, colour and font", () => {
      const svg = renderPageToSvg(docWithHeadingStyle(), 1);
      // sz=32 half-points → 16pt (NOT the hardcoded 24pt heading-scale value).
      expect(svg).toContain('font-size="16.0"');
      expect(svg).toContain('fill="#2F5496"');
      expect(svg).toContain("Calibri Light");
    });

    it("an inline run property still overrides the resolved style", () => {
      const doc = {
        body: [
          {
            type: "paragraph",
            properties: { style: "Heading1" },
            children: [makeRun("Title", { color: "FF0000" } as Run["properties"])]
          }
        ],
        styles: [
          {
            type: "paragraph",
            styleId: "Heading1",
            name: "heading 1",
            runProperties: { size: 32, color: "2F5496" }
          }
        ]
      } as DocxDocument;
      const svg = renderPageToSvg(doc, 1);
      expect(svg).toContain('fill="#FF0000"');
      expect(svg).not.toContain('fill="#2F5496"');
    });

    it("falls back to the heuristic heading scale when there is no styles table", () => {
      const normalDoc = makeDoc([makeParagraph("Normal")]);
      const headingDoc = makeDoc([makeParagraph("Heading", { style: "Heading1" })]);
      const normalSize = parseFloat(renderPageToSvg(normalDoc, 1).match(/font-size="([^"]+)"/)![1]);
      const headingSize = parseFloat(
        renderPageToSvg(headingDoc, 1).match(/font-size="([^"]+)"/)![1]
      );
      expect(headingSize).toBeGreaterThan(normalSize);
    });
  });
});

describe("renderDocumentToSvg chart rendering", () => {
  /** A body with one inline chart carrying a title and explicit EMU extent. */
  const chartDoc = (): DocxDocument =>
    makeDoc([
      makeParagraph("Before"),
      {
        type: "chart",
        chart: { title: "Q1 Revenue", width: 3_000_000, height: 2_000_000 }
      } as unknown as DocxDocument["body"][number]
    ]);

  it("falls back to a titled placeholder when no renderer is supplied", () => {
    // `word/` may only reach the chart engine through its Excel bridge, so this
    // module cannot draw a chart itself. Without an injected renderer the
    // placeholder is the honest output.
    const svg = renderDocumentToSvg(chartDoc())[0];
    expect(svg).toContain("Q1 Revenue");
    expect(svg).not.toContain('<g transform="translate');
  });

  it("scales a fragment that declares its own size down to the chart box", () => {
    // `renderWordChartSvg` emits 96-DPI pixels while the layout rect is in
    // points, so a fragment inlined verbatim overflowed its box by exactly 4/3.
    // 3_000_000 EMU is 3.28in → 315px at 96dpi and 236pt at 72dpi.
    const svg = renderDocumentToSvg(chartDoc(), {
      renderChart: () => '<svg width="315" height="210"><rect width="315" height="210"/></svg>'
    })[0];
    const scale = /scale\(([\d.]+)\)/.exec(svg);
    expect(scale).not.toBeNull();
    // 72/96 = 0.75.
    expect(Number(scale![1])).toBeCloseTo(0.75, 3);
  });

  it("does not add a scale when the fragment declares no size", () => {
    const svg = renderDocumentToSvg(chartDoc(), {
      renderChart: () => '<rect width="10" height="10"/>'
    })[0];
    expect(svg).toMatch(/<g transform="translate\([\d.]+ [\d.]+\)"><rect/);
    expect(svg).not.toContain("scale(");
  });

  it("derives the fragment size from a viewBox when width/height are absent", () => {
    const svg = renderDocumentToSvg(chartDoc(), {
      renderChart: () => '<svg viewBox="0 0 472 315"><rect width="472" height="315"/></svg>'
    })[0];
    const scale = /scale\(([\d.]+)\)/.exec(svg);
    expect(scale).not.toBeNull();
    expect(Number(scale![1])).toBeLessThan(1);
  });

  it("inlines the fragment returned by renderChart", () => {
    // Regression: `LayoutChart.svg` was declared and consumed but nothing on the
    // normal layout path ever set it, so every chart was a placeholder and there
    // was no way for a caller to supply one.
    const svg = renderDocumentToSvg(chartDoc(), {
      renderChart: chart => `<rect width="10" height="10" data-title="${chart.title}"/>`
    })[0];
    expect(svg).toContain('data-title="Q1 Revenue"');
    // Positioned at the chart's page coordinates rather than dumped at 0,0.
    expect(svg).toMatch(/<g transform="translate\([\d.]+ [\d.]+\)"><rect width="10"/);
  });

  it("keeps the placeholder when the renderer declines", () => {
    const svg = renderDocumentToSvg(chartDoc(), { renderChart: () => undefined })[0];
    expect(svg).toContain("Q1 Revenue");
    expect(svg).not.toContain('<g transform="translate');
  });
});

describe("renderDocumentToSvg shape colours", () => {
  /** A body with one drawing shape carrying the given fill. */
  const shapeDoc = (fillColor: string): DocxDocument =>
    makeDoc([
      {
        type: "drawingShape",
        shapeType: "rect",
        width: 900_000,
        height: 500_000,
        fillColor
      } as unknown as DocxDocument["body"][number]
    ]);

  it("never emits a literal #undefined for an unusable fill", () => {
    // Regression: the layout only strips a leading `#` and never validates, so a
    // colour that is not 3- or 6-digit hex reached the emitter and produced
    // `fill="#undefined"` — invalid SVG.
    const svg = renderDocumentToSvg(shapeDoc("red"))[0];
    expect(svg).not.toContain("#undefined");
    expect(svg).toMatch(/<rect[^>]*fill="none"/);
  });

  it("still honours a valid hex fill", () => {
    const svg = renderDocumentToSvg(shapeDoc("#4472C4"))[0];
    expect(svg).toMatch(/<rect[^>]*fill="#4472C4"/);
  });

  it("accepts a 3-digit hex fill", () => {
    expect(renderDocumentToSvg(shapeDoc("f00"))[0]).toMatch(/<rect[^>]*fill="#f00"/);
  });

  it("rejects an 8-digit value rather than emitting it", () => {
    // OOXML sometimes carries alpha inside the hex; this emitter has no alpha
    // channel, so the colour is dropped rather than written malformed.
    const svg = renderDocumentToSvg(shapeDoc("80FF0000"))[0];
    expect(svg).not.toContain("#undefined");
    expect(svg).not.toContain("80FF0000");
  });
});

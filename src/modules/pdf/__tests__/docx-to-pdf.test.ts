/**
 * Smoke tests + option-fidelity tests for docxToPdf.
 *
 * Beyond the basic byte-shape check, these tests guard against
 * regressions where caller-supplied page geometry options would be
 * silently dropped — the symptom is `pdfBytes` not reflecting the
 * requested `pageWidth` / `pageHeight` / `margin*`.
 */

import { buildWordChartExXml } from "@word/excel";
import { Document, Build, Io, Layout } from "@word/index";
import type { DocxDocument, PageContent } from "@word/index";
import { describe, it, expect } from "vitest";

import { docxToPdf } from "../word-bridge";
import { decompressPdfContent } from "./test-helpers";
import { buildTtfWithCmap } from "./ttf-test-utils";

describe("docxToPdf — layout-driven smoke test", () => {
  it("produces a valid PDF for a paragraph-only document", async () => {
    const h = Document.create();
    Document.addParagraphElement(h, Build.paragraph([Build.text("hello world")]));
    const docBytes = await Io.package(Document.build(h));

    const doc = await Io.read(docBytes);

    const pdfBytes = await docxToPdf(doc);
    expect(pdfBytes.length).toBeGreaterThan(100);
    const head = new TextDecoder().decode(pdfBytes.slice(0, 5));
    expect(head).toBe("%PDF-");
    const tailDecoded = new TextDecoder().decode(pdfBytes.slice(-32));
    expect(tailDecoded).toMatch(/%%EOF\s*$/);
  });

  it("registers configured fonts before Word performs its first draw", async () => {
    const h = Document.create();
    Document.addParagraphElement(
      h,
      Build.paragraph([Build.text("A", { bold: true, font: "Word Family" })])
    );
    const regular = buildTtfWithCmap([{ start: 0x41, end: 0x41, delta: 1 - 0x41 }], 2, {
      familyName: "WordRegular"
    });
    const bold = buildTtfWithCmap([{ start: 0x41, end: 0x41, delta: 1 - 0x41 }], 2, {
      familyName: "WordBold",
      postScriptName: "WordBold-Bold"
    });

    const bytes = await docxToPdf(Document.build(h), {
      fonts: {
        default: { regular },
        families: [{ name: "Word Family", faces: { regular, bold } }]
      }
    });
    const pdf = new TextDecoder("latin1").decode(bytes);
    expect(pdf).toContain("WordBold-Bold");
    const encoded = pdf.match(/<([0-9A-F]{4})> Tj/);
    expect(encoded).not.toBeNull();
    expect(encoded![1]).not.toBe("0000");
  });

  it("uses the configured font metrics for both Word layout and PDF drawing", async () => {
    const h = Document.create();
    Document.addParagraphElement(
      h,
      Build.paragraph([Build.text("AAA AAA", { font: "Wide Family", size: 20 })])
    );
    const widths = [500, ...Array.from({ length: 59 }, () => 500)];
    widths[0x41 - 0x20 + 1] = 2000;
    const wide = buildTtfWithCmap([{ start: 0x20, end: 0x5a, delta: 1 - 0x20 }], 60, {
      advanceWidths: widths,
      familyName: "WideFont"
    });

    const bytes = await docxToPdf(Document.build(h), {
      pageWidth: 90,
      pageHeight: 200,
      marginLeft: 20,
      marginRight: 20,
      marginTop: 20,
      marginBottom: 20,
      fonts: {
        default: { regular: wide },
        families: [{ name: "Wide Family", faces: { regular: wide } }]
      }
    });
    const pdf = new TextDecoder("latin1").decode(bytes);
    const textYs = [...pdf.matchAll(/1 0 0 1 [\d.]+ ([\d.]+) Tm/g)].map(match =>
      Number.parseFloat(match[1])
    );

    // Each `A` is 2 em wide in this font, so at 10pt one glyph advances 20pt in
    // a 50pt text column: "AAA" (60pt) cannot fit a line even by itself and is
    // broken mid-token into "AA" + "A", giving four lines for "AAA AAA". The
    // metrics therefore have to reach the Word layout pass, not just the PDF
    // drawing — with the default metrics "AAA AAA" would fit on a single line.
    expect(new Set(textYs).size).toBe(4);
  });

  it("reports uncovered characters through onWarning", async () => {
    const h = Document.create();
    Document.addParagraphElement(h, Build.paragraph([Build.text("A中")]));
    const latin = buildTtfWithCmap([{ start: 0x41, end: 0x41, delta: 1 - 0x41 }], 2, {
      familyName: "LatinOnly"
    });
    const warnings: string[] = [];

    await docxToPdf(Document.build(h), {
      fonts: { default: { regular: latin } },
      onWarning: message => warnings.push(message)
    });

    expect(warnings.some(message => message.includes("U+4E2D"))).toBe(true);
  });

  it("does not interpret a real family name ending in -Bold as a style suffix", async () => {
    const h = Document.create();
    Document.addParagraphElement(h, Build.paragraph([Build.text("AAAA", { font: "Brand-Bold" })]));
    const narrow = buildTtfWithCmap([{ start: 0x41, end: 0x41, delta: 1 - 0x41 }], 2, {
      familyName: "Default",
      advanceWidths: [500, 300]
    });
    const wide = buildTtfWithCmap([{ start: 0x41, end: 0x41, delta: 1 - 0x41 }], 2, {
      familyName: "Brand-Bold",
      advanceWidths: [500, 900]
    });

    const bytes = await docxToPdf(Document.build(h), {
      fonts: {
        default: { regular: narrow },
        families: [{ name: "Brand-Bold", faces: { regular: wide } }]
      }
    });

    expect(new TextDecoder("latin1").decode(bytes)).toContain("Brand-Bold-Regular-Subset");
  });

  it("handles a document with a paragraph + table without throwing", async () => {
    const h = Document.create();
    Document.addParagraphElement(h, Build.paragraph([Build.text("intro")]));

    const t = Build.table(
      [
        Build.row([Build.cell("A1"), Build.cell("A2")]),
        Build.row([Build.cell("B1"), Build.cell("B2")])
      ],
      { width: { value: 5000, type: "pct" } },
      [2500, 2500]
    );
    Document.addTableElement(h, t);
    const docBytes = await Io.package(Document.build(h));

    const doc = await Io.read(docBytes);

    const pdfBytes = await docxToPdf(doc);
    expect(pdfBytes.length).toBeGreaterThan(200);
  });
});

describe("docxToPdf — option fidelity", () => {
  async function buildSimpleDoc(): Promise<{ doc: DocxDocument }> {
    const h = Document.create();
    Document.addParagraphElement(h, Build.paragraph([Build.text("page geometry probe")]));
    const docBytes = await Io.package(Document.build(h));
    return { doc: await Io.read(docBytes) };
  }

  it("forwards pageWidth / pageHeight overrides into the layout engine", async () => {
    const { doc } = await buildSimpleDoc();
    const layoutOverridden = Layout.documentFull(doc, {
      pageGeometry: { pageWidth: 400, pageHeight: 500 }
    });
    expect(layoutOverridden.pages[0].geometry.width).toBe(400);
    expect(layoutOverridden.pages[0].geometry.height).toBe(500);

    const layoutDefault = Layout.documentFull(doc);
    expect(layoutDefault.pages[0].geometry.width).not.toBe(400);
  });

  it("forwards margin overrides into the layout engine", async () => {
    const { doc } = await buildSimpleDoc();
    const layout = Layout.documentFull(doc, {
      pageGeometry: {
        marginTop: 10,
        marginBottom: 20,
        marginLeft: 30,
        marginRight: 40
      }
    });
    const g = layout.pages[0].geometry;
    expect(g.marginTop).toBe(10);
    expect(g.marginBottom).toBe(20);
    expect(g.marginLeft).toBe(30);
    expect(g.marginRight).toBe(40);
    expect(g.contentWidth).toBe(g.width - 30 - 40);
    expect(g.contentHeight).toBe(g.height - 10 - 20);
  });

  it("docxToPdf actually applies pageWidth / pageHeight options end-to-end", async () => {
    const { doc } = await buildSimpleDoc();
    // A known small page size; the resulting PDF must declare a media
    // box matching this width/height. PDF media boxes are written as
    // `/MediaBox [0 0 W H]`.
    const w = 300;
    const h = 450;
    const pdfBytes = await docxToPdf(doc, { pageWidth: w, pageHeight: h });
    const decoded = new TextDecoder().decode(pdfBytes);
    expect(decoded).toMatch(/\/MediaBox\s*\[\s*0\s+0\s+300\s+450\s*\]/);
  });

  it("falls back to section properties when no overrides are supplied", async () => {
    const { doc } = await buildSimpleDoc();
    const pdfBytes = await docxToPdf(doc);
    const decoded = new TextDecoder().decode(pdfBytes);
    // US Letter default (612 x 792) with no override.
    expect(decoded).toMatch(/\/MediaBox\s*\[\s*0\s+0\s+612\s+792\s*\]/);
  });
});

describe("docxToPdf — header / footer margin fidelity", () => {
  /**
   * Build a document with an explicit header and footer reference so
   * the layout engine produces header / footer bands whose y-position
   * is governed by the header / footer margin.
   */
  async function buildDocWithHeaderFooter(): Promise<DocxDocument> {
    const h = Document.create();
    Document.addParagraphElement(h, Build.paragraph([Build.text("body text")]));
    const built = Document.build(h);
    // Inject a header and footer part + section references by hand so
    // we exercise the real layout-header / layout-footer code paths.
    const headerPara = Build.paragraph([Build.text("PAGE HEADER")]);
    const footerPara = Build.paragraph([Build.text("PAGE FOOTER")]);
    const withChrome: DocxDocument = {
      ...built,
      headers: new Map([["rIdH", { content: { children: [headerPara] } }]]),
      footers: new Map([["rIdF", { content: { children: [footerPara] } }]]),
      sectionProperties: {
        ...built.sectionProperties,
        headers: [{ type: "default", rId: "rIdH" }],
        footers: [{ type: "default", rId: "rIdF" }]
      }
    };
    return withChrome;
  }

  it("forwards headerMargin / footerMargin into the layout engine geometry", async () => {
    const doc = await buildDocWithHeaderFooter();
    const layout = Layout.documentFull(doc, {
      pageGeometry: { headerMargin: 20, footerMargin: 50 }
    });
    const g = layout.pages[0].geometry;
    expect(g.headerOffset).toBe(20);
    expect(g.footerOffset).toBe(50);
  });

  it("positions the header band at the requested headerMargin offset", async () => {
    const doc = await buildDocWithHeaderFooter();
    const tight = Layout.documentFull(doc, { pageGeometry: { headerMargin: 10 } });
    const loose = Layout.documentFull(doc, { pageGeometry: { headerMargin: 100 } });
    const tightHeader = tight.pages[0].header?.[0];
    const looseHeader = loose.pages[0].header?.[0];
    expect(tightHeader).toBeDefined();
    expect(looseHeader).toBeDefined();
    // The header band's first paragraph y starts at the header offset,
    // so a larger headerMargin pushes the header further down the page.
    expect(looseHeader!.rect.y).toBeGreaterThan(tightHeader!.rect.y);
    expect(tightHeader!.rect.y).toBeCloseTo(10, 1);
    expect(looseHeader!.rect.y).toBeCloseTo(100, 1);
  });

  it("positions the footer band relative to the requested footerMargin", async () => {
    const doc = await buildDocWithHeaderFooter();
    const pageHeight = 792;
    const small = Layout.documentFull(doc, {
      pageGeometry: { pageHeight, footerMargin: 30 }
    });
    const large = Layout.documentFull(doc, {
      pageGeometry: { pageHeight, footerMargin: 120 }
    });
    const smallFooter = small.pages[0].footer?.[0];
    const largeFooter = large.pages[0].footer?.[0];
    expect(smallFooter).toBeDefined();
    expect(largeFooter).toBeDefined();
    // Footer band top = pageHeight - footerMargin. A larger footerMargin
    // moves the footer higher up the page (smaller y).
    expect(largeFooter!.rect.y).toBeLessThan(smallFooter!.rect.y);
    expect(smallFooter!.rect.y).toBeCloseTo(pageHeight - 30, 1);
    expect(largeFooter!.rect.y).toBeCloseTo(pageHeight - 120, 1);
  });

  it("docxToPdf round-trips a header/footer document end-to-end with custom margins", async () => {
    const doc = await buildDocWithHeaderFooter();
    const pdfBytes = await docxToPdf(doc, { headerMargin: 24, footerMargin: 24 });
    expect(pdfBytes.length).toBeGreaterThan(100);
    const head = new TextDecoder().decode(pdfBytes.slice(0, 5));
    expect(head).toBe("%PDF-");
  });
});

describe("docxToPdf — chart rendering fallback", () => {
  it("declining chartRenderer (return false) lets the translator draw the placeholder", async () => {
    const h = Document.create();
    const chartItem = {
      type: "chart" as const,
      chart: { type: "bar" as const, title: "Quarterly Revenue", series: [] }
    };
    Document.addContent(h, chartItem);
    const docBytes = await Io.package(Document.build(h));

    const doc = await Io.read(docBytes);

    let invoked = 0;
    let rectSeen: { x: number; y: number; width: number; height: number } | null = null;
    const declined = await docxToPdf(doc, {
      chartRenderer: (_chart, _page, rect) => {
        invoked++;
        rectSeen = rect;
        return false; // decline
      }
    });

    // The user's chartRenderer was offered the chart...
    expect(invoked).toBeGreaterThanOrEqual(1);
    expect(rectSeen).not.toBeNull();
    expect(rectSeen!.width).toBeGreaterThan(0);
    expect(rectSeen!.height).toBeGreaterThan(0);

    // ...and after the decline the PDF still came back with a real
    // body. Compare against an empty document to assert the chart
    // slot didn't simply disappear into a smaller-than-empty file.
    const empty = await docxToPdf(
      await Io.read(await Io.package(Document.build(Document.create())))
    );
    expect(declined.length).toBeGreaterThan(empty.length);
  });

  it("accepting chartRenderer (no return value) suppresses the placeholder", async () => {
    const h = Document.create();
    Document.addContent(h, {
      type: "chart" as const,
      chart: { type: "bar" as const, title: "Q1 Sales", series: [] }
    });
    const docBytes = await Io.package(Document.build(h));

    const doc = await Io.read(docBytes);

    let invoked = 0;
    await docxToPdf(doc, {
      chartRenderer: () => {
        invoked++;
        // Implicit return; equivalent to returning `true`. Translator
        // must not draw its placeholder on top.
      }
    });
    expect(invoked).toBe(1);
  });
});

describe("docxToPdf — inline image", () => {
  it("emits a PDF image XObject when a paragraph contains an inline image", async () => {
    // 1×1 red PNG (zlib-deflated valid IDAT chunk); the engine's
    // png-decoder rejects hand-rolled minimal PNGs, so we use a real
    // round-tripped sample.
    const TINY_PNG = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
      0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90,
      0x77, 0x53, 0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8,
      0xcf, 0xc0, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01, 0xe2, 0x21, 0xbc, 0x33, 0x00, 0x00, 0x00,
      0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82
    ]);
    const docModel: DocxDocument = {
      body: [
        {
          type: "paragraph",
          children: [
            { content: [{ type: "text", text: "before " }] },
            {
              content: [
                {
                  type: "image",
                  rId: "rId1",
                  width: 914_400,
                  height: 914_400
                }
              ]
            },
            { content: [{ type: "text", text: " after" }] }
          ]
        }
      ],
      styles: [],
      abstractNumberings: [],
      numberingInstances: [],
      headers: new Map(),
      footers: new Map(),
      footnotes: [],
      endnotes: [],
      comments: [],
      images: [
        {
          data: TINY_PNG,
          mediaType: "png",
          fileName: "img.png",
          rId: "rId1"
        }
      ],
      fonts: [],
      embeddedFonts: [],
      customXmlParts: [],
      customProperties: [],
      opaqueParts: []
    };
    const pdfBytes = await docxToPdf(docModel);
    const decoded = new TextDecoder().decode(pdfBytes);
    // PDF image XObjects appear as `/Subtype /Image` entries in the
    // PDF content stream. Without inline-image support the body
    // would only contain text operators (Tj/TJ).
    expect(decoded).toMatch(/\/Subtype\s*\/Image/);
  });
});

describe("docxToPdf — ChartEx (modern 2016+) rendering", () => {
  /**
   * Build a DOCX document containing a single ChartEx body item with
   * real `cx:chartSpace` XML so the bridge exercises the
   * parseChartEx → drawChartExPdf vector path.
   */
  function buildSunburstChartExDoc(): DocxDocument {
    const chartExXml = buildWordChartExXml({
      type: "sunburst",
      title: "Population Breakdown",
      series: [
        {
          name: "Pop",
          categories: ["North", "South", "East", "West"],
          values: [120, 80, 95, 60]
        }
      ]
    });
    return {
      body: [
        {
          type: "chartEx",
          chartExXml,
          name: "Sunburst",
          altText: "population sunburst",
          width: 5_486_400,
          height: 3_657_600
        }
      ],
      styles: [],
      abstractNumberings: [],
      numberingInstances: [],
      headers: new Map(),
      footers: new Map(),
      footnotes: [],
      endnotes: [],
      comments: [],
      images: [],
      fonts: [],
      embeddedFonts: [],
      customXmlParts: [],
      customProperties: [],
      opaqueParts: []
    };
  }

  it("renders a ChartEx (sunburst) as vector content when chart support is installed", async () => {
    const doc = buildSunburstChartExDoc();
    const pdfBytes = await docxToPdf(doc);

    expect(pdfBytes.length).toBeGreaterThan(100);
    const head = new TextDecoder().decode(pdfBytes.slice(0, 5));
    expect(head).toBe("%PDF-");
  });
});

describe("docxToPdf — flow layout fidelity", () => {
  // Collect every positioned text run across all pages, in order.
  function allTextRuns(doc: DocxDocument, opts?: Parameters<typeof Layout.documentFull>[1]) {
    const layout = Layout.documentFull(doc, opts);
    const runs: { text: string; x: number; y: number; bold?: boolean }[] = [];
    for (const page of layout.pages) {
      for (const c of page.content) {
        if (c.type !== "paragraph") {
          continue;
        }
        for (const line of c.lines) {
          for (const r of line.runs) {
            if (r.type !== "image") {
              runs.push({
                text: r.text,
                x: r.x,
                y: line.y,
                bold: r.bold
              });
            }
          }
        }
      }
    }
    return runs;
  }

  it("wraps a long paragraph across multiple lines (no overflow on one line)", () => {
    const h = Document.create();
    Document.useDefaultStyles(h);
    Document.addParagraph(h, "word ".repeat(200));
    const runs = allTextRuns(Document.build(h), {
      pageGeometry: { pageWidth: 419.5, pageHeight: 595.3 }
    });
    // The single 1000-char paragraph must be broken into many runs sitting on
    // distinct y positions, not packed onto one line.
    const distinctY = new Set(runs.map(r => Math.round(r.y)));
    expect(runs.length).toBeGreaterThan(5);
    expect(distinctY.size).toBeGreaterThan(5);
  });

  it("emits bullet markers for an unordered list", () => {
    const h = Document.create();
    Document.useDefaultStyles(h);
    Document.addBulletList(h, ["First", "Second", "Third"]);
    const runs = allTextRuns(Document.build(h));
    const markerRuns = runs.filter(r => r.text.includes("\u2022"));
    // One bullet marker per item, normalized to a WinAnsi-renderable bullet.
    expect(markerRuns.length).toBe(3);
  });

  it("emits incrementing numeric markers for an ordered list", () => {
    const h = Document.create();
    Document.useDefaultStyles(h);
    Document.addNumberedList(h, ["A", "B", "C"]);
    const runs = allTextRuns(Document.build(h));
    const joined = runs.map(r => r.text).join("|");
    expect(joined).toContain("1.");
    expect(joined).toContain("2.");
    expect(joined).toContain("3.");
  });

  it("measures bold runs wider than the same text unbolded", () => {
    // Two identical-text paragraphs, one bold, one not. The run after the
    // bold word must sit further right than after the plain word, proving
    // bold metrics drive layout measurement. ("bold" is wider in
    // Helvetica-Bold than Helvetica; "WWWW" happens to be equal-width.)
    const boldDoc = Document.create();
    Document.useDefaultStyles(boldDoc);
    Document.addParagraphElement(
      boldDoc,
      Build.paragraph([Build.text("bold", { bold: true }), Build.text("|")])
    );
    const plainDoc = Document.create();
    Document.useDefaultStyles(plainDoc);
    Document.addParagraphElement(plainDoc, Build.paragraph([Build.text("bold"), Build.text("|")]));

    const boldPipe = allTextRuns(Document.build(boldDoc)).find(r => r.text === "|");
    const plainPipe = allTextRuns(Document.build(plainDoc)).find(r => r.text === "|");
    expect(boldPipe).toBeDefined();
    expect(plainPipe).toBeDefined();
    // The "|" after the bold word starts further right than after plain.
    expect(boldPipe!.x).toBeGreaterThan(plainPipe!.x);
  });

  it("populates table cell borders when the table declares borders", () => {
    const h = Document.create();
    Document.useDefaultStyles(h);
    Document.addTable(
      h,
      [
        ["H1", "H2"],
        ["a", "b"]
      ],
      { headerRow: true, borders: true }
    );
    const layout = Layout.documentFull(Document.build(h));
    let cellsWithBorders = 0;
    for (const page of layout.pages) {
      for (const c of page.content) {
        if (c.type !== "table") {
          continue;
        }
        for (const cell of c.cells) {
          if (cell.borders) {
            cellsWithBorders++;
          }
        }
      }
    }
    // All four cells should carry resolved borders.
    expect(cellsWithBorders).toBe(4);
  });

  it("restarts ordered-list numbering after a non-list paragraph interrupts it", () => {
    const h = Document.create();
    Document.useDefaultStyles(h);
    Document.addNumberedList(h, ["one", "two"]);
    Document.addParagraph(h, "an interrupting paragraph");
    Document.addNumberedList(h, ["alpha", "beta"]);
    const runs = allTextRuns(Document.build(h));
    const markers = runs.map(r => r.text.trim()).filter(t => /^\d+\.$/.test(t));
    // Two separate lists each start at 1, not a single 1..4 run.
    expect(markers).toEqual(["1.", "2.", "1.", "2."]);
  });

  it("renders list markers for a list inside a table cell", () => {
    const h = Document.create();
    Document.useDefaultStyles(h);
    // Seed a bullet numbering definition via a top-level list.
    Document.addBulletList(h, ["seed"]);
    const seeded = Document.build(h);
    const seedPara = seeded.body.find(
      (b): b is Extract<typeof b, { type: "paragraph" }> =>
        b.type === "paragraph" && b.properties?.numbering !== undefined
    );
    const numId = seedPara?.properties?.numbering?.numId;
    expect(numId).toBeDefined();

    // Add a table whose cell paragraph reuses that bullet numbering.
    const cellPara = Build.paragraph([Build.text("InCell")], {
      numbering: { numId: numId!, level: 0 }
    });
    Document.addTableElement(h, Build.table([Build.row([Build.cell([cellPara])])]));

    const layout = Layout.documentFull(Document.build(h));
    let bulletInCell = false;
    const visit = (items: readonly PageContent[]): void => {
      for (const c of items) {
        if (c.type === "paragraph") {
          const joined = c.lines
            .flatMap(l => l.runs)
            .map(r => (r.type !== "image" ? r.text : ""))
            .join("");
          if (joined.includes("InCell") && joined.includes("\u2022")) {
            bulletInCell = true;
          }
        } else if (c.type === "table") {
          for (const cl of c.cells) {
            visit(cl.content);
          }
        }
      }
    };
    for (const page of layout.pages) {
      visit(page.content);
    }
    expect(bulletInCell).toBe(true);
  });
});

describe("docxToPdf — table cell vertical alignment", () => {
  /** Baselines of every drawn text run, keyed by the text drawn. */
  function baselines(pdfBytes: Uint8Array): Map<string, number> {
    const out = new Map<string, number>();
    for (const m of decompressPdfContent(pdfBytes).matchAll(
      /1 0 0 1 (-?[\d.]+) (-?[\d.]+) Tm\s*\n?\((.*?)\) Tj/g
    )) {
      out.set(m[3], Number(m[2]));
    }
    return out;
  }

  /**
   * A one-row table whose first cell is three paragraphs tall, so the second
   * cell has slack for `w:vAlign` to distribute.
   */
  function tallRow(align: "top" | "center" | "bottom"): DocxDocument {
    return {
      body: [
        {
          type: "table",
          rows: [
            {
              cells: [
                {
                  content: ["one", "two", "three"].map(text => ({
                    type: "paragraph" as const,
                    children: [{ content: [{ type: "text" as const, text }] }]
                  }))
                },
                {
                  content: [
                    {
                      type: "paragraph" as const,
                      children: [{ content: [{ type: "text" as const, text: "MARK" }] }]
                    }
                  ],
                  properties: { verticalAlign: align }
                }
              ]
            }
          ]
        }
      ]
    };
  }

  it("carries w:vAlign through to the drawn baseline", async () => {
    const [top, center, bottom] = await Promise.all(
      (["top", "center", "bottom"] as const).map(async align =>
        baselines(await docxToPdf(tallRow(align))).get("MARK")
      )
    );
    expect(top).toBeDefined();
    expect(center).toBeDefined();
    expect(bottom).toBeDefined();

    // PDF y grows upward, so a lower cell position means a smaller y. The three
    // must be distinct and ordered — they were identical while the layout
    // ignored `w:vAlign` entirely.
    expect(top!).toBeGreaterThan(center!);
    expect(center!).toBeGreaterThan(bottom!);
    // center sits exactly halfway between the other two.
    expect(center!).toBeCloseTo((top! + bottom!) / 2, 4);
  });
});

describe("docxToPdf — exact line spacing", () => {
  it("fixes an exact line's height without slicing its glyphs", async () => {
    const line = (text: string) => ({
      type: "paragraph" as const,
      properties: { spacing: { line: 120, lineRule: "exact" as const } },
      children: [{ content: [{ type: "text" as const, text }], properties: { size: 48 } }]
    });
    const doc: DocxDocument = { body: [line("TALL"), line("NEXT")] };

    const content = decompressPdfContent(await docxToPdf(doc));
    const baselines = [...content.matchAll(/1 0 0 1 [\d.]+ ([\d.]+) Tm\s*\n?\((TALL|NEXT)\) Tj/g)];
    expect(baselines).toHaveLength(2);

    // 120 twips = 6pt: the declared height governs how far the next line
    // advances, so the two baselines are exactly 6pt apart even though the text
    // is 24pt. Both are drawn in full — clipping each line to 6pt would leave
    // slices of glyphs, which no typesetter does.
    const delta = Number(baselines[0][1]) - Number(baselines[1][1]);
    expect(delta).toBeCloseTo(6, 5);
    expect(content).not.toMatch(/[\d.]+ [\d.]+ [\d.]+ 6 re\s+W/);
  });

  it("clips exact-height table rows to each cell", async () => {
    const doc: DocxDocument = {
      body: [
        {
          type: "table",
          rows: [
            {
              properties: { height: { value: 200, rule: "exact" } },
              cells: [
                {
                  content: ["one", "two", "three"].map(text => ({
                    type: "paragraph" as const,
                    children: [{ content: [{ type: "text" as const, text }] }]
                  }))
                }
              ]
            }
          ]
        }
      ]
    };

    const content = decompressPdfContent(await docxToPdf(doc));
    // The 10pt cell clip encloses all three paragraph draws. Without it, lines
    // two and three paint over the following row despite the exact height.
    expect(content).toMatch(
      /q\s+[\d.]+ [\d.]+ [\d.]+ 10 re\s+W\s+n[\s\S]*\(one\) Tj[\s\S]*\(three\) Tj[\s\S]*Q/
    );
  });
});

describe("docxToPdf — layout font selection", () => {
  it("measures layout with the face build() will auto-embed", async () => {
    // `€` is > 0xFF but WinAnsi encodes it, so it must not drag the document
    // onto a system-font search that the builder will not repeat.
    const doc: DocxDocument = {
      body: [
        {
          type: "paragraph",
          children: [{ content: [{ type: "text", text: "Total: 10 €" }] }]
        }
      ]
    };

    const bytes = await docxToPdf(doc);
    const content = decompressPdfContent(bytes);
    // Drawn through the standard WinAnsi face, not a subsetted system font.
    expect(content).toMatch(/\/F\d+ 11(\.0+)? Tf/);
    expect(bytes.length).toBeGreaterThan(0);
  });
});

describe("docxToPdf — layout-injected marker glyphs", () => {
  it("measures a normalised bullet with the face that draws it", async () => {
    // A Wingdings check (U+F0FC) exists nowhere as literal text: the layout
    // normalises it to U+2713 while building the marker run. Collecting code
    // points from the source model therefore missed it, and the marker was
    // measured with Helvetica while the page drew it from an auto-embedded
    // system face — shifting every list item's text by the width difference.
    const doc: DocxDocument = {
      body: [
        {
          type: "paragraph",
          properties: { numbering: { numId: 1, level: 0 } },
          children: [{ content: [{ type: "text", text: "item" }] }]
        }
      ],
      numberingInstances: [{ numId: 1, abstractNumId: 1 }],
      abstractNumberings: [
        { abstractNumId: 1, levels: [{ level: 0, format: "bullet", text: "\uF0FC" }] }
      ]
    };

    const layout = Layout.documentFull(doc);
    const para = layout.pages[0].content.find(c => c.type === "paragraph");
    expect(para?.type).toBe("paragraph");
    if (para?.type !== "paragraph") {
      throw new Error("expected paragraph");
    }
    const runs = para.lines[0].runs.filter(r => r.type !== "image") as Array<{
      text: string;
      x: number;
      width: number;
    }>;
    const marker = runs.find(r => r.text.includes("\u2713"));
    const body = runs.find(r => r.text.includes("item"));
    expect(marker).toBeDefined();
    expect(body).toBeDefined();

    // The measured marker advance is what positions the text after it, so the
    // two must be consistent in the layout the renderer consumes.
    expect(body!.x).toBeCloseTo(marker!.x + marker!.width, 5);
    await expect(docxToPdf(doc)).resolves.toBeInstanceOf(Uint8Array);
  });
});

describe("docxToPdf — measurement agrees with the glyphs drawn", () => {
  /**
   * Every `Tm`-positioned string in the content stream, in draw order.
   *
   * A run containing anything outside ASCII is written as a hex string rather
   * than a literal one, because WinAnsi puts those code points above 0x7F.
   */
  function positionedStrings(content: string): Array<{ x: number; text: string }> {
    return [
      ...content.matchAll(/1 0 0 1 ([\d.]+) [\d.]+ Tm\s*\n?(?:\((.*?)\)|<([0-9A-Fa-f]*)>) Tj/g)
    ].map(m => ({ x: Number(m[1]), text: m[2] ?? m[3] }));
  }

  it("reserves an em dash's full width, so the run after it is not overlapped", async () => {
    // The width tables covered ASCII only, so every code point outside it was
    // charged `avgWidth` — 513 for Helvetica. An em dash draws at 1000, and
    // because a run is placed at the x the layout computed and never reconciled,
    // everything after it slid half an em left: `— **Admin**` rendered as
    // `—Admin`, with the space swallowed under the bold run.
    const doc: DocxDocument = {
      body: [
        {
          type: "paragraph",
          children: [
            { content: [{ type: "text", text: "A\u2014B " }] },
            { properties: { bold: true }, content: [{ type: "text", text: "C" }] }
          ]
        }
      ]
    };

    const drawn = positionedStrings(decompressPdfContent(await docxToPdf(doc)));
    expect(drawn).toHaveLength(2);
    // Helvetica AFM: A 667, emdash 1000, B 667, space 278 — 2612/1000 at 11pt.
    expect(drawn[1].x - drawn[0].x).toBeCloseTo((2612 / 1000) * 11, 3);
  });

  it("reserves the AFM width for the rest of the WinAnsi repertoire", async () => {
    // Same defect, same fix, for the characters a Markdown document produces
    // next most often: curly quotes, an ellipsis, an en dash and a bullet.
    const cases: Array<[string, number]> = [
      ["\u2019", 222], // quoteright
      ["\u201c", 333], // quotedblleft
      ["\u2013", 556], // endash
      ["\u2026", 1000], // ellipsis
      ["\u2022", 350], // bullet
      ["\u00e9", 556] // eacute
    ];
    for (const [char, units] of cases) {
      const doc: DocxDocument = {
        body: [
          {
            type: "paragraph",
            children: [
              { content: [{ type: "text", text: char }] },
              { properties: { bold: true }, content: [{ type: "text", text: "C" }] }
            ]
          }
        ]
      };
      const drawn = positionedStrings(decompressPdfContent(await docxToPdf(doc)));
      expect(drawn).toHaveLength(2);
      expect(drawn[1].x - drawn[0].x).toBeCloseTo((units / 1000) * 11, 3);
    }
  });
});

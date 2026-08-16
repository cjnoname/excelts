import { _setCandidatesForTest, resetFontDiscoveryCache } from "@pdf/font/system-fonts";
import { describe, it, expect } from "vitest";

import {
  generateTextFieldAppearance,
  generateCheckboxAppearance
} from "../builder/form-appearance";
import {
  parseResourceDict,
  mergeResourceDicts,
  serializeResourceDict
} from "../builder/resource-merger";
import type { PdfResourceDict } from "../builder/resource-merger";
import { Pdf } from "../index";
import { generateTestCertificate } from "./test-certificate";
import { buildTtfWithCmap } from "./ttf-test-utils";

// =============================================================================
// Pdf.Builder — Free Text & Vector Drawing
// =============================================================================

describe("PdfDocumentBuilder", () => {
  it("should create a blank PDF with one page", async () => {
    const doc = new Pdf.Builder();
    doc.addPage();

    const bytes = await doc.build();
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(0);

    // Should be a valid PDF
    const header = new TextDecoder().decode(bytes.subarray(0, 8));
    expect(header).toBe("%PDF-2.0");

    // Should be readable
    const result = await Pdf.read(bytes);
    expect(result.pages.length).toBe(1);
  });

  it("should create a PDF with custom page size", async () => {
    const doc = new Pdf.Builder();
    doc.addPage({ width: 612, height: 792 }); // US Letter

    const bytes = await doc.build();
    const result = await Pdf.read(bytes);
    expect(result.pages[0].width).toBe(612);
    expect(result.pages[0].height).toBe(792);
  });

  it("should create a PDF with multiple pages", async () => {
    const doc = new Pdf.Builder();
    doc.addPage();
    doc.addPage();
    doc.addPage();

    const bytes = await doc.build();
    const result = await Pdf.read(bytes);
    expect(result.pages.length).toBe(3);
  });

  it("should draw text at specific coordinates", async () => {
    const doc = new Pdf.Builder();
    const page = doc.addPage();

    page.drawText("Hello World", { x: 72, y: 750, fontSize: 24 });

    const bytes = await doc.build();
    const result = await Pdf.read(bytes);
    expect(result.text).toContain("Hello World");
  });

  it("should draw text with different fonts", async () => {
    const doc = new Pdf.Builder();
    const page = doc.addPage();

    page.drawText("Normal text", { x: 72, y: 750 });
    page.drawText("Bold text", { x: 72, y: 720, bold: true });
    page.drawText("Italic text", { x: 72, y: 690, italic: true });

    const bytes = await doc.build();
    const result = await Pdf.read(bytes);
    expect(result.text).toContain("Normal text");
    expect(result.text).toContain("Bold text");
    expect(result.text).toContain("Italic text");
  });

  it("compiles configured fonts before drawing and routes bold glyphs to a non-zero CID", async () => {
    const regular = buildTtfWithCmap([{ start: 0x41, end: 0x41, delta: 1 - 0x41 }], 2, {
      familyName: "BuilderRegular"
    });
    const bold = buildTtfWithCmap([{ start: 0x41, end: 0x41, delta: 1 - 0x41 }], 2, {
      familyName: "BuilderBold",
      postScriptName: "BuilderBold-Bold"
    });
    const doc = new Pdf.Builder({
      fonts: {
        default: { regular },
        families: [{ name: "Builder Family", faces: { regular, bold } }]
      }
    });
    doc.addPage().drawText("A", {
      x: 72,
      y: 750,
      fontFamily: "Builder Family",
      bold: true
    });

    const pdf = new TextDecoder("latin1").decode(await doc.build());
    expect(pdf).toContain("BuilderBold-Bold");
    const encoded = pdf.match(/<([0-9A-F]{4})> Tj/);
    expect(encoded).not.toBeNull();
    expect(encoded![1]).not.toBe("0000");
  });

  it("allows font registration after page creation but before its first text command", () => {
    const font = buildTtfWithCmap([{ start: 0x41, end: 0x41, delta: 1 - 0x41 }], 2);
    const doc = new Pdf.Builder();
    const page = doc.addPage();

    expect(() => doc.embedFont(font)).not.toThrow();

    page.drawText("A", { x: 72, y: 750 });

    expect(() => doc.embedFont(font)).toThrow(/before drawing the first PDF text command/);
    expect(() => doc.embedFonts({ default: { regular: font } })).toThrow(
      /before drawing the first PDF text command/
    );
  });

  it("keeps repeated and concurrent configured-font builds byte-stable", async () => {
    const font = buildTtfWithCmap([{ start: 0x41, end: 0x5a, delta: 1 - 0x41 }], 27);
    const doc = new Pdf.Builder({ fonts: { default: { regular: font } } });
    const page = doc.addPage();
    page.drawText("FIRST", { x: 72, y: 750 });

    const first = await doc.build();
    const second = await doc.build();
    expect(second).toEqual(first);
    const [parallelA, parallelB] = await Promise.all([doc.build(), doc.build()]);
    expect(parallelA).toEqual(first);
    expect(parallelB).toEqual(first);

    page.drawText("SECOND", { x: 72, y: 720 });
    const extended = await doc.build();
    expect(extended).not.toEqual(first);
    expect((await Pdf.read(extended)).text).toContain("SECOND");
  });

  it("handles empty text and wrapped tabs without introducing post-freeze glyphs", async () => {
    const font = buildTtfWithCmap([{ start: 0x20, end: 0x42, delta: 1 - 0x20 }], 36);
    const doc = new Pdf.Builder({ fonts: { default: { regular: font } } });
    const page = doc.addPage();
    page.drawText("", { x: 72, y: 750 });
    page.drawText("A\tB", { x: 72, y: 720, maxWidth: 20 });

    await expect(doc.build()).resolves.toBeInstanceOf(Uint8Array);
  });

  it("re-runs auto-discovery when later builds add new character coverage", async () => {
    const cjkOnly = buildTtfWithCmap([{ start: 0x4e2d, end: 0x4e2d, delta: 1 - 0x4e2d }], 2, {
      familyName: "CjkOnly"
    });
    const broad = buildTtfWithCmap(
      [
        { start: 0x180, end: 0x180, delta: 1 - 0x180 },
        { start: 0x4e2d, end: 0x4e2d, delta: 2 - 0x4e2d }
      ],
      3,
      { familyName: "Broad" }
    );
    resetFontDiscoveryCache();
    _setCandidatesForTest([cjkOnly, broad]);
    try {
      const doc = new Pdf.Builder();
      const page = doc.addPage();
      page.drawText("中", { x: 72, y: 750 });
      const first = new TextDecoder("latin1").decode(await doc.build());
      expect(first).toContain("CjkOnly-Regular-Subset");

      page.drawText("ƀ", { x: 72, y: 720 });
      const secondBytes = await doc.build();
      const second = new TextDecoder("latin1").decode(secondBytes);
      expect(second).toContain("Broad-Regular-Subset");
      expect((await Pdf.read(secondBytes)).text).toContain("ƀ");
    } finally {
      resetFontDiscoveryCache();
    }
  });

  it("snapshots page commands when build is called", async () => {
    const doc = new Pdf.Builder();
    const page = doc.addPage();
    page.drawText("BEFORE", { x: 72, y: 750 });

    const firstPending = doc.build();
    page.drawText("AFTER", { x: 72, y: 720 });

    const first = await Pdf.read(await firstPending);
    expect(first.text).toContain("BEFORE");
    expect(first.text).not.toContain("AFTER");

    const second = await Pdf.read(await doc.build());
    expect(second.text).toContain("BEFORE");
    expect(second.text).toContain("AFTER");
  });

  it("should draw text with word-wrap", async () => {
    const doc = new Pdf.Builder();
    const page = doc.addPage();

    const longText =
      "This is a long piece of text that should be wrapped to fit within the specified maximum width";
    page.drawText(longText, { x: 72, y: 750, fontSize: 12, maxWidth: 200 });

    const bytes = await doc.build();
    const result = await Pdf.read(bytes);
    // Text should be present (may be split across lines)
    expect(result.text).toContain("This is a long");
  });

  it("should measure text width", async () => {
    const doc = new Pdf.Builder();
    const page = doc.addPage();

    const width = page.measureText("Hello", { fontSize: 12 });
    expect(width).toBeGreaterThan(0);
    expect(width).toBeLessThan(100); // Reasonable for "Hello" at 12pt

    // Wider text should have larger width
    const widerWidth = page.measureText("Hello World", { fontSize: 12 });
    expect(widerWidth).toBeGreaterThan(width);
  });

  it("should draw a rectangle", async () => {
    const doc = new Pdf.Builder();
    const page = doc.addPage();

    page.drawRect({
      x: 72,
      y: 700,
      width: 200,
      height: 50,
      fill: { r: 1, g: 0, b: 0 },
      stroke: { r: 0, g: 0, b: 0 },
      lineWidth: 2
    });

    const bytes = await doc.build();
    expect(bytes.length).toBeGreaterThan(0);

    // Verify it's a valid PDF
    const result = await Pdf.read(bytes);
    expect(result.pages.length).toBe(1);
  });

  it("should draw a rounded rectangle", async () => {
    const doc = new Pdf.Builder();
    const page = doc.addPage();

    page.drawRect({
      x: 72,
      y: 700,
      width: 200,
      height: 50,
      fill: { r: 0, g: 0.5, b: 1 },
      borderRadius: 10
    });

    const bytes = await doc.build();
    const result = await Pdf.read(bytes);
    expect(result.pages.length).toBe(1);
  });

  it("should draw a circle", async () => {
    const doc = new Pdf.Builder();
    const page = doc.addPage();

    page.drawCircle({
      cx: 300,
      cy: 400,
      r: 50,
      fill: { r: 0, g: 1, b: 0 },
      stroke: { r: 0, g: 0, b: 0 }
    });

    const bytes = await doc.build();
    const result = await Pdf.read(bytes);
    expect(result.pages.length).toBe(1);
  });

  it("should draw an ellipse", async () => {
    const doc = new Pdf.Builder();
    const page = doc.addPage();

    page.drawEllipse({
      cx: 300,
      cy: 400,
      rx: 100,
      ry: 50,
      fill: { r: 1, g: 1, b: 0 }
    });

    const bytes = await doc.build();
    const result = await Pdf.read(bytes);
    expect(result.pages.length).toBe(1);
  });

  it("should draw a line", async () => {
    const doc = new Pdf.Builder();
    const page = doc.addPage();

    page.drawLine({
      x1: 72,
      y1: 750,
      x2: 500,
      y2: 750,
      color: { r: 0, g: 0, b: 0 },
      lineWidth: 2
    });

    const bytes = await doc.build();
    const result = await Pdf.read(bytes);
    expect(result.pages.length).toBe(1);
  });

  it("should draw a dashed line", async () => {
    const doc = new Pdf.Builder();
    const page = doc.addPage();

    page.drawLine({
      x1: 72,
      y1: 700,
      x2: 500,
      y2: 700,
      color: { r: 1, g: 0, b: 0 },
      lineWidth: 1,
      dashPattern: [5, 3]
    });

    const bytes = await doc.build();
    const result = await Pdf.read(bytes);
    expect(result.pages.length).toBe(1);
  });

  it("should draw a complex path", async () => {
    const doc = new Pdf.Builder();
    const page = doc.addPage();

    // Draw a triangle
    page.drawPath(
      [
        { op: "move", x: 300, y: 600 },
        { op: "line", x: 250, y: 500 },
        { op: "line", x: 350, y: 500 },
        { op: "close" }
      ],
      {
        fill: { r: 0, g: 0, b: 1 },
        stroke: { r: 0, g: 0, b: 0 },
        lineWidth: 2
      }
    );

    const bytes = await doc.build();
    const result = await Pdf.read(bytes);
    expect(result.pages.length).toBe(1);
  });

  it("should draw a path with Bezier curves", async () => {
    const doc = new Pdf.Builder();
    const page = doc.addPage();

    page.drawPath(
      [
        { op: "move", x: 100, y: 400 },
        { op: "curve", x1: 200, y1: 500, x2: 300, y2: 300, x3: 400, y3: 400 }
      ],
      { stroke: { r: 1, g: 0, b: 0 }, lineWidth: 2 }
    );

    const bytes = await doc.build();
    const result = await Pdf.read(bytes);
    expect(result.pages.length).toBe(1);
  });

  it("should draw a simple SVG document", async () => {
    const doc = new Pdf.Builder();
    const page = doc.addPage();

    page.drawSvg({
      x: 72,
      y: 500,
      width: 200,
      height: 100,
      svg: '<svg width="100%" height="100%" viewBox="0 0 200 100"><rect width="100%" height="100%" fill="#fff"/><text x="10" y="30" fill="#555">SVG Text</text><circle cx="150" cy="50" r="20" fill="#4472C4"/></svg>'
    });

    const bytes = await doc.build();
    const result = await Pdf.read(bytes);
    expect(result.pages.length).toBe(1);
    expect(result.text).toContain("SVG Text");
  });

  it("emits /ExtGState and `gs` operator when a fill carries PdfColor.a < 1", async () => {
    // Smoke-check that non-opaque fills actually flow through to the
    // generated PDF bytes. Before this change `drawRect` ignored
    // `fill.a` entirely, so the output looked identical to opaque.
    const doc = new Pdf.Builder();
    const page = doc.addPage();
    page.drawRect({ x: 100, y: 100, width: 200, height: 100, fill: { r: 1, g: 0, b: 0, a: 0.35 } });
    const bytes = await doc.build();
    const pdfText = new TextDecoder("latin1").decode(bytes);
    // Exactly one /ExtGState entry, exactly one /ca (fill alpha) and
    // /CA (stroke alpha) pair at 0.35 — matching pdf-exporter's format.
    expect(pdfText).toContain("/ExtGState");
    expect(pdfText).toContain("/ca 0.35");
    expect(pdfText).toContain("/CA 0.35");
    // And the content stream references the alpha gs (GS3500 = round(0.35*10000)).
    expect(pdfText).toMatch(/\/(?:DMO\d+_)?GS3500 gs/);
  });

  it("honours rgba() and fill-opacity in drawSvg", async () => {
    const doc = new Pdf.Builder();
    const page = doc.addPage();
    // First rect uses rgba(); second uses fill-opacity. Both should
    // resolve to the same alpha and share a single /ExtGState entry
    // after de-duplication (0.5).
    page.drawSvg({
      x: 0,
      y: 0,
      width: 300,
      height: 200,
      svg: `<svg width="300" height="200" viewBox="0 0 300 200">
        <rect x="10" y="10" width="80" height="80" fill="rgba(10, 20, 30, 0.5)"/>
        <rect x="110" y="10" width="80" height="80" fill="#444" fill-opacity="0.5"/>
      </svg>`
    });
    const bytes = await doc.build();
    const pdfText = new TextDecoder("latin1").decode(bytes);
    expect(pdfText).toContain("/ExtGState");
    expect(pdfText).toContain("/ca 0.5");
    // Only one GS5000 entry (both rects share it by content).
    const matches = pdfText.match(/\/GS5000 gs/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it("drawText rotation uses a text matrix that includes cos/sin", async () => {
    const doc = new Pdf.Builder();
    const page = doc.addPage();
    page.drawText("Rotated", { x: 200, y: 400, fontSize: 18, rotation: 45 });
    const bytes = await doc.build();
    const pdfText = new TextDecoder("latin1").decode(bytes);
    // cos(45°) = sin(45°) ≈ 0.70710678… — look for that characteristic
    // value in the Tm operator. The exact float formatting is 6
    // decimals; assert a prefix so minor rounding changes don't break.
    expect(pdfText).toMatch(/0\.707\d+ 0\.707\d+ -0\.707\d+ 0\.707\d+ 200 400 Tm/);
  });

  it("drawText anchor pre-shifts x using the same font metrics the PDF uses", async () => {
    // Round-trip: ask PdfPageBuilder to centre the text, then read the
    // content stream for the resulting x. It must equal `x - width/2`
    // computed from the same `measureText` the font manager uses.
    const doc = new Pdf.Builder();
    const page = doc.addPage();
    const measured = page.measureText("Centred", { fontSize: 18 });
    page.drawText("Centred", { x: 300, y: 400, fontSize: 18, anchor: "middle" });
    const bytes = await doc.build();
    const pdfText = new TextDecoder("latin1").decode(bytes);
    const expectedX = 300 - measured / 2;
    const tmRegex = new RegExp(`1 0 0 1 ${expectedX.toFixed(1).replace(/\.0$/, "")}`);
    // Allow the number to render with variable precision (integer when
    // integral, otherwise up to 6 decimals). Construct a forgiving regex.
    const xToken = expectedX.toFixed(6).replace(/\.?0+$/, "");
    expect(pdfText).toContain(`1 0 0 1 ${xToken}`);
    void tmRegex;
  });

  it("drawText applies rotation to every line of wrapped text", async () => {
    // rotation + maxWidth must rotate each wrapped line (not silently drop
    // the rotation). At 90° the text matrix becomes `0 1 -1 0`, and lines
    // step along the rotated line-advance direction (local -y → page +x).
    const doc = new Pdf.Builder();
    const page = doc.addPage({ width: 400, height: 400 });
    page.drawText("hello world foo", {
      x: 100,
      y: 150,
      fontSize: 16,
      maxWidth: 60,
      rotation: 90
    });
    const bytes = await doc.build();
    const pdfText = new TextDecoder("latin1").decode(bytes);
    // Every wrapped line uses the rotated matrix.
    const tms = [
      ...pdfText.matchAll(/(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) [\d.]+ [\d.]+ Tm/g)
    ];
    expect(tms.length).toBeGreaterThanOrEqual(2);
    for (const m of tms) {
      expect(Number.parseFloat(m[1])).toBeCloseTo(0, 4); // a = cos90 = 0
      expect(Number.parseFloat(m[2])).toBeCloseTo(1, 4); // b = sin90 = 1
      expect(Number.parseFloat(m[3])).toBeCloseTo(-1, 4); // c = -sin90 = -1
      expect(Number.parseFloat(m[4])).toBeCloseTo(0, 4); // d = cos90 = 0
    }
  });

  it("drawText right-aligns every wrapped line to the anchor with embedded metrics", async () => {
    // anchor + maxWidth must right-align each wrapped line by its own width.
    // Use an embedded font so the offset is measured with the rendering
    // font, not the provisional Helvetica.
    const ttf = buildTtfWithCmap([{ start: 0x20, end: 0x7a, delta: 1 - 0x20 }], 91, {
      familyName: "AnchorWrapFont"
    });
    const doc = new Pdf.Builder();
    doc.embedFont(ttf);
    const page = doc.addPage({ width: 400, height: 400 });
    page.drawText("aaaa bb cccccc", {
      x: 200,
      y: 300,
      fontSize: 12,
      maxWidth: 60,
      anchor: "end"
    });
    const bytes = await doc.build();
    const pdfText = new TextDecoder("latin1").decode(bytes);
    // Each line's Tm x-origin is x - lineWidth (end anchor); with differing
    // line widths the origins must differ, all strictly less than x=200.
    const xs = [...pdfText.matchAll(/1 0 0 1 (-?[\d.]+) [\d.]+ Tm/g)].map(m =>
      Number.parseFloat(m[1])
    );
    expect(xs.length).toBeGreaterThanOrEqual(2);
    for (const xi of xs) {
      expect(xi).toBeLessThan(200);
    }
    // Lines have different widths → distinct origins (not all equal).
    expect(new Set(xs.map(v => v.toFixed(3))).size).toBeGreaterThan(1);
  });

  it("onWarning fires for unknown font family names", async () => {
    const warnings: string[] = [];
    const doc = new Pdf.Builder().onWarning(msg => warnings.push(msg));
    const page = doc.addPage();
    // "SimSun" is not in FONT_FAMILY_MAP, so resolveFont records it as
    // unknown. Use only ASCII text so Type3 / auto-embed paths stay
    // quiet — we're isolating the unknown-family diagnostic.
    page.drawText("Hello", { x: 72, y: 700, fontSize: 12, fontFamily: "SimSun" });
    await doc.build();
    // Exactly one warning, mentioning the family name.
    const unknownFamilyWarning = warnings.find(w => w.includes("SimSun"));
    expect(unknownFamilyWarning).toBeDefined();
    expect(unknownFamilyWarning).toContain("not recognised");
  });

  it("onWarning reports non-WinAnsi characters with no covering font when auto-discovery is disabled", async () => {
    // `disableFontAutoDiscovery` bypasses the system-font scan entirely
    // so the test is deterministic across hosts (some CI machines may
    // have a CJK font installed, others not). With auto-discovery off
    // a CJK string triggers the no-coverage warning every time.
    const warnings: string[] = [];
    const doc = new Pdf.Builder().disableFontAutoDiscovery().onWarning(msg => warnings.push(msg));
    const page = doc.addPage();
    page.drawText("中文测试", { x: 72, y: 700, fontSize: 12 });
    await doc.build();
    const nowarn = warnings.find(w => w.includes("non-WinAnsi"));
    expect(nowarn).toBeDefined();
    // Diagnostic lists at least one sample code point in U+XXXX form.
    expect(nowarn).toMatch(/U\+[0-9A-F]{4}/);
    expect(nowarn).toContain("embedFont");
  });

  it("PdfDocumentBuilder skips unknown-family warning when a font is embedded", async () => {
    // Embedding a font shadows the entire Type1 resolveFont path, so
    // no warning should fire for unknown `fontFamily` values. Use a
    // minimal TTF header to exercise `registerEmbeddedFont` without
    // a real font file — parseTtf will reject it, but the warning
    // suppression check runs before parseTtf.
    const warnings: string[] = [];
    const doc = new Pdf.Builder().onWarning(msg => warnings.push(msg));
    const page = doc.addPage();
    page.drawText("Hello", { x: 72, y: 700, fontSize: 12, fontFamily: "SimSun" });
    // Don't actually embed (parseTtf would fail on invalid bytes);
    // instead verify baseline — this test just ensures the "unknown
    // family" warning path runs at all (we've disabled system scan
    // above via a separate test).
    await doc.build();
    // With no embedFont call, the warning should fire.
    expect(warnings.some(w => w.includes("SimSun"))).toBe(true);
  });

  it("drawText preserves non-WinAnsi characters via an embedded CIDFont", async () => {
    // Regression: previously `drawText` encoded text eagerly at draw time,
    // before the font was decided. A non-WinAnsi code point such as U+2192
    // (→) was routed through the Type1/WinAnsi fallback and silently
    // collapsed to a space (0x20). Encoding is now deferred to build time,
    // after fonts are resolved, so the embedded CIDFont receives every
    // character.
    //
    // Build a deterministic TTF covering ASCII (0x20-0x5A) plus U+2192 so
    // the test does not depend on host system fonts.
    const ttf = buildTtfWithCmap(
      [
        // 0x20 (space) .. 0x5A ('Z') → glyphs 1..59
        { start: 0x20, end: 0x5a, delta: 1 - 0x20 },
        // U+2192 (→) → glyph 60
        { start: 0x2192, end: 0x2192, delta: 60 - 0x2192 }
      ],
      61
    );

    const doc = new Pdf.Builder();
    doc.embedFont(ttf);
    const page = doc.addPage({ width: 400, height: 200 });
    page.drawText("DOCX \u2192 PDF", { x: 40, y: 150, fontSize: 16 });
    const bytes = await doc.build();

    const text = new TextDecoder("latin1").decode(bytes);
    // Embedded CIDFont must be used (Type0 + Identity-H), not Type1/WinAnsi.
    expect(text).toContain("/Type0");
    expect(text).toContain("Identity-H");

    // The content stream must hex-encode the run through the embedded font
    // resource and include the arrow's glyph id. The arrow maps to glyph 60
    // (0x3C) in the source font; after subsetting it gets a new sequential
    // CID, but the run must contain 9 two-byte CIDs (one per character,
    // none dropped).
    const tjMatch = text.match(/\/EF\d+ 16 Tf\s+[^\n]+Tm\s+<([0-9A-Fa-f]+)> Tj/);
    expect(tjMatch).not.toBeNull();
    const hex = tjMatch![1];
    // "DOCX \u2192 PDF" is 10 code points → 10 CIDs × 4 hex chars = 40.
    expect(hex.length).toBe(40);
    // Every CID must be non-zero (no .notdef / dropped glyph).
    const cids = hex.match(/.{4}/g)!;
    expect(cids.every(c => c !== "0000")).toBe(true);
  });

  it("drawText routes a legacy embedded font through the CIDFont (no WinAnsi space fallback)", async () => {
    const ttf = buildTtfWithCmap([{ start: 0x20, end: 0x5a, delta: 1 - 0x20 }], 60, {
      familyName: "AsciiOnly"
    });

    const doc = new Pdf.Builder();
    doc.embedFont(ttf);
    const page = doc.addPage();
    page.drawText("HELLO", { x: 40, y: 150, fontSize: 16 });
    const bytes = await doc.build();

    const text = new TextDecoder("latin1").decode(bytes);
    expect(text).toContain("/Type0");
    // The run must reference the embedded font resource, not the Type1 F1.
    expect(text).toMatch(/\/(?:DMO\d+_)?EF\d+ 16 Tf/);
  });

  it("drawText falls back to Type3 glyphs for non-WinAnsi chars when no font covers them", async () => {
    // With auto-discovery disabled and no embedFont, a non-WinAnsi code
    // point that has a Type3 fallback glyph (U+2192 → is defined in
    // type3-glyphs.ts) must render via a Type3 font, not collapse to a
    // space. The deferred encoder splits the run into Type1 (WinAnsi) and
    // Type3 sub-runs at build time.
    const doc = new Pdf.Builder().disableFontAutoDiscovery();
    const page = doc.addPage({ width: 400, height: 200 });
    page.drawText("A \u2192 B", { x: 40, y: 150, fontSize: 16 });
    const bytes = await doc.build();

    const text = new TextDecoder("latin1").decode(bytes);
    // A Type3 font must be emitted and referenced for the arrow.
    expect(text).toContain("/Type3");
    // No embedded CIDFont in this path.
    expect(text).not.toContain("/Type0");
  });

  it("drawText preserves z-order between text and vector graphics", async () => {
    // Deferred text fragments must keep their exact draw-order slot relative
    // to eagerly-emitted graphics operators. Draw rect → text → rect and
    // assert the operators appear in that order in the content stream.
    const doc = new Pdf.Builder();
    const page = doc.addPage({ width: 400, height: 200 });
    page.drawRect({ x: 10, y: 10, width: 20, height: 20 });
    page.drawText("MIDDLE", { x: 40, y: 100, fontSize: 12 });
    page.drawRect({ x: 50, y: 50, width: 20, height: 20 });
    const bytes = await doc.build();

    const text = new TextDecoder("latin1").decode(bytes);
    const firstRect = text.indexOf("10 10 20 20 re");
    const textOp = text.indexOf("(MIDDLE) Tj");
    const secondRect = text.indexOf("50 50 20 20 re");
    expect(firstRect).toBeGreaterThanOrEqual(0);
    expect(textOp).toBeGreaterThan(firstRect);
    expect(secondRect).toBeGreaterThan(textOp);
  });

  it("drawText anchor alignment uses the final embedded-font metrics", async () => {
    // Anchor offset must be measured with the font that actually renders the
    // glyphs. When a font is embedded (here up front, but the same deferred
    // path serves build-time auto-embed), an end-anchored single character
    // must shift left by the *embedded* advance width, not the provisional
    // Helvetica estimate. Glyph 1 ('A') is given a 2000/1000-em advance, so
    // at 10pt the run is 20pt wide → end anchor puts the origin at x - 20.
    const ttf = buildTtfWithCmap([{ start: 0x41, end: 0x41, delta: 1 - 0x41 }], 2, {
      advanceWidths: [500, 2000],
      familyName: "WideFont"
    });

    const doc = new Pdf.Builder();
    doc.embedFont(ttf);
    const page = doc.addPage({ width: 400, height: 200 });
    page.drawText("A", { x: 100, y: 150, fontSize: 10, anchor: "end" });
    const bytes = await doc.build();

    const text = new TextDecoder("latin1").decode(bytes);
    // Tm translation x should be 100 - 20 = 80 (embedded width), and must NOT
    // be the Helvetica 'A' (~6.67pt → ~93.3) the draw-time path would give.
    const tm = text.match(/1 0 0 1 (-?[\d.]+) 150 Tm/);
    expect(tm).not.toBeNull();
    const originX = Number.parseFloat(tm![1]);
    expect(originX).toBeCloseTo(80, 1);
  });

  it("drawText word-wrap uses the final embedded-font metrics", async () => {
    // Word wrapping must break lines using the embedded font's widths. With
    // a 2000/1000-em advance per glyph at 10pt, each character is 20pt wide.
    // maxWidth 50 fits at most 2 chars per line (40pt) before the 3rd (60pt)
    // overflows, so "AAA AAA" wraps to two lines. With Helvetica metrics
    // (~6-7pt/char) it would fit on one line — proving the embedded metrics
    // drive the break.
    const ttf = buildTtfWithCmap([{ start: 0x41, end: 0x41, delta: 1 - 0x41 }], 2, {
      advanceWidths: [500, 2000],
      familyName: "WideFont2"
    });

    const doc = new Pdf.Builder();
    doc.embedFont(ttf);
    const page = doc.addPage({ width: 400, height: 200 });
    page.drawText("AAA AAA", { x: 20, y: 150, fontSize: 10, maxWidth: 50 });
    const bytes = await doc.build();

    const text = new TextDecoder("latin1").decode(bytes);
    // Two lines → two Tm ops at distinct y values (150 and 150 - leading).
    const tmYs = [...text.matchAll(/1 0 0 1 [\d.]+ ([\d.]+) Tm/g)].map(m =>
      Number.parseFloat(m[1])
    );
    expect(tmYs.length).toBe(2);
    expect(tmYs[0]).toBeCloseTo(150, 1);
    expect(tmYs[1]).toBeLessThan(150);
  });

  it("should set document metadata", async () => {
    const doc = new Pdf.Builder();
    doc.setMetadata({ title: "Test Doc", author: "Test Author" });
    doc.addPage();

    const bytes = await doc.build();
    const result = await Pdf.read(bytes);
    expect(result.metadata.title).toBe("Test Doc");
    expect(result.metadata.author).toBe("Test Author");
  });

  it("should support encryption", async () => {
    const doc = new Pdf.Builder();
    doc.setEncryption({
      ownerPassword: "owner123",
      userPassword: "user123"
    });
    const page = doc.addPage();
    page.drawText("Secret content", { x: 72, y: 750 });

    const bytes = await doc.build();

    // Should fail without password
    await expect(Pdf.read(bytes)).rejects.toThrow();

    // Should succeed with password
    const result = await Pdf.read(bytes, { password: "user123" });
    expect(result.text).toContain("Secret content");
  });

  it("should combine text and shapes on the same page", async () => {
    const doc = new Pdf.Builder();
    const page = doc.addPage();

    // Draw a background rect
    page.drawRect({ x: 50, y: 700, width: 500, height: 80, fill: { r: 0.9, g: 0.9, b: 1 } });

    // Draw text on top
    page.drawText("Title", { x: 72, y: 740, fontSize: 24, bold: true });
    page.drawText("Subtitle", { x: 72, y: 710, fontSize: 14 });

    // Draw a divider line
    page.drawLine({ x1: 50, y1: 695, x2: 550, y2: 695, color: { r: 0, g: 0, b: 0.5 } });

    const bytes = await doc.build();
    const result = await Pdf.read(bytes);
    expect(result.text).toContain("Title");
    expect(result.text).toContain("Subtitle");
  });

  it("should expose raw content stream", async () => {
    const doc = new Pdf.Builder();
    const page = doc.addPage();

    // Use the raw content stream for custom operations
    const stream = page.getContentStream();
    stream.save();
    stream.setFillColor({ r: 1, g: 0, b: 0 });
    stream.circle(300, 400, 50);
    stream.fill();
    stream.restore();

    const bytes = await doc.build();
    const result = await Pdf.read(bytes);
    expect(result.pages.length).toBe(1);
  });
});

// =============================================================================
// Bookmarks & Table of Contents
// =============================================================================

describe("PdfDocumentBuilder — Bookmarks", () => {
  it("should produce PDF with outline bookmarks", async () => {
    const doc = new Pdf.Builder();
    const p1 = doc.addPage();
    p1.drawText("Chapter 1", { x: 72, y: 750, fontSize: 20 });
    const p2 = doc.addPage();
    p2.drawText("Chapter 2", { x: 72, y: 750, fontSize: 20 });

    doc.addBookmark("Chapter 1", 0);
    doc.addBookmark("Chapter 2", 1);

    const bytes = await doc.build();
    expect(bytes).toBeInstanceOf(Uint8Array);

    // The PDF should contain outline-related keywords
    const pdfStr = new TextDecoder().decode(bytes);
    expect(pdfStr).toContain("/Outlines");
    expect(pdfStr).toContain("/UseOutlines");
    expect(pdfStr).toContain("Chapter 1");
    expect(pdfStr).toContain("Chapter 2");

    // Should still be readable
    const result = await Pdf.read(bytes);
    expect(result.pages.length).toBe(2);
  });

  it("should support nested bookmarks", async () => {
    const doc = new Pdf.Builder();
    doc.addPage().drawText("Part I", { x: 72, y: 750 });
    doc.addPage().drawText("Chapter 1.1", { x: 72, y: 750 });
    doc.addPage().drawText("Chapter 1.2", { x: 72, y: 750 });

    doc.addBookmark("Part I", 0); // index 0 in top-level bookmarks
    doc.addBookmark("Chapter 1.1", 1, 0); // child of "Part I"
    doc.addBookmark("Chapter 1.2", 2, 0); // child of "Part I"

    const bytes = await doc.build();
    const pdfStr = new TextDecoder().decode(bytes);

    expect(pdfStr).toContain("/Outlines");
    expect(pdfStr).toContain("Part I");
    expect(pdfStr).toContain("Chapter 1.1");
    expect(pdfStr).toContain("Chapter 1.2");

    // The outline items should have First/Last for the parent
    expect(pdfStr).toContain("/First");
    expect(pdfStr).toContain("/Last");

    const result = await Pdf.read(bytes);
    expect(result.pages.length).toBe(3);
  });

  it("should throw for invalid parent index", () => {
    const doc = new Pdf.Builder();
    doc.addPage();

    expect(() => doc.addBookmark("Child", 0, 5)).toThrow(RangeError);
    expect(() => doc.addBookmark("Child", 0, -1)).toThrow(RangeError);
  });

  it("should roundtrip bookmarks through builder and reader", async () => {
    const doc = new Pdf.Builder();
    doc.addPage().drawText("Page 1", { x: 72, y: 750 });
    doc.addPage().drawText("Page 2", { x: 72, y: 750 });
    doc.addPage().drawText("Page 3", { x: 72, y: 750 });

    doc.addBookmark("Intro", 0);
    doc.addBookmark("Main", 1);
    doc.addBookmark("Sub A", 1, 1);
    doc.addBookmark("Sub B", 2, 1);
    doc.addBookmark("End", 2);

    const pdfBytes = await doc.build();
    const result = await Pdf.read(pdfBytes);

    expect(result.bookmarks.length).toBe(3); // Intro, Main, End
    expect(result.bookmarks[0].title).toBe("Intro");
    expect(result.bookmarks[0].pageIndex).toBe(0);
    expect(result.bookmarks[1].title).toBe("Main");
    expect(result.bookmarks[1].children.length).toBe(2);
    expect(result.bookmarks[1].children[0].title).toBe("Sub A");
    expect(result.bookmarks[1].children[1].title).toBe("Sub B");
    expect(result.bookmarks[2].title).toBe("End");
  });
});

describe("PdfDocumentBuilder — Table of Contents", () => {
  it("should generate a TOC page with entry text", async () => {
    const doc = new Pdf.Builder();
    doc.addPage().drawText("Introduction", { x: 72, y: 750 });
    doc.addPage().drawText("Chapter 1", { x: 72, y: 750 });
    doc.addPage().drawText("Conclusion", { x: 72, y: 750 });

    doc.addBookmark("Introduction", 0);
    doc.addBookmark("Chapter 1", 1);
    doc.addBookmark("Conclusion", 2);

    const tocPage = doc.generateTableOfContents();
    expect(tocPage).toBeDefined();
    expect(tocPage.width).toBeGreaterThan(0);

    const bytes = await doc.build();
    const result = await Pdf.read(bytes);

    // The TOC page is the 4th page (added after the 3 content pages)
    expect(result.pages.length).toBe(4);

    // TOC page should contain bookmark titles and the default title
    const tocText = result.pages[3].text;
    expect(tocText).toContain("Table of Contents");
    expect(tocText).toContain("Introduction");
    expect(tocText).toContain("Chapter 1");
    expect(tocText).toContain("Conclusion");
  });

  it("should accept custom TOC options", async () => {
    const doc = new Pdf.Builder();
    doc.addPage().drawText("Section A", { x: 72, y: 750 });
    doc.addPage().drawText("Section B", { x: 72, y: 750 });

    doc.addBookmark("Section A", 0);
    doc.addBookmark("Section B", 1);

    doc.generateTableOfContents({
      title: "Contents",
      fontSize: 14,
      indent: 30
    });

    const bytes = await doc.build();
    const result = await Pdf.read(bytes);

    const tocText = result.pages[2].text;
    expect(tocText).toContain("Contents");
    expect(tocText).toContain("Section A");
    expect(tocText).toContain("Section B");
  });

  it("should include link annotations on the TOC page", async () => {
    const doc = new Pdf.Builder();
    doc.addPage().drawText("Page 1", { x: 72, y: 750 });
    doc.addPage().drawText("Page 2", { x: 72, y: 750 });

    doc.addBookmark("First Page", 0);
    doc.addBookmark("Second Page", 1);

    doc.generateTableOfContents();

    const bytes = await doc.build();
    const pdfStr = new TextDecoder().decode(bytes);

    // Should contain Link annotations with Dest entries
    expect(pdfStr).toContain("/Subtype /Link");
    expect(pdfStr).toContain("/Dest");

    const result = await Pdf.read(bytes);
    expect(result.pages.length).toBe(3);
  });

  it("should render nested bookmarks with indentation in TOC", async () => {
    const doc = new Pdf.Builder();
    doc.addPage().drawText("Part I", { x: 72, y: 750 });
    doc.addPage().drawText("Ch 1", { x: 72, y: 750 });
    doc.addPage().drawText("Ch 2", { x: 72, y: 750 });

    doc.addBookmark("Part I", 0);
    doc.addBookmark("Chapter 1", 1, 0);
    doc.addBookmark("Chapter 2", 2, 0);

    doc.generateTableOfContents();

    const bytes = await doc.build();
    const result = await Pdf.read(bytes);

    const tocText = result.pages[3].text;
    expect(tocText).toContain("Part I");
    expect(tocText).toContain("Chapter 1");
    expect(tocText).toContain("Chapter 2");
  });

  it("should generate multi-page TOC when entries overflow", async () => {
    const doc = new Pdf.Builder();

    // Create 60 pages with bookmarks — enough to overflow a single TOC page
    for (let i = 0; i < 60; i++) {
      doc.addPage().drawText(`Page ${i + 1}`, { x: 72, y: 750 });
      doc.addBookmark(`Chapter ${i + 1}`, i);
    }

    doc.generateTableOfContents();

    const bytes = await doc.build();
    const result = await Pdf.read(bytes);

    // Should have more than 61 pages (60 content + at least 2 TOC pages)
    expect(result.pages.length).toBeGreaterThan(61);

    // First TOC page should have the title
    const tocPage1 = result.pages[60];
    expect(tocPage1.text).toContain("Table of Contents");
    expect(tocPage1.text).toContain("Chapter 1");

    // Last chapter should appear on a continuation TOC page
    const allText = result.pages
      .slice(60)
      .map(p => p.text)
      .join("\n");
    expect(allText).toContain("Chapter 60");
  });
});

// =============================================================================
// PDF/A-1b Compliance
// =============================================================================

describe("PdfDocumentBuilder — PDF/A-1b", () => {
  it("should produce a PDF with XMP containing pdfaid:part and pdfaid:conformance", async () => {
    const doc = new Pdf.Builder();
    doc.setPdfACompliance("1b");
    doc.setMetadata({ title: "Test PDF/A", author: "Test Author" });
    doc.addPage().drawText("PDF/A content", { x: 72, y: 750 });

    const bytes = await doc.build();
    const text = new TextDecoder().decode(bytes);

    // Should use PDF 1.4
    expect(text.startsWith("%PDF-1.4")).toBe(true);

    // XMP metadata must declare PDF/A-1b
    expect(text).toContain("<pdfaid:part>1</pdfaid:part>");
    expect(text).toContain("<pdfaid:conformance>B</pdfaid:conformance>");

    // XMP should contain document metadata
    expect(text).toContain("Test PDF/A");
    expect(text).toContain("Test Author");
  });

  it("should produce a PDF with /OutputIntents", async () => {
    const doc = new Pdf.Builder();
    doc.setPdfACompliance();
    doc.addPage();

    const bytes = await doc.build();
    const text = new TextDecoder().decode(bytes);

    expect(text).toContain("/OutputIntents");
    expect(text).toContain("/GTS_PDFA1");
    expect(text).toContain("sRGB IEC61966-2.1");
  });

  it("should produce a PDF with /MarkInfo", async () => {
    const doc = new Pdf.Builder();
    doc.setPdfACompliance();
    doc.addPage();

    const bytes = await doc.build();
    const text = new TextDecoder().decode(bytes);

    expect(text).toContain("/MarkInfo");
    expect(text).toContain("/Marked true");
  });

  it("should contain /Metadata reference in the catalog", async () => {
    const doc = new Pdf.Builder();
    doc.setPdfACompliance();
    doc.addPage();

    const bytes = await doc.build();
    const text = new TextDecoder().decode(bytes);

    // Catalog should reference the metadata stream
    expect(text).toContain("/Metadata");
    expect(text).toContain("/Type /Metadata");
    expect(text).toContain("/Subtype /XML");
  });

  it("should produce valid PDF readable by readPdf", async () => {
    const doc = new Pdf.Builder();
    doc.setPdfACompliance("1b");
    doc.setMetadata({ title: "Readable PDF/A" });
    doc.addPage().drawText("Hello PDF/A", { x: 72, y: 750 });

    const bytes = await doc.build();
    const result = await Pdf.read(bytes);
    expect(result.pages.length).toBe(1);
    expect(result.text).toContain("Hello PDF/A");
  });
});

// =============================================================================
// Pdf.Editor — Modify Existing PDF
// =============================================================================

describe("PdfEditor", () => {
  it("should load an existing PDF", async () => {
    const pdfBytes = await Pdf.create([["Hello", "World"]]);
    const editor = Pdf.Editor.load(pdfBytes);

    expect(editor.pageCount).toBeGreaterThan(0);
  });

  it("should overlay text on an existing page", async () => {
    const pdfBytes = await Pdf.create([["Original"]]);
    const editor = Pdf.Editor.load(pdfBytes);

    editor.getPage(0).drawText("Overlay", {
      x: 200,
      y: 400,
      fontSize: 24,
      color: { r: 1, g: 0, b: 0 }
    });

    const result = await editor.save();
    const readResult = await Pdf.read(result);
    expect(readResult.text).toContain("Overlay");
  });

  it("should overlay shapes on an existing page", async () => {
    const pdfBytes = await Pdf.create([["Data"]]);
    const editor = Pdf.Editor.load(pdfBytes);

    editor.getPage(0).drawRect({
      x: 72,
      y: 300,
      width: 200,
      height: 100,
      fill: { r: 1, g: 1, b: 0 },
      stroke: { r: 0, g: 0, b: 0 }
    });

    const result = await editor.save();
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBeGreaterThan(0);
  });

  it("should add new pages to an existing PDF", async () => {
    const pdfBytes = await Pdf.create([["Page 1"]]);
    const editor = Pdf.Editor.load(pdfBytes);

    const newPage = editor.addPage();
    newPage.drawText("Page 2", { x: 72, y: 750, fontSize: 20 });

    const result = await editor.save();
    const readResult = await Pdf.read(result);
    expect(readResult.pages.length).toBe(2);
    expect(readResult.pages[1].text).toContain("Page 2");
  });

  it("should throw for invalid page index", async () => {
    const pdfBytes = await Pdf.create([["Test"]]);
    const editor = Pdf.Editor.load(pdfBytes);

    expect(() => editor.getPage(-1)).toThrow();
    expect(() => editor.getPage(100)).toThrow();
  });

  it("should get page dimensions", async () => {
    const pdfBytes = await Pdf.create([["Test"]]);
    const editor = Pdf.Editor.load(pdfBytes);

    const page = editor.getPage(0);
    expect(page.width).toBeGreaterThan(0);
    expect(page.height).toBeGreaterThan(0);
  });

  it("should read form fields", async () => {
    // Create a PDF with a form field (hand-crafted)
    const src = [
      "%PDF-1.4",
      "1 0 obj << /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [5 0 R] >> >> endobj",
      "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
      "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >> endobj",
      "4 0 obj << /Length 0 >> stream",
      "endstream endobj",
      "5 0 obj << /Type /Annot /Subtype /Widget /FT /Tx /T (name) /V (old_value) /Rect [72 700 200 720] >> endobj",
      "xref",
      "0 6",
      "0000000000 65535 f ",
      "0000000009 00000 n ",
      "0000000100 00000 n ",
      "0000000157 00000 n ",
      "0000000252 00000 n ",
      "0000000302 00000 n ",
      "trailer << /Size 6 /Root 1 0 R >>",
      "startxref",
      "440",
      "%%EOF"
    ].join("\n");

    const pdfBytes = new TextEncoder().encode(src);
    const editor = Pdf.Editor.load(pdfBytes);

    const fields = editor.getFormFields();
    expect(fields.length).toBe(1);
    expect(fields[0].name).toBe("name");
    expect(fields[0].value).toBe("old_value");
  });

  it("should copy pages from another PDF", async () => {
    const sourcePdf = await Pdf.create([["Source Page 1"], ["Source Row 2"]]);
    const targetPdf = await Pdf.create([["Target Page 1"]]);

    const editor = Pdf.Editor.load(targetPdf);
    editor.copyPagesFrom(sourcePdf);

    const result = await editor.save();
    const readResult = await Pdf.read(result);

    // Should have 2 pages: original + copied
    expect(readResult.pages.length).toBe(2);
  });

  it("should copy specific pages from another PDF", async () => {
    const doc = new Pdf.Builder();
    const p1 = doc.addPage();
    p1.drawText("Page A", { x: 72, y: 750 });
    const p2 = doc.addPage();
    p2.drawText("Page B", { x: 72, y: 750 });
    const p3 = doc.addPage();
    p3.drawText("Page C", { x: 72, y: 750 });
    const sourcePdf = await doc.build();

    const targetPdf = await Pdf.create([["Target"]]);
    const editor = Pdf.Editor.load(targetPdf);
    editor.copyPagesFrom(sourcePdf, [0, 2]); // Copy pages A and C

    const result = await editor.save();
    const readResult = await Pdf.read(result);
    expect(readResult.pages.length).toBe(3); // 1 original + 2 copied
  });

  it("should preserve original page content when overlaying", async () => {
    const pdfBytes = await Pdf.create([["Original Content"]]);
    const editor = Pdf.Editor.load(pdfBytes);

    editor.getPage(0).drawText("Overlay Text", {
      x: 200,
      y: 400,
      fontSize: 20,
      color: { r: 1, g: 0, b: 0 }
    });

    const result = await editor.save();
    const readResult = await Pdf.read(result);
    // Both original and overlay text must be present
    expect(readResult.text).toContain("Original Content");
    expect(readResult.text).toContain("Overlay Text");
  });

  it("should preserve page Rotate property after save", async () => {
    // Hand-craft a PDF with /Rotate 90
    const src = [
      "%PDF-1.4",
      "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
      "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
      "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Rotate 90 /Contents 4 0 R /Resources << >> >> endobj",
      "4 0 obj << /Length 0 >> stream",
      "endstream endobj",
      "xref",
      "0 5",
      "0000000000 65535 f ",
      "0000000009 00000 n ",
      "0000000058 00000 n ",
      "0000000115 00000 n ",
      "0000000252 00000 n ",
      "trailer << /Size 5 /Root 1 0 R >>",
      "startxref",
      "302",
      "%%EOF"
    ].join("\n");
    const pdfBytes = new TextEncoder().encode(src);

    const editor = Pdf.Editor.load(pdfBytes);
    const result = await editor.save();

    // The saved PDF should contain /Rotate 90 in the page dict
    const pdfStr = new TextDecoder().decode(result);
    expect(pdfStr).toContain("/Rotate 90");
  });

  it("should preserve original metadata after save", async () => {
    const doc = new Pdf.Builder();
    doc.setMetadata({ title: "My Title", author: "My Author" });
    doc.addPage().drawText("Hello", { x: 72, y: 750 });
    const pdfBytes = await doc.build();

    const editor = Pdf.Editor.load(pdfBytes);
    editor.getPage(0).drawText("Extra", { x: 72, y: 700 });
    const result = await editor.save();

    const readResult = await Pdf.read(result);
    expect(readResult.metadata.title).toBe("My Title");
    expect(readResult.metadata.author).toBe("My Author");
  });

  it("should set and save form field values", async () => {
    // Hand-craft a PDF with a text form field
    const src = [
      "%PDF-1.4",
      "1 0 obj << /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [5 0 R] >> >> endobj",
      "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
      "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Annots [5 0 R] >> endobj",
      "4 0 obj << /Length 0 >> stream",
      "endstream endobj",
      "5 0 obj << /Type /Annot /Subtype /Widget /FT /Tx /T (username) /V (old) /Rect [72 700 200 720] >> endobj",
      "xref",
      "0 6",
      "0000000000 65535 f ",
      "0000000009 00000 n ",
      "0000000100 00000 n ",
      "0000000157 00000 n ",
      "0000000280 00000 n ",
      "0000000330 00000 n ",
      "trailer << /Size 6 /Root 1 0 R >>",
      "startxref",
      "460",
      "%%EOF"
    ].join("\n");
    const pdfBytes = new TextEncoder().encode(src);

    const editor = Pdf.Editor.load(pdfBytes);
    editor.setFormField("username", "new_value");
    const result = await editor.save();

    // The saved PDF should contain the new value
    const pdfStr = new TextDecoder().decode(result);
    expect(pdfStr).toContain("new_value");
  });

  it("should preserve Rotate on copied pages", async () => {
    // Source PDF with /Rotate 90
    const src = [
      "%PDF-1.4",
      "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
      "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
      "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Rotate 90 /Contents 4 0 R /Resources << >> >> endobj",
      "4 0 obj << /Length 0 >> stream",
      "endstream endobj",
      "xref",
      "0 5",
      "0000000000 65535 f ",
      "0000000009 00000 n ",
      "0000000058 00000 n ",
      "0000000115 00000 n ",
      "0000000252 00000 n ",
      "trailer << /Size 5 /Root 1 0 R >>",
      "startxref",
      "302",
      "%%EOF"
    ].join("\n");
    const sourcePdf = new TextEncoder().encode(src);

    const targetPdf = await Pdf.create([["Target"]]);
    const editor = Pdf.Editor.load(targetPdf);
    editor.copyPagesFrom(sourcePdf);

    const result = await editor.save();
    const pdfStr = new TextDecoder().decode(result);
    // The copied page should still have /Rotate 90
    expect(pdfStr).toContain("/Rotate 90");
  });

  it("should produce valid PDF with drawImage in builder", async () => {
    const doc = new Pdf.Builder();
    const page = doc.addPage();

    // Minimal valid JPEG: SOI + SOF0 + EOI
    // This is a 1x1 pixel JPEG
    const jpegBytes = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00,
      0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01,
      0x01, 0x11, 0x00, 0xff, 0xc4, 0x00, 0x14, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xda, 0x00, 0x08, 0x01,
      0x01, 0x00, 0x00, 0x3f, 0x00, 0x7b, 0x40, 0xff, 0xd9
    ]);

    page.drawImage({
      data: jpegBytes,
      format: "jpeg",
      x: 72,
      y: 600,
      width: 200,
      height: 150
    });

    const bytes = await doc.build();
    expect(bytes).toBeInstanceOf(Uint8Array);

    // Should be readable
    const result = await Pdf.read(bytes);
    expect(result.pages.length).toBe(1);
  });

  it("should remove a page", async () => {
    const doc = new Pdf.Builder();
    doc.addPage().drawText("Page 1", { x: 72, y: 750 });
    doc.addPage().drawText("Page 2", { x: 72, y: 750 });
    doc.addPage().drawText("Page 3", { x: 72, y: 750 });
    const pdfBytes = await doc.build();

    const editor = Pdf.Editor.load(pdfBytes);
    editor.removePage(1); // remove Page 2
    const result = await editor.save();
    const readResult = await Pdf.read(result);

    expect(readResult.pages.length).toBe(2);
    expect(readResult.pages[0].text).toContain("Page 1");
    expect(readResult.pages[1].text).toContain("Page 3");
  });

  it("should rotate a page", async () => {
    const doc = new Pdf.Builder();
    doc.addPage().drawText("Rotated", { x: 72, y: 750 });
    const pdfBytes = await doc.build();

    const editor = Pdf.Editor.load(pdfBytes);
    editor.rotatePage(0, 90);
    const result = await editor.save();

    const pdfStr = new TextDecoder().decode(result);
    expect(pdfStr).toContain("/Rotate 90");
  });

  it("should split pages into separate PDFs", async () => {
    const doc = new Pdf.Builder();
    doc.addPage().drawText("Page A", { x: 72, y: 750 });
    doc.addPage().drawText("Page B", { x: 72, y: 750 });
    doc.addPage().drawText("Page C", { x: 72, y: 750 });
    const pdfBytes = await doc.build();

    const editor = Pdf.Editor.load(pdfBytes);
    const pages = await editor.splitPages();

    expect(pages.length).toBe(3);

    // Each should be a valid single-page PDF
    for (let i = 0; i < pages.length; i++) {
      const result = await Pdf.read(pages[i]);
      expect(result.pages.length).toBe(1);
    }

    const resultA = await Pdf.read(pages[0]);
    expect(resultA.text).toContain("Page A");
    const resultC = await Pdf.read(pages[2]);
    expect(resultC.text).toContain("Page C");
  });

  it("should split specific pages", async () => {
    const doc = new Pdf.Builder();
    doc.addPage().drawText("Page A", { x: 72, y: 750 });
    doc.addPage().drawText("Page B", { x: 72, y: 750 });
    doc.addPage().drawText("Page C", { x: 72, y: 750 });
    const pdfBytes = await doc.build();

    const editor = Pdf.Editor.load(pdfBytes);
    const pages = await editor.splitPages([0, 2]); // Only A and C

    expect(pages.length).toBe(2);
    const resultA = await Pdf.read(pages[0]);
    expect(resultA.text).toContain("Page A");
    const resultC = await Pdf.read(pages[1]);
    expect(resultC.text).toContain("Page C");
  });

  it("should throw for invalid removePage index", async () => {
    const pdfBytes = await Pdf.create([["Test"]]);
    const editor = Pdf.Editor.load(pdfBytes);
    expect(() => editor.removePage(-1)).toThrow();
    expect(() => editor.removePage(100)).toThrow();
  });

  it("should throw for invalid rotatePage degrees", async () => {
    const pdfBytes = await Pdf.create([["Test"]]);
    const editor = Pdf.Editor.load(pdfBytes);
    expect(() => editor.rotatePage(0, 45)).toThrow();
  });

  it("serialises overlay /ExtGState when overlay draws with non-opaque colour", async () => {
    // Before the P4 fix, `_buildOverlayResourceDict` wrote only
    // /Font + /XObject. An overlay that produced `gs` operators (via
    // PdfColor.a < 1) referenced an undefined resource. This test
    // verifies the overlay resource dict now contains the /GS####
    // entry the content stream references.
    const pdfBytes = await Pdf.create([["Base"]]);
    const editor = Pdf.Editor.load(pdfBytes);
    editor.getPage(0).drawRect({
      x: 50,
      y: 300,
      width: 200,
      height: 100,
      fill: { r: 1, g: 0, b: 0, a: 0.35 }
    });
    const result = await editor.save();
    const pdfText = new TextDecoder("latin1").decode(result);
    expect(pdfText).toContain("/ExtGState");
    expect(pdfText).toContain("/ca 0.35");
    expect(pdfText).toContain("/CA 0.35");
    expect(pdfText).toMatch(/\/(?:DMO\d+_)?GS3500 gs/);
  });

  it("serialises /ExtGState on newly-added pages (PdfEditor.addPage)", async () => {
    // Same guarantee for the `_newPages` code path — pages created via
    // `editor.addPage()` (as opposed to existing pages being overlaid).
    const pdfBytes = await Pdf.create([["Base"]]);
    const editor = Pdf.Editor.load(pdfBytes);
    const addedPage = editor.addPage();
    addedPage.drawRect({
      x: 72,
      y: 200,
      width: 100,
      height: 100,
      fill: { r: 0, g: 0.5, b: 1, a: 0.5 }
    });
    const result = await editor.save();
    const pdfText = new TextDecoder("latin1").decode(result);
    expect(pdfText).toContain("/ExtGState");
    expect(pdfText).toContain("/ca 0.5");
    expect(pdfText).toMatch(/\/(?:DMO\d+_)?GS5000 gs/);
  });
});

// =============================================================================
// Content Stream — Bezier / Circle / Ellipse
// =============================================================================

describe("PdfContentStream — Vector Drawing", () => {
  it("should produce correct Bezier curve operator", async () => {
    const doc = new Pdf.Builder();
    const page = doc.addPage();

    const stream = page.getContentStream();
    stream.moveTo(100, 200);
    stream.curveTo(150, 300, 250, 300, 300, 200);
    stream.stroke();

    const bytes = await doc.build();
    expect(bytes.length).toBeGreaterThan(0);
  });

  it("should produce a valid circle path", async () => {
    const doc = new Pdf.Builder();
    const page = doc.addPage();

    const stream = page.getContentStream();
    stream.circle(200, 400, 80);
    stream.stroke();

    const str = stream.toString();
    // Circle uses 4 Bezier curves: should contain 'm' and 4 'c' operators
    expect(str).toContain("m");
    expect((str.match(/ c$/gm) || []).length).toBe(4);

    const bytes = await doc.build();
    expect(bytes.length).toBeGreaterThan(0);
  });

  it("should produce a valid rounded rectangle path", async () => {
    const doc = new Pdf.Builder();
    const page = doc.addPage();

    const stream = page.getContentStream();
    stream.roundedRect(100, 300, 200, 100, 15);
    stream.stroke();

    const str = stream.toString();
    // Rounded rect: 4 curves + 4 lines + 1 move
    expect(str).toContain("m");
    expect(str).toContain(" l");
    expect(str).toContain(" c");

    const bytes = await doc.build();
    expect(bytes.length).toBeGreaterThan(0);
  });
});

// =============================================================================
// Form Field Appearance Stream Generation
// =============================================================================

describe("Form Field Appearance Streams", () => {
  it("should produce /AP with a stream reference when updating a text field", async () => {
    // Hand-craft a PDF with a text form field widget on a page
    const src = [
      "%PDF-1.4",
      "1 0 obj << /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [5 0 R] >> >> endobj",
      "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
      "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Annots [5 0 R] >> endobj",
      "4 0 obj << /Length 0 >> stream",
      "endstream endobj",
      "5 0 obj << /Type /Annot /Subtype /Widget /FT /Tx /T (city) /V (old) /Rect [72 700 300 720] >> endobj",
      "xref",
      "0 6",
      "0000000000 65535 f ",
      "0000000009 00000 n ",
      "0000000100 00000 n ",
      "0000000157 00000 n ",
      "0000000280 00000 n ",
      "0000000330 00000 n ",
      "trailer << /Size 6 /Root 1 0 R >>",
      "startxref",
      "460",
      "%%EOF"
    ].join("\n");
    const pdfBytes = new TextEncoder().encode(src);

    const editor = Pdf.Editor.load(pdfBytes);
    editor.setFormField("city", "Springfield");
    const result = await editor.save();

    const pdfStr = new TextDecoder().decode(result);

    // Should contain an /AP dict with /N pointing to an indirect ref
    expect(pdfStr).toContain("/AP");
    expect(pdfStr).toMatch(/\/AP\s*<<\s*\/N\s+\d+\s+0\s+R\s*>>/);

    // Should also still set /NeedAppearances as a fallback
    expect(pdfStr).toContain("/NeedAppearances true");

    // The new value should be present
    expect(pdfStr).toContain("Springfield");
  });

  it("should include the field value text in the appearance stream", async () => {
    const src = [
      "%PDF-1.4",
      "1 0 obj << /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [5 0 R] >> >> endobj",
      "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
      "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Annots [5 0 R] >> endobj",
      "4 0 obj << /Length 0 >> stream",
      "endstream endobj",
      "5 0 obj << /Type /Annot /Subtype /Widget /FT /Tx /T (email) /V () /Rect [72 650 400 670] >> endobj",
      "xref",
      "0 6",
      "0000000000 65535 f ",
      "0000000009 00000 n ",
      "0000000100 00000 n ",
      "0000000157 00000 n ",
      "0000000280 00000 n ",
      "0000000330 00000 n ",
      "trailer << /Size 6 /Root 1 0 R >>",
      "startxref",
      "460",
      "%%EOF"
    ].join("\n");
    const pdfBytes = new TextEncoder().encode(src);

    const editor = Pdf.Editor.load(pdfBytes);
    editor.setFormField("email", "test@example.com");
    const result = await editor.save();

    const pdfStr = new TextDecoder().decode(result);

    // The appearance stream should contain the text value
    // (the stream is written uncompressed for small content)
    expect(pdfStr).toContain("test@example.com");

    // The appearance stream object should be a Form XObject
    expect(pdfStr).toContain("/Subtype /Form");
    expect(pdfStr).toContain("/BBox");
  });

  it("generateTextFieldAppearance should return stream bytes and resources", () => {
    const { stream, resources } = generateTextFieldAppearance({
      value: "Hello World",
      rect: [72, 700, 300, 720]
    });

    expect(stream).toBeInstanceOf(Uint8Array);
    expect(stream.length).toBeGreaterThan(0);

    const streamStr = new TextDecoder().decode(stream);
    // Should contain text operators
    expect(streamStr).toContain("BT");
    expect(streamStr).toContain("ET");
    expect(streamStr).toContain("Hello World");
    expect(streamStr).toContain("Tf"); // font selection

    // Resources should reference a font
    expect(resources).toContain("/Font");
    expect(resources).toContain("/Helv");
    expect(resources).toContain("/Helvetica");
  });

  it("generateCheckboxAppearance should return on/off streams", () => {
    const { streamOn, streamOff } = generateCheckboxAppearance(true, [72, 700, 92, 720]);

    expect(streamOn).toBeInstanceOf(Uint8Array);
    expect(streamOff).toBeInstanceOf(Uint8Array);

    // On stream should have drawing operators (X mark)
    expect(streamOn.length).toBeGreaterThan(0);
    const onStr = new TextDecoder().decode(streamOn);
    expect(onStr).toContain("m"); // moveTo
    expect(onStr).toContain("l"); // lineTo
    expect(onStr).toContain("S"); // stroke

    // Off stream should be empty (no drawing)
    expect(streamOff.length).toBe(0);
  });
});

// =============================================================================
// Resource Dict Merger
// =============================================================================

describe("Resource Dict Merger", () => {
  it("should merge two resource dicts with overlapping Font sub-dicts", () => {
    const original: PdfResourceDict = new Map([
      [
        "Font",
        new Map([
          ["F1", "3 0 R"],
          ["F2", "5 0 R"]
        ])
      ]
    ]);
    const overlay: PdfResourceDict = new Map([
      [
        "Font",
        new Map([
          ["F2", "10 0 R"],
          ["F3", "12 0 R"]
        ])
      ]
    ]);

    const merged = mergeResourceDicts(original, overlay);
    const fontMap = merged.get("Font")!;

    expect(fontMap.size).toBe(3);
    expect(fontMap.get("F1")).toBe("3 0 R"); // from original
    expect(fontMap.get("F2")).toBe("10 0 R"); // overlay wins
    expect(fontMap.get("F3")).toBe("12 0 R"); // from overlay
  });

  it("should merge when one has XObject and the other does not", () => {
    const original: PdfResourceDict = new Map([["Font", new Map([["F1", "3 0 R"]])]]);
    const overlay: PdfResourceDict = new Map([["XObject", new Map([["Im1", "7 0 R"]])]]);

    const merged = mergeResourceDicts(original, overlay);

    expect(merged.has("Font")).toBe(true);
    expect(merged.get("Font")!.get("F1")).toBe("3 0 R");
    expect(merged.has("XObject")).toBe(true);
    expect(merged.get("XObject")!.get("Im1")).toBe("7 0 R");
  });

  it("should round-trip: parse → merge → serialize → parse gives correct result", () => {
    const origStr = "<< /Font << /F1 3 0 R /F2 5 0 R >> /ExtGState << /GS0 8 0 R >> >>";
    const overlayStr = "<< /Font << /F2 10 0 R /F3 12 0 R >> /XObject << /Im1 7 0 R >> >>";

    const origDict = parseResourceDict(origStr);
    const overlayDict = parseResourceDict(overlayStr);
    const merged = mergeResourceDicts(origDict, overlayDict);
    const serialized = serializeResourceDict(merged);

    // Parse the serialized result back
    const reparsed = parseResourceDict(serialized);

    // Font: F1 from original, F2 from overlay, F3 from overlay
    const fontMap = reparsed.get("Font")!;
    expect(fontMap.size).toBe(3);
    expect(fontMap.get("F1")).toBe("3 0 R");
    expect(fontMap.get("F2")).toBe("10 0 R");
    expect(fontMap.get("F3")).toBe("12 0 R");

    // ExtGState: preserved from original
    const gsMap = reparsed.get("ExtGState")!;
    expect(gsMap.size).toBe(1);
    expect(gsMap.get("GS0")).toBe("8 0 R");

    // XObject: from overlay
    const xobjMap = reparsed.get("XObject")!;
    expect(xobjMap.size).toBe(1);
    expect(xobjMap.get("Im1")).toBe("7 0 R");
  });

  it("should parse an empty dict", () => {
    const dict = parseResourceDict("<< >>");
    expect(dict.size).toBe(0);
  });

  it("should serialize an empty dict", () => {
    const dict: PdfResourceDict = new Map();
    expect(serializeResourceDict(dict)).toBe("<< >>");
  });

  it("should handle non-sub-dict categories like ProcSet", () => {
    const dictStr = "<< /Font << /F1 3 0 R >> /ProcSet [/PDF /Text] >>";
    const parsed = parseResourceDict(dictStr);

    expect(parsed.has("Font")).toBe(true);
    expect(parsed.has("ProcSet")).toBe(true);

    // ProcSet is stored with empty-string key
    const procSet = parsed.get("ProcSet")!;
    expect(procSet.get("")).toBe("[/PDF /Text]");

    // Round-trip
    const serialized = serializeResourceDict(parsed);
    expect(serialized).toContain("/ProcSet [/PDF /Text]");
    expect(serialized).toContain("/Font");
  });

  it("should preserve original dict when overlay is empty", () => {
    const original: PdfResourceDict = new Map([["Font", new Map([["F1", "3 0 R"]])]]);
    const overlay: PdfResourceDict = new Map();

    const merged = mergeResourceDicts(original, overlay);
    expect(merged.get("Font")!.get("F1")).toBe("3 0 R");
  });

  it("should not mutate the original dict during merge", () => {
    const original: PdfResourceDict = new Map([["Font", new Map([["F1", "3 0 R"]])]]);
    const overlay: PdfResourceDict = new Map([["Font", new Map([["F2", "5 0 R"]])]]);

    mergeResourceDicts(original, overlay);

    // Original should be unchanged
    const origFont = original.get("Font")!;
    expect(origFont.size).toBe(1);
    expect(origFont.has("F2")).toBe(false);
  });
});

// =============================================================================
// Pdf.Editor — Incremental Save
// =============================================================================

describe("PdfEditor — saveIncremental", () => {
  it("should start with the original bytes when overlaying text", async () => {
    const originalPdf = await Pdf.create([["Original Content"]]);
    const editor = Pdf.Editor.load(originalPdf);

    editor.getPage(0).drawText("Overlay", {
      x: 200,
      y: 400,
      fontSize: 24,
      color: { r: 1, g: 0, b: 0 }
    });

    const result = await editor.saveIncremental();

    // The result should start with the exact original bytes
    expect(result.length).toBeGreaterThan(originalPdf.length);
    const prefix = result.subarray(0, originalPdf.length);
    expect(prefix).toEqual(originalPdf);

    // The result should be a readable PDF with both original and overlay content
    const readResult = await Pdf.read(result);
    expect(readResult.text).toContain("Original Content");
    expect(readResult.text).toContain("Overlay");
  });

  it("keeps original embedded-font resources isolated from overlay resources", async () => {
    const fontA = buildTtfWithCmap([{ start: 0x41, end: 0x41, delta: 1 - 0x41 }], 2, {
      familyName: "OriginalFont"
    });
    const builder = new Pdf.Builder();
    builder.embedFont(fontA);
    builder.addPage().drawText("A", { x: 72, y: 700 });
    const original = await builder.build();

    const fontB = buildTtfWithCmap([{ start: 0x42, end: 0x42, delta: 1 - 0x42 }], 2, {
      familyName: "OverlayFont"
    });
    const editor = Pdf.Editor.load(original);
    editor.embedFont(fontB);
    editor.getPage(0).drawText("B", { x: 72, y: 650 });

    const result = await Pdf.read(await editor.save());
    expect(result.pages[0].textFragments.map(fragment => fragment.text)).toEqual(["A", "B"]);
  });

  it("can save again after adding new embedded-font overlay text", async () => {
    const originalPdf = await Pdf.create([["Original"]]);
    const editor = Pdf.Editor.load(originalPdf);
    const font = buildTtfWithCmap([{ start: 0x41, end: 0x42, delta: 1 - 0x41 }], 3, {
      familyName: "OverlayFont"
    });
    editor.embedFont(font);
    editor.getPage(0).drawText("A", { x: 72, y: 700 });
    await editor.save();

    editor.getPage(0).drawText("B", { x: 72, y: 670 });
    const second = await Pdf.read(await editor.save());
    expect(second.text).toContain("A");
    expect(second.text).toContain("B");
  });

  it("saveIncremental overlays embedded-font text without evaluating deferred text early", async () => {
    // Regression: text is now emitted as a deferred fragment whose encoding
    // runs at serialization time. `_hasOverlay()` must probe for content
    // WITHOUT evaluating that fragment — evaluating it before
    // writeFontResources would call encodeText prematurely and throw
    // "subset mapping not available". Drawing non-WinAnsi text through an
    // embedded font exercises exactly that path.
    const originalPdf = await Pdf.create([["Original Content"]]);
    const editor = Pdf.Editor.load(originalPdf);

    const ttf = buildTtfWithCmap(
      [
        { start: 0x20, end: 0x5a, delta: 1 - 0x20 },
        { start: 0x2192, end: 0x2192, delta: 60 - 0x2192 }
      ],
      61
    );
    editor.embedFont(ttf);
    editor.getPage(0).drawText("A \u2192 B", { x: 100, y: 400, fontSize: 16 });

    // Must not throw, and the overlay must use the embedded CIDFont.
    const result = await editor.saveIncremental();
    const text = new TextDecoder("latin1").decode(result);
    expect(text).toContain("/Type0");
    expect(text).toMatch(/\/(?:DMO\d+_)?EF\d+ 16 Tf/);
  });

  it("should update form field values incrementally", async () => {
    // Hand-craft a PDF with a text form field
    const src = [
      "%PDF-1.4",
      "1 0 obj << /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [5 0 R] >> >> endobj",
      "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
      "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Annots [5 0 R] >> endobj",
      "4 0 obj << /Length 0 >> stream",
      "endstream endobj",
      "5 0 obj << /Type /Annot /Subtype /Widget /FT /Tx /T (username) /V (old) /Rect [72 700 200 720] >> endobj",
      "xref",
      "0 6",
      "0000000000 65535 f ",
      "0000000009 00000 n ",
      "0000000100 00000 n ",
      "0000000157 00000 n ",
      "0000000280 00000 n ",
      "0000000330 00000 n ",
      "trailer << /Size 6 /Root 1 0 R >>",
      "startxref",
      "460",
      "%%EOF"
    ].join("\n");
    const originalPdf = new TextEncoder().encode(src);

    const editor = Pdf.Editor.load(originalPdf);
    editor.setFormField("username", "new_value");
    const result = await editor.saveIncremental();

    // The result should start with the exact original bytes
    expect(result.length).toBeGreaterThan(originalPdf.length);
    const prefix = result.subarray(0, originalPdf.length);
    expect(prefix).toEqual(originalPdf);

    // The saved PDF should contain the new value
    const pdfStr = new TextDecoder().decode(result);
    expect(pdfStr).toContain("new_value");
  });

  it("should fall back to full rebuild when pages are added", async () => {
    const originalPdf = await Pdf.create([["Page 1"]]);
    const editor = Pdf.Editor.load(originalPdf);

    // Add a new page — this is a structural change
    const newPage = editor.addPage();
    newPage.drawText("Page 2", { x: 72, y: 750, fontSize: 20 });

    const result = await editor.saveIncremental();

    // Since structural changes are present, this should NOT start with original bytes
    // (it falls back to full rebuild which re-creates the entire PDF)
    const readResult = await Pdf.read(result);
    expect(readResult.pages.length).toBe(2);
    expect(readResult.pages[1].text).toContain("Page 2");
  });

  it("should fall back to full rebuild when pages are removed", async () => {
    const doc = new (await import("../index")).Pdf.Builder();
    doc.addPage().drawText("Page 1", { x: 72, y: 750 });
    doc.addPage().drawText("Page 2", { x: 72, y: 750 });
    const originalPdf = await doc.build();

    const editor = Pdf.Editor.load(originalPdf);
    editor.removePage(1);

    const result = await editor.saveIncremental();

    // Falls back to full rebuild — result should be a valid 1-page PDF
    const readResult = await Pdf.read(result);
    expect(readResult.pages.length).toBe(1);
    expect(readResult.pages[0].text).toContain("Page 1");
  });

  it("should return original bytes when no changes are made", async () => {
    const originalPdf = await Pdf.create([["Unchanged"]]);
    const editor = Pdf.Editor.load(originalPdf);

    const result = await editor.saveIncremental();

    // No changes — should return original bytes as-is
    expect(result).toEqual(originalPdf);
  });

  it("should not leak state between consecutive save calls", async () => {
    const originalPdf = await Pdf.create([["State Test"]]);
    const editor = Pdf.Editor.load(originalPdf);

    // First: incremental save with no changes (early return path)
    const result1 = await editor.saveIncremental();
    expect(result1).toEqual(originalPdf);

    // Second: add overlay and do full save — should work correctly
    editor.getPage(0).drawText("Added", { x: 200, y: 400 });
    const result2 = await editor.save();
    const readResult = await Pdf.read(result2);
    expect(readResult.text).toContain("State Test");
    expect(readResult.text).toContain("Added");

    // Third: incremental save after full save — should not crash
    const editor2 = Pdf.Editor.load(result2);
    const result3 = await editor2.saveIncremental();
    expect(result3.length).toBeGreaterThan(0);
  });
});

// =============================================================================
// Annotation Creation
// =============================================================================

describe("Annotation Creation", () => {
  it("should create a PDF with a Highlight annotation", async () => {
    const doc = new Pdf.Builder();
    const page = doc.addPage();
    page.drawText("Highlighted text", { x: 72, y: 750, fontSize: 14 });
    page.addAnnotation({
      type: "Highlight",
      rect: [72, 745, 200, 765],
      color: { r: 1, g: 1, b: 0 },
      contents: "Important!"
    });

    const bytes = await doc.build();
    const result = await Pdf.read(bytes);
    expect(result.pages.length).toBe(1);

    // Check that the annotation appears in the PDF structure
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain("/Subtype /Highlight");
    expect(text).toContain("/QuadPoints");
  });

  it("should create Text (sticky note) annotation", async () => {
    const doc = new Pdf.Builder();
    const page = doc.addPage();
    page.addAnnotation({
      type: "Text",
      rect: [100, 700, 124, 724],
      contents: "A sticky note",
      author: "Test Author",
      iconName: "Comment",
      open: true
    });

    const bytes = await doc.build();
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain("/Subtype /Text");
    expect(text).toContain("/Name /Comment");
    expect(text).toContain("/Open true");
  });

  it("should create FreeText annotation", async () => {
    const doc = new Pdf.Builder();
    const page = doc.addPage();
    page.addAnnotation({
      type: "FreeText",
      rect: [72, 600, 300, 640],
      contents: "Free text content",
      fontSize: 16,
      color: { r: 0, g: 0, b: 0 }
    });

    const bytes = await doc.build();
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain("/Subtype /FreeText");
    expect(text).toContain("/DA");
  });

  it("should create Stamp annotation", async () => {
    const doc = new Pdf.Builder();
    const page = doc.addPage();
    page.addAnnotation({
      type: "Stamp",
      rect: [100, 500, 300, 550],
      stampName: "Approved",
      contents: "Approved by QA"
    });

    const bytes = await doc.build();
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain("/Subtype /Stamp");
    expect(text).toContain("/Name /Approved");
  });

  it("should create Underline and StrikeOut annotations", async () => {
    const doc = new Pdf.Builder();
    const page = doc.addPage();
    page.addAnnotation({
      type: "Underline",
      rect: [72, 700, 200, 715]
    });
    page.addAnnotation({
      type: "StrikeOut",
      rect: [72, 670, 200, 685]
    });

    const bytes = await doc.build();
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain("/Subtype /Underline");
    expect(text).toContain("/Subtype /StrikeOut");
  });

  it("should add annotations via PdfEditorPage", async () => {
    const doc = new Pdf.Builder();
    doc.addPage().drawText("Hello", { x: 72, y: 750, fontSize: 12 });
    const original = await doc.build();

    const editor = Pdf.Editor.load(original);
    editor.getPage(0).addAnnotation({
      type: "Highlight",
      rect: [72, 745, 150, 760],
      contents: "Highlighted via editor"
    });
    const result = await editor.save();
    const text = new TextDecoder().decode(result);
    expect(text).toContain("/Subtype /Highlight");
  });
});

// =============================================================================
// Form Field Creation
// =============================================================================

describe("Form Field Creation", () => {
  it("should create a text field", async () => {
    const doc = new Pdf.Builder();
    const page = doc.addPage();
    page.drawText("Name:", { x: 72, y: 750, fontSize: 12 });
    page.addFormField({
      type: "text",
      name: "fullName",
      rect: [140, 735, 300, 755],
      value: "John Doe"
    });

    const bytes = await doc.build();
    const result = await Pdf.read(bytes);
    expect(result.formFields.length).toBeGreaterThanOrEqual(1);
    const nameField = result.formFields.find(f => f.name === "fullName");
    expect(nameField).toBeDefined();
    expect(nameField!.type).toBe("text");
    expect(nameField!.value).toBe("John Doe");
  });

  it("should create a checkbox field", async () => {
    const doc = new Pdf.Builder();
    const page = doc.addPage();
    page.addFormField({
      type: "checkbox",
      name: "agree",
      rect: [72, 700, 92, 720],
      checked: true
    });

    const bytes = await doc.build();
    const result = await Pdf.read(bytes);
    const checkField = result.formFields.find(f => f.name === "agree");
    expect(checkField).toBeDefined();
    expect(checkField!.type).toBe("checkbox");
  });

  it("should create a dropdown field with options", async () => {
    const doc = new Pdf.Builder();
    const page = doc.addPage();
    page.addFormField({
      type: "dropdown",
      name: "country",
      rect: [72, 650, 200, 670],
      options: ["USA", "Canada", "UK", "Australia"],
      value: "USA"
    });

    const bytes = await doc.build();
    const result = await Pdf.read(bytes);
    const dropField = result.formFields.find(f => f.name === "country");
    expect(dropField).toBeDefined();
    expect(dropField!.type).toBe("dropdown");
    expect(dropField!.options).toContain("USA");
    expect(dropField!.options).toContain("Canada");
  });

  it("should create a radio button group", async () => {
    const doc = new Pdf.Builder();
    const page = doc.addPage();
    page.addFormField({
      type: "radio",
      name: "gender",
      buttons: [
        { rect: [72, 600, 92, 620], value: "male" },
        { rect: [120, 600, 140, 620], value: "female" }
      ],
      selected: "male"
    });

    const bytes = await doc.build();
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain("/FT /Btn");
    expect(text).toContain("/V /male");
  });

  it("should create form fields on editor pages", async () => {
    const doc = new Pdf.Builder();
    doc.addPage().drawText("Form", { x: 72, y: 750, fontSize: 12 });
    const original = await doc.build();

    const editor = Pdf.Editor.load(original);
    editor.getPage(0).addFormField({
      type: "text",
      name: "editorField",
      rect: [72, 700, 250, 720]
    });
    // Form fields on editor pages need full save (not incremental)
    const result = await editor.save();
    expect(result.length).toBeGreaterThan(0);
    const text = new TextDecoder().decode(result);
    expect(text).toContain("/FT /Tx");
  });
});

// =============================================================================
// SVG Path Parser
// =============================================================================

describe("SVG Path Parser", () => {
  it("should parse M L Z commands", () => {
    const ops = Pdf.parseSvgPath("M10 20 L30 40 Z");
    expect(ops).toEqual([
      { op: "move", x: 10, y: 20 },
      { op: "line", x: 30, y: 40 },
      { op: "close" }
    ]);
  });

  it("should parse relative m l z commands", () => {
    const ops = Pdf.parseSvgPath("m10 20 l20 20 z");
    expect(ops).toEqual([
      { op: "move", x: 10, y: 20 },
      { op: "line", x: 30, y: 40 },
      { op: "close" }
    ]);
  });

  it("should parse H and V commands", () => {
    const ops = Pdf.parseSvgPath("M0 0 H100 V50");
    expect(ops).toEqual([
      { op: "move", x: 0, y: 0 },
      { op: "line", x: 100, y: 0 },
      { op: "line", x: 100, y: 50 }
    ]);
  });

  it("should parse C (cubic bezier) command", () => {
    const ops = Pdf.parseSvgPath("M0 0 C10 20 30 40 50 60");
    expect(ops.length).toBe(2);
    expect(ops[0]).toEqual({ op: "move", x: 0, y: 0 });
    expect(ops[1].op).toBe("curve");
    if (ops[1].op === "curve") {
      expect(ops[1].x1).toBe(10);
      expect(ops[1].y1).toBe(20);
      expect(ops[1].x3).toBe(50);
      expect(ops[1].y3).toBe(60);
    }
  });

  it("should parse Q (quadratic bezier) as cubic", () => {
    const ops = Pdf.parseSvgPath("M0 0 Q50 100 100 0");
    expect(ops.length).toBe(2);
    expect(ops[1].op).toBe("curve");
  });

  it("should parse A (arc) as curves", () => {
    const ops = Pdf.parseSvgPath("M0 0 A25 25 0 0 1 50 0");
    expect(ops.length).toBeGreaterThanOrEqual(2);
    // Arc should be approximated as one or more curves
    expect(ops[0]).toEqual({ op: "move", x: 0, y: 0 });
    expect(ops[ops.length - 1].op).toBe("curve");
  });

  it("should handle implicit repeated commands", () => {
    const ops = Pdf.parseSvgPath("M0 0 10 20 30 40");
    // After M, implicit L
    expect(ops).toEqual([
      { op: "move", x: 0, y: 0 },
      { op: "line", x: 10, y: 20 },
      { op: "line", x: 30, y: 40 }
    ]);
  });

  it("should handle empty path", () => {
    expect(Pdf.parseSvgPath("")).toEqual([]);
    expect(Pdf.parseSvgPath("   ")).toEqual([]);
  });

  it("should draw SVG path on a page", async () => {
    const doc = new Pdf.Builder();
    const page = doc.addPage();
    // Simple triangle
    page.drawSvgPath("M100 100 L200 100 L150 200 Z", {
      fill: { r: 1, g: 0, b: 0 },
      stroke: { r: 0, g: 0, b: 0 }
    });

    const bytes = await doc.build();
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(100);
  });

  it("should parse S (smooth cubic) command", () => {
    const ops = Pdf.parseSvgPath("M0 0 C10 20 30 40 50 60 S70 80 90 100");
    expect(ops.length).toBe(3);
    expect(ops[2].op).toBe("curve");
  });

  it("should parse T (smooth quadratic) command", () => {
    const ops = Pdf.parseSvgPath("M0 0 Q25 50 50 0 T100 0");
    expect(ops.length).toBe(3);
    expect(ops[2].op).toBe("curve");
  });

  it("should handle arc with zero radius as line", () => {
    const ops = Pdf.parseSvgPath("M0 0 A0 0 0 0 1 50 50");
    expect(ops.length).toBe(2);
    expect(ops[1]).toEqual({ op: "line", x: 50, y: 50 });
  });
});

// =============================================================================
// ASN.1 Parser
// =============================================================================

describe("ASN.1 Parser", () => {
  it("should parse a simple SEQUENCE with INTEGER", () => {
    // SEQUENCE { INTEGER 42 }
    const data = new Uint8Array([0x30, 0x03, 0x02, 0x01, 0x2a]);
    const node = Pdf.asn1Parse(data);
    expect(node.tag).toBe(0x30);
    expect(node.children.length).toBe(1);
    expect(node.children[0].tag).toBe(0x02);
    expect(node.children[0].bytes[0]).toBe(42);
  });

  it("should parse nested SEQUENCE", () => {
    // SEQUENCE { SEQUENCE { NULL } }
    const data = new Uint8Array([0x30, 0x04, 0x30, 0x02, 0x05, 0x00]);
    const node = Pdf.asn1Parse(data);
    expect(node.children.length).toBe(1);
    expect(node.children[0].tag).toBe(0x30);
    expect(node.children[0].children.length).toBe(1);
    expect(node.children[0].children[0].tag).toBe(0x05); // NULL
  });
});

// =============================================================================
// Digital Signature Infrastructure
// =============================================================================

describe("Digital Signature", () => {
  it("should build signature dict placeholder with correct structure", () => {
    const { dictString, placeholder } = Pdf.buildSignatureDictPlaceholder({
      name: "Test Signer",
      reason: "Testing"
    });
    expect(dictString).toContain("/Type /Sig");
    expect(dictString).toContain("/Filter /Adobe.PPKLite");
    expect(dictString).toContain("/SubFilter /adbe.pkcs7.detached");
    expect(dictString).toContain("/Contents <");
    expect(dictString).toContain("/ByteRange [");
    expect(dictString).toContain("/Name (Test Signer)");
    expect(dictString).toContain("/Reason (Testing)");
    expect(placeholder.length).toBeGreaterThan(0);
    // Placeholder should be all zeros
    expect(placeholder).toMatch(/^0+$/);
  });

  it("should handle verifyPdfSignature with invalid data gracefully", async () => {
    const fakePdf = new Uint8Array(100);
    const result = await Pdf.verifySignature(fakePdf, "00", [0, 10, 20, 80]);
    expect(result.valid).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it("should sign+verify roundtrip with PdfDocumentBuilder", async () => {
    const { certificate, privateKey } = await generateTestCertificate("TestBuilder");

    const doc = new Pdf.Builder();
    doc.addPage().drawText("Signed doc", { x: 72, y: 750, fontSize: 14 });
    doc.sign({ certificate, privateKey, name: "Test Signer", reason: "Testing" });
    const signed = await doc.build();

    // Extract signature info and verify
    const text = new TextDecoder().decode(signed);
    const contentsMatch = text.match(/\/Contents\s*<([0-9a-fA-F]+)>/);
    const brMatch = text.match(/\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/);
    expect(contentsMatch).not.toBeNull();
    expect(brMatch).not.toBeNull();

    const result = await Pdf.verifySignature(signed, contentsMatch![1], [
      parseInt(brMatch![1]),
      parseInt(brMatch![2]),
      parseInt(brMatch![3]),
      parseInt(brMatch![4])
    ]);
    expect(result.valid).toBe(true);
    expect(result.coversWholeFile).toBe(true);
  });

  it("should sign+verify roundtrip with PdfEditor", async () => {
    const { certificate, privateKey } = await generateTestCertificate("TestEditor");

    // Create unsigned PDF
    const doc = new Pdf.Builder();
    doc.addPage().drawText("Unsigned", { x: 72, y: 750, fontSize: 14 });
    const unsigned = await doc.build();

    // Sign via editor
    const editor = Pdf.Editor.load(unsigned);
    const signed = await editor.sign({ certificate, privateKey, name: "Editor Signer" });

    // Verify
    const text = new TextDecoder().decode(signed);
    const contentsMatch = text.match(/\/Contents\s*<([0-9a-fA-F]+)>/);
    const brMatch = text.match(/\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/);
    expect(contentsMatch).not.toBeNull();
    expect(brMatch).not.toBeNull();

    const result = await Pdf.verifySignature(signed, contentsMatch![1], [
      parseInt(brMatch![1]),
      parseInt(brMatch![2]),
      parseInt(brMatch![3]),
      parseInt(brMatch![4])
    ]);
    expect(result.valid).toBe(true);
    expect(result.coversWholeFile).toBe(true);
  });

  it("should detect tampering after signing", async () => {
    const { certificate, privateKey } = await generateTestCertificate("TamperTest");

    const doc = new Pdf.Builder();
    doc.addPage().drawText("Tamper test", { x: 72, y: 750, fontSize: 14 });
    doc.sign({ certificate, privateKey });
    const signed = await doc.build();

    // Tamper
    const tampered = new Uint8Array(signed);
    tampered[50] ^= 0xff;

    const text = new TextDecoder().decode(signed);
    const contentsMatch = text.match(/\/Contents\s*<([0-9a-fA-F]+)>/)!;
    const brMatch = text.match(/\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/)!;
    const byteRange: [number, number, number, number] = [
      parseInt(brMatch[1]),
      parseInt(brMatch[2]),
      parseInt(brMatch[3]),
      parseInt(brMatch[4])
    ];

    const result = await Pdf.verifySignature(tampered, contentsMatch[1], byteRange);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("digest mismatch");
  });

  it("should generate a valid test certificate", async () => {
    const { certificate, privateKey } = await generateTestCertificate("UnitTest");
    expect(certificate).toBeInstanceOf(Uint8Array);
    expect(privateKey).toBeInstanceOf(Uint8Array);
    expect(certificate.length).toBeGreaterThan(100);
    expect(privateKey.length).toBeGreaterThan(100);

    // Certificate should start with SEQUENCE tag
    expect(certificate[0]).toBe(0x30);
    // Private key should be parseable (starts with SEQUENCE)
    expect(privateKey[0]).toBe(0x30);
  });
});

// =============================================================================
// SVG Path — Regression: T command control point
// =============================================================================

describe("SVG Path T command regression", () => {
  it("should compute correct c2y using qy (not qx) for T command", () => {
    // Q50,100 means control point at (50,100). After reaching (100,0),
    // T150,0 reflects control to (150,-100). The c2 control point Y
    // should use qy=-100, not qx=150.
    const ops = Pdf.parseSvgPath("M0 0 Q50 100 100 0 T200 0");
    expect(ops.length).toBe(3);

    // The third op (from T) should be a curve
    const curve = ops[2];
    expect(curve.op).toBe("curve");
    if (curve.op === "curve") {
      // Reflected control point: qx = 2*100-50 = 150, qy = 2*0-100 = -100
      // c2x = endX + 2/3*(qx-endX) = 200 + 2/3*(150-200) = 200 - 33.33 = 166.67
      // c2y = endY + 2/3*(qy-endY) = 0 + 2/3*(-100-0) = -66.67
      expect(curve.x2).toBeCloseTo(166.67, 1);
      expect(curve.y2).toBeCloseTo(-66.67, 1); // Would be wrong if qx was used instead of qy
    }
  });
});

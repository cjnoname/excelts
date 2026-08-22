/**
 * Layout precision assertions.
 *
 * Most existing layout tests check "an SVG was produced" or "the heading
 * is bigger than body text". Those are smoke tests and they let real
 * regressions slip — a bug in margin handling that shifts every line by
 * 10pt would not fail the smoke tests as long as a number is produced.
 *
 * The tests in this file pin the actual coordinates and counts so that
 * any future change to the layout engine has to confront its impact on
 * page geometry, line placement, and pagination explicitly.
 */

import { getFontAscent, getFontDescent, styledFontVariant } from "@utils/font-metrics";
import { describe, it, expect } from "vitest";

import { layoutDocument } from "../layout/layout";
import { SCRIPT_BASELINE_SHIFT_FACTOR } from "../layout/layout-constants";
import { layoutDocumentFull } from "../layout/layout-full";
import type { DocxDocument, Paragraph, SectionProperties, TableProperties } from "../types";

const HALF_PT_12 = 24; // 12pt body text in half-points

const makeRun = (textValue: string): Paragraph["children"][number] => ({
  content: [{ type: "text", text: textValue }],
  properties: { size: HALF_PT_12 }
});

const makeParagraph = (textValue: string): Paragraph => ({
  type: "paragraph",
  children: [makeRun(textValue)]
});

describe("layoutDocumentFull — page geometry", () => {
  it("uses default US Letter geometry when section properties are omitted", () => {
    const doc: DocxDocument = { body: [makeParagraph("hello")] };
    const out = layoutDocumentFull(doc);
    const page = out.pages[0]!;
    const g = page.geometry;

    // 12240 twips × 11×72 = 8.5 in × 11 in = 612pt × 792pt (US Letter)
    expect(g.width).toBeCloseTo(612, 5);
    expect(g.height).toBeCloseTo(792, 5);
    // 1 in margins = 72pt each side
    expect(g.marginTop).toBeCloseTo(72, 5);
    expect(g.marginBottom).toBeCloseTo(72, 5);
    expect(g.marginLeft).toBeCloseTo(72, 5);
    expect(g.marginRight).toBeCloseTo(72, 5);
    // Content area = 612 − 72 − 72 = 468pt wide, 792 − 144 = 648pt tall
    expect(g.contentWidth).toBeCloseTo(468, 5);
    expect(g.contentHeight).toBeCloseTo(648, 5);
  });

  it("respects explicit page size and margins", () => {
    // A4 in twips: 11906 × 16838; 0.5 in margins = 720 twips
    const sectionProperties: SectionProperties = {
      pageSize: { width: 11906, height: 16838 },
      margins: { top: 720, bottom: 720, left: 720, right: 720 }
    };
    const doc: DocxDocument = {
      body: [makeParagraph("a")],
      sectionProperties
    };
    const out = layoutDocumentFull(doc);
    const g = out.pages[0]!.geometry;

    // 11906 / 20 ≈ 595.3pt, 16838 / 20 ≈ 841.9pt (A4)
    expect(g.width).toBeCloseTo(595.3, 1);
    expect(g.height).toBeCloseTo(841.9, 1);
    expect(g.marginTop).toBeCloseTo(36, 5);
    expect(g.marginLeft).toBeCloseTo(36, 5);
    // Content area: 595.3 − 36 − 36 ≈ 523.3
    expect(g.contentWidth).toBeCloseTo(523.3, 1);
  });
});

describe("layoutDocumentFull — paragraph placement", () => {
  it("places the first paragraph relative to the content origin", () => {
    const doc: DocxDocument = { body: [makeParagraph("first line")] };
    const out = layoutDocumentFull(doc);
    const page = out.pages[0]!;
    const para = page.content.find(c => c.type === "paragraph");
    expect(para).toBeDefined();
    if (!para || para.type !== "paragraph") {
      throw new Error("expected paragraph");
    }

    // The layout engine reports `rect` in content-area coordinates
    // (0,0 = top-left of the usable area, so margins are NOT included).
    // Either convention is fine, but we pin it explicitly so a future
    // change to the convention forces the renderers to follow.
    expect(para.rect.x).toBeCloseTo(0, 1);
    expect(para.rect.y).toBeCloseTo(0, 1);
    // Width must fit inside the content area (468pt for default Letter+1in).
    expect(para.rect.width).toBeLessThanOrEqual(page.geometry.contentWidth + 0.01);
  });

  it("stacks consecutive paragraphs vertically with non-overlapping y", () => {
    const doc: DocxDocument = {
      body: [
        makeParagraph("first paragraph"),
        makeParagraph("second paragraph"),
        makeParagraph("third paragraph")
      ]
    };
    const out = layoutDocumentFull(doc);
    const paras = out.pages[0]!.content.filter(c => c.type === "paragraph");
    expect(paras.length).toBe(3);

    let prevBottom = 0;
    for (const p of paras) {
      if (p.type !== "paragraph") {
        continue;
      }
      // Each paragraph must start at or below the previous paragraph's bottom.
      expect(p.rect.y).toBeGreaterThanOrEqual(prevBottom - 0.01);
      // And produce at least one positive-height line.
      expect(p.rect.height).toBeGreaterThan(0);
      prevBottom = p.rect.y + p.rect.height;
    }
  });

  it("at least one line per paragraph; 12pt body has line height ≥ 12pt", () => {
    const doc: DocxDocument = { body: [makeParagraph("the quick brown fox")] };
    const out = layoutDocumentFull(doc);
    const para = out.pages[0]!.content.find(c => c.type === "paragraph");
    if (!para || para.type !== "paragraph") {
      throw new Error("expected paragraph");
    }

    expect(para.lines.length).toBeGreaterThanOrEqual(1);
    const firstLine = para.lines[0]!;
    expect(firstLine.height).toBeGreaterThanOrEqual(12);
    // The baseline must be inside the line box (not above it, not below).
    expect(firstLine.baseline).toBeGreaterThan(0);
    expect(firstLine.baseline).toBeLessThanOrEqual(firstLine.height);
  });

  it("splits a line box's leading evenly above and below the ink", () => {
    const doc: DocxDocument = { body: [makeParagraph("Hello gjpqy")] };
    const out = layoutDocumentFull(doc);
    const para = out.pages[0]!.content.find(c => c.type === "paragraph");
    if (!para || para.type !== "paragraph") {
      throw new Error("expected paragraph");
    }
    const line = para.lines[0]!;

    const face = styledFontVariant("Calibri", false, false);
    const ascent = getFontAscent(face, 12);
    const descent = getFontDescent(face, 12);

    // `baseline` is measured from the top of the line box, so the space above
    // the ascent and below the descender are the two halves of the leading and
    // must match. Deriving the baseline from a fraction of the box height
    // instead (it used to be 0.8) leaves almost nothing under the descender,
    // and the text sinks against the following line.
    const above = line.baseline - ascent;
    const below = line.height - line.baseline + descent;
    expect(above).toBeCloseTo(below, 6);
    expect(line.baseline).toBeCloseTo((line.height - (ascent - descent)) / 2 + ascent, 6);
  });

  it("uses text-aware metrics and keeps exact line spacing exact", () => {
    const para: Paragraph = {
      type: "paragraph",
      properties: { spacing: { line: 160, lineRule: "exact" } },
      children: [makeRun("fallback glyph")]
    };
    const measured: string[] = [];
    const out = layoutDocumentFull(
      { body: [para] },
      {
        measureTextMetrics: text => {
          measured.push(text);
          return { ascent: 11, descent: -4 };
        }
      }
    );
    const laid = out.pages[0]!.content.find(c => c.type === "paragraph");
    if (!laid || laid.type !== "paragraph") {
      throw new Error("expected paragraph");
    }
    const line = laid.lines[0]!;

    expect(measured).toContain("fallback glyph");
    // 160 twips = 8pt. The 15pt ink does not silently turn an exact line into
    // an at-least line — the box stays 8pt so everything after it keeps its
    // position — while the baseline stays where the ink puts it, so the glyphs
    // overlap their neighbours rather than being sliced.
    expect(line.height).toBe(8);
    expect(line.baseline).toBe(11);
  });

  it("keeps pagination and positioned layout consistent for tall embedded-font ink", () => {
    const doc: DocxDocument = {
      body: Array.from({ length: 50 }, (_, i) => makeParagraph(`line ${i}`))
    };
    const options = {
      // Deliberately much taller than the nominal 14.4pt line. Before the
      // pagination pass consumed the same metrics as full layout, it fitted 45
      // of these on a page while the positioned pass could fit only 21.
      measureTextMetrics: () => ({ ascent: 24, descent: -6 })
    };

    const paginated = layoutDocument(doc, options);
    const positioned = layoutDocumentFull(doc, options);

    expect(paginated.pageCount).toBe(3);
    expect(positioned.pages).toHaveLength(paginated.pageCount);
    for (const page of positioned.pages) {
      for (const item of page.content) {
        expect(item.rect.y + item.rect.height).toBeLessThanOrEqual(
          page.geometry.contentHeight + 1e-6
        );
      }
    }
  });

  it("includes superscript rise and subscript drop in automatic line extents", () => {
    const scripted = (vertAlign: "superscript" | "subscript"): Paragraph => ({
      type: "paragraph",
      children: [
        {
          content: [{ type: "text", text: vertAlign }],
          properties: { size: HALF_PT_12, vertAlign }
        }
      ]
    });
    const normal = layoutDocumentFull({ body: [makeParagraph("normal")] }).pages[0].content[0];
    const sup = layoutDocumentFull({ body: [scripted("superscript")] }).pages[0].content[0];
    const sub = layoutDocumentFull({ body: [scripted("subscript")] }).pages[0].content[0];
    if (normal.type !== "paragraph" || sup.type !== "paragraph" || sub.type !== "paragraph") {
      throw new Error("expected paragraphs");
    }

    // Scripts draw at 65%, and their exact renderer shift participates in the
    // same line extents. Reconstruct each shifted ink box and prove both edges
    // remain inside the line.
    const scriptSize = 12 * 0.65;
    const face = styledFontVariant("Calibri", false, false);
    const ascent = getFontAscent(face, scriptSize);
    const descent = getFontDescent(face, scriptSize);
    const shift = scriptSize * SCRIPT_BASELINE_SHIFT_FACTOR;
    const supLine = sup.lines[0]!;
    const subLine = sub.lines[0]!;
    expect(supLine.baseline - (ascent + shift)).toBeGreaterThanOrEqual(-1e-10);
    expect(supLine.baseline - (descent + shift)).toBeLessThanOrEqual(supLine.height + 1e-10);
    expect(subLine.baseline - (ascent - shift)).toBeGreaterThanOrEqual(-1e-10);
    expect(subLine.baseline - (descent - shift)).toBeLessThanOrEqual(subLine.height + 1e-10);
    expect(supLine.baseline).toBeGreaterThan(subLine.baseline);
  });
});

describe("layoutDocumentFull — style resolution", () => {
  // A minimal styles table shaped like the one `markdownToDocx` emits: the
  // spacing and font size live on the *style*, not on the paragraph.
  const styledDoc = (body: readonly Paragraph[]): DocxDocument => ({
    body,
    docDefaults: {
      paragraphProperties: { spacing: { after: 160, line: 259, lineRule: "auto" } },
      runProperties: { size: 22 }
    },
    styles: [
      { type: "paragraph", styleId: "Normal", name: "Normal", isDefault: true },
      {
        type: "paragraph",
        styleId: "Heading1",
        name: "heading 1",
        basedOn: "Normal",
        paragraphProperties: { spacing: { before: 480, after: 120 }, outlineLevel: 0 },
        runProperties: { size: 48, bold: true }
      },
      {
        type: "paragraph",
        styleId: "Quote",
        name: "Quote",
        basedOn: "Normal",
        paragraphProperties: { indent: { left: 720 } }
      }
    ]
  });

  const styled = (styleId: string, text: string): Paragraph => ({
    type: "paragraph",
    properties: { style: styleId },
    children: [{ content: [{ type: "text", text }] }]
  });

  const firstTextRun = (para: { lines: readonly { runs: readonly unknown[] }[] }, line = 0) => {
    const run = para.lines[line]!.runs[0]! as { type?: string };
    if (run.type === "image") {
      throw new Error("expected a text run");
    }
    return run as {
      text: string;
      x: number;
      width: number;
      fontSize: number;
      bold?: boolean;
      font?: string;
    };
  };

  it("honours spacing.before / spacing.after supplied by the paragraph style", () => {
    const out = layoutDocumentFull(
      styledDoc([styled("Normal", "body"), styled("Heading1", "Heading"), styled("Normal", "body")])
    );
    const paras = out.pages[0]!.content.filter(c => c.type === "paragraph");
    const [first, heading] = paras;
    if (first?.type !== "paragraph" || heading?.type !== "paragraph") {
      throw new Error("expected paragraphs");
    }

    // Heading1 contributes 480 twips (24pt) of space before. The engine folds
    // it into the paragraph's own box, so the heading's first line sits 24pt
    // below the top of that box — and the box starts at the previous bottom.
    expect(heading.rect.y).toBeCloseTo(first.rect.y + first.rect.height, 1);
    expect(heading.lines[0]!.y).toBeCloseTo(24, 1);

    // …and 120 twips (6pt) after, on top of its single line box.
    const trailing = heading.rect.height - heading.lines[0]!.height;
    expect(trailing).toBeCloseTo(24 + 6, 1);
  });

  it("honours indent supplied by the paragraph style", () => {
    const out = layoutDocumentFull(styledDoc([styled("Quote", "quoted text")]));
    const para = out.pages[0]!.content.find(c => c.type === "paragraph");
    if (para?.type !== "paragraph") {
      throw new Error("expected paragraph");
    }
    // 720 twips = 36pt of left indent, applied to the line's first run.
    expect(firstTextRun(para).x).toBeCloseTo(36, 1);
  });

  it("scales line height with the paragraph's own font size, not a document constant", () => {
    const out = layoutDocumentFull(
      styledDoc([styled("Heading1", "Heading"), styled("Normal", "body")])
    );
    const paras = out.pages[0]!.content.filter(c => c.type === "paragraph");
    const [heading, body] = paras;
    if (heading?.type !== "paragraph" || body?.type !== "paragraph") {
      throw new Error("expected paragraphs");
    }

    // Heading1 is 24pt (48 half-points); its line box must be taller than the
    // glyphs it holds, and much taller than the 11pt body line.
    expect(firstTextRun(heading).fontSize).toBeCloseTo(24, 5);
    expect(heading.lines[0]!.height).toBeGreaterThan(24);
    expect(heading.lines[0]!.height).toBeGreaterThan(body.lines[0]!.height * 1.5);
  });

  it("applies spacing.line as a multiple of the paragraph's natural line height", () => {
    const single: Paragraph = {
      type: "paragraph",
      children: [{ content: [{ type: "text", text: "x" }], properties: { size: 40 } }]
    };
    const doubled: Paragraph = {
      type: "paragraph",
      properties: { spacing: { line: 480, lineRule: "auto" } },
      children: [{ content: [{ type: "text", text: "x" }], properties: { size: 40 } }]
    };
    const out = layoutDocumentFull({ body: [single, doubled] });
    const paras = out.pages[0]!.content.filter(c => c.type === "paragraph");
    const [a, b] = paras;
    if (a?.type !== "paragraph" || b?.type !== "paragraph") {
      throw new Error("expected paragraphs");
    }
    // 20pt text → 24pt natural line; line=480 (2×) → 48pt.
    expect(a.lines[0]!.height).toBeCloseTo(24, 1);
    expect(b.lines[0]!.height).toBeCloseTo(48, 1);
  });

  it("resolves a run's character style chain (w:rStyle)", () => {
    // Word records `Strong`, `Emphasis`, `Hyperlink`, `Code Char` … as
    // *character* styles on the run. Consulting only the paragraph style made
    // them invisible: a `Strong` run drew at body weight and a run sized by a
    // character style was measured with body-text metrics.
    const doc: DocxDocument = {
      body: [
        {
          type: "paragraph",
          children: [
            { content: [{ type: "text", text: "plain " }] },
            { properties: { style: "Strong" }, content: [{ type: "text", text: "strong " }] },
            { properties: { style: "BigCode" }, content: [{ type: "text", text: "big" }] }
          ]
        }
      ],
      styles: [
        { type: "character", styleId: "Strong", name: "Strong", runProperties: { bold: true } },
        {
          type: "character",
          styleId: "BigCode",
          name: "Big Code",
          runProperties: { size: 48, font: "Courier New", color: "FF0000" }
        }
      ]
    };
    const para = layoutDocumentFull(doc).pages[0]!.content[0]!;
    if (para.type !== "paragraph") {
      throw new Error("expected paragraph");
    }
    const runs = para.lines[0]!.runs.filter(r => !("type" in r && r.type === "image"));
    expect(runs[0]).toMatchObject({ text: "plain " });
    expect((runs[0] as { bold?: boolean }).bold).toBeUndefined();
    expect(runs[1]).toMatchObject({ text: "strong ", bold: true });
    expect(runs[2]).toMatchObject({
      text: "big",
      font: "Courier New",
      fontSize: 24,
      color: "FF0000"
    });
    // The 24pt character-styled run must also drive the line box.
    expect(para.lines[0]!.height).toBeCloseTo(28.8, 1);

    // The first pagination pass resolves that same character style. If it read
    // raw run properties, the metrics callback would see 11pt Calibri instead
    // of 24pt Courier and could make different page/keep-next decisions.
    const seen: Array<{ font: string; size: number; bold?: boolean }> = [];
    layoutDocument(doc, {
      measureTextMetrics: (_text, font, size, bold) => {
        seen.push({ font, size, bold });
        return { ascent: size * 0.8, descent: -size * 0.2 };
      }
    });
    expect(seen).toContainEqual({ font: "Courier New", size: 24, bold: undefined });
    expect(seen).toContainEqual({ font: "Calibri", size: 11, bold: true });
  });

  it("indents a list from the numbering level definition", () => {
    // Real lists carry their geometry in `w:lvl/w:pPr/w:ind`; the hardcoded
    // half-inch-per-level fallback ignored it.
    const doc: DocxDocument = {
      body: [
        {
          type: "paragraph",
          properties: { numbering: { numId: 1, level: 0 } },
          children: [{ content: [{ type: "text", text: "listed" }] }]
        }
      ],
      numberingInstances: [{ numId: 1, abstractNumId: 1 }],
      abstractNumberings: [
        {
          abstractNumId: 1,
          levels: [
            {
              level: 0,
              format: "bullet",
              text: "\u2022",
              paragraphProperties: { indent: { left: 2160, hanging: 360 } }
            }
          ]
        }
      ]
    };
    const para = layoutDocumentFull(doc).pages[0]!.content[0]!;
    if (para.type !== "paragraph") {
      throw new Error("expected paragraph");
    }
    // 2160 twips = 108pt, not the 36pt the per-level convention would give.
    // The marker hangs left of that column by its own width so the text it
    // precedes lands exactly on the indent.
    const marker = firstTextRun(para);
    expect(marker.x).toBeLessThan(108);
    expect(marker.x + marker.width).toBeCloseTo(108, 1);
  });

  it("applies a table style's conditional formatting to cell text", () => {
    // Word's built-in table styles put the header row's bold and the banded
    // rows' shading in `tableStyleConditions`, resolved per cell position.
    const cellPara = (text: string): Paragraph => ({
      type: "paragraph",
      children: [{ content: [{ type: "text", text }] }]
    });
    const doc: DocxDocument = {
      body: [
        {
          type: "table",
          properties: { style: "GridTable", look: { firstRow: true } },
          rows: [
            { cells: [{ content: [cellPara("HEADER")] }] },
            { cells: [{ content: [cellPara("row one")] }] },
            { cells: [{ content: [cellPara("row two")] }] }
          ]
        }
      ],
      styles: [
        {
          type: "table",
          styleId: "GridTable",
          name: "Grid Table",
          tableStyleConditions: [
            { type: "firstRow", runProperties: { bold: true, size: 40 } },
            { type: "evenRowBanding", runProperties: { italic: true } }
          ]
        }
      ]
    };
    const table = layoutDocumentFull(doc).pages[0]!.content[0]!;
    if (table.type !== "table") {
      throw new Error("expected table");
    }
    const runOfRow = (row: number) => {
      const cell = table.cells.find(c => c.row === row)!;
      const para = cell.content[0]!;
      if (para.type !== "paragraph") {
        throw new Error("expected paragraph");
      }
      return para.lines[0]!.runs[0]! as { bold?: boolean; italic?: boolean; fontSize: number };
    };
    expect(runOfRow(0)).toMatchObject({ bold: true, fontSize: 20 });
    expect(runOfRow(1)).toMatchObject({ italic: true });
    expect(runOfRow(2).bold).toBeUndefined();
  });

  it("collapses spacing between same-style paragraphs under contextualSpacing", () => {
    // `w:contextualSpacing` is how Word keeps a list tight while still
    // separating it from the body text around it (its `ListParagraph` sets it).
    const p = (styleId: string, text: string): Paragraph => ({
      type: "paragraph",
      properties: { style: styleId },
      children: [{ content: [{ type: "text", text }] }]
    });
    const doc = (contextual: boolean): DocxDocument => ({
      body: [p("Body", "intro"), p("List", "one"), p("List", "two"), p("List", "three")],
      styles: [
        { type: "paragraph", styleId: "Body", name: "Body" },
        {
          type: "paragraph",
          styleId: "List",
          name: "List",
          paragraphProperties: {
            spacing: { before: 200, after: 200 },
            ...(contextual ? { contextualSpacing: true } : {})
          }
        }
      ]
    });

    const heights = (contextual: boolean) =>
      layoutDocumentFull(doc(contextual)).pages[0]!.content.map(b => b.rect.height);

    const loose = heights(false);
    const tight = heights(true);

    // Without the flag all three list items carry before+after (10pt each).
    expect(loose[1]).toBeCloseTo(loose[2]!, 1);
    expect(loose[2]).toBeCloseTo(loose[3]!, 1);
    // With it, the middle item loses both, the first keeps its space-before
    // (the paragraph above uses a different style) and the last its space-after.
    expect(tight[2]).toBeLessThan(tight[1]!);
    expect(tight[2]).toBeLessThan(tight[3]!);
    expect(tight[2]).toBeCloseTo(loose[2]! - 20, 1);
  });

  it("gives full-width text a full em so it cannot overlap what follows", () => {
    // Ideographs are drawn one em wide by whatever face the renderer
    // substitutes. Measuring them with the Latin average understated a CJK run
    // by half, and the run positioned after it landed on top of the glyphs.
    const para: Paragraph = {
      type: "paragraph",
      children: [
        { content: [{ type: "text", text: "\u4e2d\u6587\u6d4b\u8bd5" }], properties: { size: 22 } },
        { content: [{ type: "text", text: "after" }], properties: { size: 22 } }
      ]
    };
    const laid = layoutDocumentFull({ body: [para] }).pages[0]!.content[0]!;
    if (laid.type !== "paragraph") {
      throw new Error("expected paragraph");
    }
    const runs = laid.lines[0]!.runs.filter(r => !("type" in r && r.type === "image")) as {
      text: string;
      x: number;
      width: number;
    }[];
    // 4 ideographs at 11pt = 44pt exactly.
    expect(runs[0]!.width).toBeCloseTo(44, 3);
    // …and the next run starts where the first one ends, not inside it.
    expect(runs[1]!.x).toBeCloseTo(runs[0]!.x + runs[0]!.width, 3);
  });

  it("starts a new line at a hard break", () => {
    // `<w:br/>` (markdown's fenced code blocks, Word's Shift+Enter) used to be
    // encoded as a "\n" inside the text, which the wrap engines split on
    // `/\s+/` and swallowed as ordinary whitespace — so every hard break
    // vanished and a code block collapsed onto one line.
    const para: Paragraph = {
      type: "paragraph",
      children: [
        {
          content: [
            { type: "text", text: "one" },
            { type: "break" },
            { type: "text", text: "two" },
            { type: "break" },
            { type: "text", text: "three" }
          ]
        }
      ]
    };
    const laid = layoutDocumentFull({ body: [para] }).pages[0]!.content[0]!;
    if (laid.type !== "paragraph") {
      throw new Error("expected paragraph");
    }
    const text = laid.lines.map(l => l.runs.map(r => ("text" in r ? r.text : "")).join(""));
    expect(text).toEqual(["one", "two", "three"]);
    // Successive lines must actually step down the page.
    expect(laid.lines[1]!.y).toBeGreaterThan(laid.lines[0]!.y);
    expect(laid.lines[2]!.y).toBeGreaterThan(laid.lines[1]!.y);
  });

  it("insets cell content by the resolved cell margins", () => {
    // `w:tblCellMar` / `w:tcMar` were ignored in favour of a hardcoded 2pt that
    // was only ever subtracted from the wrap *width* — the left margin never
    // reached the content's x origin, so text sat flush against the border.
    const cp = (text: string): Paragraph => ({
      type: "paragraph",
      children: [{ content: [{ type: "text", text }] }]
    });
    const table = (properties?: TableProperties): DocxDocument => ({
      body: [
        {
          type: "table",
          properties,
          rows: [{ cells: [{ content: [cp("Name")] }, { content: [cp("Value")] }] }]
        }
      ]
    });
    const textX = (doc: DocxDocument) => {
      const laid = layoutDocumentFull(doc).pages[0]!.content[0]!;
      if (laid.type !== "table") {
        throw new Error("expected table");
      }
      const cell = laid.cells[0]!;
      const block = cell.content[0]!;
      return { x: cell.rect.x + block.rect.x, height: cell.rect.height };
    };

    // Word's default: 108 twips = 5.4pt left, nothing top/bottom.
    expect(textX(table()).x).toBeCloseTo(5.4, 3);

    // A declared `w:tblCellMar` wins over the default, on all four sides.
    const declared = textX(
      table({
        cellMargins: {
          top: { value: 200, type: "dxa" },
          bottom: { value: 200, type: "dxa" },
          left: { value: 200, type: "dxa" },
          right: { value: 200, type: "dxa" }
        }
      })
    );
    expect(declared.x).toBeCloseTo(10, 3);
    // 13.2pt line + 10pt top + 10pt bottom.
    expect(declared.height).toBeCloseTo(33.2, 1);

    // `type: "nil"` is an explicit zero, not "unset".
    expect(
      textX(
        table({
          cellMargins: { left: { value: 0, type: "nil" }, right: { value: 0, type: "nil" } }
        })
      ).x
    ).toBeCloseTo(0, 3);
  });

  it("lets a cell's own w:tcMar override the table's w:tblCellMar", () => {
    const cp = (text: string): Paragraph => ({
      type: "paragraph",
      children: [{ content: [{ type: "text", text }] }]
    });
    const doc: DocxDocument = {
      body: [
        {
          type: "table",
          properties: { cellMargins: { left: { value: 108, type: "dxa" } } },
          rows: [
            {
              cells: [
                {
                  properties: { margins: { left: { value: 720, type: "dxa" } } },
                  content: [cp("indented")]
                },
                { content: [cp("default")] }
              ]
            }
          ]
        }
      ]
    };
    const laid = layoutDocumentFull(doc).pages[0]!.content[0]!;
    if (laid.type !== "table") {
      throw new Error("expected table");
    }
    const inset = (col: number) => {
      const cell = laid.cells.find(c => c.col === col)!;
      return cell.content[0]!.rect.x;
    };
    expect(inset(0)).toBeCloseTo(36, 3); // 720 twips
    expect(inset(1)).toBeCloseTo(5.4, 3); // table default
  });

  it("fills cell backgrounds from the table style's conditional formats", () => {
    // `LayoutTableCell.backgroundColor` existed and both renderers drew it, but
    // nothing ever populated it — so every table came out white, and Word's
    // built-in table styles lost their header band and row stripes entirely.
    const cp = (text: string): Paragraph => ({
      type: "paragraph",
      children: [{ content: [{ type: "text", text }] }]
    });
    const row = (label: string) => ({
      cells: [{ content: [cp(label)] }, { content: [cp("v")] }]
    });
    const doc: DocxDocument = {
      body: [
        {
          type: "table",
          properties: { style: "GridTable", look: { firstRow: true, lastRow: true } },
          rows: [row("head"), row("a"), row("b"), row("c"), row("last")]
        }
      ],
      styles: [
        {
          type: "table",
          styleId: "GridTable",
          name: "Grid Table",
          tableProperties: { shading: { fill: "FFFFFF" } },
          tableStyleConditions: [
            { type: "firstRow", cellProperties: { shading: { fill: "4472C4" } } },
            { type: "oddRowBanding", cellProperties: { shading: { fill: "D9E2F3" } } },
            { type: "lastRow", cellProperties: { shading: { fill: "8EAADB" } } }
          ]
        }
      ]
    };
    const laid = layoutDocumentFull(doc).pages[0]!.content[0]!;
    if (laid.type !== "table") {
      throw new Error("expected table");
    }
    const fills = laid.cells.filter(c => c.col === 0).map(c => c.backgroundColor);
    // Header band, base fill, banded row, base fill, last-row band.
    expect(fills).toEqual(["4472C4", "FFFFFF", "D9E2F3", "FFFFFF", "8EAADB"]);
  });

  it("lets direct cell shading override — and explicitly clear — a style's fill", () => {
    const cp = (text: string): Paragraph => ({
      type: "paragraph",
      children: [{ content: [{ type: "text", text }] }]
    });
    const doc: DocxDocument = {
      body: [
        {
          type: "table",
          properties: { style: "S", look: { firstRow: true } },
          rows: [
            {
              cells: [
                { content: [cp("styled")] },
                {
                  properties: { shading: { fill: "FF0000" } },
                  content: [cp("own colour")]
                },
                {
                  // `w:shd w:val="clear" w:fill="auto"` is how Word records "no
                  // shading here", so it must beat the style rather than being
                  // mistaken for "unspecified".
                  properties: { shading: { fill: "auto", pattern: "clear" } },
                  content: [cp("cleared")]
                },
                {
                  properties: { shading: { fill: "112233", pattern: "nil" } },
                  content: [cp("nil pattern")]
                }
              ]
            }
          ]
        }
      ],
      styles: [
        {
          type: "table",
          styleId: "S",
          name: "S",
          tableStyleConditions: [
            { type: "firstRow", cellProperties: { shading: { fill: "4472C4" } } }
          ]
        }
      ]
    };
    const laid = layoutDocumentFull(doc).pages[0]!.content[0]!;
    if (laid.type !== "table") {
      throw new Error("expected table");
    }
    expect(laid.cells.map(c => c.backgroundColor)).toEqual([
      "4472C4",
      "FF0000",
      undefined,
      undefined
    ]);
  });

  it("inherits the table's own shading and expands short hex", () => {
    const cp = (text: string): Paragraph => ({
      type: "paragraph",
      children: [{ content: [{ type: "text", text }] }]
    });
    const laid = layoutDocumentFull({
      body: [
        {
          type: "table",
          properties: { shading: { fill: "00FF00" } },
          rows: [{ cells: [{ content: [cp("a")] }, { content: [cp("b")] }] }]
        }
      ]
    }).pages[0]!.content[0]!;
    if (laid.type !== "table") {
      throw new Error("expected table");
    }
    expect(laid.cells.map(c => c.backgroundColor)).toEqual(["00FF00", "00FF00"]);

    const short = layoutDocumentFull({
      body: [
        {
          type: "table",
          rows: [{ cells: [{ properties: { shading: { fill: "f00" } }, content: [cp("x")] }] }]
        }
      ]
    }).pages[0]!.content[0]!;
    if (short.type !== "table") {
      throw new Error("expected table");
    }
    // Normalised to a canonical upper-case six-digit form.
    expect(short.cells[0]!.backgroundColor).toBe("FF0000");
  });

  it("paginates styled content so no page overflows its content area", () => {
    // The paginator (layout.ts) and the positioner (layout-full.ts) compute
    // heights independently and must agree. When the paginator ignored the
    // style chain it saw every heading as default-sized body text with no
    // spacing, packed ~40% too much onto each page, and the positioner — which
    // does resolve styles — ran ~265pt past the bottom margin.
    const body: Paragraph[] = [];
    for (let i = 0; i < 40; i++) {
      body.push(styled("Heading1", `Section ${i}`));
      body.push(styled("Normal", `Body text for section ${i}, long enough to wrap once or twice.`));
    }
    const out = layoutDocumentFull(styledDoc(body));
    expect(out.totalPages).toBeGreaterThan(1);

    for (const page of out.pages) {
      let bottom = 0;
      for (const block of page.content) {
        bottom = Math.max(bottom, block.rect.y + block.rect.height);
      }
      expect(bottom).toBeLessThanOrEqual(page.geometry.contentHeight + 0.01);
    }
  });
});

describe("layoutDocumentFull — splitting blocks across pages", () => {
  it("splits a paragraph taller than the page instead of running off it", () => {
    // The paginator's item→page map holds one page per body item, so a block
    // taller than a page used to overflow the bottom margin by whatever it
    // could not fit. Pass 2 owns the fit decision and splits on a line edge.
    const long: Paragraph = {
      type: "paragraph",
      children: [{ content: [{ type: "text", text: "word ".repeat(3000) }] }]
    };
    const out = layoutDocumentFull({ body: [long] });
    expect(out.totalPages).toBeGreaterThan(1);

    let splitLines = 0;
    for (const page of out.pages) {
      let bottom = 0;
      for (const block of page.content) {
        bottom = Math.max(bottom, block.rect.y + block.rect.height);
        if (block.type === "paragraph") {
          splitLines += block.lines.length;
        }
      }
      expect(bottom).toBeLessThanOrEqual(page.geometry.contentHeight + 0.01);
    }

    // Splitting must neither drop nor duplicate a line: laid out on a page tall
    // enough to hold the whole paragraph, the line count has to match.
    const unsplit = layoutDocumentFull(
      { body: [long] },
      { pageGeometry: { pageHeight: 20000, marginTop: 0, marginBottom: 0 } }
    );
    const wholeParagraph = unsplit.pages[0]!.content[0]!;
    if (wholeParagraph.type !== "paragraph") {
      throw new Error("expected paragraph");
    }
    expect(splitLines).toBe(wholeParagraph.lines.length);
  });

  it("splits a long table on a row edge and repeats its header row", () => {
    const cellPara = (text: string): Paragraph => ({
      type: "paragraph",
      children: [{ content: [{ type: "text", text }] }]
    });
    const rows = [
      {
        properties: { tableHeader: true },
        cells: [{ content: [cellPara("Name")] }, { content: [cellPara("Value")] }]
      }
    ];
    for (let i = 0; i < 80; i++) {
      rows.push({
        properties: { tableHeader: false },
        cells: [{ content: [cellPara(`row ${i}`)] }, { content: [cellPara(`v${i}`)] }]
      });
    }
    const out = layoutDocumentFull({ body: [{ type: "table", rows }] });
    expect(out.totalPages).toBeGreaterThan(1);

    for (const page of out.pages) {
      const table = page.content.find(b => b.type === "table");
      if (!table || table.type !== "table") {
        continue;
      }
      // Fits the page…
      expect(table.rect.y + table.rect.height).toBeLessThanOrEqual(
        page.geometry.contentHeight + 0.01
      );
      // …and every continuation starts with the repeated header row.
      const topRow = Math.min(...table.cells.map(c => c.row));
      const header = table.cells.filter(c => c.row === topRow);
      const label = header
        .map(c => {
          const para = c.content[0];
          return para && para.type === "paragraph"
            ? para.lines[0]!.runs.map(r => ("text" in r ? r.text : "")).join("")
            : "";
        })
        .join("|");
      expect(label).toBe("Name|Value");
    }
  });

  it("keeps a short table whole", () => {
    const cellPara = (text: string): Paragraph => ({
      type: "paragraph",
      children: [{ content: [{ type: "text", text }] }]
    });
    const out = layoutDocumentFull({
      body: [
        {
          type: "table",
          rows: [
            { cells: [{ content: [cellPara("a")] }, { content: [cellPara("b")] }] },
            { cells: [{ content: [cellPara("1")] }, { content: [cellPara("2")] }] }
          ]
        }
      ]
    });
    expect(out.totalPages).toBe(1);
    const table = out.pages[0]!.content.find(b => b.type === "table")!;
    expect(table.type).toBe("table");
    if (table.type === "table") {
      expect(new Set(table.cells.map(c => c.row)).size).toBe(2);
    }
  });

  it("fills each page before starting the next", () => {
    // The positioner also has to pull content *forward*. Selecting items by the
    // paginator's page number left a page stopping early — sometimes hundreds of
    // points short — whenever the estimate had been too pessimistic.
    const body: Paragraph[] = [];
    for (let i = 0; i < 120; i++) {
      body.push({
        type: "paragraph",
        children: [{ content: [{ type: "text", text: `paragraph number ${i}` }] }]
      });
    }
    const out = layoutDocumentFull({ body });
    expect(out.totalPages).toBeGreaterThan(1);

    // Every page but the last must be filled to within one line of the bottom.
    for (let i = 0; i < out.pages.length - 1; i++) {
      const page = out.pages[i]!;
      let bottom = 0;
      let tallestLine = 0;
      for (const block of page.content) {
        bottom = Math.max(bottom, block.rect.y + block.rect.height);
        if (block.type === "paragraph") {
          for (const line of block.lines) {
            tallestLine = Math.max(tallestLine, line.height);
          }
        }
      }
      const unused = page.geometry.contentHeight - bottom;
      expect(unused).toBeLessThan(tallestLine * 2);
    }
  });

  it("honours an explicit page break even when the page has room left", () => {
    // A forced break is the one thing the positioner must not second-guess.
    const p = (text: string): Paragraph => ({
      type: "paragraph",
      children: [{ content: [{ type: "text", text }] }]
    });
    const out = layoutDocumentFull({
      body: [
        p("one"),
        {
          type: "paragraph",
          properties: { pageBreakBefore: true },
          children: [{ content: [{ type: "text", text: "two" }] }]
        },
        p("three"),
        {
          type: "paragraph",
          children: [
            {
              content: [
                { type: "break", breakType: "page" },
                { type: "text", text: "four" }
              ]
            }
          ]
        }
      ]
    });
    expect(out.totalPages).toBe(3);
    const textOf = (index: number) =>
      out.pages[index]!.content.flatMap(b =>
        b.type === "paragraph"
          ? b.lines.flatMap(l => l.runs.map(r => ("text" in r ? r.text : "")))
          : []
      ).join("");
    expect(textOf(0)).toContain("one");
    expect(textOf(1)).toContain("two");
    expect(textOf(1)).toContain("three");
    expect(textOf(2)).toContain("four");
  });
});

describe("layoutDocumentFull — paragraph decoration and indents", () => {
  const para = (text: string, properties?: Paragraph["properties"]): Paragraph => ({
    type: "paragraph",
    properties,
    children: [{ content: [{ type: "text", text }] }]
  });

  it("resolves paragraph borders and shading onto the layout model", () => {
    // A heading rule, a block quote's bar and a code block's frame are all
    // `w:pBdr` + `w:shd`. Both renderers draw them from these fields; nothing
    // populated them, so none of those decorations existed.
    const laid = layoutDocumentFull({
      body: [
        para("framed", {
          shading: { fill: "F1F1F1", pattern: "clear" },
          borders: {
            bottom: { style: "single", size: 8, color: "D1D1D1", space: 5 },
            left: { style: "single", size: 40, color: "7FBDE6" }
          }
        })
      ]
    }).pages[0]!.content[0]!;
    if (laid.type !== "paragraph") {
      throw new Error("expected paragraph");
    }
    expect(laid.backgroundColor).toBe("F1F1F1");
    // `w:sz` is eighths of a point; `w:space` is whole points.
    expect(laid.borders?.bottom).toEqual({ width: 1, color: "D1D1D1", space: 5 });
    expect(laid.borders?.left).toEqual({ width: 5, color: "7FBDE6", space: 0 });
    expect(laid.borders?.top).toBeUndefined();
    // The decoration is described as insets from `rect`, so translating or
    // splitting the paragraph moves and resizes it automatically.
    expect(laid.decorationInsets).toBeDefined();
    const insets = laid.decorationInsets!;
    const boxHeight = laid.rect.height - insets.top - insets.bottom;
    expect(boxHeight).toBeCloseTo(laid.lines[0]!.height, 3);
  });

  it("draws no decoration for a paragraph that declares none", () => {
    const laid = layoutDocumentFull({ body: [para("plain")] }).pages[0]!.content[0]!;
    if (laid.type !== "paragraph") {
      throw new Error("expected paragraph");
    }
    expect(laid.borders).toBeUndefined();
    expect(laid.backgroundColor).toBeUndefined();
    expect(laid.decorationInsets).toBeUndefined();
  });

  it("treats w:hanging as a negative first-line indent", () => {
    const laid = layoutDocumentFull({
      body: [
        para(
          "a hanging paragraph whose text is long enough to wrap onto a second line, and then some more words to be certain of it",
          { indent: { left: 720, hanging: 360 } }
        )
      ]
    }).pages[0]!.content[0]!;
    if (laid.type !== "paragraph") {
      throw new Error("expected paragraph");
    }
    expect(laid.lines.length).toBeGreaterThan(1);
    // 720 twips = 36pt, hanging 360 = 18pt → first line at 18pt, rest at 36pt.
    expect(laid.lines[0]!.runs[0]!.x).toBeCloseTo(18, 1);
    expect(laid.lines[1]!.runs[0]!.x).toBeCloseTo(36, 1);
  });

  it("narrows the text column by the right indent", () => {
    const long = "word ".repeat(80);
    const wide = layoutDocumentFull({ body: [para(long)] }).pages[0]!.content[0]!;
    const narrow = layoutDocumentFull({
      body: [para(long, { indent: { left: 720, right: 720 } })]
    }).pages[0]!.content[0]!;
    if (wide.type !== "paragraph" || narrow.type !== "paragraph") {
      throw new Error("expected paragraphs");
    }
    // Ignoring `w:right` let an indented block run to the same right edge as
    // body text, so a code block's or quote's right padding did nothing.
    expect(narrow.lines.length).toBeGreaterThan(wide.lines.length);
  });

  it("never opens a wrapped line with the whitespace the break consumed", () => {
    const laid = layoutDocumentFull({
      body: [para("alpha beta gamma delta epsilon zeta eta theta iota kappa ".repeat(6))]
    }).pages[0]!.content[0]!;
    if (laid.type !== "paragraph") {
      throw new Error("expected paragraph");
    }
    expect(laid.lines.length).toBeGreaterThan(1);
    for (const line of laid.lines) {
      const text = line.runs.map(r => ("text" in r ? r.text : "")).join("");
      // A stray leading space indents the line by ~3pt and breaks centring;
      // a trailing one makes the measured line width wrong.
      expect(text).toBe(text.trim());
    }
  });

  it("gives a thematic break no text line of its own", () => {
    // An `hr` is its border. Reserving an empty line for it made a Markdown
    // `---` nearly three times as tall as the rule it stands for.
    const rule: Paragraph = {
      type: "paragraph",
      properties: {
        thematicBreak: true,
        borders: { bottom: { style: "single", size: 8, color: "D1D1D1" } },
        spacing: { before: 240, after: 240 }
      },
      children: []
    };
    const laid = layoutDocumentFull({ body: [para("above"), rule, para("below")] }).pages[0]!
      .content[1]!;
    if (laid.type !== "paragraph") {
      throw new Error("expected paragraph");
    }
    expect(laid.lines).toHaveLength(0);
    // 240 twips above + 240 below = 24pt, and nothing else.
    expect(laid.rect.height).toBeCloseTo(24, 1);
    const insets = laid.decorationInsets!;
    expect(laid.rect.height - insets.top - insets.bottom).toBeCloseTo(0, 3);
  });

  it("collapses the space above the document's first block only", () => {
    const heading = (text: string): Paragraph => ({
      type: "paragraph",
      properties: { style: "H" },
      children: [{ content: [{ type: "text", text }] }]
    });
    const doc: DocxDocument = {
      body: [heading("Title"), para("body"), heading("Later heading"), para("more")],
      styles: [
        {
          type: "paragraph",
          styleId: "H",
          name: "H",
          paragraphProperties: { spacing: { before: 480, after: 120 } }
        }
      ]
    };
    const blocks = layoutDocumentFull(doc).pages[0]!.content;
    const leadOf = (index: number) => {
      const block = blocks[index]!;
      if (block.type !== "paragraph") {
        throw new Error("expected paragraph");
      }
      return block.lines[0]!.y;
    };
    // CSS collapses a container's first child's top margin — which is why the
    // stylesheet can say `h1 { margin-top: 0 }` and still give the others air.
    expect(blocks[0]!.rect.y).toBeCloseTo(0, 3);
    expect(leadOf(0)).toBeCloseTo(0, 3);
    // The mid-document heading keeps its 480 twips = 24pt.
    expect(leadOf(2)).toBeCloseTo(24, 1);
  });

  it("draws a declared w:between at each internal boundary of a merged block", () => {
    const quoted = (text: string): Paragraph => ({
      type: "paragraph",
      properties: { style: "Q" },
      children: [{ content: [{ type: "text", text }] }]
    });
    const doc: DocxDocument = {
      body: [quoted("one"), quoted("two"), quoted("three")],
      styles: [
        {
          type: "paragraph",
          styleId: "Q",
          name: "Q",
          paragraphProperties: {
            borders: {
              left: { style: "single", size: 40, color: "7FBDE6" },
              top: { style: "single", size: 8, color: "CCCCCC" },
              bottom: { style: "single", size: 8, color: "CCCCCC" },
              between: { style: "single", size: 8, color: "FF0000" }
            }
          }
        }
      ]
    };
    const blocks = layoutDocumentFull(doc).pages[0]!.content;
    const borderOf = (index: number) => {
      const block = blocks[index]!;
      if (block.type !== "paragraph") {
        throw new Error("expected paragraph");
      }
      return block.borders!;
    };
    // The block is capped by its own rules and divided by `w:between`, drawn as
    // the lower paragraph's top edge so each boundary gets exactly one line.
    expect(borderOf(0).top?.color).toBe("CCCCCC");
    expect(borderOf(0).bottom).toBeUndefined();
    expect(borderOf(1).top?.color).toBe("FF0000");
    expect(borderOf(1).bottom).toBeUndefined();
    expect(borderOf(2).top?.color).toBe("FF0000");
    expect(borderOf(2).bottom?.color).toBe("CCCCCC");
  });

  it("draws each interior table rule exactly once", () => {
    // `border-collapse`: an interior rule is shared by two cells. Emitting it
    // from both stroked it twice and the second stroke overpainted the first, so
    // a table style's darker header rule came out in the body-rule colour.
    const doc: DocxDocument = {
      body: [
        {
          type: "table",
          properties: {
            borders: {
              insideH: { style: "single", size: 8, color: "D1D1D1" },
              insideV: { style: "none" },
              top: { style: "none" },
              bottom: { style: "none" },
              left: { style: "none" },
              right: { style: "none" }
            }
          },
          rows: [
            {
              cells: [
                {
                  properties: {
                    borders: { bottom: { style: "single", size: 8, color: "4F4F4F" } }
                  },
                  content: []
                },
                { content: [] }
              ]
            },
            { cells: [{ content: [] }, { content: [] }] },
            { cells: [{ content: [] }, { content: [] }] }
          ]
        }
      ]
    };
    const table = layoutDocumentFull(doc).pages[0]!.content[0]!;
    if (table.type !== "table") {
      throw new Error("expected table");
    }
    const first = table.cells.find(c => c.row === 0 && c.col === 0)!;
    const second = table.cells.find(c => c.row === 1 && c.col === 0)!;
    // The header's own darker rule survives, and the row below adds no
    // coincident lighter one on top of it.
    expect(first.borders?.bottom?.color).toBe("4F4F4F");
    expect(second.borders?.top).toBeUndefined();
    // The rule between the two body rows is owned by the upper cell.
    expect(second.borders?.bottom?.color).toBe("D1D1D1");
    // No vertical rules were asked for, and no outer frame.
    for (const cell of table.cells) {
      expect(cell.borders?.left).toBeUndefined();
      expect(cell.borders?.right).toBeUndefined();
    }
  });

  it("still rules every edge of a fully gridded table", () => {
    const line = { style: "single" as const, size: 8 };
    const table = layoutDocumentFull({
      body: [
        {
          type: "table",
          properties: {
            borders: {
              top: line,
              bottom: line,
              left: line,
              right: line,
              insideH: line,
              insideV: line
            }
          },
          rows: [
            { cells: [{ content: [] }, { content: [] }] },
            { cells: [{ content: [] }, { content: [] }] }
          ]
        }
      ]
    }).pages[0]!.content[0]!;
    if (table.type !== "table") {
      throw new Error("expected table");
    }
    const at = (row: number, col: number) => table.cells.find(c => c.row === row && c.col === col)!;
    // Every cell owns its bottom and right; outer top/left belong to the edge
    // cells. Union of all edges covers the whole grid, each exactly once.
    expect(Object.keys(at(0, 0).borders!).sort()).toEqual(["bottom", "left", "right", "top"]);
    expect(Object.keys(at(0, 1).borders!).sort()).toEqual(["bottom", "right", "top"]);
    expect(Object.keys(at(1, 0).borders!).sort()).toEqual(["bottom", "left", "right"]);
    expect(Object.keys(at(1, 1).borders!).sort()).toEqual(["bottom", "right"]);
  });

  it("runs one continuous bar and fill through adjacent paragraphs that share it", () => {
    // A multi-paragraph block quote is one quote. Insetting each paragraph's
    // space-after left a gap with no bar and no background between them, and
    // drawing every edge put a rule across the middle of the block.
    const quoted = (text: string): Paragraph => ({
      type: "paragraph",
      properties: { style: "Quote" },
      children: [{ content: [{ type: "text", text }] }]
    });
    const doc: DocxDocument = {
      body: [quoted("one"), quoted("two"), quoted("three")],
      docDefaults: { paragraphProperties: { spacing: { after: 240 } } },
      styles: [
        {
          type: "paragraph",
          styleId: "Quote",
          name: "Quote",
          paragraphProperties: {
            shading: { fill: "F2F2F2" },
            borders: {
              left: { style: "single", size: 40, color: "7FBDE6" },
              top: { style: "single", size: 8, color: "CCCCCC" },
              bottom: { style: "single", size: 8, color: "CCCCCC" }
            }
          }
        }
      ]
    };
    const blocks = layoutDocumentFull(doc).pages[0]!.content;
    expect(blocks).toHaveLength(3);

    let previousBottom: number | null = null;
    blocks.forEach((block, index) => {
      if (block.type !== "paragraph") {
        throw new Error("expected paragraph");
      }
      const insets = block.decorationInsets!;
      const top = block.rect.y + insets.top;
      const bottom = block.rect.y + block.rect.height - insets.bottom;
      // Boxes touch, so the bar and the fill are unbroken.
      if (previousBottom !== null) {
        expect(top).toBeCloseTo(previousBottom, 3);
      }
      previousBottom = bottom;
      // The bar spans every paragraph; the horizontal rules only cap the block.
      expect(block.borders?.left).toBeDefined();
      expect(block.borders?.top === undefined).toBe(index !== 0);
      expect(block.borders?.bottom === undefined).toBe(index !== blocks.length - 1);
    });
  });

  it("moves and resizes decoration with the paragraph it belongs to", () => {
    // Insets are relative to `rect`, so a paragraph translated into a table cell
    // and one resized by a page split both keep their box correct without the
    // renderers doing anything. A second copy of the position did not: a split
    // shaded paragraph painted its full unsplit height on both pages.
    const boxOf = (block: {
      rect: { y: number; height: number };
      decorationInsets?: { top: number; bottom: number };
    }) => {
      const insets = block.decorationInsets!;
      return {
        y: block.rect.y + insets.top,
        height: block.rect.height - insets.top - insets.bottom
      };
    };

    // (a) Split across a page break: each part's box matches its own lines.
    const long: Paragraph = {
      type: "paragraph",
      properties: { shading: { fill: "F1F1F1" } },
      children: [{ content: [{ type: "text", text: "word ".repeat(1500) }] }]
    };
    const split = layoutDocumentFull({ body: [long] });
    expect(split.totalPages).toBeGreaterThan(1);
    for (const page of split.pages) {
      for (const block of page.content) {
        if (block.type !== "paragraph") {
          continue;
        }
        const linesHeight = block.lines.reduce((sum, l) => sum + l.height, 0);
        expect(boxOf(block).height).toBeCloseTo(linesHeight, 2);
      }
    }

    // (b) Inside a table cell: the box tracks the cell's own offset.
    const shaded = (text: string): Paragraph => ({
      type: "paragraph",
      properties: { shading: { fill: "F1F1F1" } },
      children: [{ content: [{ type: "text", text }] }]
    });
    const table = layoutDocumentFull({
      body: [
        {
          type: "table",
          rows: [
            { cells: [{ content: [shaded("row 0")] }] },
            { cells: [{ content: [shaded("row 1")] }] }
          ]
        }
      ]
    }).pages[0]!.content[0]!;
    if (table.type !== "table") {
      throw new Error("expected table");
    }
    const secondRow = table.cells.find(c => c.row === 1)!;
    const inner = secondRow.content[0]!;
    if (inner.type !== "paragraph") {
      throw new Error("expected paragraph");
    }
    expect(secondRow.rect.y).toBeGreaterThan(0);
    // Renderers translate `rect` by the cell origin; the box has to follow.
    expect(boxOf(inner).y).toBeCloseTo(inner.rect.y + inner.decorationInsets!.top, 3);
  });

  it("never ends a page on a keepNext paragraph", () => {
    // A heading carries `w:keepNext` so a section title is never the last thing
    // on a page. Pass 1 honours it, but pass 1 no longer decides page
    // boundaries — pass 2 does, and it was ignoring the flag.
    const heading = (text: string): Paragraph => ({
      type: "paragraph",
      properties: { style: "H" },
      children: [{ content: [{ type: "text", text }] }]
    });
    const body: Paragraph[] = [];
    // Enough alternating content to push a heading against many page bottoms.
    for (let i = 0; i < 60; i++) {
      body.push(heading(`Section ${i}`));
      body.push(para(`Body text for section ${i}. `.repeat(3 + (i % 4))));
    }
    const doc: DocxDocument = {
      body,
      styles: [
        {
          type: "paragraph",
          styleId: "H",
          name: "H",
          paragraphProperties: { keepNext: true, spacing: { before: 240, after: 120 } },
          runProperties: { size: 28, bold: true }
        }
      ]
    };
    const out = layoutDocumentFull(doc);
    expect(out.totalPages).toBeGreaterThan(3);

    const headingIndices = new Set(body.map((b, i) => (b.properties?.style === "H" ? i : -1)));
    for (const page of out.pages) {
      const last = page.content[page.content.length - 1];
      if (!last || last.type !== "paragraph" || page.content.length < 2) {
        continue;
      }
      expect(headingIndices.has(last.sourceIndex)).toBe(false);
    }
  });

  it("still places a keepNext paragraph that has a whole page to itself", () => {
    // The rule must not deadlock: on an empty page there is nowhere better.
    const doc: DocxDocument = {
      body: [
        {
          type: "paragraph",
          properties: { style: "H" },
          children: [{ content: [{ type: "text", text: "lonely heading" }] }]
        }
      ],
      styles: [
        {
          type: "paragraph",
          styleId: "H",
          name: "H",
          paragraphProperties: { keepNext: true }
        }
      ]
    };
    const out = layoutDocumentFull(doc);
    expect(out.totalPages).toBe(1);
    expect(out.pages[0]!.content).toHaveLength(1);
  });

  it("positions table cells relative to the table on both axes", () => {
    // Renderers add the table's origin to a cell's `rect`. Emitting an absolute
    // `y` while `x` stayed table-relative made them add the table's `y` twice,
    // so any table that did not begin at the top of a page drew its contents
    // that far below where the layout had put them — and a table at the top of
    // a page, which is what every ad-hoc check happened to use, looked fine.
    const cp = (text: string): Paragraph => ({
      type: "paragraph",
      children: [{ content: [{ type: "text", text }] }]
    });
    const laid = layoutDocumentFull({
      body: [
        para("a paragraph pushing the table down the page"),
        para("and another one"),
        {
          type: "table",
          rows: [{ cells: [{ content: [cp("r0")] }] }, { cells: [{ content: [cp("r1")] }] }]
        }
      ]
    }).pages[0]!.content;
    const table = laid.find(b => b.type === "table")!;
    if (table.type !== "table") {
      throw new Error("expected table");
    }
    // The table itself sits below the paragraphs…
    expect(table.rect.y).toBeGreaterThan(0);
    // …but its first row starts at the table's own top, not at that offset again.
    const rows = [...table.cells].sort((a, b) => a.row - b.row);
    expect(rows[0]!.rect.y).toBeCloseTo(0, 3);
    expect(rows[1]!.rect.y).toBeCloseTo(rows[0]!.rect.height, 3);
    // Every cell lies inside the table's box.
    for (const cell of table.cells) {
      expect(cell.rect.y).toBeGreaterThanOrEqual(0);
      expect(cell.rect.y + cell.rect.height).toBeLessThanOrEqual(table.rect.height + 0.01);
    }
  });

  it("drops a space pushed onto the next line by the word that follows it", () => {
    // The separator space fits the line it is measured against, so it is
    // buffered — and then the next word overflows and carries it to the top of
    // the following line. Checking the "whitespace cannot open a line" rule only
    // once, before wrapping, let exactly that case through, and every wrapped
    // line in a multi-run paragraph began with a stray space.
    const laid = layoutDocumentFull({
      body: [
        {
          type: "paragraph",
          children: [
            {
              content: [
                {
                  type: "text",
                  text:
                    "A desktop application for managing multiple terminal-based " +
                    "coding-agent sessions from a single interface. It supports two backends "
                }
              ]
            },
            { properties: { bold: true }, content: [{ type: "text", text: "Claude Code" }] },
            { content: [{ type: "text", text: " and more trailing prose to force a wrap here." }] }
          ]
        }
      ]
    }).pages[0]!.content[0]!;
    if (laid.type !== "paragraph") {
      throw new Error("expected paragraph");
    }
    expect(laid.lines.length).toBeGreaterThan(1);
    for (const line of laid.lines) {
      const text = line.runs.map(r => ("text" in r ? r.text : "")).join("");
      expect(text).toBe(text.trim());
    }
    // Runs within a line stay exactly contiguous, so no gap opens up where a
    // bold span begins.
    for (const line of laid.lines) {
      let expected: number | null = null;
      for (const run of line.runs) {
        if ("text" in run) {
          if (expected !== null) {
            expect(run.x).toBeCloseTo(expected, 3);
          }
          expected = run.x + run.width;
        }
      }
    }
  });

  it("breaks a token too wide for any line, at code-point boundaries", () => {
    // CSS `overflow-wrap: break-word`. Without it a long URL, a hex digest or
    // any space-less script ran off the right edge — a CJK paragraph measured
    // 924pt inside a 468pt column.
    const widest = (text: string) => {
      const laid = layoutDocumentFull({ body: [para(text)] }).pages[0]!.content[0]!;
      if (laid.type !== "paragraph") {
        throw new Error("expected paragraph");
      }
      let right = 0;
      for (const line of laid.lines) {
        for (const run of line.runs) {
          right = Math.max(right, run.x + run.width);
        }
      }
      return { right, lines: laid.lines.length, laid };
    };
    const contentWidth = 468; // US Letter with 1in margins

    const cjk = widest(
      "\u8fd9\u662f\u4e00\u6bb5\u6ca1\u6709\u7a7a\u683c\u7684\u4e2d\u6587".repeat(6)
    );
    expect(cjk.lines).toBeGreaterThan(1);
    expect(cjk.right).toBeLessThanOrEqual(contentWidth);

    const digest = widest("a1b2c3d4e5f6".repeat(12));
    expect(digest.lines).toBeGreaterThan(1);
    expect(digest.right).toBeLessThanOrEqual(contentWidth);

    // No text may be lost or duplicated by the break.
    const source = "a1b2c3d4e5f6".repeat(12);
    const rejoined = digest.laid.lines
      .map(l => l.runs.map(r => ("text" in r ? r.text : "")).join(""))
      .join("");
    expect(rejoined).toBe(source);
  });

  it("never splits a surrogate pair when breaking a long token", () => {
    // Half a surrogate pair renders as a replacement character.
    const emoji = "\u{1F600}".repeat(200);
    const laid = layoutDocumentFull({ body: [para(emoji)] }).pages[0]!.content[0]!;
    if (laid.type !== "paragraph") {
      throw new Error("expected paragraph");
    }
    expect(laid.lines.length).toBeGreaterThan(1);
    for (const line of laid.lines) {
      const text = line.runs.map(r => ("text" in r ? r.text : "")).join("");
      expect(text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
      expect(text).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    }
  });

  it("only breaks a token that cannot fit a line by itself", () => {
    // A word that merely does not fit the space left moves to the next line
    // intact — breaking it there would be wrong.
    const laid = layoutDocumentFull({
      body: [para("short words here " + "x".repeat(40) + " and more short words after it")]
    }).pages[0]!.content[0]!;
    if (laid.type !== "paragraph") {
      throw new Error("expected paragraph");
    }
    const joined = laid.lines
      .map(l => l.runs.map(r => ("text" in r ? r.text : "")).join(""))
      .join("\n");
    // The 40-character run fits a full line, so it survives whole.
    expect(joined).toContain("x".repeat(40));
  });

  it("keeps leading whitespace after a hard break, where it is the indentation", () => {
    // A fenced code block is one paragraph whose lines are separated by hard
    // breaks. Dropping whitespace that opens *any* line — rather than only a
    // wrapped one — silently reindented every line of code to column zero.
    const laid = layoutDocumentFull({
      body: [
        {
          type: "paragraph",
          children: [
            {
              content: [
                { type: "text", text: "function f() {" },
                { type: "break" },
                { type: "text", text: "  indented();" },
                { type: "break" },
                { type: "text", text: "    deeper();" }
              ]
            }
          ]
        }
      ]
    }).pages[0]!.content[0]!;
    if (laid.type !== "paragraph") {
      throw new Error("expected paragraph");
    }
    const text = laid.lines.map(l => l.runs.map(r => ("text" in r ? r.text : "")).join(""));
    expect(text).toEqual(["function f() {", "  indented();", "    deeper();"]);
  });

  it("aligns a list item's wrapped lines with its text, not with the marker", () => {
    const doc: DocxDocument = {
      body: [
        {
          type: "paragraph",
          properties: { numbering: { numId: 1, level: 0 } },
          children: [
            {
              content: [
                {
                  type: "text",
                  text:
                    "a list item long enough that it certainly wraps onto a second line, " +
                    "with several more words appended to leave no doubt about it"
                }
              ]
            }
          ]
        }
      ],
      numberingInstances: [{ numId: 1, abstractNumId: 1 }],
      abstractNumberings: [
        { abstractNumId: 1, levels: [{ level: 0, format: "bullet", text: "\u2022" }] }
      ]
    };
    const laid = layoutDocumentFull(doc).pages[0]!.content[0]!;
    if (laid.type !== "paragraph") {
      throw new Error("expected paragraph");
    }
    expect(laid.lines.length).toBeGreaterThan(1);
    const marker = laid.lines[0]!.runs[0]! as { x: number; width: number };
    const wrapped = laid.lines[1]!.runs[0]! as { x: number };
    // The marker hangs left of the text column; the text after it and every
    // wrapped line share the same x.
    expect(marker.x).toBeLessThan(wrapped.x);
    expect(marker.x + marker.width).toBeCloseTo(wrapped.x, 2);
  });
});

describe("layoutDocumentFull — pagination", () => {
  it("emits a single page when content fits the content area", () => {
    const doc: DocxDocument = {
      body: [makeParagraph("just one short paragraph")]
    };
    const out = layoutDocumentFull(doc);
    expect(out.totalPages).toBe(1);
    expect(out.pages.length).toBe(1);
  });

  it("breaks to a new page when content exceeds the content area height", () => {
    // Content area height with default margins ≈ 648pt. A 12pt body line
    // is ≈ 14pt tall, so we need ~50+ paragraphs to overflow one page.
    const body: Paragraph[] = [];
    for (let i = 0; i < 80; i++) {
      body.push(makeParagraph(`paragraph ${i}`));
    }
    const out = layoutDocumentFull({ body });
    expect(out.totalPages).toBeGreaterThanOrEqual(2);

    // Every paragraph that landed on page 2+ must restart at the top of
    // the content area (rect.y ≈ 0 in content-area coordinates), not a
    // continuation of page 1's y coordinate.
    for (let pageIdx = 1; pageIdx < out.pages.length; pageIdx++) {
      const page = out.pages[pageIdx]!;
      const firstPara = page.content.find(c => c.type === "paragraph");
      if (firstPara && firstPara.type === "paragraph") {
        expect(firstPara.rect.y).toBeLessThanOrEqual(1);
      }
    }
  });

  it("preserves source-index ordering across page boundaries", () => {
    const body: Paragraph[] = [];
    for (let i = 0; i < 80; i++) {
      body.push(makeParagraph(`paragraph ${i}`));
    }
    const out = layoutDocumentFull({ body });

    let lastSourceIdx = -1;
    for (const page of out.pages) {
      for (const c of page.content) {
        if (c.type === "paragraph") {
          expect(c.sourceIndex).toBeGreaterThan(lastSourceIdx);
          lastSourceIdx = c.sourceIndex;
        }
      }
    }
    // We placed every paragraph from 0..79 in some page.
    expect(lastSourceIdx).toBe(79);
  });

  it("reports section breaks as page indices", () => {
    const doc: DocxDocument = { body: [makeParagraph("a"), makeParagraph("b")] };
    const out = layoutDocumentFull(doc);
    // A single-section document still reports the implicit section start
    // at page 0 (first page).
    expect(out.sectionBreaks.length).toBeGreaterThanOrEqual(1);
    expect(out.sectionBreaks[0]).toBe(0);
  });
});

describe("layoutDocumentFull — custom text measurement", () => {
  it("uses custom wide metrics for positioned line wrapping and pagination", () => {
    const body = Array.from({ length: 12 }, () => makeParagraph("wide words wide words"));
    const doc: DocxDocument = {
      body,
      sectionProperties: {
        pageSize: { width: 2400, height: 2400 },
        margins: { top: 200, bottom: 200, left: 200, right: 200 }
      }
    };

    const normal = layoutDocumentFull(doc, { measureText: text => text.length * 3 });
    const wide = layoutDocumentFull(doc, { measureText: text => text.length * 12 });
    const normalParagraph = normal.pages[0]!.content.find(item => item.type === "paragraph");
    const wideParagraph = wide.pages[0]!.content.find(item => item.type === "paragraph");
    if (normalParagraph?.type !== "paragraph" || wideParagraph?.type !== "paragraph") {
      throw new Error("expected paragraphs");
    }

    expect(normalParagraph.lines).toHaveLength(1);
    expect(wideParagraph.lines.length).toBeGreaterThan(1);
    expect(wide.totalPages).toBeGreaterThan(normal.totalPages);
  });

  it("passes the styled font variant to the custom measurer", () => {
    const fonts: Array<{ name: string; bold?: boolean; italic?: boolean }> = [];
    const paragraph: Paragraph = {
      type: "paragraph",
      children: [
        {
          content: [{ type: "text", text: "styled" }],
          properties: { size: HALF_PT_12, font: "Times New Roman", bold: true, italic: true }
        }
      ]
    };

    layoutDocumentFull(
      { body: [paragraph] },
      {
        measureText: (text, fontName, _fontSize, bold, italic) => {
          fonts.push({ name: fontName, bold, italic });
          return text.length;
        }
      }
    );

    expect(fonts).toContainEqual({ name: "Times New Roman", bold: true, italic: true });
  });
});

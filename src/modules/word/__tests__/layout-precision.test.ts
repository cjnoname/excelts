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

import { describe, it, expect } from "vitest";

import { layoutDocumentFull } from "../layout/layout-full";
import type { DocxDocument, Paragraph, SectionProperties } from "../types";

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

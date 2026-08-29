/**
 * The pagination pass must never under-reserve relative to the positioned pass.
 *
 * `layoutDocument` (coarse) reserves heights to decide page breaks; `layoutDocumentFull`
 * (positioned) lays the text out for real. The coarse pass documents the invariant it
 * exists to hold — it "can never place more on a page than the positioned pass can
 * fit" — and `pageCount` is not an internal detail: `NUMPAGES`, `PAGE`, TOC entry page
 * numbers and `PAGEREF` are all resolved from it, so a wrong count is written into the
 * document itself.
 *
 * It has been broken twice by the two passes measuring differently:
 *
 * - The coarse pass chose the East Asian face for any run containing CJK, on the
 *   stated grounds that it is always the taller. Real faces disagree, so a tall Latin
 *   face in a mixed run was measured against a shorter CJK face.
 * - The positioned pass enlarged a heading that declares no `w:sz` by a heuristic
 *   scale and the coarse pass did not, so 40 `Heading 1` paragraphs reported one page
 *   and paginated to two.
 *
 * Both directions are asserted. Over-reserving satisfies the letter of the invariant
 * but still writes a page count the reader can see is wrong — the first attempt at the
 * heading fix scaled the wrap width as well as the line box and over-reserved by 1.8×.
 */
import { describe, expect, it } from "vitest";

import { layoutDocument } from "../layout/layout";
import { layoutDocumentFull } from "../layout/layout-full";
import type { BodyContent, DocxDocument, ParagraphProperties, Table } from "../types";

const BODY_TEXT = "Chapter i: an introduction to the subject at hand";

const paragraph = (properties: ParagraphProperties = {}): BodyContent =>
  ({
    type: "paragraph",
    properties,
    children: [{ content: [{ type: "text", text: BODY_TEXT }] }]
  }) as BodyContent;

/** Both passes' page counts for a document of `count` identical paragraphs. */
function pageCounts(
  properties: ParagraphProperties,
  count: number,
  styles?: DocxDocument["styles"]
) {
  const doc = { body: Array.from({ length: count }, () => paragraph(properties)), styles };
  return {
    coarse: layoutDocument(doc as DocxDocument).pageCount,
    positioned: layoutDocumentFull(doc as DocxDocument).pages.length
  };
}

const COUNTS = [8, 14, 16, 20, 40, 60, 100];

describe("heading heuristics reach both passes", () => {
  it.each([
    ["Heading1", { style: "Heading1" }],
    ["Heading2", { style: "Heading2" }],
    ["Heading3", { style: "Heading3" }],
    ["Heading6", { style: "Heading6" }],
    ["outlineLevel 0", { outlineLevel: 0 }],
    ["outlineLevel 2", { outlineLevel: 2 }],
    ["body text", { style: "Body" }],
    ["no properties", {}]
  ])("should agree exactly for %s", (_label, properties) => {
    for (const count of COUNTS) {
      const { coarse, positioned } = pageCounts(properties as ParagraphProperties, count);
      expect(coarse, `${count} paragraphs`).toBe(positioned);
    }
  });

  it("should let a styles table opt out of the heuristic on both sides", () => {
    // A declared `w:sz` is authoritative; the heuristic only covers its absence.
    const styles: DocxDocument["styles"] = [
      { styleId: "Heading1", name: "heading 1", type: "paragraph", runProperties: { size: 48 } }
    ];
    for (const count of [20, 40, 60]) {
      const { coarse, positioned } = pageCounts({ style: "Heading1" }, count, styles);
      expect(coarse, `${count} paragraphs`).toBe(positioned);
    }
  });
});

describe("a mixed-script run reaches both passes", () => {
  // The coarse pass measured such a run against one face and the positioned pass
  // against both, taking the extremes.
  const TALL_ASCII = "TallAscii";
  const SHORT_CJK = "ShortCjk";
  const measureTextMetrics = (
    _text: string,
    font: string,
    size: number
  ): { ascent: number; descent: number } =>
    font === TALL_ASCII
      ? { ascent: size * 1.0, descent: -size * 0.5 }
      : { ascent: size * 0.86, descent: -size * 0.14 };

  const mixed = (): BodyContent =>
    ({
      type: "paragraph",
      children: [
        {
          properties: {
            font: { ascii: TALL_ASCII, hAnsi: TALL_ASCII, eastAsia: SHORT_CJK },
            size: 24
          },
          content: [{ type: "text", text: "报表Report" }]
        }
      ]
    }) as BodyContent;

  it.each([1, 10, 34, 40, 45, 70, 90, 120])("should agree for %i paragraphs", count => {
    const doc = { body: Array.from({ length: count }, mixed) } as DocxDocument;
    expect(layoutDocument(doc, { measureTextMetrics }).pageCount).toBe(
      layoutDocumentFull(doc, { measureTextMetrics }).pages.length
    );
  });
});

describe("the paragraph mark governs only an empty paragraph", () => {
  // `w:pPr/w:rPr/w:sz` describes the pilcrow. The pagination pass used it as the
  // default for every run that declares no size, which is a different statement and
  // a wrong one: an 8pt mark shrank the body text with it and a 36pt mark inflated it
  // sixfold (15 pages reported against 3).
  const withMark = (size?: number): BodyContent =>
    ({
      type: "paragraph",
      properties: size === undefined ? {} : { markRunProperties: { size } },
      children: [{ content: [{ type: "text", text: BODY_TEXT }] }]
    }) as BodyContent;

  const emptyWithMark = (size: number): BodyContent =>
    ({
      type: "paragraph",
      properties: { markRunProperties: { size } },
      children: []
    }) as BodyContent;

  it.each([16, 24, 72, undefined])("should ignore a %s half-point mark on a run", size => {
    for (const count of [20, 40, 60, 100, 140]) {
      const doc = { body: Array.from({ length: count }, () => withMark(size)) } as DocxDocument;
      expect(layoutDocument(doc).pageCount, `${count} paragraphs`).toBe(
        layoutDocumentFull(doc).pages.length
      );
    }
  });

  it.each([16, 22, 24, 48, 72])(
    "should honour a %s half-point mark on an empty paragraph",
    size => {
      // The one place it does govern: with no run to measure, the mark sets the line box.
      for (const count of [14, 15, 16, 29, 30, 31, 45, 46, 59, 60, 61, 100]) {
        const doc = {
          body: Array.from({ length: count }, () => emptyWithMark(size))
        } as DocxDocument;
        expect(layoutDocument(doc).pageCount, `${count} paragraphs`).toBe(
          layoutDocumentFull(doc).pages.length
        );
      }
    }
  );
});

describe("w:rFonts merges per slot", () => {
  // A run naming only `w:eastAsia` keeps the Latin face it inherits. Spreading the
  // whole `FontSpec` threw it away, and the positioned pass — which had no
  // compensating parameter — measured the Latin half of every such run against
  // Calibri. That is narrower than a serif default, so it disagreed with the
  // pagination pass in the direction that writes a wrong `NUMPAGES`.
  const measureText = (text: string, font: string, size: number): number => {
    const perChar = font.startsWith("Times") ? 0.42 : font.startsWith("Courier") ? 0.62 : 0.5;
    return [...text].reduce((w, ch) => w + size * (ch.codePointAt(0)! > 0x2e80 ? 1.0 : perChar), 0);
  };

  const eastAsiaOnly = (): BodyContent =>
    ({
      type: "paragraph",
      children: [
        {
          properties: { font: { eastAsia: "Songti SC" } },
          content: [{ type: "text", text: "摘要 Summary 报表 Report 数据 Data ".repeat(5) }]
        }
      ]
    }) as BodyContent;

  it.each(["Times New Roman", "Helvetica", "Courier", "Songti SC"])(
    "should keep an inherited %s through an eastAsia-only override",
    ascii => {
      for (const count of [8, 12, 18, 24, 30, 40, 60]) {
        const doc = {
          body: Array.from({ length: count }, eastAsiaOnly),
          docDefaults: { runProperties: { font: { ascii, hAnsi: ascii } } }
        } as DocxDocument;
        expect(layoutDocument(doc, { measureText }).pageCount, `${count} paragraphs`).toBe(
          layoutDocumentFull(doc, { measureText }).pages.length
        );
      }
    }
  );

  it("should ask both passes for the same faces", () => {
    const doc = {
      body: [eastAsiaOnly()],
      docDefaults: {
        runProperties: { font: { ascii: "Times New Roman", hAnsi: "Times New Roman" } }
      }
    } as DocxDocument;
    const facesFrom = (run: (m: typeof measureText) => void): string[] => {
      const seen: string[] = [];
      run((text, font, size) => {
        seen.push(font);
        return measureText(text, font, size);
      });
      return [...new Set(seen)].sort();
    };
    // Calibri appearing on one side only is the symptom.
    expect(facesFrom(m => void layoutDocumentFull(doc, { measureText: m }))).toEqual(
      facesFrom(m => void layoutDocument(doc, { measureText: m }))
    );
  });
});

describe("table geometry reaches both passes", () => {
  // `w:tblGrid` is advisory — Word fits it to the measure — and a row has a minimum
  // height. The pagination pass used the declared twips unscaled, and the two passes
  // had different minimum heights (16.5pt against a line plus the cell margins).
  const CELL = "A reasonably long cell value that will need to wrap when the column is narrow. ";

  const table = (
    rows: number,
    columnWidths: number[] | undefined,
    text: string,
    properties?: Table["properties"]
  ): BodyContent =>
    ({
      type: "table",
      columnWidths,
      properties,
      rows: Array.from({ length: rows }, () => ({
        cells: [
          { content: [{ type: "paragraph", children: [{ content: [{ type: "text", text }] }] }] },
          { content: [{ type: "paragraph", children: [{ content: [{ type: "text", text }] }] }] }
        ]
      }))
    }) as BodyContent;

  it.each([
    ["a grid that fits", [4680, 4680]],
    ["a grid twice the page width", [9360, 9360]],
    ["a grid four times the page width", [18720, 18720]],
    ["an under-wide grid", [1000, 1000]],
    ["no grid", undefined]
  ])("should scale %s the same way", (_label, columnWidths) => {
    for (const rows of [10, 20, 30, 40, 60]) {
      const doc = { body: [table(rows, columnWidths, CELL)] } as DocxDocument;
      expect(layoutDocument(doc).pageCount, `${rows} rows`).toBe(
        layoutDocumentFull(doc).pages.length
      );
    }
  });

  it.each([
    ["default margins", undefined],
    ["declared margins", { cellMargin: { top: 120, bottom: 120 } }]
  ])("should use the same minimum row height with %s", (_label, properties) => {
    // Single-character cells, where the minimum is the only thing deciding the height.
    for (const rows of [10, 20, 30, 35, 40, 45, 50, 60]) {
      const doc = {
        body: [table(rows, undefined, "x", properties as Table["properties"])]
      } as DocxDocument;
      expect(layoutDocument(doc).pageCount, `${rows} rows`).toBe(
        layoutDocumentFull(doc).pages.length
      );
    }
  });
});

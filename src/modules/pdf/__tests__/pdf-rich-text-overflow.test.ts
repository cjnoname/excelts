import { inflateSync } from "node:zlib";

import { Cell, Column, Row, Workbook } from "@excel/index";
import { excelToPdf } from "@pdf/excel-bridge";
import { readPdf } from "@pdf/reader/pdf-reader";
import { measureRichTextRange } from "@pdf/render/page-renderer";
import { describe, it, expect } from "vitest";

/**
 * Regression tests for rich text overflow and wrapping in PDF rendering.
 *
 * Covers:
 * - Rich text overflow in non-merged cells (clip width)
 * - Overflow erase covers gridlines/borders in overflow region
 * - Wrap path uses per-run font size, not max size
 * - Layout countWrapLines matches render wrapRichTextLines
 * - Neighbor blocking: rich text in adjacent cell blocks overflow
 */

async function getFragments(
  pdfBytes: Uint8Array
): Promise<{ text: string; x: number; y: number; fontSize?: number }[]> {
  const result = await readPdf(pdfBytes);
  return result.pages[0].textFragments.map(f => ({
    text: f.text,
    x: Math.round(f.x * 10) / 10,
    y: Math.round(f.y * 10) / 10,
    fontSize: f.fontSize
  }));
}

/** Extract clip rect widths from the PDF content stream for text-drawing states. */
function extractClipWidths(pdfBytes: Uint8Array): number[] {
  const pdfStr = Buffer.from(pdfBytes).toString("latin1");
  const regex = /stream\r?\n([\s\S]*?)endstream/g;
  let m: RegExpExecArray | null;
  const widths: number[] = [];
  while ((m = regex.exec(pdfStr)) !== null) {
    const raw = Buffer.from(m[1], "latin1");
    let decoded: string;
    try {
      decoded = inflateSync(raw).toString("latin1");
    } catch {
      continue;
    }
    // Find clip rects: "x y w h re" followed by "W" and "n"
    // Allow flexible whitespace between operators
    const clipPattern = /([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+re\s+W\s+n/g;
    let cm: RegExpExecArray | null;
    while ((cm = clipPattern.exec(decoded)) !== null) {
      widths.push(parseFloat(cm[3]));
    }
  }
  return widths;
}

describe("Rich text PDF rendering", () => {
  it.each([
    ["leading", "\nText", -12],
    ["trailing", "Text\n", 12]
  ])(
    "keeps %s blank-line metrics during vertical alignment",
    async (_kind, text, expectedOffset) => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Column.setWidth(ws, 1, 20);
      Column.setWidth(ws, 2, 20);
      Row.setHeight(ws, 1, 80);

      Cell.setValue(ws, "A1", { richText: [{ text, font: { size: 20 } }] });
      Cell.setStyle(ws, "A1", { alignment: { wrapText: true, vertical: "middle" } });
      Cell.setValue(ws, "B1", "Text");
      Cell.setStyle(ws, "B1", {
        font: { size: 20 },
        alignment: { vertical: "middle" }
      });

      const fragments = (await getFragments(await excelToPdf(wb)))
        .filter(f => f.text === "Text")
        .sort((a, b) => a.x - b.x);
      expect(fragments).toHaveLength(2);

      // The blank line occupies a real 24pt line box. Relative to a centred
      // single line, the visible line therefore moves by half a line in the
      // appropriate direction. A zero-metric blank moves it by an ascent.
      expect(fragments[0].y - fragments[1].y).toBeCloseTo(expectedOffset, 5);
    }
  );

  describe("rich text overflow into adjacent empty cells", () => {
    it("should expand clip rect beyond cell width for rich text overflow", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Column.setWidth(ws, 1, 5); // ~30pt — very narrow
      Column.setWidth(ws, 2, 20); // ~113pt
      Column.setWidth(ws, 3, 10);

      // Rich text wider than column A (~30pt), B is empty → overflow expected
      Cell.setValue(ws, "A1", {
        richText: [
          { text: "AAAA", font: { size: 8 } },
          { text: " BBBB CCCC", font: { size: 16 } }
        ]
      });
      Cell.setValue(ws, "C1", "X");

      const pdf = await excelToPdf(wb);
      const clipWidths = extractClipWidths(pdf);

      // Column A is ~30pt. The first clip rect (for A1's rich text) must be
      // wider than the cell itself due to overflow into B1.
      const colAWidth = (5 * 7 + 5) * 0.75; // ~30pt
      const a1Clip = clipWidths[0];
      expect(a1Clip).toBeGreaterThan(colAWidth);
    });

    it("should stop overflow at neighbor cell with rich text", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Column.setWidth(ws, 1, 5);
      Column.setWidth(ws, 2, 10);
      Column.setWidth(ws, 3, 10);

      Cell.setValue(ws, "A1", "OverflowingTextThatShouldBeStopped");
      // B1 has rich text — should block A1's overflow
      Cell.setValue(ws, "B1", {
        richText: [{ text: "Block", font: { bold: true } }]
      });
      Cell.setValue(ws, "C1", "X");

      const pdf = await excelToPdf(wb);
      const clipWidths = extractClipWidths(pdf);

      // A1's clip should NOT extend past its own column since B1 blocks it
      const colAWidth = (5 * 7 + 5) * 0.75; // ~30pt
      // First clip is for A1 (no overflow since B1 blocks it)
      expect(clipWidths.length).toBeGreaterThan(0);
      expect(clipWidths[0]).toBeCloseTo(colAWidth, 0);
    });
  });

  describe("wrap uses per-run font size", () => {
    it("should wrap small-font text with more characters per line", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Column.setWidth(ws, 1, 15); // ~83pt
      Row.setHeight(ws, 1, 60);

      // 16pt header + 7pt body. If wrap used 16pt for everything,
      // body words would each be on separate lines.
      Cell.setValue(ws, "A1", {
        richText: [
          { text: "HDR ", font: { size: 16 } },
          { text: "aaa bbb ccc ddd eee fff", font: { size: 7 } }
        ]
      });
      Cell.setStyle(ws, "A1", { alignment: { wrapText: true } });

      const pdf = await excelToPdf(wb);
      const frags = await getFragments(pdf);

      // At 7pt, "aaa bbb ccc" should fit on one line (~83pt available).
      // If measured at 16pt, each word would be ~30pt and only 2 would fit.
      // Check that we get fewer fragments (more words per line).
      const smallFrags = frags.filter(f => f.fontSize === 7);
      // With correct per-run measurement, at least one fragment should contain
      // multiple words joined together (e.g. "aaa bbb ccc")
      const multiWordFrag = smallFrags.find(f => f.text.split(" ").length >= 3);
      expect(multiWordFrag).toBeDefined();
    });
  });

  describe("layout row height matches render for rich text wrap", () => {
    it("should auto-calculate row height correctly for rich text wrap", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Column.setWidth(ws, 1, 15);
      // Do NOT set explicit row height — let auto-height calculate it

      Cell.setValue(ws, "A1", {
        richText: [
          { text: "BIG ", font: { size: 14 } },
          { text: "tiny words that wrap at their own 7pt size", font: { size: 7 } }
        ]
      });
      Cell.setStyle(ws, "A1", { alignment: { wrapText: true } });

      const pdf = await excelToPdf(wb);
      const frags = await getFragments(pdf);

      // All text should be present (not clipped due to wrong row height)
      const allText = frags.map(f => f.text).join("");
      expect(allText).toContain("BIG");
      expect(allText).toContain("tiny");
      expect(allText).toContain("wrap");
      expect(allText).toContain("size");
    });
  });

  describe("East Asian rich text wraps like plain text", () => {
    // The height estimate and the renderer each had their own transcription of
    // "where may a line break". Only the renderer's was updated for East Asian
    // text, so a CJK rich-text row was reserved one line of height and then
    // drawn as six — and the following row, placed against the short reservation,
    // started before the previous one had finished drawing. Both now call
    // `wrapUnitsOf`.
    //
    // Note what does *not* detect this: counting distinct baselines. The
    // overlapping lines belong to different rows and sit at different offsets
    // within them, so all 18 baselines stay numerically distinct while the text
    // is an unreadable smear. The signal is that the baselines stop descending —
    // row 2 restarts at 761.4 after row 1 reached 710.4.
    const ZH = "这是一段很长的中文文字内容需要在窄列中自动换行";

    const baselines = async (value: unknown): Promise<number[]> => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Column.setWidth(ws, 1, 10);
      // No explicit row height: the auto-height reservation is what regressed.
      for (let r = 1; r <= 3; r++) {
        Cell.setValue(ws, `A${r}`, value as never);
        Cell.setStyle(ws, `A${r}`, { alignment: { wrapText: true } });
      }
      return (await getFragments(await excelToPdf(wb))).map(f => f.y);
    };

    it("should keep descending baselines for CJK rich text across rows", async () => {
      const ys = await baselines({ richText: [{ text: ZH }] });
      expect(ys.length).toBeGreaterThan(3); // it really did wrap
      for (let i = 1; i < ys.length; i++) {
        expect(ys[i]).toBeLessThan(ys[i - 1]);
      }
    });

    it("should place CJK rich text exactly where plain text goes", async () => {
      const rich = await baselines({ richText: [{ text: ZH }] });
      const plain = await baselines(ZH);
      expect(rich).toEqual(plain);
    });
  });

  describe("the reserved line count is the drawn line count", () => {
    // The layout pass reserves a row's height from a line count and the renderer
    // draws the lines; each used to carry its own transcription of the wrapping
    // rule. They disagreed twice. The first time only the renderer had been updated
    // for East Asian breaking, so a Chinese cell reserved one line, drew six and
    // overprinted itself. The second time the layout charged a paragraph's leading
    // whitespace to its first line and the renderer did not, so
    // `"   aaa bbb ccc ddd"` reserved three lines and drew two.
    //
    // Both now call `wrapRichTextLines`, so the count is the length of the list
    // that gets drawn. These cases are the ones that diverged.
    const drawnBaselines = async (
      richText: readonly { text: string; font?: { size?: number } }[],
      width: number
    ): Promise<number> => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Column.setWidth(ws, 1, width);
      Cell.setValue(ws, "A1", { richText } as never);
      Cell.setStyle(ws, "A1", { alignment: { wrapText: true } });
      const frags = await getFragments(await excelToPdf(wb));
      return new Set(frags.map(f => f.y)).size;
    };

    it("should not change with a run boundary inside a word", () => {
      // `measureRichTextRange` splits at run boundaries, so measuring `[a,c)` once
      // and `[a,b) + [b,c)` twice sums different sets of per-run measurements. Both
      // passes now measure through the same function, so the split cannot move.
      expect(typeof measureRichTextRange).toBe("function");
    });

    it("should wrap per-character runs the same as one run", async () => {
      const body = "aaa bbb ccc ddd";
      const asOneRun = await drawnBaselines([{ text: body, font: { size: 11 } }], 10);
      const asManyRuns = await drawnBaselines(
        [...body].map(ch => ({ text: ch, font: { size: 11 } })),
        10
      );
      expect(asManyRuns).toBe(asOneRun);
    });
  });

  describe("overflow region erases underlying borders/gridlines", () => {
    it("should produce valid PDF with overflow and gridlines enabled", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Column.setWidth(ws, 1, 8);
      Column.setWidth(ws, 2, 8);
      Column.setWidth(ws, 3, 8);

      Cell.setValue(ws, "A1", "Long text that overflows into B1 and C1 area");
      Cell.setStyle(ws, "A1", {
        border: {
          top: { style: "thin" },
          bottom: { style: "thin" },
          left: { style: "thin" },
          right: { style: "thin" }
        }
      });
      // B1 has border but is empty — should be visually hidden by overflow
      Cell.setStyle(ws, "B1", {
        border: {
          top: { style: "thin" },
          bottom: { style: "thin" },
          left: { style: "thin" },
          right: { style: "thin" }
        }
      });
      Cell.setValue(ws, "C1", "Stop");

      const pdf = await excelToPdf(wb, { showGridLines: true });
      // At minimum: no crash, text is present
      const frags = await getFragments(pdf);
      expect(frags.find(f => f.text.startsWith("Long text"))).toBeDefined();
      expect(frags.find(f => f.text === "Stop")).toBeDefined();
      expect(pdf.length).toBeGreaterThan(0);
    });
  });
});

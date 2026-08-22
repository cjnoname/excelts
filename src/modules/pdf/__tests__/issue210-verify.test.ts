import { Cell, Column, Workbook, Worksheet } from "@excel/index";
import { excelToPdf } from "@pdf/excel-bridge";
import { readPdf } from "@pdf/reader/pdf-reader";
import { CELL_PADDING_V } from "@pdf/render/constants";
import { getFontAscent, getFontDescent } from "@utils/font-metrics";
import { describe, expect, it } from "vitest";

import { decompressPdfContent } from "./test-helpers";

// Faithful port of the reporter's buildTestWorkbook() from issue #210.
function buildTestWorkbook() {
  const workbook = Workbook.create();
  const ws = Workbook.addWorksheet(workbook, "TestSheet");
  const defRowHeight = 80;

  let curRow = Worksheet.addRow(ws, ["left_top", "left_middle", "left_bottom"]);
  curRow.height = defRowHeight;
  Cell.setAlignment(ws, "A1", { horizontal: "left", vertical: "top" });
  Cell.setFont(ws, "A1", { name: "Consolas", size: 11, bold: false });
  Cell.setAlignment(ws, "B1", { horizontal: "left", vertical: "middle" });
  Cell.setFont(ws, "B1", { name: "Consolas", size: 11, bold: false });
  Cell.setAlignment(ws, "C1", { horizontal: "left", vertical: "bottom" });
  Cell.setFont(ws, "C1", { name: "Consolas", size: 11, bold: false });

  curRow = Worksheet.addRow(ws, ["center_top", "center_middle", "center_bottom"]);
  curRow.height = defRowHeight;
  Cell.setAlignment(ws, "A2", { horizontal: "center", vertical: "top" });
  Cell.setAlignment(ws, "B2", { horizontal: "center", vertical: "middle" });
  Cell.setAlignment(ws, "C2", { horizontal: "center", vertical: "bottom" });

  curRow = Worksheet.addRow(ws, ["right_top", "right_middle", "right_bottom"]);
  curRow.height = defRowHeight;
  Cell.setAlignment(ws, "A3", { horizontal: "right", vertical: "top" });
  Cell.setAlignment(ws, "B3", { horizontal: "right", vertical: "middle" });
  Cell.setAlignment(ws, "C3", { horizontal: "right", vertical: "bottom" });

  Column.setWidth(ws, 1, 30);
  Column.setWidth(ws, 2, 30);
  Column.setWidth(ws, 3, 30);

  applyBoxGridBorder(ws, 1, 3, 1, 3);
  return workbook;
}

function applyBoxGridBorder(
  ws: Parameters<typeof Cell.setBorder>[0],
  startRow: number,
  endRow: number,
  startCol: number,
  endCol: number
) {
  const inner = { style: "thin", color: { argb: "FF000000" } } as const;
  const outer = { style: "medium", color: { argb: "FF000000" } } as const;
  for (let r = startRow; r <= endRow; r++) {
    for (let c = startCol; c <= endCol; c++) {
      Cell.setBorder(ws, toCellAddress(r, c), {
        top: r === startRow ? outer : inner,
        bottom: r === endRow ? outer : inner,
        left: c === startCol ? outer : inner,
        right: c === endCol ? outer : inner
      });
    }
  }
}

function toCellAddress(row: number, col: number) {
  let letter = "";
  let c = Math.max(1, Number(col) || 1);
  while (c > 0) {
    const temp = (c - 1) % 26;
    letter = String.fromCharCode(65 + temp) + letter;
    c = Math.floor((c - temp - 1) / 26);
  }
  return `${letter}${row}`;
}

describe("issue #210 — vertical alignment insets", () => {
  /**
   * The reporter's own workbook: three rows of 80pt with top / middle / bottom
   * cells, a medium outer + thin inner border grid, and Consolas on the first
   * row. Bottom-aligned text used to float 3.025pt above its inset and centred
   * text sat half that above the middle, because the block height was taken from
   * the line box (font size x 1.2) instead of the ink the glyphs occupy.
   */
  it("insets every cell by its own padding and centres the middle row", async () => {
    const wb = buildTestWorkbook();
    const pdfBytes = await excelToPdf(wb, {
      fitToPage: true,
      title: "Test Title PDF Props",
      author: "John Doe",
      subject: "Subject",
      creator: "Brother of John Doe"
    });

    const clips = [
      ...decompressPdfContent(pdfBytes).matchAll(/([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+) re\s+W/g)
    ].map(m => ({ x: Number(m[1]), y: Number(m[2]), w: Number(m[3]), h: Number(m[4]) }));
    const frags = (await readPdf(pdfBytes)).pages[0].textFragments;
    expect(frags).toHaveLength(9);

    // Half of each border stroke encroaches on the cell, so a medium edge insets
    // by 0.25pt more than a thin one. The grid is medium on the outside.
    const MEDIUM_INSET = 0.25;
    const THIN_INSET = 0.125;
    const padFor = (edge: "outer" | "inner") =>
      CELL_PADDING_V + (edge === "outer" ? MEDIUM_INSET : THIN_INSET);

    const expected: Record<string, { align: "top" | "middle" | "bottom"; pad: number }> = {
      left_top: { align: "top", pad: padFor("outer") },
      left_middle: { align: "middle", pad: 0 },
      left_bottom: { align: "bottom", pad: padFor("inner") },
      center_top: { align: "top", pad: padFor("inner") },
      center_middle: { align: "middle", pad: 0 },
      center_bottom: { align: "bottom", pad: padFor("inner") },
      right_top: { align: "top", pad: padFor("inner") },
      right_middle: { align: "middle", pad: 0 },
      right_bottom: { align: "bottom", pad: padFor("outer") }
    };

    for (const frag of frags) {
      const cell = clips.find(
        c => frag.x >= c.x - 0.6 && frag.x <= c.x + c.w && frag.y >= c.y - 2 && frag.y <= c.y + c.h
      );
      expect(cell, frag.text).toBeDefined();
      const ascent = getFontAscent(frag.fontName, frag.fontSize);
      const descent = getFontDescent(frag.fontName, frag.fontSize);
      const gapTop = cell!.y + cell!.h - (frag.y + ascent);
      const gapBottom = frag.y + descent - cell!.y;
      const want = expected[frag.text];
      expect(want, frag.text).toBeDefined();

      if (want.align === "top") {
        expect(gapTop, frag.text).toBeCloseTo(want.pad, 2);
      } else if (want.align === "bottom") {
        expect(gapBottom, frag.text).toBeCloseTo(want.pad, 2);
      } else {
        // The reported symptom: these two were 3.025pt apart.
        expect(gapTop, frag.text).toBeCloseTo(gapBottom, 1);
      }
    }
  });
});

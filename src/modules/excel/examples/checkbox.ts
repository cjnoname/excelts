#!/usr/bin/env node
/**
 * Checkbox example
 *
 * Generates an XLSX file that uses in-cell checkbox UI (Office Online compatible).
 *
 * Usage:
 *   node src/modules/excel/examples/checkbox.ts [outputPath]
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { writeBothFormats } from "@excel/examples/utils/write-both";
import { Cell, Column, Row, Workbook } from "@excel/index";
import type { Fill, Alignment } from "@excel/types";

async function main(): Promise<void> {
  const outDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../../tmp/excel-examples"
  );
  fs.mkdirSync(outDir, { recursive: true });
  const outputPath = process.argv[2] || path.join(outDir, "checkbox.xlsx");

  const wb = Workbook.create();
  wb.creator = "documonster";

  const ws = Workbook.addWorksheet(wb, "Checkbox");

  Cell.setValue(ws, "A1", "Task");
  Cell.setValue(ws, "B1", "Done");
  Row.setFont(ws, 1, { bold: true });

  const rows: Array<{ task: string; done: boolean; priority: "P0" | "P1" | "P2" }> = [
    { task: "Implement checkbox (Office Online)", done: true, priority: "P0" },
    { task: "Merge user styles with checkbox", done: true, priority: "P1" },
    { task: "Regression tests", done: true, priority: "P1" },
    { task: "Try opening in Excel/Office Online", done: false, priority: "P2" }
  ];

  rows.forEach((r, i) => {
    const rowNo = i + 2;
    Cell.setValue(ws, `A${rowNo}`, r.task);
    Cell.setValue(ws, `B${rowNo}`, { checkbox: r.done });
    Cell.setValue(ws, `C${rowNo}`, r.priority);
  });

  Column.setWidth(ws, 1, 46);
  Column.setWidth(ws, 2, 12);
  Column.setWidth(ws, 3, 10);

  // Add some styling to prove checkbox + user style merge works
  Cell.getStyle(ws, "B2").font = { bold: true };
  Cell.getStyle(ws, "B3").fill = {
    type: "gradient",
    gradient: "path",
    center: { left: 0.5, top: 0.5 },
    stops: [
      { position: 0, color: { argb: "FFB3E5FC" } },
      { position: 1, color: { argb: "FFFFFFFF" } }
    ]
  } satisfies Fill;

  const centered: Partial<Alignment> = { vertical: "middle", horizontal: "center" };
  Cell.getStyle(ws, "A1").alignment = centered;
  Cell.getStyle(ws, "B1").alignment = centered;
  Cell.setValue(ws, "C1", "Priority");

  await writeBothFormats(wb, outputPath);

  console.log(`Wrote: ${outputPath}`);
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});

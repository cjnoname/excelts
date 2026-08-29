/**
 * Example: PDF Export with Images
 *
 * Demonstrates embedding JPEG and PNG images via:
 * 1. Pdf.fromExcel() — Excel workbook with images → PDF
 * 2. pdf() — Standalone PDF with images (no Excel)
 *
 * Run: pnpm example --filter pdf-images
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Cell, Image, Workbook, Worksheet } from "@excel/index";

import { Pdf } from "../index";
import { pdf } from "../pdf";

const outDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../tmp/pdf-examples"
);
fs.mkdirSync(outDir, { recursive: true });

const excelDataDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../excel/examples/data"
);

const jpegPath = path.join(excelDataDir, "bubbles.jpg");
const pngPath = path.join(excelDataDir, "image2.png");
const hasJpeg = fs.existsSync(jpegPath);
const hasPng = fs.existsSync(pngPath);

console.log("=== PDF Image Examples ===\n");
console.log("--- Part A: excelToPdf (Excel workbook with images) ---\n");

// =============================================================================
// A1. Excel → PDF: JPEG image
// =============================================================================

if (hasJpeg) {
  const wb = Workbook.create();
  const ws = Workbook.addWorksheet(wb, "JPEG Example");

  Worksheet.setColumns(ws, [
    { header: "Product", key: "product", width: 25 },
    { header: "Status", key: "status", width: 15 },
    { header: "Notes", key: "notes", width: 30 }
  ]);
  Worksheet.addRows(ws, [
    { product: "Widget A", status: "Active", notes: "Best seller" },
    { product: "Widget B", status: "Pending", notes: "New launch" },
    { product: "Widget C", status: "Active", notes: "Updated design" }
  ]);

  const jpegId = Image.add(wb, { buffer: fs.readFileSync(jpegPath), extension: "jpeg" });
  Image.place(ws, jpegId, { tl: { col: 0, row: 4 }, ext: { width: 300, height: 200 } });

  fs.writeFileSync(
    path.join(outDir, "excel-images-jpeg.pdf"),
    await Pdf.fromExcel(wb, { showGridLines: true })
  );
  console.log("A1. excel-images-jpeg.pdf — table with embedded JPEG");
} else {
  console.log("A1. SKIPPED — bubbles.jpg not found");
}

// =============================================================================
// A2. Excel → PDF: PNG with alpha
// =============================================================================

if (hasPng) {
  const wb = Workbook.create();
  const ws = Workbook.addWorksheet(wb, "PNG Alpha");

  Cell.setValue(ws, "A1", "PNG with transparency");
  Cell.setStyle(ws, "A1", { font: { bold: true, size: 14 } });
  for (let r = 2; r <= 12; r++) {
    Cell.setValue(ws, `A${r}`, `Row ${r}`);
    Cell.setValue(ws, `B${r}`, r * 100);
    Cell.setValue(ws, `C${r}`, "filler");
  }

  const pngId = Image.add(wb, { buffer: fs.readFileSync(pngPath), extension: "png" });
  Image.place(ws, pngId, { tl: { col: 1, row: 2 }, ext: { width: 150, height: 150 } });

  fs.writeFileSync(
    path.join(outDir, "excel-images-png.pdf"),
    await Pdf.fromExcel(wb, { showGridLines: true })
  );
  console.log("A2. excel-images-png.pdf — PNG with alpha transparency");
} else {
  console.log("A2. SKIPPED — image2.png not found");
}

// =============================================================================
// A3. Excel → PDF: Multiple images
// =============================================================================

if (hasJpeg && hasPng) {
  const wb = Workbook.create();
  const ws = Workbook.addWorksheet(wb, "Multi-Image");

  Cell.setValue(ws, "A1", "Multiple Images");
  Cell.setStyle(ws, "A1", { font: { bold: true, size: 14 } });
  for (let r = 2; r <= 20; r++) {
    Cell.setValue(ws, `A${r}`, `Data ${r}`);
    Cell.setValue(ws, `B${r}`, r);
    Cell.setValue(ws, `C${r}`, `Item ${r}`);
    Cell.setValue(ws, `D${r}`, r * 1.5);
    Cell.setValue(ws, `E${r}`, " ");
    Cell.setValue(ws, `F${r}`, " ");
    Cell.setValue(ws, `G${r}`, " ");
  }

  const img1 = Image.add(wb, { buffer: fs.readFileSync(jpegPath), extension: "jpeg" });
  const img2 = Image.add(wb, { buffer: fs.readFileSync(pngPath), extension: "png" });
  Image.place(ws, img1, { tl: { col: 4, row: 1 }, ext: { width: 200, height: 150 } });
  Image.place(ws, img2, { tl: { col: 4, row: 10 }, ext: { width: 150, height: 150 } });

  fs.writeFileSync(
    path.join(outDir, "excel-images-multi.pdf"),
    await Pdf.fromExcel(wb, {
      showGridLines: true,
      showPageNumbers: true,
      title: "Multi-Image Report"
    })
  );
  console.log("A3. excel-images-multi.pdf — multiple images on one sheet");
} else {
  console.log("A3. SKIPPED — image files not found");
}

// =============================================================================
// Part B: Standalone pdf() with images
// =============================================================================

console.log("\n--- Part B: Standalone pdf() with images ---\n");

// =============================================================================
// B1. Standalone: JPEG image
// =============================================================================

if (hasJpeg) {
  const result = await pdf(
    {
      columns: [
        { width: 20, header: "Product" },
        { width: 15, header: "Price" }
      ],
      data: [
        ["Widget A", "$10"],
        ["Widget B", "$25"],
        ["Widget C", "$15"]
      ],
      images: [
        {
          data: fs.readFileSync(jpegPath),
          format: "jpeg",
          col: 0,
          row: 4,
          width: 300,
          height: 200
        }
      ]
    },
    { showGridLines: true }
  );

  fs.writeFileSync(path.join(outDir, "standalone-images-jpeg.pdf"), result);
  console.log("B1. standalone-images-jpeg.pdf — standalone PDF with JPEG");
} else {
  console.log("B1. SKIPPED — bubbles.jpg not found");
}

// =============================================================================
// B2. Standalone: PNG with alpha
// =============================================================================

if (hasPng) {
  const rows: (string | number)[][] = [];
  for (let r = 1; r <= 10; r++) {
    rows.push([`Row ${r}`, r * 100, "filler"]);
  }

  const result = await pdf(
    {
      name: "PNG Test",
      data: rows,
      images: [
        {
          data: fs.readFileSync(pngPath),
          format: "png",
          col: 1,
          row: 2,
          width: 150,
          height: 150
        }
      ]
    },
    { showGridLines: true }
  );

  fs.writeFileSync(path.join(outDir, "standalone-images-png.pdf"), result);
  console.log("B2. standalone-images-png.pdf — standalone PDF with PNG alpha");
} else {
  console.log("B2. SKIPPED — image2.png not found");
}

console.log("\nAll image examples generated.");

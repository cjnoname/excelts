/**
 * Example: Pdf.fromDocx — Render a Word Document to PDF
 *
 * `Pdf.fromDocx(doc, options?)` converts a `DocxDocument` (the value
 * returned by `Document.build(...)`) to PDF bytes. Options come from
 * `DocxToPdfOptions` (see pdf/word-bridge.ts): pageWidth/pageHeight, the
 * four margins, defaultFont/defaultFontSize, header/footer margins, and an
 * optional chartRenderer.
 *
 * The pdf module is allowed to reach into @word via its bridge layer, so
 * this example builds the document with @word directly.
 *
 * Usage:  pnpm example --filter pdf-from-docx
 * Output: tmp/pdf-examples/from-docx-letter.pdf
 *         tmp/pdf-examples/from-docx-a5.pdf
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Build, Document, Units } from "@word/index";

import { Pdf } from "../index";

const outDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../tmp/pdf-examples"
);
fs.mkdirSync(outDir, { recursive: true });

console.log("=== Pdf.fromDocx ===\n");

// =============================================================================
// 1. Build a simple Word document and convert with default page geometry
// =============================================================================

const doc = Document.create();
Document.useDefaultStyles(doc);
Document.addHeading(doc, "Word → PDF", 1);
Document.addParagraph(doc, "A plain paragraph rendered through the PDF flow renderer.");
Document.addParagraphElement(
  doc,
  Build.paragraph([
    Build.text("Mixed run: "),
    Build.bold("bold"),
    Build.text(", "),
    Build.text("colored", { color: "C00000" }),
    Build.text(", "),
    Build.text("LARGE", { size: Units.ptToHalfPoint(18) })
  ])
);
Document.addBulletList(doc, ["First", "Second", "Third"]);
Document.addNumberedList(doc, ["Step 1", "Step 2", "Step 3"]);
Document.addTable(
  doc,
  [
    ["Quarter", "Revenue", "Profit"],
    ["Q1", "1.2M", "0.2M"],
    ["Q2", "1.5M", "0.3M"],
    ["Q3", "1.8M", "0.4M"]
  ],
  { headerRow: true, borders: true }
);

const letterBytes = await Pdf.fromDocx(Document.build(doc));
const letterPath = path.join(outDir, "from-docx-letter.pdf");
fs.writeFileSync(letterPath, letterBytes);
console.log(`Default (US Letter) PDF: ${letterPath} (${letterBytes.length} bytes)`);

// =============================================================================
// 2. Custom page size, margins, and default font
// =============================================================================

const a5 = Document.create();
Document.useDefaultStyles(a5);
Document.addHeading(a5, "Custom A5 Portrait", 1);
Document.addParagraph(a5, "This PDF is rendered onto an A5 page (148 × 210 mm).");
Document.addParagraph(a5, "Lorem ipsum dolor sit amet. ".repeat(40));

const a5Bytes = await Pdf.fromDocx(Document.build(a5), {
  // A5 portrait: 148mm × 210mm ≈ 419.5 × 595.3 points
  pageWidth: 419.5,
  pageHeight: 595.3,
  marginTop: 36,
  marginBottom: 36,
  marginLeft: 36,
  marginRight: 36,
  defaultFont: "Helvetica",
  defaultFontSize: 10
});
const a5Path = path.join(outDir, "from-docx-a5.pdf");
fs.writeFileSync(a5Path, a5Bytes);
console.log(`Custom A5 PDF:           ${a5Path} (${a5Bytes.length} bytes)`);

// =============================================================================
// 3. Read the default PDF back to confirm the conversion is valid
// =============================================================================

const read = await Pdf.read(letterBytes);
console.log(
  `\nRead back: ${read.pages.length} page(s), ` +
    `${read.pages[0].width.toFixed(0)} x ${read.pages[0].height.toFixed(0)} pts`
);
console.log(`First line of extracted text: "${read.pages[0].textLines[0]?.text ?? ""}"`);

console.log("\n=== Done ===");

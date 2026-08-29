/**
 * Example: PDF Document Builder & Editor
 *
 * Covers:
 *   1.  PdfDocumentBuilder — blank PDF with text, shapes, images
 *   2.  Vector drawing — rectangles, circles, ellipses, lines, paths
 *   3.  SVG path rendering — drawSvgPath() with SVG `d` attributes
 *   4.  Annotations — Highlight, Text (sticky note), FreeText, Stamp, Underline, StrikeOut
 *   5.  Form field creation — TextField, Checkbox, Dropdown, RadioGroup
 *   6.  Bookmarks / outline tree
 *   7.  Table of Contents (TOC) auto-generation
 *   8.  PDF/A-1b compliance
 *   9.  PdfEditor — overlay content on existing PDFs
 *   10. PdfEditor — add/remove/rotate/split pages
 *   11. PdfEditor — form filling
 *   12. PdfEditor — incremental save
 *   13. PdfEditor — copy pages from other PDFs
 *
 * Run: pnpm example --filter pdf-builder
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Pdf } from "../index";

const outDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../tmp/pdf-examples"
);
fs.mkdirSync(outDir, { recursive: true });

// =============================================================================
// 1. PdfDocumentBuilder — Text and Shapes
// =============================================================================

{
  const doc = new Pdf.Builder();
  doc.setMetadata({ title: "Builder Basics", author: "documonster" });

  const page = doc.addPage({ width: 595, height: 842 }); // A4

  // Title
  page.drawText("PDF Document Builder", { x: 72, y: 770, fontSize: 24, bold: true });
  page.drawText("Built from scratch with documonster", {
    x: 72,
    y: 745,
    fontSize: 12,
    color: { r: 0.4, g: 0.4, b: 0.4 }
  });

  // Horizontal line
  page.drawLine({
    x1: 72,
    y1: 730,
    x2: 523,
    y2: 730,
    color: { r: 0, g: 0, b: 0 },
    lineWidth: 1
  });

  // Filled rectangle
  page.drawRect({
    x: 72,
    y: 650,
    width: 200,
    height: 60,
    fill: { r: 0.2, g: 0.4, b: 0.8 },
    stroke: { r: 0, g: 0, b: 0 },
    lineWidth: 1
  });
  page.drawText("Filled Rectangle", {
    x: 110,
    y: 672,
    fontSize: 14,
    color: { r: 1, g: 1, b: 1 }
  });

  // Circle
  page.drawCircle({
    cx: 400,
    cy: 680,
    r: 30,
    fill: { r: 0.9, g: 0.2, b: 0.2 },
    stroke: { r: 0, g: 0, b: 0 }
  });
  page.drawText("Circle", { x: 382, y: 672, fontSize: 10, color: { r: 1, g: 1, b: 1 } });

  // Ellipse
  page.drawEllipse({
    cx: 170,
    cy: 580,
    rx: 80,
    ry: 30,
    fill: { r: 0.2, g: 0.8, b: 0.3 }
  });

  // Custom path — star
  page.drawPath(
    [
      { op: "move", x: 400, y: 610 },
      { op: "line", x: 415, y: 570 },
      { op: "line", x: 455, y: 570 },
      { op: "line", x: 422, y: 545 },
      { op: "line", x: 435, y: 505 },
      { op: "line", x: 400, y: 530 },
      { op: "line", x: 365, y: 505 },
      { op: "line", x: 378, y: 545 },
      { op: "line", x: 345, y: 570 },
      { op: "line", x: 385, y: 570 },
      { op: "close" }
    ],
    { fill: { r: 1, g: 0.8, b: 0 }, stroke: { r: 0, g: 0, b: 0 } }
  );

  const bytes = await doc.build();
  fs.writeFileSync(path.join(outDir, "01-builder-basics.pdf"), bytes);
  console.log("1. 01-builder-basics.pdf — text, shapes, custom path");
}

// =============================================================================
// 2. SVG Path Rendering
// =============================================================================

{
  const doc = new Pdf.Builder();
  const page = doc.addPage();

  page.drawText("SVG Path Rendering", { x: 72, y: 770, fontSize: 20, bold: true });

  // Heart shape (SVG path)
  page.drawSvgPath(
    "M 150 400 C 150 350 100 300 50 300 C 0 300 0 350 0 375 C 0 450 75 475 150 525 C 225 475 300 450 300 375 C 300 350 300 300 250 300 C 200 300 150 350 150 400 Z",
    { fill: { r: 0.9, g: 0.1, b: 0.2 } }
  );

  page.drawText("Heart (SVG Path)", { x: 80, y: 270, fontSize: 12 });

  // Rounded rectangle via arc commands
  page.drawSvgPath(
    "M 370 700 h 150 a 10 10 0 0 1 10 10 v 50 a 10 10 0 0 1 -10 10 h -150 a 10 10 0 0 1 -10 -10 v -50 a 10 10 0 0 1 10 -10 z",
    {
      fill: { r: 0.9, g: 0.95, b: 1 },
      stroke: { r: 0.2, g: 0.4, b: 0.8 },
      lineWidth: 2
    }
  );
  page.drawText("Rounded Rect (SVG Arc)", { x: 380, y: 730, fontSize: 10 });

  // Bezier curve
  page.drawSvgPath("M 350 500 C 400 600 450 400 500 500", {
    stroke: { r: 0, g: 0.5, b: 0 },
    lineWidth: 3
  });
  page.drawText("Cubic Bezier", { x: 390, y: 480, fontSize: 10 });

  // parseSvgPath — programmatic access
  const starPath = Pdf.parseSvgPath(
    "M 400 350 L 410 310 L 440 310 L 415 290 L 425 250 L 400 270 L 375 250 L 385 290 L 360 310 L 390 310 Z"
  );
  page.drawPath(starPath, { fill: { r: 0.8, g: 0.6, b: 0 } });

  const bytes = await doc.build();
  fs.writeFileSync(path.join(outDir, "02-svg-paths.pdf"), bytes);
  console.log("2. 02-svg-paths.pdf — SVG heart, rounded rect, bezier, star");
}

// =============================================================================
// 3. Annotations
// =============================================================================

{
  const doc = new Pdf.Builder();
  const page = doc.addPage();

  page.drawText("Annotation Examples", { x: 72, y: 770, fontSize: 20, bold: true });

  // Highlight annotation
  page.drawText("This text has a highlight annotation over it.", {
    x: 72,
    y: 720,
    fontSize: 12
  });
  page.addAnnotation({
    type: "Highlight",
    rect: [72, 715, 370, 735],
    color: { r: 1, g: 1, b: 0 },
    contents: "Important text"
  });

  // Underline annotation
  page.drawText("This text is underlined via annotation.", { x: 72, y: 690, fontSize: 12 });
  page.addAnnotation({
    type: "Underline",
    rect: [72, 685, 330, 705],
    color: { r: 0, g: 0, b: 1 }
  });

  // StrikeOut annotation
  page.drawText("This text has a strikeout annotation.", { x: 72, y: 660, fontSize: 12 });
  page.addAnnotation({
    type: "StrikeOut",
    rect: [72, 655, 320, 675],
    color: { r: 1, g: 0, b: 0 }
  });

  // Sticky note (Text annotation)
  page.addAnnotation({
    type: "Text",
    rect: [72, 600, 96, 624],
    contents: "This is a sticky note comment.\nIt can have multiple lines.",
    author: "Reviewer",
    iconName: "Comment",
    color: { r: 1, g: 0.8, b: 0 }
  });
  page.drawText("← Sticky note (click to open)", { x: 110, y: 605, fontSize: 11 });

  // FreeText annotation
  page.addAnnotation({
    type: "FreeText",
    rect: [72, 530, 350, 570],
    contents: "This is a FreeText annotation — inline text on the page.",
    fontSize: 12,
    color: { r: 0, g: 0, b: 0 },
    borderColor: { r: 0.5, g: 0.5, b: 0.5 }
  });

  // Stamp annotation
  page.addAnnotation({
    type: "Stamp",
    rect: [380, 600, 520, 650],
    stampName: "Approved",
    contents: "Approved by QA on 2026-04-14",
    author: "QA Team",
    color: { r: 0, g: 0.6, b: 0 }
  });

  page.addAnnotation({
    type: "Stamp",
    rect: [380, 530, 520, 570],
    stampName: "Draft",
    contents: "Work in progress",
    color: { r: 0.8, g: 0, b: 0 }
  });

  const bytes = await doc.build();
  fs.writeFileSync(path.join(outDir, "03-annotations.pdf"), bytes);
  console.log(
    "3. 03-annotations.pdf — highlight, underline, strikeout, sticky note, freetext, stamp"
  );
}

// =============================================================================
// 4. Form Field Creation
// =============================================================================

{
  const doc = new Pdf.Builder();
  const page = doc.addPage();

  page.drawText("Form Field Creation", { x: 72, y: 770, fontSize: 20, bold: true });

  // Text field
  page.drawText("Full Name:", { x: 72, y: 720, fontSize: 12 });
  page.addFormField({
    type: "text",
    name: "fullName",
    rect: [180, 705, 400, 730],
    value: "John Doe"
  });

  // Email field
  page.drawText("Email:", { x: 72, y: 685, fontSize: 12 });
  page.addFormField({
    type: "text",
    name: "email",
    rect: [180, 670, 400, 695]
  });

  // Password field
  page.drawText("Password:", { x: 72, y: 650, fontSize: 12 });
  page.addFormField({
    type: "text",
    name: "password",
    rect: [180, 635, 400, 660],
    password: true
  });

  // Multiline text
  page.drawText("Comments:", { x: 72, y: 610, fontSize: 12 });
  page.addFormField({
    type: "text",
    name: "comments",
    rect: [180, 560, 520, 620],
    multiline: true
  });

  // Checkbox
  page.drawText("I agree to the terms:", { x: 72, y: 530, fontSize: 12 });
  page.addFormField({
    type: "checkbox",
    name: "agreeTerms",
    rect: [250, 520, 270, 540],
    checked: true
  });

  page.drawText("Subscribe to newsletter:", { x: 72, y: 500, fontSize: 12 });
  page.addFormField({
    type: "checkbox",
    name: "subscribe",
    rect: [250, 490, 270, 510]
  });

  // Dropdown
  page.drawText("Country:", { x: 72, y: 465, fontSize: 12 });
  page.addFormField({
    type: "dropdown",
    name: "country",
    rect: [180, 450, 350, 475],
    options: ["United States", "Canada", "United Kingdom", "Australia", "Germany", "Japan"],
    value: "United States"
  });

  // Radio buttons
  page.drawText("Preferred Contact:", { x: 72, y: 420, fontSize: 12 });
  page.drawText("Email", { x: 200, y: 420, fontSize: 11 });
  page.drawText("Phone", { x: 280, y: 420, fontSize: 11 });
  page.drawText("Mail", { x: 355, y: 420, fontSize: 11 });
  page.addFormField({
    type: "radio",
    name: "contactMethod",
    buttons: [
      { rect: [180, 415, 195, 430], value: "email" },
      { rect: [260, 415, 275, 430], value: "phone" },
      { rect: [335, 415, 350, 430], value: "mail" }
    ],
    selected: "email"
  });

  const bytes = await doc.build();
  fs.writeFileSync(path.join(outDir, "04-form-fields.pdf"), bytes);

  // Verify form fields are readable
  const result = await Pdf.read(bytes);
  console.log(
    `4. 04-form-fields.pdf — ${result.formFields.length} form fields created:`,
    result.formFields.map(f => `${f.name}(${f.type})`).join(", ")
  );
}

// =============================================================================
// 5. Bookmarks & Table of Contents
// =============================================================================

{
  const doc = new Pdf.Builder();
  doc.setMetadata({ title: "Report with TOC" });

  // Page 1: TOC placeholder (will be generated)
  // Pages 2+: content pages with bookmarks
  const chapters = ["Introduction", "Getting Started", "API Reference", "Advanced Topics", "FAQ"];

  // Create content pages
  for (const chapter of chapters) {
    const page = doc.addPage();
    page.drawText(chapter, { x: 72, y: 770, fontSize: 24, bold: true });
    page.drawText(`This is the ${chapter.toLowerCase()} chapter content.`, {
      x: 72,
      y: 730,
      fontSize: 12
    });
    page.drawText("Lorem ipsum dolor sit amet, consectetur adipiscing elit.", {
      x: 72,
      y: 710,
      fontSize: 11,
      color: { r: 0.3, g: 0.3, b: 0.3 }
    });
  }

  // Add bookmarks
  doc.addBookmark("Introduction", 0);
  doc.addBookmark("Getting Started", 1);
  doc.addBookmark("API Reference", 2);
  doc.addBookmark("Advanced Topics", 3);
  doc.addBookmark("FAQ", 4);

  // Generate TOC (inserted before content pages)
  doc.generateTableOfContents({
    title: "Table of Contents",
    fontSize: 11
  });

  const bytes = await doc.build();
  fs.writeFileSync(path.join(outDir, "05-bookmarks-toc.pdf"), bytes);

  // Verify bookmarks are readable
  await Pdf.read(bytes, { extractBookmarks: true } as never);
  console.log(`5. 05-bookmarks-toc.pdf — ${chapters.length} chapters with bookmarks + TOC`);
}

// =============================================================================
// 6. PDF/A-1b Compliance
// =============================================================================

{
  const doc = new Pdf.Builder();
  doc.setMetadata({
    title: "PDF/A Compliant Document",
    author: "documonster",
    subject: "Archive-safe document"
  });
  doc.setPdfACompliance();

  const page = doc.addPage();
  page.drawText("PDF/A-1b Compliant Document", { x: 72, y: 770, fontSize: 20, bold: true });
  page.drawText("This PDF includes XMP metadata, OutputIntent, and sRGB ICC profile.", {
    x: 72,
    y: 740,
    fontSize: 11
  });
  page.drawText("Suitable for long-term archival per ISO 19005-1.", {
    x: 72,
    y: 720,
    fontSize: 11,
    color: { r: 0.3, g: 0.3, b: 0.3 }
  });

  const bytes = await doc.build();
  fs.writeFileSync(path.join(outDir, "06-pdfa.pdf"), bytes);
  console.log("6. 06-pdfa.pdf — PDF/A-1b with XMP + OutputIntent + sRGB ICC");
}

// =============================================================================
// 6b. PdfDocumentBuilder — Encryption
// =============================================================================

{
  const doc = new Pdf.Builder();
  const page = doc.addPage();
  page.drawText("This PDF is encrypted with AES-256", { x: 72, y: 770, fontSize: 16 });
  page.drawText("Owner password: admin, User password: reader", {
    x: 72,
    y: 740,
    fontSize: 11,
    color: { r: 0.3, g: 0.3, b: 0.3 }
  });

  doc.setEncryption({
    ownerPassword: "admin",
    userPassword: "reader",
    permissions: { print: true, copy: false, modify: false }
  });

  const bytes = await doc.build();
  fs.writeFileSync(path.join(outDir, "06b-encrypted.pdf"), bytes);

  // Verify it's encrypted and readable with password
  const result = await Pdf.read(bytes, { password: "reader" });
  console.log(
    `6b. 06b-encrypted.pdf — encrypted: ${result.metadata.encrypted}, text: "${result.text.slice(0, 40)}..."`
  );
}

// =============================================================================
// 6c. Watermarks (via pdf() / excelToPdf())
// =============================================================================

{
  // Text watermark
  const { pdf: pdfFn } = await import("../pdf");
  const bytes = await pdfFn(
    [
      ["Product", "Revenue", "Region"],
      ["Widget A", 1200, "North"],
      ["Widget B", 800, "South"],
      ["Gadget C", 3200, "East"]
    ],
    {
      showGridLines: true,
      watermark: {
        type: "text",
        text: "CONFIDENTIAL",
        fontSize: 48,
        color: { r: 0.8, g: 0.8, b: 0.8 },
        opacity: 0.3,
        rotation: -45,
        position: "center"
      }
    }
  );
  fs.writeFileSync(path.join(outDir, "06c-watermark-text.pdf"), bytes);
  console.log("6c. 06c-watermark-text.pdf — text watermark: CONFIDENTIAL");
}

// =============================================================================
// 7. PdfEditor — Overlay Content on Existing PDF
// =============================================================================

{
  // First create a base PDF
  const doc = new Pdf.Builder();
  const page = doc.addPage();
  page.drawText("Original Document", { x: 72, y: 770, fontSize: 20 });
  page.drawText("This is the original content.", { x: 72, y: 740, fontSize: 12 });
  const basePdf = await doc.build();

  // Now edit it
  const editor = Pdf.Editor.load(basePdf);
  const editPage = editor.getPage(0);

  // Add overlay text
  editPage.drawText("EDITED — overlay text added", {
    x: 72,
    y: 700,
    fontSize: 14,
    color: { r: 0.8, g: 0, b: 0 }
  });

  // Add a shape
  editPage.drawRect({
    x: 72,
    y: 620,
    width: 200,
    height: 50,
    fill: { r: 0.9, g: 0.95, b: 1 },
    stroke: { r: 0.2, g: 0.4, b: 0.8 }
  });
  editPage.drawText("Overlaid rectangle", { x: 90, y: 640, fontSize: 11 });

  // Add an annotation
  editPage.addAnnotation({
    type: "Highlight",
    rect: [72, 735, 300, 755],
    contents: "Highlighting the original text"
  });

  // Add a form field
  editPage.addFormField({
    type: "text",
    name: "editorNote",
    rect: [72, 560, 300, 585]
  });

  // Add SVG path
  editPage.drawSvgPath("M 400 700 L 420 650 L 440 700 Z", {
    fill: { r: 0, g: 0.7, b: 0 }
  });

  const result = await editor.save();
  fs.writeFileSync(path.join(outDir, "07-editor-overlay.pdf"), result);
  console.log("7. 07-editor-overlay.pdf — text, shape, annotation, form field overlaid");
}

// =============================================================================
// 8. PdfEditor — Page Manipulation (Add/Remove/Rotate/Split)
// =============================================================================

{
  // Create a 4-page source PDF
  const doc = new Pdf.Builder();
  for (let i = 1; i <= 4; i++) {
    const page = doc.addPage();
    page.drawText(`Page ${i}`, { x: 250, y: 420, fontSize: 36, bold: true });
  }
  const sourcePdf = await doc.build();

  // Remove page 2
  {
    const editor = Pdf.Editor.load(sourcePdf);
    editor.removePage(1); // 0-indexed
    const result = await editor.save();
    const read = await Pdf.read(result);
    fs.writeFileSync(path.join(outDir, "08a-removed-page2.pdf"), result);
    console.log(`8a. 08a-removed-page2.pdf — ${read.metadata.pageCount} pages (removed page 2)`);
  }

  // Rotate page 1 by 90 degrees
  {
    const editor = Pdf.Editor.load(sourcePdf);
    editor.rotatePage(0, 90);
    const result = await editor.save();
    fs.writeFileSync(path.join(outDir, "08b-rotated.pdf"), result);
    console.log("8b. 08b-rotated.pdf — page 1 rotated 90°");
  }

  // Split into individual pages
  {
    const editor = Pdf.Editor.load(sourcePdf);
    const pages = await editor.splitPages();
    for (let i = 0; i < pages.length; i++) {
      fs.writeFileSync(path.join(outDir, `08c-split-page${i + 1}.pdf`), pages[i]);
    }
    console.log(`8c. 08c-split-page*.pdf — split into ${pages.length} individual PDFs`);
  }

  // Add a new blank page
  {
    const editor = Pdf.Editor.load(sourcePdf);
    const newPage = editor.addPage();
    newPage.drawText("New Page Added by Editor", { x: 72, y: 770, fontSize: 18 });
    const result = await editor.save();
    const read = await Pdf.read(result);
    fs.writeFileSync(path.join(outDir, "08d-added-page.pdf"), result);
    console.log(`8d. 08d-added-page.pdf — ${read.metadata.pageCount} pages (1 new)`);
  }
}

// =============================================================================
// 9. PdfEditor — Form Filling
// =============================================================================

{
  // Create a PDF with form fields
  const doc = new Pdf.Builder();
  const page = doc.addPage();
  page.drawText("Application Form", { x: 72, y: 770, fontSize: 20, bold: true });
  page.drawText("Name:", { x: 72, y: 720, fontSize: 12 });
  page.addFormField({ type: "text", name: "applicantName", rect: [150, 705, 350, 730] });
  page.drawText("Accepted:", { x: 72, y: 685, fontSize: 12 });
  page.addFormField({ type: "checkbox", name: "accepted", rect: [150, 678, 168, 696] });
  const formPdf = await doc.build();

  // Now fill the form
  const editor = Pdf.Editor.load(formPdf);
  editor.setFormField("applicantName", "Jane Smith");
  editor.setFormField("accepted", "Yes");
  const filled = await editor.save();
  fs.writeFileSync(path.join(outDir, "09-form-filled.pdf"), filled);

  const result = await Pdf.read(filled);
  const nameField = result.formFields.find(f => f.name === "applicantName");
  console.log(`9. 09-form-filled.pdf — filled: name="${nameField?.value}"`);
}

// =============================================================================
// 10. PdfEditor — Incremental Save
// =============================================================================

{
  const doc = new Pdf.Builder();
  const page = doc.addPage();
  page.drawText("Original content for incremental update", { x: 72, y: 770, fontSize: 14 });
  page.addFormField({ type: "text", name: "note", rect: [72, 720, 300, 745] });
  const original = await doc.build();

  // Incremental save — only appends changes, preserves original bytes
  const editor = Pdf.Editor.load(original);
  editor.setFormField("note", "Updated via incremental save");
  const updated = await editor.saveIncremental();

  // The updated file starts with the original bytes
  const isIncremental = updated.length > original.length;
  fs.writeFileSync(path.join(outDir, "10-incremental.pdf"), updated);
  console.log(
    `10. 10-incremental.pdf — incremental: ${isIncremental}, original=${original.length}b, updated=${updated.length}b`
  );
}

// =============================================================================
// 11. PdfEditor — Copy Pages from Another PDF
// =============================================================================

{
  // Source A
  const docA = new Pdf.Builder();
  const pageA = docA.addPage();
  pageA.drawText("Document A — Page 1", { x: 72, y: 770, fontSize: 20 });
  const pdfA = await docA.build();

  // Source B
  const docB = new Pdf.Builder();
  const pageB1 = docB.addPage();
  pageB1.drawText("Document B — Page 1", { x: 72, y: 770, fontSize: 20 });
  const pageB2 = docB.addPage();
  pageB2.drawText("Document B — Page 2", { x: 72, y: 770, fontSize: 20 });
  const pdfB = await docB.build();

  // Merge: A's page + B's pages into one PDF
  const editor = Pdf.Editor.load(pdfA);
  editor.copyPagesFrom(pdfB);
  const merged = await editor.save();

  const result = await Pdf.read(merged);
  fs.writeFileSync(path.join(outDir, "11-merged.pdf"), merged);
  console.log(`11. 11-merged.pdf — merged ${result.metadata.pageCount} pages from 2 PDFs`);
}

console.log(`\nAll examples written to: ${outDir}`);

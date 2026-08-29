/**
 * Word Example 49 — Streaming reader
 *
 * The read-side counterpart to example 22 (the streaming writer). Instead of
 * materializing the whole document.xml DOM, the streaming reader yields one
 * body-level element (`BodyContent`) at a time while the package is inflated
 * incrementally — peak memory is O(largest single body element).
 *
 * Covers:
 *   - Streaming.createDocxStreamReader(bytes)   — factory
 *   - new Streaming.StreamingDocxReader(bytes, opts) — class form, with the
 *     onProgress callback (reports cumulative uncompressed document.xml bytes)
 *   - `for await (const item of reader)`        — async iteration over body
 *   - reader.metadata / reader.styles           — up-front metadata
 *   - reader.consumedBytes                      — incremental-streaming evidence
 *   - reader.sectionProperties                  — trailing <w:sectPr>
 *
 * The DOCX is generated first with the streaming *writer* (mirroring example
 * 22), then read straight back from the in-memory buffer.
 *
 * Usage:   pnpm example --filter 49-streaming-read
 * Output:  tmp/word-examples/49-streaming-read-source.docx
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Build, Streaming } from "../index";

const outDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../tmp/word-examples"
);
fs.mkdirSync(outDir, { recursive: true });

// ---------------------------------------------------------------------------
// 1. Produce a DOCX buffer with the streaming writer (write side, à la #22)
// ---------------------------------------------------------------------------
const writer = Streaming.createDocxStream({
  styles: [
    { type: "paragraph", styleId: "Normal", name: "Normal", isDefault: true, qFormat: true },
    {
      type: "paragraph",
      styleId: "Heading1",
      name: "heading 1",
      basedOn: "Normal",
      next: "Normal",
      qFormat: true,
      runProperties: { font: "Calibri Light", color: "2F5496", size: 32 }
    }
  ],
  coreProperties: { title: "Streamed source", creator: "OpenCode" }
});
writer.add(Build.paragraph([Build.bold("Streamed Source Document")], { style: "Heading1" }));
for (let i = 1; i <= 800; i++) {
  writer.addText(`Body paragraph ${i}: the quick brown fox jumps over the lazy dog.`);
}
// A table — exercises the reader's non-paragraph body element path.
writer.add({
  type: "table",
  rows: [
    {
      cells: [
        { content: [Build.textParagraph("Cell A1")] },
        { content: [Build.textParagraph("Cell B1")] }
      ]
    },
    {
      cells: [
        { content: [Build.textParagraph("Cell A2")] },
        { content: [Build.textParagraph("Cell B2")] }
      ]
    }
  ]
});
const sourceBuf = await writer.finalize();
fs.writeFileSync(path.join(outDir, "49-streaming-read-source.docx"), sourceBuf);
console.log(`  → 49-streaming-read-source.docx (${(sourceBuf.length / 1024).toFixed(1)} KB)`);

// ---------------------------------------------------------------------------
// 2. Read it back with the factory createDocxStreamReader + for-await
// ---------------------------------------------------------------------------
{
  const reader = Streaming.createDocxStreamReader(sourceBuf);
  let paragraphs = 0;
  let tables = 0;
  let firstConsumed = -1;
  for await (const item of reader) {
    if (firstConsumed < 0) {
      // The first element is emitted long before the whole part is inflated —
      // direct evidence of incremental (non-buffering) streaming.
      firstConsumed = reader.consumedBytes;
    }
    if (item.type === "paragraph") {
      paragraphs++;
    } else if (item.type === "table") {
      tables++;
    }
  }
  console.log(
    `  iterated: ${paragraphs} paragraph(s), ${tables} table(s); ` +
      `consumedBytes at first yield = ${firstConsumed}, total = ${reader.consumedBytes}`
  );
  console.log(
    `  metadata: ${reader.styles.length} style(s); ` +
      `sectionProperties present = ${reader.sectionProperties !== undefined}`
  );
}

// ---------------------------------------------------------------------------
// 3. Class form with onProgress callback (the factory option bag has no hook).
//    The callback reports cumulative uncompressed document.xml bytes consumed.
// ---------------------------------------------------------------------------
{
  let progressEvents = 0;
  let lastConsumed = 0;
  const reader = new Streaming.StreamingDocxReader(sourceBuf, {
    onProgress: consumed => {
      progressEvents++;
      lastConsumed = consumed;
    }
  });
  let count = 0;
  for await (const _item of reader) {
    count++;
  }
  console.log(
    `  class form: ${count} body element(s), ${progressEvents} progress event(s), ` +
      `final consumed = ${lastConsumed} bytes`
  );
}

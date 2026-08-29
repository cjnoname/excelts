/**
 * Integration test: comments subdirectory layout + author round-trip
 *
 * Verifies that documonster correctly reads comments from xlsx files using
 * the subdirectory layout (xl/comments/comment1.xml) with absolute rel
 * targets, as produced by some third-party tools.
 */

import { ZipArchive } from "@archive/zip";
import { expectValidXlsx } from "@excel/__tests__/helpers/expect-valid-xlsx";
import { cellNote, cellComment, cellSetComment } from "@excel/core/cell";
import { noteCreate, noteModel } from "@excel/core/note";
import { getCell } from "@excel/core/worksheet";
import { Cell, Workbook } from "@excel/index";
import { describe, it, expect } from "vitest";

// =============================================================================
// Helpers
// =============================================================================

/** Build an XLSX buffer with comments from two different authors. */
async function buildCommentsXlsx(): Promise<Uint8Array> {
  const wb = Workbook.create();
  const ws = Workbook.addWorksheet(wb, "Sheet1");

  Cell.setValue(ws, "A1", "Hello");
  cellSetComment(getCell(ws, "A1"), noteCreate({ texts: [{ text: "Comment by Alice" }] }, "Alice"));

  Cell.setValue(ws, "B2", "World");
  cellSetComment(getCell(ws, "B2"), noteCreate({ texts: [{ text: "Comment by Bob" }] }, "Bob"));

  const buffer = new Uint8Array(await Workbook.toBuffer(wb));
  await expectValidXlsx(buffer, { label: "comments-subdir build" });
  return buffer;
}

/**
 * Repack an XLSX buffer to use subdirectory layout for comments:
 * - xl/comments1.xml -> xl/comments/comment1.xml
 * - worksheet rels use absolute targets (/xl/comments/comment1.xml)
 * - [Content_Types].xml references updated paths
 */
async function repackToSubdirLayout(buffer: Uint8Array): Promise<Uint8Array> {
  const { extractAll } = await import("@archive/unzip/extract");
  const entries = await extractAll(buffer);
  const archive = new ZipArchive({ level: 0, reproducible: true });

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  for (const [name, entry] of entries) {
    // Rename xl/comments1.xml -> xl/comments/comment1.xml
    const commentsMatch = /^xl\/comments(\d+)\.xml$/.exec(name);
    if (commentsMatch) {
      const idx = commentsMatch[1];
      archive.add(`xl/comments/comment${idx}.xml`, entry.data);
      continue;
    }

    // Rewrite [Content_Types].xml
    if (name === "[Content_Types].xml") {
      let xml = decoder.decode(entry.data);
      xml = xml.replace(
        /PartName="\/xl\/comments(\d+)\.xml"/g,
        'PartName="/xl/comments/comment$1.xml"'
      );
      archive.add(name, encoder.encode(xml));
      continue;
    }

    // Rewrite worksheet rels to use absolute targets
    if (/^xl\/worksheets\/_rels\/sheet\d+\.xml\.rels$/.test(name)) {
      let xml = decoder.decode(entry.data);
      xml = xml.replace(
        /Target="\.\.\/comments(\d+)\.xml"/g,
        'Target="/xl/comments/comment$1.xml"'
      );
      archive.add(name, encoder.encode(xml));
      continue;
    }

    archive.add(name, entry.data);
  }

  return archive.bytes();
}

async function omitWorksheetCell(buffer: Uint8Array, address: string): Promise<Uint8Array> {
  const { extractAll } = await import("@archive/unzip/extract");
  const entries = await extractAll(buffer);
  const archive = new ZipArchive({ level: 0, reproducible: true });
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  for (const [name, entry] of entries) {
    if (name === "xl/worksheets/sheet1.xml") {
      const escaped = address.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const xml = decoder
        .decode(entry.data)
        .replace(new RegExp(`<c\\b[^>]*\\br="${escaped}"[^>]*(?:/>|>[\\s\\S]*?</c>)`), "");
      archive.add(name, encoder.encode(xml));
    } else {
      archive.add(name, entry.data);
    }
  }
  return archive.bytes();
}

// =============================================================================
// Tests
// =============================================================================

describe("Comments subdirectory layout", () => {
  it("materializes a blank cell referenced only by the comments part", async () => {
    const source = Workbook.create();
    const sourceSheet = Workbook.addWorksheet(source, "Sheet1");
    Cell.setComment(sourceSheet, "C3", {
      author: "Blank cell author",
      note: "Comment on an omitted blank cell"
    });
    const generated = new Uint8Array(await Workbook.toBuffer(source));
    const withoutCell = await omitWorksheetCell(generated, "C3");

    const target = Workbook.create();
    await Workbook.read(target, withoutCell);
    expect(Cell.getComment(Workbook.getWorksheet(target, "Sheet1")!, "C3")).toEqual({
      author: "Blank cell author",
      note: "Comment on an omitted blank cell"
    });
  });

  it("round-trips comments and authors through flat layout", async () => {
    const buffer = await buildCommentsXlsx();
    const wb = Workbook.create();
    await Workbook.read(wb, buffer);
    const ws = Workbook.getWorksheet(wb, "Sheet1")!;

    const a1 = getCell(ws, "A1");
    const b2 = getCell(ws, "B2");

    expect(cellNote(a1)).toBeDefined();
    expect(cellNote(b2)).toBeDefined();
    expect(cellComment(a1)?.author).toBe("Alice");
    expect(cellComment(b2)?.author).toBe("Bob");
  });

  it("reads comments from subdirectory layout with absolute rel targets", async () => {
    const flatBuffer = await buildCommentsXlsx();
    const subdirBuffer = await repackToSubdirLayout(flatBuffer);

    const wb = Workbook.create();
    await Workbook.read(wb, subdirBuffer);
    const ws = Workbook.getWorksheet(wb, "Sheet1")!;

    const a1 = getCell(ws, "A1");
    const b2 = getCell(ws, "B2");

    expect(cellNote(a1)).toBeDefined();
    expect(cellNote(b2)).toBeDefined();
    expect(cellComment(a1)?.author).toBe("Alice");
    expect(cellComment(b2)?.author).toBe("Bob");
  });

  it("preserves comment text content from subdirectory layout", async () => {
    const flatBuffer = await buildCommentsXlsx();
    const subdirBuffer = await repackToSubdirLayout(flatBuffer);

    const wb = Workbook.create();
    await Workbook.read(wb, subdirBuffer);
    const ws = Workbook.getWorksheet(wb, "Sheet1")!;

    // Verify the actual text survived
    const a1Note = Cell.getNote(ws, "A1");
    expect(a1Note).toContain("Comment by Alice");
  });

  it("round-trips comment without explicit author (default author)", async () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "A1", "Test");
    cellSetComment(getCell(ws, "A1"), noteCreate({ texts: [{ text: "No author set" }] }));

    const buffer = await Workbook.toBuffer(wb);
    await expectValidXlsx(buffer, { label: "comment-default-author" });
    const wb2 = Workbook.create();
    await Workbook.read(wb2, buffer);
    const ws2 = Workbook.getWorksheet(wb2, "Sheet1")!;

    expect(Cell.getNote(ws2, "A1")).toBeDefined();
    // Default author should be "Author"
    expect(cellComment(getCell(ws2, "A1"))?.author).toBe("Author");
  });

  it("reads legacy comment body written as a bare <t> (no <r> run)", async () => {
    // Some tools store the comment body as <text><t>...</t></text>
    // with no <r> run wrapper. Rewrite our generated comments file to that
    // shape and verify the body survives the read.
    const flatBuffer = await buildCommentsXlsx();

    const { extractAll } = await import("@archive/unzip/extract");
    const entries = await extractAll(flatBuffer);
    const archive = new ZipArchive({ level: 0, reproducible: true });

    const decoder = new TextDecoder();
    const encoder = new TextEncoder();

    for (const [name, entry] of entries) {
      if (/^xl\/comments\d+\.xml$/.test(name)) {
        let xml = decoder.decode(entry.data);
        // Replace <r>...<t>TEXT</t></r> runs with a bare <t>TEXT</t>
        xml = xml.replace(/<r>(?:(?!<\/r>).)*?<t[^>]*>([^<]*)<\/t><\/r>/g, "<t>$1</t>");
        archive.add(name, encoder.encode(xml));
        continue;
      }
      archive.add(name, entry.data);
    }

    const repackedBuffer = await archive.bytes();
    const wb = Workbook.create();
    await Workbook.read(wb, repackedBuffer);
    const ws = Workbook.getWorksheet(wb, "Sheet1")!;

    expect(Cell.getNote(ws, "A1")).toContain("Comment by Alice");
    expect(Cell.getNote(ws, "B2")).toContain("Comment by Bob");
    expect(cellComment(getCell(ws, "A1"))?.author).toBe("Alice");
  });

  it("merges VML metadata correctly even when VML shape order differs from comments", async () => {
    const flatBuffer = await buildCommentsXlsx();

    // Repack: reverse the order of <v:shape> elements in the VML file
    const { extractAll } = await import("@archive/unzip/extract");
    const entries = await extractAll(flatBuffer);
    const archive = new ZipArchive({ level: 0, reproducible: true });

    const decoder = new TextDecoder();
    const encoder = new TextEncoder();

    for (const [name, entry] of entries) {
      if (/^xl\/drawings\/vmlDrawing\d+\.vml$/.test(name)) {
        let vml = decoder.decode(entry.data);
        // Extract all <v:shape ...>...</v:shape> blocks and reverse them
        const shapes: string[] = [];
        const shapeRegex = /<v:shape\b[^]*?<\/v:shape>/g;
        let match: RegExpExecArray | null;
        while ((match = shapeRegex.exec(vml)) !== null) {
          shapes.push(match[0]);
        }
        if (shapes.length >= 2) {
          // Replace shapes in reverse order
          let idx = 0;
          const reversed = shapes.slice().reverse();
          vml = vml.replace(shapeRegex, () => reversed[idx++]);
        }
        archive.add(name, encoder.encode(vml));
        continue;
      }
      archive.add(name, entry.data);
    }

    const repackedBuffer = await archive.bytes();
    const wb = Workbook.create();
    await Workbook.read(wb, repackedBuffer);
    const ws = Workbook.getWorksheet(wb, "Sheet1")!;

    // Despite reversed VML order, each cell should get its own note metadata
    const a1 = getCell(ws, "A1");
    const b2 = getCell(ws, "B2");

    expect(cellNote(a1)).toBeDefined();
    expect(cellNote(b2)).toBeDefined();
    expect(cellComment(a1)?.author).toBe("Alice");
    expect(cellComment(b2)?.author).toBe("Bob");

    // Verify VML metadata (editAs) is present on both — proves merge happened
    const a1Note = cellComment(a1);
    const b2Note = cellComment(b2);
    const a1Model = a1Note ? noteModel(a1Note) : undefined;
    const b2Model = b2Note ? noteModel(b2Note) : undefined;
    expect(a1Model?.note?.editAs).toBeDefined();
    expect(b2Model?.note?.editAs).toBeDefined();
  });
});

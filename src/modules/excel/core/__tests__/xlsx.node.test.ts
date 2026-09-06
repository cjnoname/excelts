import { ZipArchive } from "@archive/zip";
import { cellFill, cellFont, cellGetValue, cellHyperlink, cellText } from "@excel/core/cell";
import { getWorksheets } from "@excel/core/workbook";
import { addConditionalFormatting, getCell, getSheetName, rowGetCell } from "@excel/core/worksheet";
import { Cell, Column, Workbook, Worksheet } from "@excel/index";
import { WorkbookReader } from "@excel/stream/workbook-reader";
import { PassThrough } from "@stream";
import { describe, it, expect } from "vitest";

// =============================================================================
// Helpers
// =============================================================================

/** Build a minimal valid XLSX buffer for testing. */
async function buildMinimalXlsx(): Promise<Uint8Array> {
  const wb = Workbook.create();
  Cell.setValue(Workbook.addWorksheet(wb, "Sheet1"), "A1", "hello");
  return Workbook.toBuffer(wb);
}

/**
 * Build a dirty XLSX buffer whose shared strings contain invalid XML characters.
 *
 * Creates a normal XLSX via the Workbook API, then extracts the raw ZIP entries,
 * injects invalid bytes (0x7F, 0x01, etc.) into the shared-strings XML, and
 * re-zips the result.  This simulates real-world XLSX files from third-party
 * tools that embed non-XML-1.0 characters.
 */
async function buildDirtyXlsx(
  invalidChars: string = "\x7f",
  cellText: string = "hello"
): Promise<Uint8Array> {
  // 1. Build a clean XLSX
  const wb = Workbook.create();
  Cell.setValue(Workbook.addWorksheet(wb, "Sheet1"), "A1", cellText);
  const cleanBuffer = await Workbook.toBuffer(wb);

  // 2. Extract all ZIP entries
  const { extractAll } = await import("@archive/unzip/extract");
  const entries = await extractAll(cleanBuffer);

  // 3. Find and mutate the shared strings XML
  const ssiKey = "xl/sharedStrings.xml";
  const ssiEntry = entries.get(ssiKey);
  if (!ssiEntry) {
    throw new Error("no sharedStrings.xml found in generated XLSX");
  }
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let xml = decoder.decode(ssiEntry.data);
  // Inject invalid chars right before the cell text
  xml = xml.replace(cellText, invalidChars + cellText + invalidChars);
  ssiEntry.data = encoder.encode(xml);

  // 4. Re-zip all entries
  const archive = new ZipArchive({ level: 0, reproducible: true });
  for (const [name, entry] of entries) {
    archive.add(name, entry.data);
  }
  return archive.bytes();
}

/** Build a feature-rich XLSX buffer for round-trip testing. */
async function buildRichXlsx(): Promise<Uint8Array> {
  const wb = Workbook.create();
  wb.creator = "TestAuthor";
  wb.created = new Date(2024, 0, 1);

  const ws1 = Workbook.addWorksheet(wb, "Data");
  Worksheet.setColumns(ws1, [
    { header: "ID", key: "id", width: 10 },
    { header: "Name", key: "name", width: 32 },
    { header: "Value", key: "val", width: 15 }
  ]);
  Worksheet.addRow(ws1, { id: 1, name: "Alice", val: 100 });
  Worksheet.addRow(ws1, { id: 2, name: "Bob", val: 200 });
  Worksheet.addRow(ws1, { id: 3, name: "Charlie", val: 300 });

  Cell.setValue(ws1, "D1", new Date(2024, 5, 15));
  Cell.setStyle(ws1, "D1", { numFmt: "yyyy-mm-dd" });
  Cell.setValue(ws1, "E1", true);
  Cell.setValue(ws1, "F1", { formula: "SUM(C2:C4)", result: 600 });
  Cell.setValue(ws1, "G1", { text: "Google", hyperlink: "https://google.com" });

  Cell.setStyle(ws1, "A1", { font: { bold: true } });
  Cell.setStyle(ws1, "A1", {
    fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FFCCCCCC" } }
  });

  Worksheet.merge(ws1, "H1:I2");
  Cell.setValue(ws1, "H1", "merged");

  const ws2 = Workbook.addWorksheet(wb, "Hidden", { state: "hidden" });
  Cell.setValue(ws2, "A1", "secret");

  return Workbook.toBuffer(wb);
}

// =============================================================================
// Tests
// =============================================================================

describe("XLSX", () => {
  // ===========================================================================
  // writeBuffer / load Round-Trip
  // ===========================================================================

  describe("writeBuffer / load round-trip", () => {
    it("writes and loads a minimal workbook", async () => {
      const buffer = await buildMinimalXlsx();

      expect(buffer).toBeInstanceOf(Uint8Array);
      expect(buffer.length).toBeGreaterThan(0);

      const wb = Workbook.create();
      await Workbook.read(wb, buffer);

      expect(getWorksheets(wb).length).toBe(1);
      expect(Cell.getValue(Workbook.getWorksheet(wb, "Sheet1")!, "A1")).toBe("hello");
    });

    it("preserves all value types through round-trip", async () => {
      const buffer = await buildRichXlsx();
      const wb = Workbook.create();
      await Workbook.read(wb, buffer);

      const ws = Workbook.getWorksheet(wb, "Data")!;
      expect(Cell.getValue(ws, "A2")).toBe(1); // number
      expect(Cell.getValue(ws, "B2")).toBe("Alice"); // string
      expect(Cell.getValue(ws, "D1")).toBeInstanceOf(Date); // date
      expect(Cell.getValue(ws, "E1")).toBe(true); // boolean

      // formula
      const f = Cell.getValue(ws, "F1") as { formula: string; result: number };
      expect(f.formula).toBe("SUM(C2:C4)");
      expect(f.result).toBe(600);

      // hyperlink
      const h = Cell.getValue(ws, "G1") as { text: string; hyperlink: string };
      expect(h.text).toBe("Google");
      expect(h.hyperlink).toBe("https://google.com");
    });

    it("preserves styles through round-trip", async () => {
      const buffer = await buildRichXlsx();
      const wb = Workbook.create();
      await Workbook.read(wb, buffer);

      const cell = getCell(Workbook.getWorksheet(wb, "Data")!, "A1");
      expect(cellFont(cell)!.bold).toBe(true);

      const fill = cellFill(cell) as { type: string; pattern: string; fgColor: { argb: string } };
      expect(fill.pattern).toBe("solid");
      expect(fill.fgColor.argb).toBe("FFCCCCCC");
    });

    it("preserves merged cells through round-trip", async () => {
      const buffer = await buildRichXlsx();
      const wb = Workbook.create();
      await Workbook.read(wb, buffer);

      const ws = Workbook.getWorksheet(wb, "Data")!;
      expect(Cell.getValue(ws, "H1")).toBe("merged");
      expect(Cell.isMerged(ws, "I2")).toBe(true);
    });

    it("preserves column definitions through round-trip", async () => {
      const buffer = await buildRichXlsx();
      const wb = Workbook.create();
      await Workbook.read(wb, buffer);

      const ws = Workbook.getWorksheet(wb, "Data")!;
      expect(Column.getWidth(ws, 1)).toBe(10);
      expect(Column.getWidth(ws, 2)).toBe(32);
      expect(Column.getWidth(ws, 3)).toBe(15);
    });

    it("preserves metadata through round-trip", async () => {
      const buffer = await buildRichXlsx();
      const wb = Workbook.create();
      await Workbook.read(wb, buffer);

      expect(wb.creator).toBe("TestAuthor");
      expect(wb.created).toBeInstanceOf(Date);
    });

    it("preserves sheet state (hidden) through round-trip", async () => {
      const buffer = await buildRichXlsx();
      const wb = Workbook.create();
      await Workbook.read(wb, buffer);

      expect(Workbook.getWorksheet(wb, "Data")!.state).toBe("visible");
      expect(Workbook.getWorksheet(wb, "Hidden")!.state).toBe("hidden");
    });

    it("preserves multiple sheets with correct order", async () => {
      const wb1 = Workbook.create();
      Cell.setValue(Workbook.addWorksheet(wb1, "First"), "A1", 1);
      Cell.setValue(Workbook.addWorksheet(wb1, "Second"), "A1", 2);
      Cell.setValue(Workbook.addWorksheet(wb1, "Third"), "A1", 3);

      const buffer = await Workbook.toBuffer(wb1);
      const wb2 = Workbook.create();
      await Workbook.read(wb2, buffer);

      const names = getWorksheets(wb2).map(ws => getSheetName(ws));
      expect(names).toEqual(["First", "Second", "Third"]);
    });

    it("handles empty workbook (no worksheets)", async () => {
      const wb1 = Workbook.create();
      const buffer = await Workbook.toBuffer(wb1);

      const wb2 = Workbook.create();
      await Workbook.read(wb2, buffer);

      expect(getWorksheets(wb2).length).toBe(0);
    });

    it("handles workbook with empty worksheet", async () => {
      const wb1 = Workbook.create();
      Workbook.addWorksheet(wb1, "Empty");
      const buffer = await Workbook.toBuffer(wb1);

      const wb2 = Workbook.create();
      await Workbook.read(wb2, buffer);

      expect(getWorksheets(wb2).length).toBe(1);
      expect(Workbook.getWorksheet(wb2, "Empty")).toBeDefined();
    });
  });

  // ===========================================================================
  // Input Types for load()
  // ===========================================================================

  describe("load() input types", () => {
    it("accepts Uint8Array", async () => {
      const buffer = await buildMinimalXlsx();
      const wb = Workbook.create();
      await Workbook.read(wb, buffer);
      expect(getWorksheets(wb).length).toBe(1);
    });

    it("accepts ArrayBuffer", async () => {
      const buffer = await buildMinimalXlsx();
      const arrayBuffer: ArrayBuffer = buffer.buffer.slice(
        buffer.byteOffset,
        buffer.byteOffset + buffer.byteLength
      ) as ArrayBuffer;

      const wb = Workbook.create();
      await Workbook.read(wb, arrayBuffer);
      expect(getWorksheets(wb).length).toBe(1);
      expect(Cell.getValue(Workbook.getWorksheet(wb, "Sheet1")!, "A1")).toBe("hello");
    });

    it("accepts base64 string with option", async () => {
      const buffer = await buildMinimalXlsx();
      // Convert to base64
      const base64 = Buffer.from(buffer).toString("base64");

      const wb = Workbook.create();
      await Workbook.read(wb, base64, { base64: true });
      expect(getWorksheets(wb).length).toBe(1);
      expect(Cell.getValue(Workbook.getWorksheet(wb, "Sheet1")!, "A1")).toBe("hello");
    });

    it("rejects invalid input (plain object)", async () => {
      const wb = Workbook.create();
      await expect(Workbook.read(wb, {} as any)).rejects.toThrow();
    });

    it("rejects null input", async () => {
      const wb = Workbook.create();
      await expect(Workbook.read(wb, null as any)).rejects.toThrow();
    });

    it("rejects undefined input", async () => {
      const wb = Workbook.create();
      await expect(Workbook.read(wb, undefined as any)).rejects.toThrow();
    });

    it("accepts a Node Buffer (Buffer extends Uint8Array)", async () => {
      const u8 = await buildMinimalXlsx();
      // Node Buffer shares the Uint8Array prototype at runtime.
      const buf = Buffer.from(u8);
      const wb = Workbook.create();
      await Workbook.read(wb, buf);
      expect(getWorksheets(wb).length).toBe(1);
      expect(Cell.getValue(Workbook.getWorksheet(wb, "Sheet1")!, "A1")).toBe("hello");
    });

    it("accepts a DataView (ArrayBufferView non-Uint8Array)", async () => {
      const u8 = await buildMinimalXlsx();
      const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
      const wb = Workbook.create();
      await Workbook.read(wb, view);
      expect(getWorksheets(wb).length).toBe(1);
      expect(Cell.getValue(Workbook.getWorksheet(wb, "Sheet1")!, "A1")).toBe("hello");
    });

    it("rejects a raw string without options.base64 with a helpful message", async () => {
      // Binary zip bytes cannot round-trip through a JS string; we require
      // the explicit opt-in so users are never silently corrupted.
      const wb = Workbook.create();
      await expect(Workbook.read(wb, "PK\u0003\u0004 not real binary" as string)).rejects.toThrow(
        // Backwards-compatible prefix — existing callers that check
        // err.message.includes("Can't read the data...") keep working.
        /Can't read the data of 'the loaded zip file'/
      );
    });
  });

  // ===========================================================================
  // Corrupt / Invalid Input
  // ===========================================================================

  describe("corrupt input handling", () => {
    it("rejects empty Uint8Array", async () => {
      const wb = Workbook.create();
      await expect(Workbook.read(wb, new Uint8Array(0))).rejects.toThrow();
    });

    it("rejects random bytes (not a ZIP file)", async () => {
      // Deterministic non-ZIP bytes (not starting with PK\x03\x04 magic)
      const garbage = new Uint8Array(256);
      for (let i = 0; i < 256; i++) {
        garbage[i] = i;
      }

      const wb = Workbook.create();
      await expect(Workbook.read(wb, garbage)).rejects.toThrow();
    });

    it("rejects a truncated ZIP file", async () => {
      const validBuffer = await buildMinimalXlsx();
      // Take only the first half
      const truncated = validBuffer.slice(0, Math.floor(validBuffer.length / 2));

      const wb = Workbook.create();
      await expect(Workbook.read(wb, truncated)).rejects.toThrow();
    });

    it("rejects a JPEG file passed as XLSX", async () => {
      // JPEG magic bytes: FF D8 FF E0
      const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

      const wb = Workbook.create();
      await expect(Workbook.read(wb, jpeg)).rejects.toThrow();
    });

    it("rejects a plain text file", async () => {
      const text = new TextEncoder().encode("This is not an XLSX file");

      const wb = Workbook.create();
      await expect(Workbook.read(wb, text)).rejects.toThrow();
    });
  });

  // ===========================================================================
  // write() / read() — Stream API
  // ===========================================================================

  describe("write(stream) / read(stream)", () => {
    /** Build a workbook whose package comfortably exceeds a stream buffer. */
    function buildStreamWorkbook(rows: number): ReturnType<typeof Workbook.create> {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Stream");
      const payload = "0123456789abcdef".repeat(32);
      for (let row = 1; row <= rows; row++) {
        Cell.setValue(ws, `A${row}`, `${row}-${payload}`);
      }
      return wb;
    }

    // The cross-platform `toStream` / sink lifecycle contract lives in
    // `xlsx-stream.test.ts`; these cases additionally exercise it through a
    // real Node PassThrough.

    it("writeStream() rejects when the sink closes before the package is complete", async () => {
      const wb = buildStreamWorkbook(20_000);
      const sink = new PassThrough();
      // Nothing consumes `sink`, so the writer parks on backpressure; closing it
      // used to leave that promise pending forever.
      setTimeout(() => sink.destroy(), 10);

      await expect(Workbook.writeStream(wb, sink)).rejects.toThrow(/destination closed/);
    });

    it("writeStream() rejects with the sink's own error", async () => {
      const wb = buildStreamWorkbook(20_000);
      const sink = new PassThrough();
      sink.on("error", () => {});
      setTimeout(() => sink.destroy(new Error("sink exploded")), 10);

      await expect(Workbook.writeStream(wb, sink)).rejects.toThrow(/sink exploded/);
    });

    it("write() pipes valid XLSX to a writable stream", async () => {
      const wb = Workbook.create();
      Cell.setValue(Workbook.addWorksheet(wb, "Stream"), "A1", "streamed");

      const output = new PassThrough();
      const chunks: Uint8Array[] = [];
      output.on("data", (chunk: Uint8Array) => chunks.push(chunk));

      await Workbook.writeStream(wb, output);

      const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
      expect(totalLength).toBeGreaterThan(0);

      // Verify the stream output is a valid XLSX
      const buf = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        buf.set(chunk, offset);
        offset += chunk.length;
      }

      const wb2 = Workbook.create();
      await Workbook.read(wb2, buf);
      expect(Cell.getValue(Workbook.getWorksheet(wb2, "Stream")!, "A1")).toBe("streamed");
    });

    it("read() loads workbook from a readable stream", async () => {
      const buffer = await buildMinimalXlsx();

      // Create a readable stream from the buffer
      const input = new PassThrough();
      input.end(buffer);

      const wb = Workbook.create();
      await Workbook.readStream(wb, input);

      expect(getWorksheets(wb).length).toBe(1);
      expect(Cell.getValue(Workbook.getWorksheet(wb, "Sheet1")!, "A1")).toBe("hello");
    });

    it("read() from stream matches load() from buffer", async () => {
      const buffer = await buildRichXlsx();

      // Load via buffer
      const wb1 = Workbook.create();
      await Workbook.read(wb1, buffer);

      // Load via stream
      const input = new PassThrough();
      input.end(buffer);
      const wb2 = Workbook.create();
      await Workbook.readStream(wb2, input);

      // Same worksheets
      expect(getWorksheets(wb1).length).toBe(getWorksheets(wb2).length);
      expect(getWorksheets(wb1).map(ws => getSheetName(ws))).toEqual(
        getWorksheets(wb2).map(ws => getSheetName(ws))
      );

      // Same values
      const ws1 = Workbook.getWorksheet(wb1, "Data")!;
      const ws2 = Workbook.getWorksheet(wb2, "Data")!;
      expect(Cell.getValue(ws1, "A2")).toEqual(Cell.getValue(ws2, "A2"));
      expect(Cell.getValue(ws1, "B2")).toEqual(Cell.getValue(ws2, "B2"));
    });
  });

  // ===========================================================================
  // Write Options
  // ===========================================================================

  describe("write options", () => {
    it("useSharedStrings option produces valid output", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Cell.setValue(ws, "A1", "shared");
      Cell.setValue(ws, "A2", "shared"); // same string

      const buffer = await Workbook.toBuffer(wb, { useSharedStrings: true });
      expect(buffer.length).toBeGreaterThan(0);

      const wb2 = Workbook.create();
      await Workbook.read(wb2, buffer);
      expect(Cell.getValue(Workbook.getWorksheet(wb2, "Sheet1")!, "A1")).toBe("shared");
      expect(Cell.getValue(Workbook.getWorksheet(wb2, "Sheet1")!, "A2")).toBe("shared");
    });

    it("useStyles option produces valid output", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Cell.setValue(ws, "A1", 42);
      Cell.setStyle(ws, "A1", { font: { bold: true } });

      const buffer = await Workbook.toBuffer(wb, { useStyles: true });
      expect(buffer.length).toBeGreaterThan(0);

      const wb2 = Workbook.create();
      await Workbook.read(wb2, buffer);
      expect(Cell.getStyle(Workbook.getWorksheet(wb2, "Sheet1")!, "A1").font!.bold).toBe(true);
    });

    it("different compression levels produce valid output", async () => {
      const wb = Workbook.create();
      Cell.setValue(Workbook.addWorksheet(wb, "Sheet1"), "A1", "compress");

      const bufStore = await Workbook.toBuffer(wb, { zip: { level: 0 } }); // STORE
      const bufDeflate = await Workbook.toBuffer(wb, { zip: { level: 9 } }); // max compression

      // Level 0 (STORE) should be larger than level 9
      expect(bufStore.length).toBeGreaterThan(bufDeflate.length);

      // Both should be readable
      for (const buf of [bufStore, bufDeflate]) {
        const wb2 = Workbook.create();
        await Workbook.read(wb2, buf);
        expect(Cell.getValue(Workbook.getWorksheet(wb2, "Sheet1")!, "A1")).toBe("compress");
      }
    });
  });

  // ===========================================================================
  // Double write / Double load
  // ===========================================================================

  describe("multiple operations", () => {
    it("writeBuffer() can be called multiple times on same workbook", async () => {
      const wb = Workbook.create();
      Cell.setValue(Workbook.addWorksheet(wb, "Sheet1"), "A1", "test");

      const buf1 = await Workbook.toBuffer(wb);
      const buf2 = await Workbook.toBuffer(wb);

      // Both buffers should be valid
      const wb1 = Workbook.create();
      await Workbook.read(wb1, buf1);
      const wb2 = Workbook.create();
      await Workbook.read(wb2, buf2);

      expect(Cell.getValue(Workbook.getWorksheet(wb1, "Sheet1")!, "A1")).toBe("test");
      expect(Cell.getValue(Workbook.getWorksheet(wb2, "Sheet1")!, "A1")).toBe("test");
    });

    it("load() replaces existing workbook content", async () => {
      const buf1 = await buildMinimalXlsx();

      const wb2 = Workbook.create();
      Cell.setValue(Workbook.addWorksheet(wb2, "Original"), "A1", "original");

      // Load overwrites
      await Workbook.read(wb2, buf1);
      expect(Workbook.getWorksheet(wb2, "Original")).toBeUndefined();
      expect(Cell.getValue(Workbook.getWorksheet(wb2, "Sheet1")!, "A1")).toBe("hello");
    });
  });

  // ===========================================================================
  // Large Data
  // ===========================================================================

  describe("large data", () => {
    it("handles 10,000 rows via writeBuffer/load", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Big");
      for (let i = 1; i <= 10000; i++) {
        Worksheet.addRow(ws, [i, `row-${i}`, i * 0.1]);
      }

      const buffer = await Workbook.toBuffer(wb);
      expect(buffer.length).toBeGreaterThan(0);

      const wb2 = Workbook.create();
      await Workbook.read(wb2, buffer);

      const ws2 = Workbook.getWorksheet(wb2, "Big")!;
      expect(Cell.getValue(ws2, "A1")).toBe(1);
      expect(Cell.getValue(ws2, "A10000")).toBe(10000);
      expect(Cell.getValue(ws2, "B10000")).toBe("row-10000");
    });
  });

  // ===========================================================================
  // Internal Hyperlinks
  // ===========================================================================

  describe("internal hyperlinks", () => {
    it("should round-trip internal hyperlink without duplication", async () => {
      const wb = Workbook.create();
      const ws1 = Workbook.addWorksheet(wb, "Sheet1");
      Workbook.addWorksheet(wb, "Sheet2");

      Cell.setValue(ws1, "A1", {
        text: "Go to Sheet2",
        hyperlink: "#Sheet2!A1"
      });

      const buffer = await Workbook.toBuffer(wb);

      // Inspect the raw XML to verify correct OOXML structure
      const { extractAll } = await import("@archive/unzip/extract");
      const entries = await extractAll(buffer);

      // Check sheet XML for hyperlink element
      const sheetXml = new TextDecoder().decode(entries.get("xl/worksheets/sheet1.xml")!.data);

      // Internal hyperlink should have location attribute, no r:id
      expect(sheetXml).toContain("location=");
      expect(sheetXml).toMatch(/hyperlink[^>]*location="Sheet2!A1"/);
      // Should NOT have r:id on internal hyperlink
      expect(sheetXml).not.toMatch(/hyperlink[^>]*r:id="[^"]*"[^>]*location=/);

      // There should be no sheet rels file for hyperlinks (only internal links)
      const sheetRels = entries.get("xl/worksheets/_rels/sheet1.xml.rels");
      if (sheetRels) {
        const relsXml = new TextDecoder().decode(sheetRels.data);
        // Should not contain hyperlink relationship for internal link
        expect(relsXml).not.toContain("hyperlink");
      }

      // Verify round-trip
      const wb2 = Workbook.create();
      await Workbook.read(wb2, buffer);

      const cell = getCell(Workbook.getWorksheet(wb2, "Sheet1")!, "A1");
      expect(cellText(cell)).toBe("Go to Sheet2");
      // The hyperlink should be "#Sheet2!A1", not "#Sheet2!A1##Sheet2!A1"
      expect(cellHyperlink(cell)).toBe("#Sheet2!A1");
    });
  });

  // ===========================================================================
  // Invalid XML Characters in XLSX (Regression)
  // ===========================================================================

  describe("invalid XML characters in XLSX", () => {
    it("reads XLSX with 0x7F (DEL) in shared string without crashing", async () => {
      const dirtyBuffer = await buildDirtyXlsx("\x7f");
      const wb = Workbook.create();
      await Workbook.read(wb, dirtyBuffer);

      const ws = Workbook.getWorksheet(wb, "Sheet1")!;
      expect(ws).toBeDefined();
      // The invalid char should be stripped; "hello" should survive
      expect(Cell.getText(ws, "A1")).toContain("hello");
    });

    it("reads XLSX with multiple control chars in shared string", async () => {
      const dirtyBuffer = await buildDirtyXlsx("\x01\x02\x03\x7f");
      const wb = Workbook.create();
      await Workbook.read(wb, dirtyBuffer);

      const ws = Workbook.getWorksheet(wb, "Sheet1")!;
      expect(ws).toBeDefined();
      expect(Cell.getText(ws, "A1")).toContain("hello");
    });

    it("reads dirty XLSX via streaming WorkbookReader", async () => {
      const dirtyBuffer = await buildDirtyXlsx("\x7f");
      const rows: string[] = [];

      const reader = new WorkbookReader(dirtyBuffer, { worksheets: "emit" });
      for await (const ws of reader) {
        for await (const row of ws) {
          const cell = rowGetCell(row, 1);
          if (cellText(cell)) {
            rows.push(cellText(cell));
          }
        }
      }

      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0]).toContain("hello");
    });

    it("reads XLSX with NUL bytes in shared string", async () => {
      const dirtyBuffer = await buildDirtyXlsx("\x00\x00\x00");
      const wb = Workbook.create();
      await Workbook.read(wb, dirtyBuffer);

      const ws = Workbook.getWorksheet(wb, "Sheet1")!;
      expect(ws).toBeDefined();
      expect(Cell.getText(ws, "A1")).toContain("hello");
    });
  });

  // ===========================================================================
  // Data Bar Conditional Formatting
  // ===========================================================================

  describe("data bar conditional formatting", () => {
    async function getSheetXml(buffer: Uint8Array): Promise<string> {
      const { extractAll } = await import("@archive/unzip/extract");
      const entries = await extractAll(buffer);
      return new TextDecoder().decode(entries.get("xl/worksheets/sheet1.xml")!.data);
    }

    function addDataBarWorkbook(ruleOverrides: Record<string, unknown> = {}): Promise<Uint8Array> {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      for (let i = 1; i <= 10; i++) {
        Cell.setValue(ws, `A${i}`, i * 10);
      }
      addConditionalFormatting(ws, {
        ref: "A1:A10",
        rules: [{ type: "dataBar", priority: 1, ...ruleOverrides } as any]
      });
      return Workbook.toBuffer(wb);
    }

    it("should produce valid data bar with default settings", async () => {
      const buf = await addDataBarWorkbook();
      const xml = await getSheetXml(buf);

      // Primary section must have <dataBar> with <cfvo> and <color>
      expect(xml).toMatch(/<dataBar>/);
      expect(xml).toMatch(/<cfvo type="min"/);
      expect(xml).toMatch(/<cfvo type="max"/);
      // The element has to be there — `CT_DataBar` requires it — but its *value* is the writer's business, and this
      // assertion used to pin it to `FF638EC6`. That is the colour Excel's UI offers when creating a data bar, not what
      // Excel writes for a bar with no colour of its own, which is `auto="1"`. Asserting the element rather than a
      // particular colour is what the test was for.
      expect(xml).toMatch(/<color (?:auto="1"|rgb="[0-9A-Fa-f]{8}")\s*\/>/);

      // Primary section must have <x14:id> referencing ext section
      const primaryIdMatch = xml.match(/<x14:id>([^<]+)<\/x14:id>/);
      expect(primaryIdMatch).not.toBeNull();
      const x14Id = primaryIdMatch![1];
      expect(x14Id).toMatch(/^\{[0-9A-F-]+\}$/);

      // Ext section must have matching <x14:cfRule id="...">
      expect(xml).toContain(`<x14:cfRule type="dataBar" id="${x14Id}"`);
      expect(xml).toMatch(/<x14:dataBar/);
    });

    it("should produce valid data bar with explicit gradient=true", async () => {
      const buf = await addDataBarWorkbook({ gradient: true });
      const xml = await getSheetXml(buf);

      // Must still have ext section even when gradient is true
      const primaryIdMatch = xml.match(/<x14:id>([^<]+)<\/x14:id>/);
      expect(primaryIdMatch).not.toBeNull();
      const x14Id = primaryIdMatch![1];
      expect(xml).toContain(`<x14:cfRule type="dataBar" id="${x14Id}"`);
    });

    it("should produce valid data bar with gradient=false", async () => {
      const buf = await addDataBarWorkbook({ gradient: false });
      const xml = await getSheetXml(buf);

      const primaryIdMatch = xml.match(/<x14:id>([^<]+)<\/x14:id>/);
      expect(primaryIdMatch).not.toBeNull();
      const x14Id = primaryIdMatch![1];
      expect(xml).toContain(`<x14:cfRule type="dataBar" id="${x14Id}"`);

      // gradient=false should appear in ext section
      expect(xml).toMatch(/x14:dataBar[^>]*gradient="0"/);
    });

    it("should round-trip data bar without corruption", async () => {
      const buf1 = await addDataBarWorkbook();

      // Read it back
      const wb2 = Workbook.create();
      await Workbook.read(wb2, buf1);

      // Verify conditional formatting survived
      const ws = Workbook.getWorksheet(wb2, "Sheet1")!;
      const cfs = ws.conditionalFormattings;
      expect(cfs.length).toBeGreaterThan(0);
      const dbRule = cfs[0].rules.find((r: any) => r.type === "dataBar");
      expect(dbRule).toBeDefined();

      // Write again
      const buf2 = await Workbook.toBuffer(wb2);
      const xml = await getSheetXml(buf2);

      // Must still have matching primary + ext IDs after round-trip
      const primaryIdMatch = xml.match(/<x14:id>([^<]+)<\/x14:id>/);
      expect(primaryIdMatch).not.toBeNull();
      const x14Id = primaryIdMatch![1];
      expect(xml).toContain(`<x14:cfRule type="dataBar" id="${x14Id}"`);
    });
  });

  // ===========================================================================
  // Dynamic Array Formulas
  // ===========================================================================

  describe("dynamic array formulas", () => {
    async function getZipEntry(buffer: Uint8Array, path: string): Promise<string | undefined> {
      const { extractAll } = await import("@archive/unzip/extract");
      const entries = await extractAll(buffer);
      const entry = entries.get(path);
      return entry ? new TextDecoder().decode(entry.data) : undefined;
    }

    function createDynamicArrayWorkbook(): Promise<Uint8Array> {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      // Source data
      for (let i = 1; i <= 10; i++) {
        Cell.setValue(ws, `A${i}`, i);
        Cell.setValue(ws, `B${i}`, i > 5 ? 1 : 0);
      }
      // Dynamic array formula
      Cell.setValue(ws, "D1", {
        formula: "_xlfn._xlws.FILTER(A1:A10,B1:B10=1)",
        shareType: "array",
        ref: "D1",
        result: 6,
        isDynamicArray: true
      });
      return Workbook.toBuffer(wb);
    }

    it("should write cm attribute and metadata.xml for dynamic array formula", async () => {
      const buf = await createDynamicArrayWorkbook();

      // Check sheet XML has cm attribute
      const sheetXml = await getZipEntry(buf, "xl/worksheets/sheet1.xml");
      expect(sheetXml).toBeDefined();
      expect(sheetXml).toMatch(/<c r="D1"[^>]*cm="1"/);
      expect(sheetXml).toContain('t="array"');
      expect(sheetXml).toContain("_xlfn._xlws.FILTER");

      // Check metadata.xml exists
      const metadataXml = await getZipEntry(buf, "xl/metadata.xml");
      expect(metadataXml).toBeDefined();
      expect(metadataXml).toContain("XLDAPR");
      expect(metadataXml).toContain("xda:dynamicArrayProperties");
      expect(metadataXml).toContain('fDynamic="1"');

      // Check Content_Types.xml has metadata override
      const ctXml = await getZipEntry(buf, "[Content_Types].xml");
      expect(ctXml).toContain("sheetMetadata+xml");

      // Check workbook.xml.rels has metadata relationship
      const relsXml = await getZipEntry(buf, "xl/_rels/workbook.xml.rels");
      expect(relsXml).toContain("sheetMetadata");
      expect(relsXml).toContain("metadata.xml");
    });

    it("should not write metadata.xml when no dynamic array formulas exist", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Cell.setValue(ws, "A1", { formula: "SUM(B1:B10)", result: 55 });
      const buf = await Workbook.toBuffer(wb);

      const metadataXml = await getZipEntry(buf, "xl/metadata.xml");
      expect(metadataXml).toBeUndefined();

      const ctXml = await getZipEntry(buf, "[Content_Types].xml");
      expect(ctXml).not.toContain("sheetMetadata");
    });

    it("should round-trip dynamic array formula", async () => {
      const buf1 = await createDynamicArrayWorkbook();

      // Read back
      const wb2 = Workbook.create();
      await Workbook.read(wb2, buf1);
      const ws2 = Workbook.getWorksheet(wb2, "Sheet1")!;
      const cellValue = Cell.getValue(ws2, "D1") as any;

      expect(cellValue).toBeDefined();
      expect(cellValue.formula).toBe("_xlfn._xlws.FILTER(A1:A10,B1:B10=1)");
      expect(cellValue.shareType).toBe("array");
      expect(cellValue.isDynamicArray).toBe(true);

      // Write again
      const buf2 = await Workbook.toBuffer(wb2);

      // Verify second generation
      const sheetXml = await getZipEntry(buf2, "xl/worksheets/sheet1.xml");
      expect(sheetXml).toMatch(/<c r="D1"[^>]*cm="1"/);
      const metadataXml = await getZipEntry(buf2, "xl/metadata.xml");
      expect(metadataXml).toContain("XLDAPR");
    });

    it("should handle multiple dynamic array formulas in same workbook", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Cell.setValue(ws, "A1", {
        formula: "_xlfn._xlws.SORT(B1:B10)",
        shareType: "array",
        ref: "A1",
        result: 1,
        isDynamicArray: true
      });
      Cell.setValue(ws, "C1", {
        formula: "_xlfn._xlws.UNIQUE(D1:D10)",
        shareType: "array",
        ref: "C1",
        result: "a",
        isDynamicArray: true
      });
      const buf = await Workbook.toBuffer(wb);

      const sheetXml = (await getZipEntry(buf, "xl/worksheets/sheet1.xml"))!;
      // Both cells should have cm="1"
      expect(sheetXml).toMatch(/<c r="A1"[^>]*cm="1"/);
      expect(sheetXml).toMatch(/<c r="C1"[^>]*cm="1"/);

      // Only one metadata record needed
      const metadataXml = (await getZipEntry(buf, "xl/metadata.xml"))!;
      expect(metadataXml).toContain('<cellMetadata count="1"');
    });

    it("should handle mixed CSE array + dynamic array in same workbook", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      // Legacy CSE array formula
      Cell.setValue(ws, "A1", {
        formula: "{ROW(1:3)}",
        shareType: "array",
        ref: "A1:A3",
        result: 1
      });
      // Dynamic array formula
      Cell.setValue(ws, "C1", {
        formula: "_xlfn._xlws.SORT(B1:B10)",
        shareType: "array",
        ref: "C1",
        result: 1,
        isDynamicArray: true
      });
      const buf = await Workbook.toBuffer(wb);

      const sheetXml = (await getZipEntry(buf, "xl/worksheets/sheet1.xml"))!;
      // Only the dynamic array cell should have cm
      expect(sheetXml).toMatch(/<c r="C1"[^>]*cm="1"/);
      // CSE cell should NOT have cm
      expect(sheetXml).not.toMatch(/<c r="A1"[^>]*cm="/);

      // Round-trip: read back and verify
      const wb2 = Workbook.create();
      await Workbook.read(wb2, buf);
      const ws2 = Workbook.getWorksheet(wb2, "Sheet1")!;

      const cseVal = Cell.getValue(ws2, "A1") as any;
      expect(cseVal.formula).toBeDefined();
      expect(cseVal.isDynamicArray).toBeUndefined();

      const daVal = Cell.getValue(ws2, "C1") as any;
      expect(daVal.formula).toContain("SORT");
      expect(daVal.isDynamicArray).toBe(true);
    });

    it("should load Excel 365-style dynamic array XLSX built from raw ZIP parts", async () => {
      // Construct a minimal XLSX that mimics the exact structure Excel 365 produces
      // for a workbook with a FILTER() dynamic array formula in D1.
      // This tests our parser against externally-authored files, not just our own output.
      const archive = new ZipArchive({ level: 0, reproducible: true });
      const enc = new TextEncoder();

      // [Content_Types].xml
      archive.add(
        "[Content_Types].xml",
        enc.encode(
          [
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
            '  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
            '  <Default Extension="xml" ContentType="application/xml"/>',
            '  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
            '  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>',
            '  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>',
            '  <Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>',
            '  <Override PartName="/xl/metadata.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheetMetadata+xml"/>',
            "</Types>"
          ].join("")
        )
      );

      // _rels/.rels
      archive.add(
        "_rels/.rels",
        enc.encode(
          [
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
            '  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>',
            "</Relationships>"
          ].join("")
        )
      );

      // xl/_rels/workbook.xml.rels
      archive.add(
        "xl/_rels/workbook.xml.rels",
        enc.encode(
          [
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
            '  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>',
            '  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>',
            '  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>',
            '  <Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sheetMetadata" Target="metadata.xml"/>',
            "</Relationships>"
          ].join("")
        )
      );

      // xl/workbook.xml
      archive.add(
        "xl/workbook.xml",
        enc.encode(
          [
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
            '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"',
            '  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
            "  <sheets>",
            '    <sheet name="Sheet1" sheetId="1" r:id="rId1"/>',
            "  </sheets>",
            "</workbook>"
          ].join("")
        )
      );

      // xl/styles.xml — minimal
      archive.add(
        "xl/styles.xml",
        enc.encode(
          [
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
            '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
            '  <fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>',
            '  <fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>',
            '  <borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>',
            '  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>',
            '  <cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>',
            "</styleSheet>"
          ].join("")
        )
      );

      // xl/sharedStrings.xml — empty
      archive.add(
        "xl/sharedStrings.xml",
        enc.encode(
          [
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
            '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="0" uniqueCount="0"/>'
          ].join("")
        )
      );

      // xl/metadata.xml — exact Excel 365 structure
      archive.add(
        "xl/metadata.xml",
        enc.encode(
          [
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
            '<metadata xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"',
            '  xmlns:xda="http://schemas.microsoft.com/office/spreadsheetml/2017/dynamicarray">',
            '  <metadataTypes count="1">',
            '    <metadataType name="XLDAPR" minSupportedVersion="120000"',
            '      copy="1" pasteAll="1" pasteValues="1" merge="1" splitFirst="1"',
            '      rowColShift="1" clearFormats="1" clearComments="1" assign="1"',
            '      coerce="1" adjust="1" cellMeta="1"/>',
            "  </metadataTypes>",
            '  <futureMetadata name="XLDAPR" count="1">',
            "    <bk>",
            "      <extLst>",
            '        <ext uri="{bdbb8cdc-fa1e-496e-a857-3c3f30c029c3}">',
            '          <xda:dynamicArrayProperties fDynamic="1" fCollapsed="0"/>',
            "        </ext>",
            "      </extLst>",
            "    </bk>",
            "  </futureMetadata>",
            '  <cellMetadata count="1">',
            "    <bk>",
            '      <rc t="1" v="0"/>',
            "    </bk>",
            "  </cellMetadata>",
            "</metadata>"
          ].join("\n")
        )
      );

      // xl/worksheets/sheet1.xml — with cm="1" on D1
      archive.add(
        "xl/worksheets/sheet1.xml",
        enc.encode(
          [
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
            '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"',
            '  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
            '  <dimension ref="A1:D5"/>',
            "  <sheetData>",
            '    <row r="1">',
            '      <c r="A1"><v>10</v></c>',
            '      <c r="B1"><v>1</v></c>',
            '      <c r="D1" cm="1"><f t="array" ref="D1">_xlfn._xlws.FILTER(A1:A5,B1:B5=1)</f><v>10</v></c>',
            "    </row>",
            '    <row r="2">',
            '      <c r="A2"><v>20</v></c>',
            '      <c r="B2"><v>0</v></c>',
            "    </row>",
            '    <row r="3">',
            '      <c r="A3"><v>30</v></c>',
            '      <c r="B3"><v>1</v></c>',
            "    </row>",
            '    <row r="4">',
            '      <c r="A4"><v>40</v></c>',
            '      <c r="B4"><v>0</v></c>',
            "    </row>",
            '    <row r="5">',
            '      <c r="A5"><v>50</v></c>',
            '      <c r="B5"><v>1</v></c>',
            "    </row>",
            "  </sheetData>",
            "</worksheet>"
          ].join("\n")
        )
      );

      const xlsxBuffer = await archive.bytes();

      // ---- Test 1: Load and verify isDynamicArray ----
      const wb = Workbook.create();
      await Workbook.read(wb, xlsxBuffer);
      const ws = Workbook.getWorksheet(wb, "Sheet1")!;

      // Regular cells should load normally
      expect(Cell.getValue(ws, "A1")).toBe(10);
      expect(Cell.getValue(ws, "B1")).toBe(1);

      // Dynamic array formula cell
      const d1 = Cell.getValue(ws, "D1") as any;
      expect(d1).toBeDefined();
      expect(d1.formula).toBe("_xlfn._xlws.FILTER(A1:A5,B1:B5=1)");
      expect(d1.shareType).toBe("array");
      expect(d1.isDynamicArray).toBe(true);
      expect(d1.result).toBe(10);

      // ---- Test 2: Round-trip — write back and verify structure ----
      const buf2 = await Workbook.toBuffer(wb);
      const sheetXml = await getZipEntry(buf2, "xl/worksheets/sheet1.xml");
      expect(sheetXml).toMatch(/<c r="D1"[^>]*cm="1"/);

      const metadataXml = await getZipEntry(buf2, "xl/metadata.xml");
      expect(metadataXml).toBeDefined();
      expect(metadataXml).toContain("XLDAPR");

      // ---- Test 3: Streaming reader should also detect isDynamicArray ----
      const reader = new WorkbookReader(xlsxBuffer, {
        worksheets: "emit",
        sharedStrings: "cache"
      });

      let streamDaFound = false;
      for await (const wsReader of reader) {
        for await (const row of wsReader) {
          const cell = rowGetCell(row, 4);
          const val = cellGetValue(cell) as any;
          if (val && typeof val === "object" && val.formula) {
            streamDaFound = true;
            expect(val.formula).toContain("FILTER");
            expect(val.isDynamicArray).toBe(true);
          }
        }
      }
      expect(streamDaFound).toBe(true);
    });

    it("should not mark isDynamicArray when cm exists but metadata has no XLDAPR", async () => {
      // Construct a workbook with a dynamic array formula, then manually strip
      // the XLDAPR type from metadata.xml to simulate a non-XLDAPR cm reference.
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Cell.setValue(ws, "A1", {
        formula: "_xlfn._xlws.FILTER(B1:B5,B1:B5>0)",
        shareType: "array",
        ref: "A1",
        result: 1,
        isDynamicArray: true
      });
      const buf = await Workbook.toBuffer(wb);

      // Extract ZIP, replace metadata.xml with one that has NO XLDAPR type
      const { extractAll } = await import("@archive/unzip/extract");
      const { ZipArchive } = await import("@archive/zip");
      const entries = await extractAll(buf);

      const fakeMetadata = [
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
        '<metadata xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
        '  <metadataTypes count="1">',
        '    <metadataType name="XLRICHVALUE" minSupportedVersion="120000" cellMeta="1"/>',
        "  </metadataTypes>",
        '  <cellMetadata count="1">',
        "    <bk>",
        '      <rc t="1" v="0"/>',
        "    </bk>",
        "  </cellMetadata>",
        "</metadata>"
      ].join("\n");

      const encoder = new TextEncoder();
      entries.get("xl/metadata.xml")!.data = encoder.encode(fakeMetadata);

      const archive = new ZipArchive({ level: 0, reproducible: true });
      for (const [name, entry] of entries) {
        archive.add(name, entry.data);
      }
      const tamperedBuf = await archive.bytes();

      // Load the tampered file
      const wb2 = Workbook.create();
      await Workbook.read(wb2, tamperedBuf);
      const cellVal = Cell.getValue(Workbook.getWorksheet(wb2, "Sheet1")!, "A1") as any;

      // cm was present but mapped to XLRICHVALUE, not XLDAPR — should NOT be isDynamicArray
      expect(cellVal.formula).toContain("FILTER");
      expect(cellVal.isDynamicArray).toBeUndefined();
    });
  });

  // ===========================================================================
  // Workbook content-type round-trip (.xltx / .xltm)
  // ===========================================================================

  describe("workbook content-type round-trip", () => {
    async function readContentTypes(buffer: Uint8Array): Promise<string> {
      const { extractAll } = await import("@archive/unzip/extract");
      const entries = await extractAll(buffer);
      return new TextDecoder().decode(entries.get("[Content_Types].xml")!.data);
    }

    it("preserves the template Override for /xl/workbook.xml through read/write", async () => {
      // Build a plain workbook, then rewrite [Content_Types].xml to declare it
      // as a template — simulating a real .xltx source (there is no API to
      // author a template directly).
      const cleanBuffer = await buildMinimalXlsx();
      const { extractAll } = await import("@archive/unzip/extract");
      const entries = await extractAll(cleanBuffer);
      const decoder = new TextDecoder();
      const encoder = new TextEncoder();

      const ctEntry = entries.get("[Content_Types].xml")!;
      const templateXml = decoder
        .decode(ctEntry.data)
        .replace(
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
          "application/vnd.openxmlformats-officedocument.spreadsheetml.template.main+xml"
        );
      expect(templateXml).not.toBe(decoder.decode(ctEntry.data));
      ctEntry.data = encoder.encode(templateXml);

      const archive = new ZipArchive({ level: 0, reproducible: true });
      for (const [name, entry] of entries) {
        archive.add(name, entry.data);
      }
      const templateBuffer = await archive.bytes();

      const wb = Workbook.create();
      await Workbook.read(wb, templateBuffer);
      const out = await Workbook.toBuffer(wb);

      const outContentTypes = await readContentTypes(out);
      expect(outContentTypes).toContain(
        'PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.template.main+xml"'
      );
      expect(outContentTypes).not.toContain(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"
      );
    });

    it("defaults to the plain-workbook content type for a freshly created workbook", async () => {
      const contentTypes = await readContentTypes(await buildMinimalXlsx());
      expect(contentTypes).toContain(
        'PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"'
      );
    });
  });
});

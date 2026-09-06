import { cellSetValue } from "@excel/core/cell";
import { getDefaultFont, getWorksheets } from "@excel/core/workbook";
import type { WorkbookData } from "@excel/core/workbook-core";
import { rowCommit, rowGetCell } from "@excel/core/worksheet";
import { Cell, Workbook } from "@excel/index";
import { WorkbookWriter } from "@excel/stream/workbook-writer";
import { Writable } from "@stream";
import { describe, it, expect } from "vitest";

// =============================================================================
// Helpers
// =============================================================================

/** Create a WorkbookWriter that writes to an in-memory buffer. */
function createMemoryWriter(options?: Record<string, unknown>): {
  wb: InstanceType<typeof WorkbookWriter>;
  getBuffer: () => Promise<Uint8Array>;
} {
  const chunks: Uint8Array[] = [];
  const stream = new Writable({
    write(chunk: Uint8Array, _encoding: string, callback: () => void) {
      chunks.push(chunk);
      callback();
    }
  });

  const wb = new WorkbookWriter({ stream, ...options });
  const getBuffer = async () => {
    await wb.commit();
    const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
    const buf = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      buf.set(chunk, offset);
      offset += chunk.length;
    }
    return buf;
  };

  return { wb, getBuffer };
}

/** Write via WorkbookWriter, then read back with Workbook for verification. */
async function writeAndReadBack(
  builder: (wb: InstanceType<typeof WorkbookWriter>) => void | Promise<void>,
  options?: Record<string, unknown>
): Promise<WorkbookData> {
  const { wb, getBuffer } = createMemoryWriter(options);
  await builder(wb);
  const buffer = await getBuffer();

  const readBack = Workbook.create();
  await Workbook.read(readBack, buffer);
  return readBack;
}

// =============================================================================
// Tests
// =============================================================================

describe("WorkbookWriter", () => {
  // ===========================================================================
  // Worksheet Access
  // ===========================================================================

  describe("worksheet access", () => {
    it("returns undefined for non-existent sheet by name", () => {
      const { wb } = createMemoryWriter();
      wb.addWorksheet("first");
      expect(wb.getWorksheet("w00t")).toBeUndefined();
    });

    it("returns worksheet by numeric id", () => {
      const { wb } = createMemoryWriter();
      const ws1 = wb.addWorksheet("first");
      const ws2 = wb.addWorksheet("second");

      expect(wb.getWorksheet(ws1.id)).toBe(ws1);
      expect(wb.getWorksheet(ws2.id)).toBe(ws2);
    });

    it("returns undefined when called with no arguments (unlike Workbook)", () => {
      // WorkbookWriter.getWorksheet() requires a name or id argument.
      // Unlike Workbook, it does not return the first sheet when called with no args.
      const { wb } = createMemoryWriter();
      wb.addWorksheet("first");

      expect(wb.getWorksheet()).toBeUndefined();
    });

    it("returns undefined for non-existent numeric id", () => {
      const { wb } = createMemoryWriter();
      wb.addWorksheet("first");
      expect(wb.getWorksheet(999)).toBeUndefined();
    });
  });

  // ===========================================================================
  // Sheet Naming
  // ===========================================================================

  describe("sheet naming", () => {
    it("creates sheets with explicit names", () => {
      const { wb } = createMemoryWriter();
      const ws = wb.addWorksheet("Hello, World!");
      expect(ws.name).toBe("Hello, World!");
    });

    it("creates sheets with auto-generated names", () => {
      const { wb } = createMemoryWriter();
      const ws = wb.addWorksheet();
      expect(ws.name).toMatch(/sheet\d+/i);
    });
  });

  // ===========================================================================
  // Images
  // ===========================================================================

  describe("images", () => {
    it("addImage() and getImage() round-trip with buffer", () => {
      const { wb } = createMemoryWriter();
      const imageBuffer = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG header stub

      const id = wb.addImage({
        buffer: imageBuffer,
        extension: "png"
      });

      expect(typeof id).toBe("number");
      const img = wb.getImage(id);
      expect(img).toBeDefined();
      expect(img!.buffer).toEqual(imageBuffer);
      expect(img!.extension).toBe("png");
    });

    it("addImage() and getImage() round-trip with base64", () => {
      const { wb } = createMemoryWriter();
      const id = wb.addImage({
        base64: "iVBORw0KGgo=",
        extension: "png"
      });

      expect(typeof id).toBe("number");
      const img = wb.getImage(id);
      expect(img).toBeDefined();
      expect(img!.extension).toBe("png");
    });

    it("getImage() returns undefined for invalid id", () => {
      const { wb } = createMemoryWriter();
      expect(wb.getImage(999)).toBeUndefined();
    });
  });

  // ===========================================================================
  // Metadata
  // ===========================================================================

  describe("metadata", () => {
    it("preserves creator and dates through serialization", async () => {
      const created = new Date(2024, 0, 1);
      const modified = new Date(2024, 5, 15);

      const wb2 = await writeAndReadBack(
        wb => {
          const ws = wb.addWorksheet("Sheet1");
          cellSetValue(ws.getCell("A1"), "test");
        },
        { creator: "TestAuthor", created, modified }
      );

      expect(wb2.creator).toBe("TestAuthor");
      expect(wb2.created).toBeInstanceOf(Date);
      expect(wb2.modified).toBeInstanceOf(Date);
    });
  });

  // ===========================================================================
  // Defined Names
  // ===========================================================================

  describe("defined names", () => {
    it("definedNames getter is accessible", () => {
      const { wb } = createMemoryWriter();
      expect(wb.definedNames).toBeDefined();
    });
  });

  // ===========================================================================
  // Views
  // ===========================================================================

  describe("views", () => {
    it("accepts and preserves workbook views", () => {
      const { wb } = createMemoryWriter();
      wb.views = [
        {
          x: 0,
          y: 0,
          width: 10000,
          height: 20000,
          firstSheet: 0,
          activeTab: 0,
          visibility: "visible"
        }
      ];
      expect(wb.views.length).toBe(1);
      expect(wb.views[0].activeTab).toBe(0);
    });
  });

  // ===========================================================================
  // Shared Strings
  // ===========================================================================

  describe("shared strings", () => {
    it("commits with shared strings enabled", async () => {
      // Migrated from workbook-writer-commit-shared-strings.test.ts
      const wb2 = await writeAndReadBack(
        wb => {
          const ws = wb.addWorksheet("myWorksheet");
          rowCommit(ws.addRow(["Hello"]));
          ws.commit();
        },
        { useSharedStrings: true }
      );

      const ws2 = Workbook.getWorksheet(wb2, "myWorksheet")!;
      expect(ws2).toBeTruthy();
      expect(Cell.getValue(ws2!, "A1")).toBe("Hello");
    });

    it("roundtrips strings containing literal _xHHHH_ patterns via shared strings", async () => {
      // Migrated from workbook-writer-commit-shared-strings.test.ts
      const wb2 = await writeAndReadBack(
        wb => {
          const ws = wb.addWorksheet("Sheet1");
          rowCommit(ws.addRow(["_x000D_"]));
          rowCommit(ws.addRow(["Normal text"]));
          rowCommit(ws.addRow(["_x005F_test"]));
          ws.commit();
        },
        { useSharedStrings: true }
      );

      const ws = Workbook.getWorksheet(wb2, "Sheet1")!;
      expect(ws).toBeTruthy();
      expect(Cell.getValue(ws!, "A1")).toBe("_x000D_");
      expect(Cell.getValue(ws!, "A2")).toBe("Normal text");
      expect(Cell.getValue(ws!, "A3")).toBe("_x005F_test");
    });
  });

  // ===========================================================================
  // Commit Behavior
  // ===========================================================================

  describe("commit behavior", () => {
    it("produces a valid XLSX with no worksheets", async () => {
      const wb2 = await writeAndReadBack(() => {
        // Intentionally empty — no worksheets added
      });

      expect(getWorksheets(wb2).length).toBe(0);
    });

    it("produces a valid XLSX with multiple worksheets", async () => {
      const wb2 = await writeAndReadBack(wb => {
        const ws1 = wb.addWorksheet("One");
        cellSetValue(ws1.getCell("A1"), 1);
        ws1.commit();

        const ws2 = wb.addWorksheet("Two");
        cellSetValue(ws2.getCell("A1"), 2);
        ws2.commit();
      });

      expect(getWorksheets(wb2).length).toBe(2);
      expect(Cell.getValue(Workbook.getWorksheet(wb2, "One")!, "A1")).toBe(1);
      expect(Cell.getValue(Workbook.getWorksheet(wb2, "Two")!, "A1")).toBe(2);
    });
  });

  // ===========================================================================
  // Browser-Specific: addMedia Filename Error
  // ===========================================================================

  describe("browser addMedia restrictions", () => {
    it("addImage with filename is handled by platform-specific implementation", () => {
      // In the browser WorkbookWriter, addImage with filename throws.
      // In Node.js, it reads the file. We just verify it doesn't crash
      // when given a buffer instead.
      const { wb } = createMemoryWriter();
      const id = wb.addImage({
        buffer: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
        extension: "png"
      });
      expect(typeof id).toBe("number");
    });
  });

  // ===========================================================================
  // Data Bar Conditional Formatting
  // ===========================================================================

  describe("data bar conditional formatting via streaming writer", () => {
    async function getSheetXml(buffer: Uint8Array): Promise<string> {
      const { extractAll } = await import("@archive/unzip/extract");
      const entries = await extractAll(buffer);
      return new TextDecoder().decode(entries.get("xl/worksheets/sheet1.xml")!.data);
    }

    it("should produce matching primary and ext sections", async () => {
      const { wb, getBuffer } = createMemoryWriter();
      const ws = wb.addWorksheet("Sheet1");
      for (let i = 1; i <= 10; i++) {
        rowCommit(ws.addRow([i * 10]));
      }
      ws.addConditionalFormatting({
        ref: "A1:A10",
        rules: [{ type: "dataBar", priority: 1 } as any]
      });
      ws.commit();

      const buffer = await getBuffer();
      const xml = await getSheetXml(buffer);

      // Primary section must have <dataBar> with cfvo and color
      expect(xml).toMatch(/<dataBar>/);
      expect(xml).toMatch(/<cfvo type="min"/);
      expect(xml).toMatch(/<cfvo type="max"/);
      // The element has to be there — `CT_DataBar` requires it — but its *value* is the writer's business, and this
      // assertion used to pin it to `FF638EC6`. That is the colour Excel's UI offers when creating a data bar, not what
      // Excel writes for a bar with no colour of its own, which is `auto="1"`. Asserting the element rather than a
      // particular colour is what the test was for.
      expect(xml).toMatch(/<color (?:auto="1"|rgb="[0-9A-Fa-f]{8}")\s*\/>/);

      // Primary section must have <x14:id> linking to ext
      const primaryIdMatch = xml.match(/<x14:id>([^<]+)<\/x14:id>/);
      expect(primaryIdMatch).not.toBeNull();
      const x14Id = primaryIdMatch![1];
      expect(x14Id).toMatch(/^\{[0-9A-F-]+\}$/);

      // Ext section must have matching <x14:cfRule id="...">
      expect(xml).toContain(`<x14:cfRule type="dataBar" id="${x14Id}"`);
      expect(xml).toMatch(/<x14:dataBar/);

      // Must also have the ext wrapper structure
      expect(xml).toMatch(/<extLst>/);
      expect(xml).toMatch(/<x14:conditionalFormattings>/);
    });

    it("should round-trip data bar written by streaming writer", async () => {
      const { wb, getBuffer } = createMemoryWriter();
      const ws = wb.addWorksheet("Sheet1");
      for (let i = 1; i <= 5; i++) {
        rowCommit(ws.addRow([i * 10]));
      }
      ws.addConditionalFormatting({
        ref: "A1:A5",
        rules: [{ type: "dataBar", priority: 1 } as any]
      });
      ws.commit();
      const buffer = await getBuffer();

      // Read back with non-streaming reader
      const readBack = Workbook.create();
      await Workbook.read(readBack, buffer);
      const sheet = Workbook.getWorksheet(readBack, "Sheet1")!;
      const cfs = sheet.conditionalFormattings;
      expect(cfs.length).toBeGreaterThan(0);
      const dbRule = cfs[0].rules.find((r: any) => r.type === "dataBar");
      expect(dbRule).toBeDefined();

      // Write again with non-streaming writer and verify still valid
      const buf2 = await Workbook.toBuffer(readBack);
      const xml2 = await getSheetXml(buf2);
      const id2Match = xml2.match(/<x14:id>([^<]+)<\/x14:id>/);
      expect(id2Match).not.toBeNull();
      expect(xml2).toContain(`<x14:cfRule type="dataBar" id="${id2Match![1]}"`);
    });

    it("should not write extLst when no ext rules exist", async () => {
      const { wb, getBuffer } = createMemoryWriter();
      const ws = wb.addWorksheet("Sheet1");
      rowCommit(ws.addRow(["hello"]));
      // Add a non-ext conditional formatting (cellIs rule)
      ws.addConditionalFormatting({
        ref: "A1",
        rules: [
          {
            type: "cellIs",
            operator: "greaterThan",
            formulae: ["5"],
            priority: 1
          } as any
        ]
      });
      ws.commit();

      const buffer = await getBuffer();
      const xml = await getSheetXml(buffer);

      // Should have primary CF but no ext section
      expect(xml).toMatch(/<conditionalFormatting/);
      expect(xml).not.toMatch(/<x14:conditionalFormattings>/);
    });
  });

  // ===========================================================================
  // Dynamic Array Formulas via streaming writer
  // ===========================================================================

  describe("dynamic array formulas via streaming writer", () => {
    async function getZipEntry(buffer: Uint8Array, path: string): Promise<string | undefined> {
      const { extractAll } = await import("@archive/unzip/extract");
      const entries = await extractAll(buffer);
      const entry = entries.get(path);
      return entry ? new TextDecoder().decode(entry.data) : undefined;
    }

    it("should produce cm attribute and metadata.xml", async () => {
      const { wb, getBuffer } = createMemoryWriter();
      const ws = wb.addWorksheet("Sheet1");
      for (let i = 1; i <= 5; i++) {
        rowCommit(ws.addRow([i]));
      }
      // Add a row with a dynamic array formula
      const row = ws.addRow([]);
      cellSetValue(rowGetCell(row, 3), {
        formula: "_xlfn._xlws.FILTER(A1:A5,A1:A5>2)",
        shareType: "array",
        ref: "C6",
        result: 3,
        isDynamicArray: true
      });
      rowCommit(row);
      ws.commit();

      const buffer = await getBuffer();

      // Sheet XML should have cm="1"
      const sheetXml = await getZipEntry(buffer, "xl/worksheets/sheet1.xml");
      expect(sheetXml).toMatch(/<c r="C6"[^>]*cm="1"/);

      // metadata.xml should exist
      const metadataXml = await getZipEntry(buffer, "xl/metadata.xml");
      expect(metadataXml).toBeDefined();
      expect(metadataXml).toContain("XLDAPR");

      // Content types should include metadata
      const ctXml = await getZipEntry(buffer, "[Content_Types].xml");
      expect(ctXml).toContain("sheetMetadata+xml");

      // Workbook rels should include metadata relationship
      const relsXml = await getZipEntry(buffer, "xl/_rels/workbook.xml.rels");
      expect(relsXml).toContain("sheetMetadata");
    });

    it("should round-trip dynamic array formula written by streaming writer", async () => {
      const { wb, getBuffer } = createMemoryWriter();
      const ws = wb.addWorksheet("Sheet1");
      rowCommit(ws.addRow([10]));
      const row = ws.addRow([]);
      cellSetValue(rowGetCell(row, 1), {
        formula: "_xlfn._xlws.SORT(B1:B5)",
        shareType: "array",
        ref: "A2",
        result: 1,
        isDynamicArray: true
      });
      rowCommit(row);
      ws.commit();
      const buffer = await getBuffer();

      // Read back with non-streaming reader
      const readBack = Workbook.create();
      await Workbook.read(readBack, buffer);
      const cellValue = Cell.getValue(Workbook.getWorksheet(readBack, "Sheet1")!, "A2") as any;
      expect(cellValue.formula).toBe("_xlfn._xlws.SORT(B1:B5)");
      expect(cellValue.isDynamicArray).toBe(true);
    });

    it("should not write metadata.xml when no dynamic array formulas", async () => {
      const { wb, getBuffer } = createMemoryWriter();
      const ws = wb.addWorksheet("Sheet1");
      rowCommit(ws.addRow(["hello"]));
      ws.commit();
      const buffer = await getBuffer();

      const metadataXml = await getZipEntry(buffer, "xl/metadata.xml");
      expect(metadataXml).toBeUndefined();
    });
  });

  // ===========================================================================
  // Workbook Protection
  // ===========================================================================

  describe("workbook protection", () => {
    it("protection round-trips through streaming write then load", async () => {
      const { wb, getBuffer } = createMemoryWriter({ useStyles: true });
      await wb.protect("mypass", { lockStructure: true });
      const ws = wb.addWorksheet("Sheet1");
      rowCommit(ws.addRow(["data"]));
      ws.commit();
      const buffer = await getBuffer();

      const wb2 = Workbook.create();
      await Workbook.read(wb2, buffer);

      expect(wb2.protection).toBeDefined();
      expect(wb2.protection!.lockStructure).toBe(true);
      expect(wb2.protection!.algorithmName).toBe("SHA-512");
      expect(wb2.protection!.hashValue).toBeTruthy();
      expect(wb2.protection!.saltValue).toBeTruthy();
      expect(wb2.protection!.spinCount).toBe(100000);
    });
  });

  // ===========================================================================
  // Default Font
  // ===========================================================================

  describe("defaultFont", () => {
    it("defaultFont round-trips through streaming write then load", async () => {
      const { wb, getBuffer } = createMemoryWriter({ useStyles: true });
      wb.defaultFont = { name: "Arial", size: 12 };
      const ws = wb.addWorksheet("Sheet1");
      rowCommit(ws.addRow(["data"]));
      ws.commit();
      const buffer = await getBuffer();

      const wb2 = Workbook.create();
      await Workbook.read(wb2, buffer);

      expect(getDefaultFont(wb2)).toBeDefined();
      expect(getDefaultFont(wb2)!.name).toBe("Arial");
      expect(getDefaultFont(wb2)!.size).toBe(12);
    });
  });
});

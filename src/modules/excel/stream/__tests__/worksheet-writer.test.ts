import { cellGetValue, cellSetValue } from "@excel/core/cell";
import { rowCellCount } from "@excel/core/row";
import { rowCommit, rowGetCell, getCell, getColumn } from "@excel/core/worksheet";
import { ExcelStreamStateError } from "@excel/errors";
import { Stream, Worksheet } from "@excel/index";
import { WorkbookWriter } from "@excel/stream/workbook-writer";
import { WorksheetWriter } from "@excel/stream/worksheet-writer";
import { StreamBuf } from "@excel/utils/stream-buf";
import { Writable } from "@stream";
import { describe, it, expect } from "vitest";

// =============================================================================
// Helpers
// =============================================================================

/** Create a WorksheetWriter with a mock workbook that captures XML output. */
function createWriter(options?: Record<string, unknown>): {
  writer: WorksheetWriter;
  getXml: () => string;
} {
  const streamBuf = new StreamBuf();
  const mockWorkbook: any = {
    _openStream() {
      return streamBuf;
    },
    stream: streamBuf
  };

  const writer = new WorksheetWriter({
    id: 1,
    workbook: mockWorkbook,
    ...options
  });

  const getXml = (): string => streamBuf.read()?.toString() ?? "";

  return { writer, getXml };
}

/** Create a real WorkbookWriter + WorksheetWriter for higher-fidelity tests. */
function createRealWriter(options?: Record<string, unknown>): {
  wb: InstanceType<typeof WorkbookWriter>;
  ws: any; // WorksheetWriter
} {
  const stream = new Writable({
    write(_chunk: Uint8Array, _encoding: string, callback: () => void) {
      callback();
    }
  });
  const wb = new WorkbookWriter({ stream, ...options });
  const ws = wb.addWorksheet("test");
  return { wb, ws };
}

// =============================================================================
// Tests
// =============================================================================

describe("WorksheetWriter", () => {
  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  describe("lifecycle", () => {
    it("destroy() throws ExcelStreamStateError", () => {
      const { ws } = createRealWriter();
      expect(() => ws.destroy()).toThrow(ExcelStreamStateError);
    });

    it("committed is false before commit", () => {
      const { ws } = createRealWriter();
      expect(ws.committed).toBe(false);
    });

    it("committed is true after commit", () => {
      const { ws } = createRealWriter();
      ws.commit();
      expect(ws.committed).toBe(true);
    });
  });

  // ===========================================================================
  // XML Output
  // ===========================================================================

  describe("XML output", () => {
    it("generates valid xml even when there is no data", () =>
      new Promise<void>((resolve, reject) => {
        const { writer, getXml } = createWriter();
        const streamBuf = (writer as any)._workbook.stream as StreamBuf;

        streamBuf.on("finish", () => {
          try {
            const xml = getXml();
            expect(xml).toContain("<?xml");
            expect(xml).toContain("</worksheet>");
            resolve();
          } catch (error) {
            reject(error);
          }
        });

        writer.commit();
      }));

    it("writes sheetProtection before autoFilter in XML output", () =>
      new Promise<void>((resolve, reject) => {
        const { writer, getXml } = createWriter();
        const streamBuf = (writer as any)._workbook.stream as StreamBuf;

        streamBuf.on("finish", () => {
          try {
            const xml = getXml();
            expect(xml).toContain("<sheetProtection");
            expect(xml).toContain("<autoFilter");

            const protectionIndex = xml.indexOf("<sheetProtection");
            const autoFilterIndex = xml.indexOf("<autoFilter");
            expect(protectionIndex).toBeLessThan(autoFilterIndex);
            resolve();
          } catch (error) {
            reject(error);
          }
        });

        writer.autoFilter = { from: "A1", to: "C1" };
        writer.protect("", {});
        writer.commit();
      }));
  });

  // ===========================================================================
  // Properties
  // ===========================================================================

  describe("properties", () => {
    it("has correct id and name", () => {
      const { ws } = createRealWriter();
      expect(ws.id).toBe(1);
      expect(ws.name).toBe("test");
    });

    it("state defaults to visible", () => {
      const { ws } = createRealWriter();
      expect(ws.state).toBe("visible");
    });

    it("state can be set to hidden", () => {
      const { wb } = createRealWriter();
      const ws = wb.addWorksheet("hidden", { state: "hidden" });
      expect(ws.state).toBe("hidden");
    });

    it("state can be set to veryHidden", () => {
      const { wb } = createRealWriter();
      const ws = wb.addWorksheet("veryHidden", { state: "veryHidden" });
      expect(ws.state).toBe("veryHidden");
    });
  });

  // ===========================================================================
  // Row Access
  // ===========================================================================

  describe("row access", () => {
    it("addRow() creates a row with values", () => {
      const { ws } = createRealWriter();
      const row = ws.addRow([1, "hello", true]);

      expect(cellGetValue(rowGetCell(row, 1))).toBe(1);
      expect(cellGetValue(rowGetCell(row, 2))).toBe("hello");
      expect(cellGetValue(rowGetCell(row, 3))).toBe(true);
    });

    it("addRows() creates multiple rows", () => {
      const { ws } = createRealWriter();
      const rows = ws.addRows([
        [1, "a"],
        [2, "b"],
        [3, "c"]
      ]);

      expect(rows.length).toBe(3);
      expect(cellGetValue(rowGetCell(rows[0], 1))).toBe(1);
      expect(cellGetValue(rowGetCell(rows[1], 2))).toBe("b");
      expect(cellGetValue(rowGetCell(rows[2], 1))).toBe(3);
      expect(rows[0].number).toBe(1);
      expect(rows[1].number).toBe(2);
      expect(rows[2].number).toBe(3);
    });

    it("addRows() handles null, undefined, and object values", () => {
      const { ws } = createRealWriter();
      ws.columns = [
        { key: "name", header: "Name" },
        { key: "age", header: "Age" }
      ];
      const rows = ws.addRows([[10, 20], null, undefined, { name: "Alice", age: 30 }]);

      expect(rows.length).toBe(4);
      // normal array row
      expect(cellGetValue(rowGetCell(rows[0], 1))).toBe(10);
      // null / undefined produce empty rows
      expect(rowCellCount(rows[1])).toBe(0);
      expect(rowCellCount(rows[2])).toBe(0);
      // object row mapped by column keys
      expect(cellGetValue(rowGetCell(rows[3], 1))).toBe("Alice");
      expect(cellGetValue(rowGetCell(rows[3], 2))).toBe(30);
    });

    it("addRows() with empty array returns empty array", () => {
      const { ws } = createRealWriter();
      const rows = ws.addRows([]);
      expect(rows).toEqual([]);
    });

    it("addRow() resolves nested column-key paths (dotted keys)", () => {
      const { ws } = createRealWriter();
      ws.columns = [
        { key: "name", header: "Name" },
        { key: "address.city", header: "City" }
      ];
      const row = ws.addRow({ name: "Alice", address: { city: "Sydney" } });

      expect(cellGetValue(rowGetCell(row, 1))).toBe("Alice");
      expect(cellGetValue(rowGetCell(row, 2))).toBe("Sydney");
    });

    it("getRow() creates/returns a row by number", () => {
      const { ws } = createRealWriter();
      const row = ws.getRow(5);
      cellSetValue(rowGetCell(row, 1), "test");

      expect(row.number).toBe(5);
      expect(cellGetValue(rowGetCell(row, 1))).toBe("test");
    });

    it("findRow() returns row if exists, undefined otherwise", () => {
      const { ws } = createRealWriter();
      expect(ws.findRow(1)).toBeUndefined();

      cellSetValue(rowGetCell(ws.getRow(1), 1), "data");
      expect(ws.findRow(1)).toBeDefined();
      expect(ws.findRow(2)).toBeUndefined();
    });

    it("lastRow returns the last non-empty row", () => {
      const { ws } = createRealWriter();
      expect(Worksheet.lastRow(ws)).toBeUndefined();

      ws.addRow(["first"]);
      ws.addRow(["second"]);

      expect(Worksheet.lastRow(ws)).toBeDefined();
    });
  });

  // ===========================================================================
  // Cell Access
  // ===========================================================================

  describe("cell access", () => {
    it("getCell() by string address", () => {
      const { ws } = createRealWriter();
      cellSetValue(getCell(ws, "B3"), 42);
      expect(cellGetValue(getCell(ws, "B3"))).toBe(42);
    });

    it("getCell() by row and column numbers", () => {
      const { ws } = createRealWriter();
      cellSetValue(getCell(ws, 2, 3), "test");
      expect(cellGetValue(getCell(ws, 2, 3))).toBe("test");
    });

    it("findCell() returns undefined when no matching row exists", () => {
      const { ws } = createRealWriter();
      expect(ws.findCell(1, 2)).toBeUndefined();
      expect(ws.findCell("Z99")).toBeUndefined();
    });

    it("findCell() finds cell created via getRow().getCell()", () => {
      const { ws } = createRealWriter();
      const row = ws.getRow(1);
      cellSetValue(rowGetCell(row, 2), 99);

      const cell = ws.findCell(1, 2);
      expect(cell).toBeDefined();
      expect(cellGetValue(cell)).toBe(99);
    });

    it("findCell() finds cell created via addRow()", () => {
      const { ws } = createRealWriter();
      ws.addRow([10, 20, 30]);

      expect(cellGetValue(ws.findCell(1, 1))).toBe(10);
      expect(cellGetValue(ws.findCell(1, 2))).toBe(20);
      expect(cellGetValue(ws.findCell(1, 3))).toBe(30);
    });

    it("findCell() with string address", () => {
      const { ws } = createRealWriter();
      cellSetValue(rowGetCell(ws.getRow(1), 2), "test");

      const cell = ws.findCell("B1");
      expect(cell).toBeDefined();
      expect(cellGetValue(cell)).toBe("test");
    });

    it("findCell() returns undefined for committed row", () => {
      const { ws } = createRealWriter();
      const row = ws.getRow(1);
      cellSetValue(rowGetCell(row, 1), "will be committed");
      rowCommit(row);

      expect(ws.findRow(1)).toBeUndefined();
      expect(ws.findCell(1, 1)).toBeUndefined();
    });

    it("findCell() works across multiple uncommitted rows", () => {
      const { ws } = createRealWriter();
      ws.addRow(["r1c1", "r1c2"]);
      ws.addRow(["r2c1", "r2c2"]);
      ws.addRow(["r3c1", "r3c2"]);

      expect(cellGetValue(ws.findCell(1, 1))).toBe("r1c1");
      expect(cellGetValue(ws.findCell(2, 2))).toBe("r2c2");
      expect(cellGetValue(ws.findCell(3, 1))).toBe("r3c1");
      expect(cellGetValue(ws.findCell("B3"))).toBe("r3c2");
    });
  });

  // ===========================================================================
  // Column Operations
  // ===========================================================================

  describe("columns", () => {
    it("columns setter creates column definitions", () => {
      const { ws } = createRealWriter();
      ws.columns = [
        { key: "id", width: 10 },
        { key: "name", width: 32 }
      ];

      expect(getColumn(ws, "id").width).toBe(10);
      expect(getColumn(ws, "name").width).toBe(32);
      expect(getColumn(ws, 1).key).toBe("id");
      expect(getColumn(ws, 2).key).toBe("name");
    });

    it("getColumn() by letter", () => {
      const { ws } = createRealWriter();
      getColumn(ws, "B").width = 20;
      expect(getColumn(ws, "B").width).toBe(20);
      expect(getColumn(ws, 2).width).toBe(20);
    });

    it("column key management", () => {
      const { ws } = createRealWriter();
      const col = getColumn(ws, 1);
      ws.setColumnKey("myKey", col);
      expect(ws.getColumnKey("myKey")).toBe(col);

      const keys: string[] = [];
      ws.eachColumnKey((_col: any, key: string) => keys.push(key));
      expect(keys).toContain("myKey");

      ws.deleteColumnKey("myKey");
      expect(ws.getColumnKey("myKey")).toBeUndefined();
    });
  });

  // ===========================================================================
  // eachRow
  // ===========================================================================

  describe("eachRow", () => {
    it("iterates over uncommitted rows", () => {
      const { ws } = createRealWriter();
      ws.addRow(["a"]);
      ws.addRow(["b"]);
      ws.addRow(["c"]);

      const values: unknown[] = [];
      ws.eachRow((row: any) => {
        values.push(cellGetValue(rowGetCell(row, 1)));
      });
      expect(values).toEqual(["a", "b", "c"]);
    });
  });

  // ===========================================================================
  // Merge Cells
  // ===========================================================================

  describe("merge cells", () => {
    it("mergeCells sets values correctly", () => {
      const { ws } = createRealWriter();
      cellSetValue(getCell(ws, "A1"), "merged");
      cellSetValue(getCell(ws, "B1"), "will be replaced");
      ws.mergeCells("A1:B2");

      expect(cellGetValue(getCell(ws, "A1"))).toBe("merged");
      expect(cellGetValue(getCell(ws, "B1"))).toBe("merged");
      expect(cellGetValue(getCell(ws, "A2"))).toBe("merged");
      expect(cellGetValue(getCell(ws, "B2"))).toBe("merged");
    });

    it("overlapping merges throw error", () => {
      const { ws } = createRealWriter();
      ws.mergeCells("B2:C3");

      expect(() => ws.mergeCells("A1:B2")).toThrow();
    });
  });

  // ===========================================================================
  // Protection
  // ===========================================================================

  describe("protection", () => {
    it("protect() without password sets sheet protection", async () => {
      const { ws } = createRealWriter();
      await ws.protect();
      expect(ws.sheetProtection).toBeDefined();
      expect(ws.sheetProtection!.sheet).toBe(true);
    });

    it("protect() with password and options", async () => {
      const { ws } = createRealWriter();
      await ws.protect("secret", { formatColumns: true });
      expect(ws.sheetProtection).toBeDefined();
      expect(ws.sheetProtection!.sheet).toBe(true);
    });

    it("unprotect() clears sheet protection", async () => {
      const { ws } = createRealWriter();
      await ws.protect("secret");
      expect(ws.sheetProtection).toBeDefined();

      ws.unprotect();
      expect(ws.sheetProtection).toBeNull();
    });
  });

  // ===========================================================================
  // Conditional Formatting
  // ===========================================================================

  describe("conditional formatting", () => {
    it("addConditionalFormatting() adds to the array", () => {
      const { ws } = createRealWriter();
      expect(ws.conditionalFormatting.length).toBe(0);

      ws.addConditionalFormatting({
        ref: "A1:A10",
        rules: [
          {
            type: "cellIs",
            operator: "greaterThan",
            formulae: [5],
            style: { font: { bold: true } },
            priority: 1
          }
        ]
      });

      expect(ws.conditionalFormatting.length).toBe(1);
    });

    it("removeConditionalFormatting() with no args clears all", () => {
      const { ws } = createRealWriter();
      ws.addConditionalFormatting({
        ref: "A1:A10",
        rules: [{ type: "cellIs", operator: "greaterThan", formulae: [5], priority: 1 }]
      });
      ws.addConditionalFormatting({
        ref: "B1:B10",
        rules: [{ type: "cellIs", operator: "lessThan", formulae: [3], priority: 2 }]
      });

      expect(ws.conditionalFormatting.length).toBe(2);
      ws.removeConditionalFormatting();
      expect(ws.conditionalFormatting.length).toBe(0);
    });

    it("removeConditionalFormatting(predicate) deletes matching rules and keeps the rest", () => {
      const { ws } = createRealWriter();
      ws.addConditionalFormatting({
        ref: "A1:A10",
        rules: [{ type: "cellIs", operator: "greaterThan", formulae: [5], priority: 1 }]
      });
      ws.addConditionalFormatting({
        ref: "B1:B10",
        rules: [{ type: "cellIs", operator: "lessThan", formulae: [3], priority: 2 }]
      });
      ws.addConditionalFormatting({
        ref: "C1:C10",
        rules: [{ type: "cellIs", operator: "greaterThan", formulae: [9], priority: 3 }]
      });

      expect(ws.conditionalFormatting.length).toBe(3);
      // Predicate selects the rules to DROP (cf.ref starting with "B")
      ws.removeConditionalFormatting(cf => cf.ref.startsWith("B"));

      expect(ws.conditionalFormatting.length).toBe(2);
      expect(ws.conditionalFormatting.map(cf => cf.ref).sort()).toEqual(["A1:A10", "C1:C10"]);
    });

    it("removeConditionalFormatting(index) deletes only that index", () => {
      const { ws } = createRealWriter();
      ws.addConditionalFormatting({
        ref: "A1:A10",
        rules: [{ type: "cellIs", operator: "greaterThan", formulae: [5], priority: 1 }]
      });
      ws.addConditionalFormatting({
        ref: "B1:B10",
        rules: [{ type: "cellIs", operator: "lessThan", formulae: [3], priority: 2 }]
      });

      ws.removeConditionalFormatting(0);
      expect(ws.conditionalFormatting.length).toBe(1);
      expect(ws.conditionalFormatting[0].ref).toBe("B1:B10");
    });
  });

  // ===========================================================================
  // Background Images
  // ===========================================================================

  describe("background images", () => {
    it("addBackgroundImage and getBackgroundImageId", () => {
      const { ws, wb } = createRealWriter();
      const imageId = wb.addImage({
        buffer: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
        extension: "png"
      });

      ws.addBackgroundImage(imageId);
      expect(ws.getBackgroundImageId()).toBe(imageId);
    });

    it("getBackgroundImageId returns undefined when no background set", () => {
      const { ws } = createRealWriter();
      expect(ws.getBackgroundImageId()).toBeUndefined();
    });
  });

  // ===========================================================================
  // Page Breaks
  // ===========================================================================

  describe("page breaks", () => {
    it("rowBreaks accumulate via Stream.addRowPageBreak", () => {
      const { ws } = createRealWriter();
      ws.addRow(["row1"]);
      ws.addRow(["row2"]);
      ws.addRow(["row3"]);

      // The streaming writer hands out row *handles*, so the break is added
      // through the handle-oriented `Stream` surface rather than `Row`, which
      // addresses rows by number on a random-access worksheet.
      Stream.addRowPageBreak(ws.getRow(1));
      Stream.addRowPageBreak(ws.getRow(2));

      expect(ws.rowBreaks).toEqual([
        { id: 1, max: 16383, man: 1 },
        { id: 2, max: 16383, man: 1 }
      ]);
    });
  });

  // ===========================================================================
  // Dimensions
  // ===========================================================================

  describe("dimensions", () => {
    it("dimensions is accessible and is a Dimensions instance", () => {
      const { ws } = createRealWriter();
      cellSetValue(getCell(ws, "A1"), 1);
      cellSetValue(getCell(ws, "C5"), 2);

      const dims = Worksheet.dimensions(ws);
      expect(dims).toBeDefined();
      // Note: WorksheetWriter._dimensions is initialized as empty and is not
      // expanded by getCell(). This is a known limitation of the streaming writer.
      // The dimensions object exists but may not reflect actual data extent.
      expect(typeof dims.top).toBe("number");
      expect(typeof dims.left).toBe("number");
    });
  });

  // ===========================================================================
  // Auto Filter
  // ===========================================================================

  describe("autoFilter", () => {
    it("accepts string form", () => {
      const { ws } = createRealWriter();
      ws.autoFilter = "A1:C1";
      expect(ws.autoFilter).toBe("A1:C1");
    });

    it("accepts object form", () => {
      const { ws } = createRealWriter();
      ws.autoFilter = { from: "A1", to: "C1" };
      expect(ws.autoFilter).toEqual({ from: "A1", to: "C1" });
    });
  });
});

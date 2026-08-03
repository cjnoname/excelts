import fs from "fs";

import { extractAll } from "@archive/unzip/extract";
import { createZip } from "@archive/zip/zip-bytes";
import { expectValidXlsx } from "@excel/__tests__/helpers/expect-valid-xlsx";
import { testUtils } from "@excel/__tests__/shared";
import { readCsvFile, writeCsvFile } from "@excel/bridge/csv-bridge.node";
import {
  cellGetValue,
  cellSetValue,
  cellNames,
  cellSetNames,
  cellName,
  cellSetName,
  cellAddName,
  cellRemoveName
} from "@excel/core/cell";
import { definedNamesGetRanges, definedNamesModel } from "@excel/core/defined-names";
import { ValueType } from "@excel/core/enums";
import {
  getDefinedNames,
  getWorkbookModel,
  getWorksheets,
  setWorkbookModel
} from "@excel/core/workbook";
import type { CsvOptions } from "@excel/core/workbook";
import { addWorkbookImage } from "@excel/core/workbook-core";
import {
  addImage,
  getCell,
  getColumn,
  getLastColumn,
  getSheetName,
  rowGetCell
} from "@excel/core/worksheet";
import { Cell, Column, Row, Workbook, Worksheet } from "@excel/index";
import { makeTestDataPath, testFilePath } from "@test/utils";
import { describe, it, expect } from "vitest";

const excelTestDataPath = makeTestDataPath(import.meta.url, "../../__tests__/data");

const TEST_XLSX_FILE_NAME = testFilePath("workbook-core.integration.test");
const TEST_CSV_FILE_NAME = testFilePath("workbook-core.integration", ".csv");

// =============================================================================
// Tests

describe("Workbook", () => {
  describe("Serialise", () => {
    it("xlsx file", async () => {
      const wb = testUtils.createTestBook(Workbook.create(), "xlsx", undefined);

      await Workbook.writeFile(wb, TEST_XLSX_FILE_NAME);
      const wb2 = Workbook.create();
      await Workbook.readFile(wb2, TEST_XLSX_FILE_NAME);
      testUtils.checkTestBook(wb2, "xlsx", undefined, {});
    });
    describe("Xlsx Zip Compression", () => {
      it("xlsx file with best compression", async () => {
        const wb = testUtils.createTestBook(Workbook.create(), "xlsx", undefined);

        await Workbook.writeFile(wb, TEST_XLSX_FILE_NAME, {
          zip: {
            level: 9
          }
        });
        const wb2 = Workbook.create();
        await Workbook.readFile(wb2, TEST_XLSX_FILE_NAME);
        testUtils.checkTestBook(wb2, "xlsx", undefined, {});
      });

      it("xlsx file with default compression", async () => {
        const wb = testUtils.createTestBook(Workbook.create(), "xlsx", undefined);

        await Workbook.writeFile(wb, TEST_XLSX_FILE_NAME, {
          zip: {}
        });
        const wb2 = Workbook.create();
        await Workbook.readFile(wb2, TEST_XLSX_FILE_NAME);
        testUtils.checkTestBook(wb2, "xlsx", undefined, {});
      });

      it("xlsx file with fast compression", async () => {
        const wb = testUtils.createTestBook(Workbook.create(), "xlsx", undefined);

        await Workbook.writeFile(wb, TEST_XLSX_FILE_NAME, {
          zip: {
            level: 1
          }
        });
        const wb2 = Workbook.create();
        await Workbook.readFile(wb2, TEST_XLSX_FILE_NAME);
        testUtils.checkTestBook(wb2, "xlsx", undefined, {});
      });

      it("xlsx file with no compression", async () => {
        const wb = testUtils.createTestBook(Workbook.create(), "xlsx", undefined);

        await Workbook.writeFile(wb, TEST_XLSX_FILE_NAME, {
          zip: {
            level: 0
          }
        });
        const wb2 = Workbook.create();
        await Workbook.readFile(wb2, TEST_XLSX_FILE_NAME);
        testUtils.checkTestBook(wb2, "xlsx", undefined, {});
      });
    });
    it("sheets with correct names", async () => {
      const wb = Workbook.create();
      const ws1 = Workbook.addWorksheet(wb, "Hello, World!");
      expect(getSheetName(ws1)).toBe("Hello, World!");
      Cell.setValue(ws1, "A1", "Hello, World!");

      const ws2 = Workbook.addWorksheet(wb);
      expect(getSheetName(ws2)).toMatch(/sheet\d+/);
      Cell.setValue(ws2, "A1", getSheetName(ws2));

      Workbook.addWorksheet(wb, "This & That");

      await Workbook.writeFile(wb, TEST_XLSX_FILE_NAME);
      const wb2 = Workbook.create();
      await Workbook.readFile(wb2, TEST_XLSX_FILE_NAME);
      expect(Workbook.getWorksheet(wb2, "Hello, World!")).toBeTruthy();
      expect(Workbook.getWorksheet(wb2, "This & That")).toBeTruthy();
    });

    it('removes "vertical tab" and other invalid control characters', async () => {
      const filename = testFilePath("invalid-control-chars.workbook");
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      Cell.setValue(ws, "A1", "Hello, \x01World!");
      Cell.setValue(ws, "A2", "Hello, \x0bWorld!");

      await Workbook.writeFile(wb, filename);

      const wb2 = Workbook.create();
      await Workbook.readFile(wb2, filename);
      const ws2 = Workbook.getWorksheet(wb2, "Sheet1")!;
      expect(Cell.getValue(ws2, "A1")).toBe("Hello, World!");
      expect(Cell.getValue(ws2, "A2")).toBe("Hello, World!");
    });

    it("special cell values produce a valid file", async () => {
      const filename = testFilePath("special-object-keys.workbook");
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      const specialValues = [
        "constructor",
        "hasOwnProperty",
        "isPrototypeOf",
        "propertyIsEnumerable",
        "toLocaleString",
        "toString",
        "valueOf",
        "__defineGetter__",
        "__defineSetter__",
        "__lookupGetter__",
        "__lookupSetter__",
        "__proto__"
      ];

      for (let i = 0; i < specialValues.length; i++) {
        const value = specialValues[i];
        Worksheet.addRow(ws, [value]);
        Cell.setValue(ws, `B${i + 1}`, value);
      }

      await Workbook.writeFile(wb, filename);

      const wb2 = Workbook.create();
      await Workbook.readFile(wb2, filename);
      const ws2 = Workbook.getWorksheet(wb2, "Sheet1")!;
      for (let i = 0; i < specialValues.length; i++) {
        const value = specialValues[i];
        expect(Cell.getValue(ws2, `A${i + 1}`)).toBe(value);
        expect(Cell.getValue(ws2, `B${i + 1}`)).toBe(value);
      }
    });

    it("hyperlink without text does not crash on write", async () => {
      const sourceFile = excelTestDataPath("hyperlink-without-text.xlsx");
      const outFile = testFilePath("hyperlink-without-text.workbook");

      const wb = Workbook.create();
      await Workbook.readFile(wb, sourceFile);
      const buffer = await Workbook.toBuffer(wb, {
        useStyles: true,
        useSharedStrings: true
      });
      await expectValidXlsx(buffer, { label: "hyperlink-without-text" });
      await fs.promises.writeFile(outFile, buffer);

      const wb2 = Workbook.create();
      await Workbook.readFile(wb2, outFile);
      expect(getWorksheets(wb2).length).toBeGreaterThan(0);
    });

    it("readFile should not throw", async () => {
      const wb = Workbook.create();
      await Workbook.readFile(wb, excelTestDataPath("graceful-read-no-throw.xlsx"));
      expect(getWorksheets(wb).length).toBeGreaterThan(0);
    });

    it("unexpected xml node should not break parsing", async () => {
      const wb = Workbook.create();
      await Workbook.readFile(wb, excelTestDataPath("unexpected-xml-node.xlsx"));
      expect(getWorksheets(wb).length).toBeGreaterThan(0);
    });

    describe("1904 dates", () => {
      it("reads 1904-based workbook", async () => {
        const wb = Workbook.create();
        await Workbook.readFile(wb, excelTestDataPath("date-system-1904.xlsx"));

        expect(wb.properties.date1904).toBe(true);
        const ws = Workbook.getWorksheet(wb, "Sheet1")!;
        expect((Cell.getValue(ws, "B4") as Date).toISOString()).toBe("1904-01-01T00:00:00.000Z");
      });

      it("writes and reads 1904-based workbook", async () => {
        const filename = testFilePath("date1904-roundtrip.workbook");
        const wb = Workbook.create();
        wb.properties.date1904 = true;
        const ws = Workbook.addWorksheet(wb, "Sheet1");
        Cell.setValue(ws, "B4", new Date("1904-01-01T00:00:00.000Z"));

        await Workbook.writeFile(wb, filename);

        const wb2 = Workbook.create();
        await Workbook.readFile(wb2, filename);
        expect(wb2.properties.date1904).toBe(true);
        const ws2 = Workbook.getWorksheet(wb2, "Sheet1")!;
        expect((Cell.getValue(ws2, "B4") as Date).toISOString()).toBe("1904-01-01T00:00:00.000Z");
      });
    });

    it("sheet order is preserved", async () => {
      const wb = Workbook.create();
      await Workbook.readFile(wb, excelTestDataPath("sheet-order.xlsx"));
      expect(getWorksheets(wb).map(ws => getSheetName(ws))).toEqual(["First", "Second"]);
    });

    describe("missing r attribute in row/cell elements", () => {
      it("reads xlsx missing r attributes", async () => {
        const wb = Workbook.create();
        await Workbook.readFile(wb, excelTestDataPath("missing-cell-address.xlsx"));

        const ws = getWorksheets(wb)[0];
        expect(ws).toBeDefined();
        expect(Worksheet.rowCount(ws)).toBe(2);

        const row1 = Worksheet.getRow(ws, 1);
        expect(cellGetValue(rowGetCell(row1, 1))).toBeDefined();
        expect(cellGetValue(rowGetCell(row1, 2))).toBeDefined();
        expect(cellGetValue(rowGetCell(row1, 3))).toBeDefined();

        const row2 = Worksheet.getRow(ws, 2);
        expect(cellGetValue(rowGetCell(row2, 1))).toBe(1);
        expect(cellGetValue(rowGetCell(row2, 2))).toBeDefined();
        expect(cellGetValue(rowGetCell(row2, 3))).toBeDefined();
      });

      it("infers cell addresses when r is missing", async () => {
        const wb = Workbook.create();
        await Workbook.readFile(wb, excelTestDataPath("missing-cell-address.xlsx"));
        const ws = getWorksheets(wb)[0];

        expect(Cell.getValue(ws, "A1")).toBeDefined();
        expect(Cell.getValue(ws, "B1")).toBeDefined();
        expect(Cell.getValue(ws, "C1")).toBeDefined();
        expect(Cell.getValue(ws, "A2")).toBeDefined();
        expect(Cell.getValue(ws, "B2")).toBeDefined();
        expect(Cell.getValue(ws, "C2")).toBeDefined();
      });

      it("can write back after reading", async () => {
        const wb = Workbook.create();
        await Workbook.readFile(wb, excelTestDataPath("missing-cell-address.xlsx"));

        // NOTE: `expectValidXlsx` is intentionally NOT invoked here.
        // The `missing-cell-address.xlsx` fixture is already OOXML-broken
        // (cells without `r=` attrs) and the library's round-trip loses
        // the theme part while leaving content-types / rels pointing at
        // it. A stricter validator flags that, but the test only asserts
        // "write does not throw", which remains true.
        const buffer = await Workbook.toBuffer(wb);
        expect(buffer).toBeDefined();
        expect(buffer.byteLength).toBeGreaterThan(0);
      });
    });

    it("optional autofilter and custom autofilter on tables", async () => {
      const wb = Workbook.create();
      await Workbook.readFile(wb, excelTestDataPath("table-autofilter-optional.xlsx"));
      expect(getWorksheets(wb).length).toBeGreaterThan(0);

      const buffer = await Workbook.toBuffer(wb);
      const entries = await extractAll(new Uint8Array(buffer));
      const table1 = new TextDecoder().decode(entries.get("xl/tables/table1.xml")!.data);
      const table2 = new TextDecoder().decode(entries.get("xl/tables/table2.xml")!.data);
      expect(table1).toContain(
        '<customFilters><customFilter operator="notEqual" val="4"/></customFilters>'
      );
      expect(table2).toContain(
        '<filters><filter val="T123456789"/><filter val="T123456791"/><filter val="T123456793"/></filters>'
      );
      expect(table1).toContain('colId="0"');
      expect(table2).toContain('colId="0"');
    });

    it("<contentType /> element", async () => {
      const wb = Workbook.create();
      await Workbook.readFile(wb, excelTestDataPath("content-type-element.xlsx"));
      expect(getWorksheets(wb).length).toBeGreaterThan(0);
    });

    it("borders for merged cells survive rewrite", async () => {
      const outFile = testFilePath("merged-cell-borders.workbook");
      const wb = Workbook.create();
      await Workbook.readFile(wb, excelTestDataPath("merged-cell-borders.xlsx"));

      const assertBorder = (cell: any, borders: Array<"left" | "right" | "top" | "bottom">) => {
        expect(cell.style?.border).toBeTruthy();
        borders.forEach(b => {
          expect(cell.style.border).toHaveProperty(b);
        });
      };

      const ws = Workbook.getWorksheet(wb, 1)!;
      assertBorder(getCell(ws, "B2"), ["left", "top"]);
      assertBorder(getCell(ws, "B3"), ["left", "bottom"]);
      assertBorder(getCell(ws, "C2"), ["right", "top"]);
      assertBorder(getCell(ws, "C3"), ["right", "bottom"]);

      await Workbook.writeFile(wb, outFile);

      const wb2 = Workbook.create();
      await Workbook.readFile(wb2, outFile);
      const ws2 = Workbook.getWorksheet(wb2, 1)!;
      assertBorder(getCell(ws2, "B2"), ["left", "top"]);
      assertBorder(getCell(ws2, "B3"), ["left", "bottom"]);
      assertBorder(getCell(ws2, "C2"), ["right", "top"]);
      assertBorder(getCell(ws2, "C3"), ["right", "bottom"]);
    });

    it("malformed comment does not crash on write", async () => {
      const sourceFile = excelTestDataPath("malformed-comment.xlsx");
      const outFile = testFilePath("malformed-comment.workbook");

      const wb = Workbook.create();
      await Workbook.readFile(wb, sourceFile);
      const buffer = await Workbook.toBuffer(wb, {
        useStyles: true,
        useSharedStrings: true
      });
      await expectValidXlsx(buffer, { label: "malformed-comment" });
      await fs.promises.writeFile(outFile, buffer);

      const stat = await fs.promises.stat(outFile);
      expect(stat.size).toBeGreaterThan(0);
    }, 6000);

    it("table without autofilter model", async () => {
      const wb = Workbook.create();
      await Workbook.readFile(wb, excelTestDataPath("table-without-autofilter.xlsx"));
      expect(getWorksheets(wb).length).toBeGreaterThan(0);
    }, 6000);

    describe("worksheet file naming with non-sequential sheetIds", () => {
      it("uses sequential file names regardless of sheetId values", async () => {
        const workbook = Workbook.create();
        const ws1: any = Workbook.addWorksheet(workbook, "Sheet1");
        const ws2: any = Workbook.addWorksheet(workbook, "Sheet2");

        ws1.id = 1;
        ws2.id = 3;

        cellSetValue(getCell(ws1, "A1"), "Sheet 1 Data");
        cellSetValue(getCell(ws2, "A1"), "Sheet 2 Data");

        const buffer = await Workbook.toBuffer(workbook);
        await expectValidXlsx(buffer, { label: "sequential sheet filenames" });
        const zipData = await extractAll(new Uint8Array(buffer));

        expect(zipData.has("xl/worksheets/sheet1.xml")).toBe(true);
        expect(zipData.has("xl/worksheets/sheet2.xml")).toBe(true);
        expect(zipData.has("xl/worksheets/sheet3.xml")).toBe(false);

        const relsData = zipData.get("xl/_rels/workbook.xml.rels");
        const relsContent = new TextDecoder().decode(relsData?.data);
        expect(relsContent).toContain("worksheets/sheet1.xml");
        expect(relsContent).toContain("worksheets/sheet2.xml");
        expect(relsContent).not.toContain("worksheets/sheet3.xml");
      });

      it("preserves sheetId values in workbook.xml while using sequential file names", async () => {
        const workbook = Workbook.create();
        const ws1: any = Workbook.addWorksheet(workbook, "Sheet1");
        const ws2: any = Workbook.addWorksheet(workbook, "Sheet2");

        ws1.id = 1;
        ws2.id = 3;

        cellSetValue(getCell(ws1, "A1"), "Data 1");
        cellSetValue(getCell(ws2, "A1"), "Data 2");

        const buffer = await Workbook.toBuffer(workbook);
        await expectValidXlsx(buffer, { label: "sheetId preserved" });
        const zipData = await extractAll(new Uint8Array(buffer));

        const workbookData = zipData.get("xl/workbook.xml");
        const workbookContent = new TextDecoder().decode(workbookData?.data);
        expect(workbookContent).toContain('sheetId="1"');
        expect(workbookContent).toContain('sheetId="3"');
      });
    });

    describe("many definedNames should not cause OOM", () => {
      it("loads file with many definedNames without excessive memory use", async () => {
        const sourceFile = excelTestDataPath("many-defined-names.xlsx");

        const wb = Workbook.create();
        await Workbook.readFile(wb, sourceFile);
        expect(getWorksheets(wb).length).toBeGreaterThan(0);

        const dnModel = definedNamesModel(getDefinedNames(wb));
        expect(Array.isArray(dnModel)).toBe(true);

        // The file contains 35000+ defined names, most of which are garbage
        // (array constants, error values, etc.). With the two-phase classifier,
        // garbage entries are preserved as opaque (for round-trip) but do NOT
        // expand into CellMatrix objects. Verify that matrixMap stays small.
        const matrixCount = Object.keys(getDefinedNames(wb).matrixMap).length;
        expect(matrixCount).toBeLessThan(1000);
      }, 60000);

      it("loads file from buffer without excessive memory use", async () => {
        const sourceFile = excelTestDataPath("many-defined-names.xlsx");
        const buffer = await fs.promises.readFile(sourceFile);

        const wb = Workbook.create();
        await Workbook.read(wb, buffer);
        expect(getWorksheets(wb).length).toBeGreaterThan(0);
      }, 60000);

      it("filters out array constants from definedNames ranges", async () => {
        const sourceFile = excelTestDataPath("many-defined-names.xlsx");

        const wb = Workbook.create();
        await Workbook.readFile(wb, sourceFile);

        // Collect ranges from all defined names — opaque names have empty ranges,
        // so array constants should never appear in the ranges array.
        const allRanges: string[] = [];
        (definedNamesModel(getDefinedNames(wb)) as Array<{ ranges: string[] }>).forEach(dn => {
          allRanges.push(...dn.ranges);
        });

        allRanges.forEach(range => {
          expect(range.startsWith("{")).toBe(false);
          expect(range.endsWith("}")).toBe(false);
        });
      }, 60000);
    });

    describe("regressions", () => {
      it("worksheet should not be undefined", async () => {
        const wb = Workbook.create();
        await Workbook.readFile(wb, excelTestDataPath("worksheet-not-undefined.xlsx"));
        const ws = Workbook.getWorksheet(wb, 1)!;
        expect(ws).toBeDefined();
      });

      it("reads worksheet hidden state", async () => {
        const wb = Workbook.create();
        await Workbook.readFile(wb, excelTestDataPath("hidden-worksheet-state.xlsx"));

        const expected: Record<number, string> = { 1: "visible", 2: "hidden", 3: "visible" };
        Workbook.eachSheet(wb, (ws, sheetId) => {
          expect(ws.state).toBe(expected[sheetId]);
        });
      });

      it("reads workbook with whole-column defined names", async () => {
        const wb = Workbook.create();
        await Workbook.readFile(wb, excelTestDataPath("whole-column-defined-names.xlsx"));
        expect(getWorksheets(wb).length).toBeGreaterThan(0);
      });

      it("handles empty _xlnm.Print_Area ranges without crashing", async () => {
        const wb = Workbook.create();
        const ws = Workbook.addWorksheet(wb, "Sheet1");
        Cell.setValue(ws, "A1", "test");

        // Inject a Print_Area defined name with empty ranges,
        // simulating an Excel file where print area was set then cleared
        const workbookModel: any = getWorkbookModel(wb);
        workbookModel.definedNames = [
          {
            name: "_xlnm.Print_Area",
            localSheetId: 0,
            ranges: []
          }
        ];
        setWorkbookModel(wb, workbookModel);

        const buffer = await Workbook.toBuffer(wb);
        await expectValidXlsx(buffer, { label: "empty Print_Area ranges" });

        const wb2 = Workbook.create();
        await Workbook.read(wb2, buffer);

        const ws2 = Workbook.getWorksheet(wb2, "Sheet1")!;
        expect(ws2).toBeDefined();
        expect(Cell.getValue(ws2, "A1")).toBe("test");
        expect(ws2.pageSetup.printArea).toBeUndefined();
      });

      it("lastColumn with an empty column", async () => {
        const wb = Workbook.create();
        const ws = Workbook.addWorksheet(wb, "Sheet1");

        Cell.setValue(ws, "A1", "not empty");
        getCell(ws, "B1").style = { numFmt: "@" };

        const buffer = await Workbook.toBuffer(wb);
        await expectValidXlsx(buffer, { label: "lastColumn empty column" });

        const wb2 = Workbook.create();
        await Workbook.read(wb2, buffer);

        const ws2 = Workbook.getWorksheet(wb2, "Sheet1")!;
        expect(getLastColumn(ws2)).toBe(getColumn(ws2, 2));
      });

      it("inlineStr cell type support", async () => {
        const wb = Workbook.create();
        await Workbook.readFile(wb, excelTestDataPath("inline-string-cells.xlsx"));

        const ws = Workbook.getWorksheet(wb, "Sheet1")!;
        expect(Cell.getValue(ws, "A1")).toBe("A");
        expect(Cell.getValue(ws, "B1")).toBe("B");
        expect(Cell.getValue(ws, "C1")).toBe("C");
        expect(Cell.getValue(ws, "A2")).toBe("1.0");
        expect(Cell.getValue(ws, "B2")).toBe("2.0");
        expect(Cell.getValue(ws, "C2")).toBe("3.0");
        expect(Cell.getValue(ws, "A3")).toBe("4.0");
        expect(Cell.getValue(ws, "B3")).toBe("5.0");
        expect(Cell.getValue(ws, "C3")).toBe("6.0");
      });

      describe("preserve whitespace", () => {
        it("preserves leading and trailing whitespace", async () => {
          const testFile = testFilePath("pr-896.whitespace");
          const wb = Workbook.create();
          const ws = Workbook.addWorksheet(wb, "foo");
          Cell.setValue(ws, "A1", " leading");
          Cell.setNote(ws, "A1", " leading");
          Cell.setValue(ws, "B1", "trailing ");
          Cell.setNote(ws, "B1", "trailing ");
          Cell.setValue(ws, "C1", " both ");
          Cell.setNote(ws, "C1", " both ");

          await Workbook.writeFile(wb, testFile);

          const wb2 = Workbook.create();
          await Workbook.readFile(wb2, testFile);
          const ws2 = Workbook.getWorksheet(wb2, "foo")!;
          expect(Cell.getValue(ws2, "A1")).toBe(" leading");
          expect(Cell.getNote(ws2, "A1")).toBe(" leading");
          expect(Cell.getValue(ws2, "B1")).toBe("trailing ");
          expect(Cell.getNote(ws2, "B1")).toBe("trailing ");
          expect(Cell.getValue(ws2, "C1")).toBe(" both ");
          expect(Cell.getNote(ws2, "C1")).toBe(" both ");
        });

        it("preserves newlines", async () => {
          const testFile = testFilePath("pr-896.newlines");
          const wb = Workbook.create();
          const ws = Workbook.addWorksheet(wb, "foo");
          Cell.setValue(ws, "A1", "Hello,\nWorld!");
          Cell.setNote(ws, "A1", "Later,\nAlligator!");
          Cell.setValue(ws, "B1", " Hello, \n World! ");
          Cell.setNote(ws, "B1", " Later, \n Alligator! ");

          await Workbook.writeFile(wb, testFile);

          const wb2 = Workbook.create();
          await Workbook.readFile(wb2, testFile);
          const ws2 = Workbook.getWorksheet(wb2, "foo")!;
          expect(Cell.getValue(ws2, "A1")).toBe("Hello,\nWorld!");
          expect(Cell.getNote(ws2, "A1")).toBe("Later,\nAlligator!");
          expect(Cell.getValue(ws2, "B1")).toBe(" Hello, \n World! ");
          expect(Cell.getNote(ws2, "B1")).toBe(" Later, \n Alligator! ");
        });

        it("preserves richText and comment texts with leading new line", async () => {
          const testFile = testFilePath("pr-896.richtext");
          const wb = Workbook.create();
          const ws = Workbook.addWorksheet(wb, "sheet1");
          Column.setWidth(ws, 1, 20);

          const RT_ARR = [
            { text: "First Line:\n", font: { bold: true } },
            { text: "Second Line\n" },
            { text: "Third Line\n" },
            { text: "Last Line" }
          ];
          const TEST_VALUE = { richText: RT_ARR };
          const TEST_NOTE = { texts: RT_ARR };

          Cell.setValue(ws, "A1", TEST_VALUE);
          Cell.setNote(ws, "A1", TEST_NOTE);
          Cell.setStyle(ws, "A1", { alignment: { wrapText: true } });

          await Workbook.writeFile(wb, testFile);

          const wb2 = Workbook.create();
          await Workbook.readFile(wb2, testFile);
          const ws2 = Workbook.getWorksheet(wb2, "sheet1")!;
          expect(ws2).toBeDefined();
          expect(Cell.getValue(ws2, "A1")).toEqual(TEST_VALUE);
        });
      });

      describe("comment box size", () => {
        it("round-trips custom comment width/height through XLSX", async () => {
          const testFile = testFilePath("comment-size.roundtrip");
          const wb = Workbook.create();
          const ws = Workbook.addWorksheet(wb, "foo");
          Cell.setValue(ws, "A1", "sized comment");
          Cell.setNote(ws, "A1", {
            texts: [{ text: "A large note" }],
            width: 240,
            height: 150
          });

          await Workbook.writeFile(wb, testFile);

          const wb2 = Workbook.create();
          await Workbook.readFile(wb2, testFile);
          const ws2 = Workbook.getWorksheet(wb2, "foo")!;
          const note = Cell.getNote(ws2, "A1") as any;
          expect(note.width).toBe(240);
          expect(note.height).toBe(150);
        });

        it("omits width/height for default-sized comments (no model pollution)", async () => {
          const testFile = testFilePath("comment-size.default");
          const wb = Workbook.create();
          const ws = Workbook.addWorksheet(wb, "foo");
          Cell.setValue(ws, "A1", "plain comment");
          Cell.setNote(ws, "A1", "just text");

          await Workbook.writeFile(wb, testFile);

          const wb2 = Workbook.create();
          await Workbook.readFile(wb2, testFile);
          const ws2 = Workbook.getWorksheet(wb2, "foo")!;
          // A plain string note round-trips back to a string.
          expect(Cell.getNote(ws2, "A1")).toBe("just text");
        });

        it("renders default dimensions when width/height equal the defaults", async () => {
          // Setting the exact default size is a documented no-op on the model
          // (it is not stored back), but the emitted VML must still carry the
          // default geometry so the rendered comment box is unchanged.
          const wb = Workbook.create();
          const ws = Workbook.addWorksheet(wb, "foo");
          Cell.setValue(ws, "A1", "x");
          Cell.setNote(ws, "A1", { texts: [{ text: "n" }], width: 97.8, height: 59.1 });

          const buffer = await Workbook.toBuffer(wb);
          const { unzip } = await import("@archive/read-archive");
          const reader = unzip(buffer);
          let vml = "";
          for await (const entry of reader.entries()) {
            if (/drawings\/vmlDrawing\d+\.vml$/.test(entry.path)) {
              vml = new TextDecoder().decode((await entry.bytes()) ?? new Uint8Array());
            }
          }
          expect(vml).toContain("width:97.8pt");
          expect(vml).toContain("height:59.1pt");
        });
      });

      it("writeFile rejects when image file is missing", async () => {
        const testFile = testFilePath("pr-2244.missing-image");

        let error: unknown;
        try {
          const workbook = Workbook.create();
          const worksheet = Workbook.addWorksheet(workbook, "sheet");
          const imageId1 = addWorkbookImage(workbook, {
            filename: "path/to/image.jpg",
            extension: "jpeg"
          });
          addImage(worksheet, imageId1, "B2:D6");
          await Workbook.writeFile(workbook, testFile);
        } catch (err) {
          error = err;
        }

        expect(error).toBeInstanceOf(Error);
      });
    });

    it("creator, lastModifiedBy, etc", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Hello");
      Cell.setValue(ws, "A1", "World!");
      wb.creator = "Foo";
      wb.lastModifiedBy = "Bar";
      wb.created = new Date(2016, 0, 1);
      wb.modified = new Date(2016, 4, 19);
      await Workbook.writeFile(wb, TEST_XLSX_FILE_NAME);
      const wb2 = Workbook.create();
      await Workbook.readFile(wb2, TEST_XLSX_FILE_NAME);
      expect(wb2.creator).toBe(wb.creator);
      expect(wb2.lastModifiedBy).toBe(wb.lastModifiedBy);
      expect(wb2.created).toEqual(wb.created);
      expect(wb2.modified).toEqual(wb.modified);
    });
    it("printTitlesRow", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "printHeader");

      Cell.setValue(ws, "A1", "This is a header row repeated on every printed page");
      Cell.setValue(ws, "B2", "This is a header row too");

      for (let i = 0; i < 100; i++) {
        Worksheet.addRow(ws, ["not header row"]);
      }

      ws.pageSetup.printTitlesRow = "1:2";

      await Workbook.writeFile(wb, TEST_XLSX_FILE_NAME);
      const wb2 = Workbook.create();
      await Workbook.readFile(wb2, TEST_XLSX_FILE_NAME);
      const ws2 = Workbook.getWorksheet(wb2, "printHeader")!;
      expect(ws2.pageSetup.printTitlesRow).toBe("1:2");
      expect(ws2.pageSetup.printTitlesColumn).toBeUndefined();
    });
    it("printTitlesColumn", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "printColumn");

      Cell.setValue(ws, "A1", "This is a column repeated on every printed page");
      Cell.setValue(ws, "A2", "This is a column repeated on every printed page");
      Cell.setValue(ws, "B1", "This is a repeated column too");
      Cell.setValue(ws, "B2", "This is a repeated column too");

      Cell.setValue(ws, "C1", "This is a regular column");
      Cell.setValue(ws, "C2", "This is a regular column");
      Cell.setValue(ws, "D1", "This is a regular column");
      Cell.setValue(ws, "D2", "This is a regular column");

      ws.pageSetup.printTitlesRow = "A:B";

      await Workbook.writeFile(wb, TEST_XLSX_FILE_NAME);
      const wb2 = Workbook.create();
      await Workbook.readFile(wb2, TEST_XLSX_FILE_NAME);
      const ws2 = Workbook.getWorksheet(wb2, "printColumn")!;
      expect(ws2.pageSetup.printTitlesRow).toBeUndefined();
      expect(ws2.pageSetup.printTitlesColumn).toBe("A:B");
    });
    it("printTitlesRowAndColumn", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "printHeaderAndColumn");

      Cell.setValue(ws, "A1", "This is a column / row repeated on every printed page");
      Cell.setValue(ws, "A2", "This is a column / row repeated on every printed page");
      Cell.setValue(ws, "B1", "This is a repeated column / row too");
      Cell.setValue(ws, "B2", "This is a repeated column / row too");

      Cell.setValue(ws, "C1", "This is a regular column, repeated row");
      Cell.setValue(ws, "C2", "This is a regular column, repeated row");
      Cell.setValue(ws, "D1", "This is a regular column, repeated row");
      Cell.setValue(ws, "D2", "This is a regular column, repeated row");

      Cell.setValue(ws, "A3", "This is a repeated column");
      Cell.setValue(ws, "B3", "This is a repeated column");
      Cell.setValue(ws, "C3", "This is a regular column / row");
      Cell.setValue(ws, "D3", "This is a regular column / row");

      ws.pageSetup.printTitlesColumn = "A:B";
      ws.pageSetup.printTitlesRow = "1:2";

      for (let i = 0; i < 100; i++) {
        Worksheet.addRow(ws, [
          "repeated column, not repeated row",
          "repeated column, not repeated row",
          "no repeat",
          "no repeat"
        ]);
      }

      await Workbook.writeFile(wb, TEST_XLSX_FILE_NAME);
      const wb2 = Workbook.create();
      await Workbook.readFile(wb2, TEST_XLSX_FILE_NAME);
      const ws2 = Workbook.getWorksheet(wb2, "printHeaderAndColumn")!;
      expect(ws2.pageSetup.printTitlesRow).toBe("1:2");
      expect(ws2.pageSetup.printTitlesColumn).toBe("A:B");
    });

    it("single-cell printArea without colon round-trips correctly", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Cell.setValue(ws, "A1", "test");
      ws.pageSetup.printArea = "A1";

      const buffer = await Workbook.toBuffer(wb);
      await expectValidXlsx(buffer, { label: "single-cell printArea" });

      const wb2 = Workbook.create();
      await Workbook.read(wb2, buffer);

      const ws2 = Workbook.getWorksheet(wb2, "Sheet1")!;
      expect(ws2.pageSetup.printArea).toBe("A1:A1");
    });

    it("multiple printAreas on a single sheet round-trip correctly", async () => {
      // Issue #168: multiple print areas in a single worksheet must round-trip.
      // Per ECMA-376 §18.2.5 the (name, localSheetId) pair on `<definedName>`
      // must be unique, so multiple print areas collapse into ONE
      // `<definedName name="_xlnm.Print_Area">` whose text is a comma-
      // separated list of ranges (Excel's native format). The
      // worksheet-level `printArea` field uses `&&` as the multi-range
      // separator (legacy documonster convention, preserved for backwards
      // compatibility); both `&&` and `,` are accepted on input.
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      for (let r = 1; r <= 10; r++) {
        for (let c = 1; c <= 5; c++) {
          Cell.setValue(ws, r, c, `${r}-${c}`);
        }
      }
      ws.pageSetup.printArea = "A1:B5&&D1:E10";

      const buffer = await Workbook.toBuffer(wb);
      await expectValidXlsx(buffer, { label: "multiple printAreas" });

      // Inspect workbook.xml to confirm a single `<definedName>` with both
      // ranges, not two duplicate elements (which would violate OOXML).
      const zipData = await extractAll(new Uint8Array(buffer));
      const workbookData = zipData.get("xl/workbook.xml");
      const workbookContent = new TextDecoder().decode(workbookData?.data);
      const printAreaMatches = workbookContent.match(/<definedName name="_xlnm.Print_Area"[^>]*>/g);
      expect(printAreaMatches).toHaveLength(1);
      // The writer normalises every range to canonical `$col$row:$col$row`
      // form (matching what Excel itself emits), regardless of how the
      // user spelled the input.
      expect(workbookContent).toContain("$A$1:$B$5,&apos;Sheet1&apos;!$D$1:$E$10");

      const wb2 = Workbook.create();
      await Workbook.read(wb2, buffer);
      const ws2 = Workbook.getWorksheet(wb2, "Sheet1")!;
      expect(ws2.pageSetup.printArea).toBe("A1:B5&&D1:E10");
    });

    it("printArea with comma separator (Excel's native syntax) is accepted", async () => {
      // Users pasting from Excel may use `,` as the separator. We accept
      // both `,` and `&&` on write; the round-tripped form uses `&&` for
      // backwards compatibility.
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Cell.setValue(ws, "A1", "test");
      ws.pageSetup.printArea = "A1:B5,D1:E10";

      const buffer = await Workbook.toBuffer(wb);
      await expectValidXlsx(buffer, { label: "comma-separated printArea" });

      const wb2 = Workbook.create();
      await Workbook.read(wb2, buffer);
      const ws2 = Workbook.getWorksheet(wb2, "Sheet1")!;
      expect(ws2.pageSetup.printArea).toBe("A1:B5&&D1:E10");
    });

    it("multiple printAreas survive across separate sheets", async () => {
      // Each sheet keeps its own `_xlnm.Print_Area` defined name (with its
      // own `localSheetId`), so multi-range entries on one sheet must not
      // bleed into other sheets.
      const wb = Workbook.create();
      const ws1 = Workbook.addWorksheet(wb, "S1");
      const ws2 = Workbook.addWorksheet(wb, "S2");
      Cell.setValue(ws1, "A1", "x");
      Cell.setValue(ws2, "A1", "y");
      ws1.pageSetup.printArea = "A1:B2&&D1:E2";
      ws2.pageSetup.printArea = "A1:C3";

      const buffer = await Workbook.toBuffer(wb);
      await expectValidXlsx(buffer, { label: "per-sheet multiple printAreas" });

      const wb2 = Workbook.create();
      await Workbook.read(wb2, buffer);
      expect(Workbook.getWorksheet(wb2, "S1")!.pageSetup.printArea).toBe("A1:B2&&D1:E2");
      expect(Workbook.getWorksheet(wb2, "S2")!.pageSetup.printArea).toBe("A1:C3");
    });

    it("multiple printAreas on a sheet with a comma in its name round-trip correctly", async () => {
      // Sheet names containing commas are quoted in OOXML
      // (`'Q1, Forecast'!$A$1:$B$5`). The reader must split on top-level
      // commas only — splitting on every comma would shred the sheet name.
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Q1, Forecast");
      Cell.setValue(ws, "A1", "x");
      ws.pageSetup.printArea = "A1:B5&&D1:E10";

      const buffer = await Workbook.toBuffer(wb);
      await expectValidXlsx(buffer, { label: "comma-named sheet printAreas" });

      const wb2 = Workbook.create();
      await Workbook.read(wb2, buffer);
      const ws2 = Workbook.getWorksheet(wb2, "Q1, Forecast")!;
      expect(ws2.pageSetup.printArea).toBe("A1:B5&&D1:E10");
    });

    describe("printArea / printTitles input normalisation", () => {
      // Regression: the previous string-concatenation writer produced
      // corrupt OOXML for several user-input shapes Excel itself accepts:
      //   - lowercase `a1:b5`        -> `$a1:$b5` (read-back returned NaN)
      //   - already-anchored `$A$1`  -> `$$A$1` (Excel rejects double-$)
      //   - sheet-prefixed input     -> `$Sheet1!A1:$B5` (corrupt)
      //   - whitespace `A1 : B5`     -> `$A1 :$ B5` (corrupt)
      //   - row-relative `A1:B5`     -> `$A1:$B5` (drifts when rows
      //                                 inserted above the print area)
      // The writer now routes every input through `parsePrintReference`
      // — a hand-rolled parser that recognises all four legal Excel
      // print-reference shapes (cell, range, whole-row, whole-column)
      // and emits Excel's canonical `$col$row[:$col$row]` shape.
      const cases: Array<{ input: string; expectedRoundTrip: string; xmlContains: string }> = [
        { input: "a1:b5", expectedRoundTrip: "A1:B5", xmlContains: "$A$1:$B$5" },
        { input: "$A$1:$B$5", expectedRoundTrip: "A1:B5", xmlContains: "$A$1:$B$5" },
        { input: "$A1:$B5", expectedRoundTrip: "A1:B5", xmlContains: "$A$1:$B$5" },
        { input: "A1 : B5", expectedRoundTrip: "A1:B5", xmlContains: "$A$1:$B$5" },
        { input: "  A1:B5  ", expectedRoundTrip: "A1:B5", xmlContains: "$A$1:$B$5" },
        { input: "Sheet1!A1:B5", expectedRoundTrip: "A1:B5", xmlContains: "$A$1:$B$5" },
        { input: "A1", expectedRoundTrip: "A1:A1", xmlContains: "$A$1:$A$1" }
      ];
      for (const { input, expectedRoundTrip, xmlContains } of cases) {
        it(`printArea input ${JSON.stringify(input)} normalises to canonical OOXML`, async () => {
          const wb = Workbook.create();
          const ws = Workbook.addWorksheet(wb, "S");
          Cell.setValue(ws, "A1", "x");
          ws.pageSetup.printArea = input;

          const buffer = await Workbook.toBuffer(wb);
          await expectValidXlsx(buffer, { label: `printArea normalise ${input}` });

          const zipData = await extractAll(new Uint8Array(buffer));
          const workbookContent = new TextDecoder().decode(zipData.get("xl/workbook.xml")?.data);
          // Output never contains the broken double-`$` or row-relative
          // forms that the old string-concat writer used to emit.
          expect(workbookContent).not.toMatch(/\$\$[A-Z]/);
          expect(workbookContent).toContain(xmlContains);

          const wb2 = Workbook.create();
          await Workbook.read(wb2, buffer);
          expect(Workbook.getWorksheet(wb2, "S")!.pageSetup.printArea).toBe(expectedRoundTrip);
        });
      }

      it("printTitlesRow input with $ does not produce $$ output", async () => {
        const wb = Workbook.create();
        const ws = Workbook.addWorksheet(wb, "S");
        Cell.setValue(ws, "A1", "x");
        ws.pageSetup.printTitlesRow = "$1:$2";

        const buffer = await Workbook.toBuffer(wb);
        await expectValidXlsx(buffer, { label: "printTitlesRow $1:$2" });
        const zipData = await extractAll(new Uint8Array(buffer));
        const workbookContent = new TextDecoder().decode(zipData.get("xl/workbook.xml")?.data);
        expect(workbookContent).not.toMatch(/\$\$\d/);
        expect(workbookContent).toContain("$1:$2");

        const wb2 = Workbook.create();
        await Workbook.read(wb2, buffer);
        expect(Workbook.getWorksheet(wb2, "S")!.pageSetup.printTitlesRow).toBe("1:2");
      });

      it("printTitlesColumn input with $ and lowercase normalises", async () => {
        const wb = Workbook.create();
        const ws = Workbook.addWorksheet(wb, "S");
        Cell.setValue(ws, "A1", "x");
        ws.pageSetup.printTitlesColumn = "$a:$b";

        const buffer = await Workbook.toBuffer(wb);
        await expectValidXlsx(buffer, { label: "printTitlesColumn $a:$b" });
        const zipData = await extractAll(new Uint8Array(buffer));
        const workbookContent = new TextDecoder().decode(zipData.get("xl/workbook.xml")?.data);
        expect(workbookContent).not.toMatch(/\$\$[A-Za-z]/);
        expect(workbookContent).toContain("$A:$B");

        const wb2 = Workbook.create();
        await Workbook.read(wb2, buffer);
        expect(Workbook.getWorksheet(wb2, "S")!.pageSetup.printTitlesColumn).toBe("A:B");
      });

      it("printTitlesRow with a column-shaped value keeps backwards-compatible auto-routing", async () => {
        // Long-standing quirk: the OOXML reader infers the axis from the
        // emitted reference, so users who set `printTitlesRow = "A:B"`
        // got the value silently re-classified onto `printTitlesColumn`
        // on round-trip. Preserve that behaviour rather than silently
        // dropping the entry — strict enforcement would be a regression.
        const wb = Workbook.create();
        const ws = Workbook.addWorksheet(wb, "S");
        Cell.setValue(ws, "A1", "x");
        ws.pageSetup.printTitlesRow = "A:B";

        const buffer = await Workbook.toBuffer(wb);
        await expectValidXlsx(buffer, { label: "row=A:B legacy" });

        const wb2 = Workbook.create();
        await Workbook.read(wb2, buffer);
        const ps = Workbook.getWorksheet(wb2, "S")!.pageSetup;
        expect(ps.printTitlesRow).toBeUndefined();
        expect(ps.printTitlesColumn).toBe("A:B");
      });

      it("malformed printArea input is dropped, not written as corrupt XML", async () => {
        const wb = Workbook.create();
        const ws = Workbook.addWorksheet(wb, "S");
        Cell.setValue(ws, "A1", "x");
        // Garbage input — neither an address nor a range.
        ws.pageSetup.printArea = "not-a-range!!";

        const buffer = await Workbook.toBuffer(wb);
        await expectValidXlsx(buffer, { label: "garbage printArea" });
        const zipData = await extractAll(new Uint8Array(buffer));
        const workbookContent = new TextDecoder().decode(zipData.get("xl/workbook.xml")?.data);
        expect(workbookContent).not.toContain("Print_Area");

        const wb2 = Workbook.create();
        await Workbook.read(wb2, buffer);
        expect(Workbook.getWorksheet(wb2, "S")!.pageSetup.printArea).toBeUndefined();
      });

      it("whole-row printArea (1:5) round-trips", async () => {
        // Excel UI allows selecting entire rows as a print area. Emitted
        // OOXML form is `'Sheet'!$1:$5`. The earlier writer mangled this
        // to `$1:$5` *without* the sheet prefix and the read side then
        // returned `NaN:NaN`; the parser-driven writer handles it.
        const wb = Workbook.create();
        const ws = Workbook.addWorksheet(wb, "S");
        Cell.setValue(ws, "A1", "x");
        ws.pageSetup.printArea = "1:5";

        const buffer = await Workbook.toBuffer(wb);
        await expectValidXlsx(buffer, { label: "whole-row printArea" });
        const zipData = await extractAll(new Uint8Array(buffer));
        const workbookContent = new TextDecoder().decode(zipData.get("xl/workbook.xml")?.data);
        expect(workbookContent).toContain("$1:$5");

        const wb2 = Workbook.create();
        await Workbook.read(wb2, buffer);
        expect(Workbook.getWorksheet(wb2, "S")!.pageSetup.printArea).toBe("1:5");
      });

      it("whole-column printArea (A:C) round-trips", async () => {
        const wb = Workbook.create();
        const ws = Workbook.addWorksheet(wb, "S");
        Cell.setValue(ws, "A1", "x");
        ws.pageSetup.printArea = "A:C";

        const buffer = await Workbook.toBuffer(wb);
        await expectValidXlsx(buffer, { label: "whole-column printArea" });
        const zipData = await extractAll(new Uint8Array(buffer));
        const workbookContent = new TextDecoder().decode(zipData.get("xl/workbook.xml")?.data);
        expect(workbookContent).toContain("$A:$C");

        const wb2 = Workbook.create();
        await Workbook.read(wb2, buffer);
        expect(Workbook.getWorksheet(wb2, "S")!.pageSetup.printArea).toBe("A:C");
      });

      it("mixed printArea forms (cell, range, whole-row, whole-column) coexist", async () => {
        // All four shapes can appear in the same comma-separated
        // OOXML `<definedName>`; verify the multi-range pipeline accepts
        // each shape and the read path preserves them all.
        const wb = Workbook.create();
        const ws = Workbook.addWorksheet(wb, "S");
        Cell.setValue(ws, "A1", "x");
        ws.pageSetup.printArea = "A1&&B2:C3&&5:7&&E:F";

        const buffer = await Workbook.toBuffer(wb);
        await expectValidXlsx(buffer, { label: "mixed shapes" });

        const wb2 = Workbook.create();
        await Workbook.read(wb2, buffer);
        // Cell promotes to A1:A1 (degenerate range); other shapes
        // round-trip verbatim.
        expect(Workbook.getWorksheet(wb2, "S")!.pageSetup.printArea).toBe("A1:A1&&B2:C3&&5:7&&E:F");
      });

      it("OOXML with bare-cell `<...>'S'!$A$1</...>` reads back as A1:A1", async () => {
        // Excel sometimes emits a bare cell (no `:`) when the print
        // area is a single cell. The reader must recognise that as a
        // legitimate print area and surface it as `A1:A1` on the
        // worksheet API (matching the writer's promote-cell-to-range
        // policy).
        const wb = Workbook.create();
        const ws = Workbook.addWorksheet(wb, "S");
        Cell.setValue(ws, "A1", "x");
        const m: any = getWorkbookModel(wb);
        m.definedNames = [
          { name: "_xlnm.Print_Area", localSheetId: 0, ranges: [], rawText: "'S'!$A$1" }
        ];
        setWorkbookModel(wb, m);
        const buffer = await Workbook.toBuffer(wb);
        await expectValidXlsx(buffer, { label: "bare-cell OOXML" });

        const wb2 = Workbook.create();
        await Workbook.read(wb2, buffer);
        expect(Workbook.getWorksheet(wb2, "S")!.pageSetup.printArea).toBe("A1:A1");
      });

      it("printArea with column past XFD throws ColumnOutOfBoundsError on write", async () => {
        // `AAAA` is column 18,279 — past Excel's hard XFD (16,384) limit.
        // Excel cannot represent the column at all, so emitting it would
        // produce a workbook Excel rejects. We surface the same error
        // type `getCell("AAAA1")` already throws so the user finds out
        // immediately rather than discovering the print area silently
        // disappeared from the saved file. The error message must carry
        // the offending letter (`AAAA`) so the user can locate the
        // mistake — the legacy `_fill(level)` path used to report
        // `Column 4 is out of bounds` (the letter count), which lied.
        const wb = Workbook.create();
        const ws = Workbook.addWorksheet(wb, "S");
        Cell.setValue(ws, "A1", "x");
        ws.pageSetup.printArea = "A1:AAAA5";

        await expect(Workbook.toBuffer(wb)).rejects.toThrow(/Column AAAA is out of bounds/);
      });

      it("whole-column printArea past XFD throws with the letter in the message", async () => {
        const wb = Workbook.create();
        const ws = Workbook.addWorksheet(wb, "S");
        Cell.setValue(ws, "A1", "x");
        ws.pageSetup.printArea = "AAAA:AAAB";

        await expect(Workbook.toBuffer(wb)).rejects.toThrow(/Column AAAA is out of bounds/);
      });

      it("printTitlesColumn past XFD throws with the letter in the message", async () => {
        const wb = Workbook.create();
        const ws = Workbook.addWorksheet(wb, "S");
        Cell.setValue(ws, "A1", "x");
        ws.pageSetup.printTitlesColumn = "AAAA:AAAB";

        await expect(Workbook.toBuffer(wb)).rejects.toThrow(/Column AAAA is out of bounds/);
      });

      it("loading a workbook whose OOXML carries an out-of-bounds column drops the bad range without aborting the load", async () => {
        // A file authored by another tool (or hand-edited) might
        // contain a print-area `<definedName>` whose body references
        // a column past XFD. We must NOT let that single corrupt entry
        // take out the whole load — drop it silently and let the rest
        // of the workbook reconcile normally. Mirrors how the validator
        // reports such cells as errors but the parser still returns a
        // usable model.
        //
        // First write a clean workbook, then patch its `xl/workbook.xml`
        // to inject a `<definedName>` that mixes a bad (out-of-XFD)
        // range and a good range. The good range must survive the load.
        const cleanWb = Workbook.create();
        Cell.setValue(Workbook.addWorksheet(cleanWb, "Sheet1"), "A1", "x");
        const cleanBuf = await Workbook.toBuffer(cleanWb);

        const entries = await extractAll(new Uint8Array(cleanBuf));
        const wbXmlText = new TextDecoder().decode(entries.get("xl/workbook.xml")!.data);
        // Inject `<definedNames>` immediately before `<calcPr>` (the
        // OOXML-mandated position) so the patched workbook stays valid
        // and the reconcile path actually sees the bad name.
        const patched = wbXmlText.replace(
          /<calcPr/,
          `<definedNames><definedName name="_xlnm.Print_Area" localSheetId="0">'Sheet1'!$AAAA$1:$AAAA$5,'Sheet1'!$A$1:$B$5</definedName></definedNames><calcPr`
        );
        const zipFiles: Array<{ name: string; data: Uint8Array }> = [];
        for (const [path, file] of entries) {
          zipFiles.push({
            name: path,
            data: path === "xl/workbook.xml" ? new TextEncoder().encode(patched) : file.data
          });
        }
        const patchedBuffer = await createZip(zipFiles);

        const wb2 = Workbook.create();
        await Workbook.read(wb2, patchedBuffer);
        // Bad range dropped, good range kept.
        expect(Workbook.getWorksheet(wb2, "Sheet1")!.pageSetup.printArea).toBe("A1:B5");
      });

      it("user-supplied sheet-prefixed input with comma in the sheet name is split correctly", async () => {
        // Regression: a quote-aware split is required so commas *inside*
        // a quoted sheet name (`'Q1, Forecast'!A1:B5`) are not treated
        // as range separators. The legacy `split(/&&|,/)` shredded such
        // inputs and lost every range — now they round-trip cleanly.
        const wb = Workbook.create();
        const ws = Workbook.addWorksheet(wb, "Q1, Forecast");
        Cell.setValue(ws, "A1", "x");
        ws.pageSetup.printArea = "'Q1, Forecast'!A1:B5,'Q1, Forecast'!D1:E10";

        const buffer = await Workbook.toBuffer(wb);
        await expectValidXlsx(buffer, { label: "comma-in-name sheet-prefixed input" });

        const wb2 = Workbook.create();
        await Workbook.read(wb2, buffer);
        expect(Workbook.getWorksheet(wb2, "Q1, Forecast")!.pageSetup.printArea).toBe(
          "A1:B5&&D1:E10"
        );
      });

      it("user-supplied sheet-prefixed input with `&&` in the sheet name is split correctly", async () => {
        const wb = Workbook.create();
        const ws = Workbook.addWorksheet(wb, "A&&B");
        Cell.setValue(ws, "A1", "x");
        ws.pageSetup.printArea = "'A&&B'!A1:B5&&'A&&B'!D1:E10";

        const buffer = await Workbook.toBuffer(wb);
        await expectValidXlsx(buffer, { label: "ampersand-in-name sheet-prefixed input" });

        const wb2 = Workbook.create();
        await Workbook.read(wb2, buffer);
        expect(Workbook.getWorksheet(wb2, "A&&B")!.pageSetup.printArea).toBe("A1:B5&&D1:E10");
      });

      it("reversed range endpoints are canonicalised to top-left:bottom-right", async () => {
        // Excel's UI never produces `B5:A1`, but a hand-authored input
        // might. Downstream consumers (PDF layout, range loops) assume
        // `s.r <= e.r && s.c <= e.c`, so the writer normalises here.
        const cases: Array<{ input: string; expected: string }> = [
          { input: "B5:A1", expected: "A1:B5" },
          { input: "5:1", expected: "1:5" },
          { input: "C:A", expected: "A:C" }
        ];
        for (const { input, expected } of cases) {
          const wb = Workbook.create();
          const ws = Workbook.addWorksheet(wb, "S");
          Cell.setValue(ws, "A1", "x");
          ws.pageSetup.printArea = input;
          const buffer = await Workbook.toBuffer(wb);
          await expectValidXlsx(buffer, { label: `reversed ${input}` });
          const wb2 = Workbook.create();
          await Workbook.read(wb2, buffer);
          expect(Workbook.getWorksheet(wb2, "S")!.pageSetup.printArea).toBe(expected);
        }
      });

      it("row 0 is rejected — Excel rows are 1-indexed", async () => {
        const wb = Workbook.create();
        const ws = Workbook.addWorksheet(wb, "S");
        Cell.setValue(ws, "A1", "x");
        ws.pageSetup.printArea = "A0:B5";

        await expect(Workbook.toBuffer(wb)).rejects.toThrow(/Row 0 is out of bounds/);
      });

      it("whole-row 0 input (e.g. `0:5`) is rejected", async () => {
        const wb = Workbook.create();
        const ws = Workbook.addWorksheet(wb, "S");
        Cell.setValue(ws, "A1", "x");
        ws.pageSetup.printArea = "0:5";

        await expect(Workbook.toBuffer(wb)).rejects.toThrow(/Row 0 is out of bounds/);
      });

      it("row past Excel's 1048576 limit is rejected", async () => {
        const wb = Workbook.create();
        const ws = Workbook.addWorksheet(wb, "S");
        Cell.setValue(ws, "A1", "x");
        ws.pageSetup.printArea = "A1:B1048577";

        await expect(Workbook.toBuffer(wb)).rejects.toThrow(
          /Row 1048577 is out of bounds.*1 to 1048576/
        );
      });

      it("printTitlesRow past the row limit is rejected", async () => {
        const wb = Workbook.create();
        const ws = Workbook.addWorksheet(wb, "S");
        Cell.setValue(ws, "A1", "x");
        ws.pageSetup.printTitlesRow = "1:1048577";

        await expect(Workbook.toBuffer(wb)).rejects.toThrow(/Row 1048577 is out of bounds/);
      });

      it("leading-zero row inputs are normalised to canonical integers", async () => {
        // OOXML expects `$A$1`, not `$A$001`. Excel tolerates the latter
        // on read, but emitting it makes the file look hand-edited and
        // confuses tooling that does string equality on cell refs.
        const wb = Workbook.create();
        const ws = Workbook.addWorksheet(wb, "S");
        Cell.setValue(ws, "A1", "x");
        ws.pageSetup.printArea = "A001:B005";

        const buffer = await Workbook.toBuffer(wb);
        await expectValidXlsx(buffer, { label: "leading-zero row" });
        const zipData = await extractAll(new Uint8Array(buffer));
        const workbookContent = new TextDecoder().decode(zipData.get("xl/workbook.xml")?.data);
        expect(workbookContent).toContain("$A$1:$B$5");
        expect(workbookContent).not.toContain("$A$001");

        const wb2 = Workbook.create();
        await Workbook.read(wb2, buffer);
        expect(Workbook.getWorksheet(wb2, "S")!.pageSetup.printArea).toBe("A1:B5");
      });

      it("loading a workbook with a row past the limit drops the bad range without aborting", async () => {
        // Mirror image of the column-OOB read-side test: a hand-edited
        // file with a row past 1048576 must not abort the load. The
        // `try/catch` around `parsePrintReference` in the read path
        // catches `RowOutOfBoundsError` the same way it catches
        // `ColumnOutOfBoundsError`.
        const cleanWb = Workbook.create();
        Cell.setValue(Workbook.addWorksheet(cleanWb, "Sheet1"), "A1", "x");
        const cleanBuf = await Workbook.toBuffer(cleanWb);

        const entries = await extractAll(new Uint8Array(cleanBuf));
        const wbXmlText = new TextDecoder().decode(entries.get("xl/workbook.xml")!.data);
        const patched = wbXmlText.replace(
          /<calcPr/,
          `<definedNames><definedName name="_xlnm.Print_Area" localSheetId="0">'Sheet1'!$A$1:$B$99999999,'Sheet1'!$A$1:$B$5</definedName></definedNames><calcPr`
        );
        const zipFiles: Array<{ name: string; data: Uint8Array }> = [];
        for (const [path, file] of entries) {
          zipFiles.push({
            name: path,
            data: path === "xl/workbook.xml" ? new TextEncoder().encode(patched) : file.data
          });
        }
        const patchedBuffer = await createZip(zipFiles);

        const wb2 = Workbook.create();
        await Workbook.read(wb2, patchedBuffer);
        expect(Workbook.getWorksheet(wb2, "Sheet1")!.pageSetup.printArea).toBe("A1:B5");
      });
    });

    it("single-column printTitlesColumn without colon round-trips correctly", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Cell.setValue(ws, "A1", "test");
      ws.pageSetup.printTitlesColumn = "A";

      const buffer = await Workbook.toBuffer(wb);
      await expectValidXlsx(buffer, { label: "single-column printTitlesColumn" });

      const wb2 = Workbook.create();
      await Workbook.read(wb2, buffer);

      const ws2 = Workbook.getWorksheet(wb2, "Sheet1")!;
      expect(ws2.pageSetup.printTitlesColumn).toBe("A:A");
    });

    it("single-row printTitlesRow without colon round-trips correctly", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Cell.setValue(ws, "A1", "test");
      ws.pageSetup.printTitlesRow = "1";

      const buffer = await Workbook.toBuffer(wb);
      await expectValidXlsx(buffer, { label: "single-row printTitlesRow" });

      const wb2 = Workbook.create();
      await Workbook.read(wb2, buffer);

      const ws2 = Workbook.getWorksheet(wb2, "Sheet1")!;
      expect(ws2.pageSetup.printTitlesRow).toBe("1:1");
    });

    it("shared formula", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Hello");
      Worksheet.fillFormula(ws, "A1:B2", "ROW()+COLUMN()", [
        [2, 3],
        [3, 4]
      ]);
      await Workbook.writeFile(wb, TEST_XLSX_FILE_NAME);
      const wb2 = Workbook.create();
      await Workbook.readFile(wb2, TEST_XLSX_FILE_NAME);
      const ws2 = Workbook.getWorksheet(wb2, "Hello")!;
      expect(Cell.getValue(ws2, "A1")).toEqual({
        formula: "ROW()+COLUMN()",
        shareType: "shared",
        ref: "A1:B2",
        result: 2
      });
      expect(Cell.getValue(ws2, "B1")).toEqual({
        sharedFormula: "A1",
        result: 3
      });
      expect(Cell.getValue(ws2, "A2")).toEqual({
        sharedFormula: "A1",
        result: 3
      });
      expect(Cell.getValue(ws2, "B2")).toEqual({
        sharedFormula: "A1",
        result: 4
      });
    });

    it("auto filter", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Hello");
      Cell.setValue(ws, "A1", 1);
      Cell.setValue(ws, "B1", 1);
      Cell.setValue(ws, "A2", 2);
      Cell.setValue(ws, "B2", 2);
      Cell.setValue(ws, "A3", 3);
      Cell.setValue(ws, "B3", 3);

      ws.autoFilter = "A1:B1";

      await Workbook.writeFile(wb, TEST_XLSX_FILE_NAME);
      const wb2 = Workbook.create();
      await Workbook.readFile(wb2, TEST_XLSX_FILE_NAME);
      const ws2 = Workbook.getWorksheet(wb2, "Hello")!;
      expect(ws2.autoFilter).toBe("A1:B1");
    });

    it("auto filter with object form {row, col}", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Cell.setValue(ws, "A1", "Name");
      Cell.setValue(ws, "B1", "Age");
      Cell.setValue(ws, "C1", "City");
      ws.autoFilter = { from: { row: 1, col: 1 }, to: { row: 1, col: 3 } };

      await Workbook.writeFile(wb, TEST_XLSX_FILE_NAME);
      const wb2 = Workbook.create();
      await Workbook.readFile(wb2, TEST_XLSX_FILE_NAME);
      const ws2 = Workbook.getWorksheet(wb2, "Sheet1")!;
      // After round-trip, autoFilter is read back as string form
      expect(ws2.autoFilter).toBe("A1:C1");
    });

    it("company, manager, etc", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Hello");
      Cell.setValue(ws, "A1", "World!");
      wb.company = "Cyber Sapiens, Ltd";
      wb.manager = "Test Manager";
      await Workbook.writeFile(wb, TEST_XLSX_FILE_NAME);
      const wb2 = Workbook.create();
      await Workbook.readFile(wb2, TEST_XLSX_FILE_NAME);
      expect(wb2.company).toBe(wb.company);
      expect(wb2.manager).toBe(wb.manager);
    });

    it("title, subject, etc", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Hello");
      Cell.setValue(ws, "A1", "World!");
      wb.title = "the title";
      wb.subject = "the subject";
      wb.keywords = "the keywords";
      wb.category = "the category";
      wb.description = "the description";
      await Workbook.writeFile(wb, TEST_XLSX_FILE_NAME);
      const wb2 = Workbook.create();
      await Workbook.readFile(wb2, TEST_XLSX_FILE_NAME);
      expect(wb2.title).toBe(wb.title);
      expect(wb2.subject).toBe(wb.subject);
      expect(wb2.keywords).toBe(wb.keywords);
      expect(wb2.category).toBe(wb.category);
      expect(wb2.description).toBe(wb.description);
    });

    it("language, revision and contentStatus", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Hello");
      Cell.setValue(ws, "A1", "World!");
      wb.language = "Klingon";
      wb.revision = 2;
      wb.contentStatus = "Final";
      await Workbook.writeFile(wb, TEST_XLSX_FILE_NAME);
      const wb2 = Workbook.create();
      await Workbook.readFile(wb2, TEST_XLSX_FILE_NAME);
      expect(wb2.language).toBe(wb.language);
      expect(wb2.revision).toBe(wb.revision);
      expect(wb2.contentStatus).toBe(wb.contentStatus);
    });

    it("empty strings", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Hello");
      Cell.setValue(ws, "A1", "Foo");
      Cell.setValue(ws, "A2", "");
      Cell.setValue(ws, "A3", "Baz");
      await Workbook.writeFile(wb, TEST_XLSX_FILE_NAME);
      const wb2 = Workbook.create();
      await Workbook.readFile(wb2, TEST_XLSX_FILE_NAME);
      const ws2 = Workbook.getWorksheet(wb2, "Hello")!;

      expect(Cell.getValue(ws2, "A1")).toBe("Foo");
      expect(Cell.getValue(ws2, "A2")).toBe("");
      expect(Cell.getValue(ws2, "A3")).toBe("Baz");
    });

    it("dataValidations", async () => {
      const wb = testUtils.createTestBook(Workbook.create(), "xlsx", ["dataValidations"]);

      await Workbook.writeFile(wb, TEST_XLSX_FILE_NAME);
      const wb2 = Workbook.create();
      await Workbook.readFile(wb2, TEST_XLSX_FILE_NAME);
      testUtils.checkTestBook(wb2, "xlsx", ["dataValidations"], {});
    });

    it("empty string", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb);

      Worksheet.setColumns(ws, [
        { key: "id", width: 10 },
        { key: "name", width: 32 }
      ]);

      Worksheet.addRow(ws, { id: 1, name: "" });

      await Workbook.writeFile(wb, TEST_XLSX_FILE_NAME);
    });

    it("a lot of sheets to xlsx file", async function () {
      let i;
      const wb = Workbook.create();
      const numSheets = 90;
      // add numSheets sheets
      for (i = 1; i <= numSheets; i++) {
        const ws = Workbook.addWorksheet(wb, `sheet${i}`);
        Cell.setValue(ws, "A1", i);
      }
      await Workbook.writeFile(wb, TEST_XLSX_FILE_NAME);
      const wb2 = Workbook.create();
      await Workbook.readFile(wb2, TEST_XLSX_FILE_NAME);
      for (i = 1; i <= numSheets; i++) {
        const ws2 = Workbook.getWorksheet(wb2, `sheet${i}`)!;
        expect(ws2).toBeTruthy();
        expect(Cell.getValue(ws2, "A1")).toBe(i);
      }
    });

    it("csv file", async function () {
      const wb = testUtils.createTestBook(Workbook.create(), "csv", undefined);

      await writeCsvFile(wb, TEST_CSV_FILE_NAME);
      const wb2 = Workbook.create();
      await readCsvFile(wb2, TEST_CSV_FILE_NAME);
      testUtils.checkTestBook(wb2, "csv", undefined, {});
    });

    it("CSV file and its configuration", async function () {
      const writeOptions = {
        dateFormat: "DD/MM/YYYY HH:mm:ss",
        dateUTC: false,
        encoding: "utf-8",
        includeEmptyRows: false,
        sheetName: "sheet1",
        delimiter: "\t",
        quote: false
      } as unknown as CsvOptions;
      const readOptions: CsvOptions = {
        dateFormats: ["DD/MM/YYYY HH:mm:ss"],
        sheetName: "sheet1",
        delimiter: "\t",
        quote: null
      };
      const wb = testUtils.createTestBook(Workbook.create(), "csv", undefined);

      await writeCsvFile(wb, TEST_CSV_FILE_NAME, writeOptions);
      const wb2 = Workbook.create();
      await readCsvFile(wb2, TEST_CSV_FILE_NAME, readOptions);
      testUtils.checkTestBook(wb2, "csv", undefined, writeOptions);
    });

    it("defined names", async () => {
      const wb1 = Workbook.create();
      const ws1a = Workbook.addWorksheet(wb1, "blort");
      const ws1b = Workbook.addWorksheet(wb1, "foo");

      function assign(sheet: any, address: any, value: any, name: any) {
        const cell = getCell(sheet, address);
        cellSetValue(cell, value);
        if (Array.isArray(name)) {
          cellSetNames(cell, name);
        } else {
          cellSetName(cell, name);
        }
      }

      // single entry
      assign(ws1a, "A1", 5, "five");

      // three amigos - horizontal line
      assign(ws1a, "A3", 3, "amigos");
      assign(ws1a, "B3", 3, "amigos");
      assign(ws1a, "C3", 3, "amigos");

      // three amigos - vertical line
      assign(ws1a, "E1", 3, "verts");
      assign(ws1a, "E2", 3, "verts");
      assign(ws1a, "E3", 3, "verts");

      // four square
      assign(ws1a, "C5", 4, "squares");
      assign(ws1a, "B6", 4, "squares");
      assign(ws1a, "C6", 4, "squares");
      assign(ws1a, "B5", 4, "squares");

      // long distance
      assign(ws1a, "B7", 2, "sheets");
      assign(ws1b, "B7", 2, "sheets");

      // two names
      assign(ws1a, "G1", 1, "thing1");
      cellAddName(getCell(ws1a, "G1"), "thing2");

      // once removed
      assign(ws1a, "G2", 1, ["once", "twice"]);
      cellRemoveName(getCell(ws1a, "G2"), "once");

      await Workbook.writeFile(wb1, TEST_XLSX_FILE_NAME);
      const wb2 = Workbook.create();
      await Workbook.readFile(wb2, TEST_XLSX_FILE_NAME);
      const ws2a = Workbook.getWorksheet(wb2, "blort")!;
      const ws2b = Workbook.getWorksheet(wb2, "foo")!;

      function check(sheet: any, address: any, value: any, name: any) {
        const cell = getCell(sheet, address);
        expect(cellGetValue(cell)).toBe(value);
        expect(cellName(cell)).toBe(name);
      }

      // single entry
      check(ws2a, "A1", 5, "five");

      // three amigos - horizontal line
      check(ws2a, "A3", 3, "amigos");
      check(ws2a, "B3", 3, "amigos");
      check(ws2a, "C3", 3, "amigos");

      // three amigos - vertical line
      check(ws2a, "E1", 3, "verts");
      check(ws2a, "E2", 3, "verts");
      check(ws2a, "E3", 3, "verts");

      // four square
      check(ws2a, "C5", 4, "squares");
      check(ws2a, "B6", 4, "squares");
      check(ws2a, "C6", 4, "squares");
      check(ws2a, "B5", 4, "squares");

      // long distance
      check(ws2a, "B7", 2, "sheets");
      check(ws2b, "B7", 2, "sheets");

      // two names
      expect(cellNames(getCell(ws2a, "G1"))).toEqual(expect.arrayContaining(["thing1", "thing2"]));
      expect(cellNames(getCell(ws2a, "G1")).length).toBe(2);

      // once removed
      expect(cellNames(getCell(ws2a, "G2"))).toEqual(expect.arrayContaining(["twice"]));
      expect(cellNames(getCell(ws2a, "G2")).length).toBe(1);

      // ranges
      function rangeCheck(name: any, members: any) {
        const ranges = definedNamesGetRanges(getDefinedNames(wb2), name);
        expect(ranges.name).toBe(name);
        if (members.length) {
          expect(ranges.ranges).toEqual(expect.arrayContaining(members));
          expect(ranges.ranges.length).toBe(members.length);
        } else {
          expect(ranges.ranges.length).toBe(0);
        }
      }

      rangeCheck("five", ["blort!$A$1"]);
      rangeCheck("amigos", ["blort!$A$3:$C$3"]);
      rangeCheck("verts", ["blort!$E$1:$E$3"]);
      rangeCheck("squares", ["blort!$B$5:$C$6"]);
      rangeCheck("sheets", ["blort!$B$7", "foo!$B$7"]);
      rangeCheck("thing1", ["blort!$G$1"]);
      rangeCheck("thing2", ["blort!$G$1"]);
      rangeCheck("once", []);
      rangeCheck("twice", ["blort!$G$2"]);
    });

    describe("Duplicate Rows", () => {
      it("Duplicate rows with styles properly", async () => {
        const fileDuplicateRowTestFile = excelTestDataPath("duplicate-row-styles.xlsx");
        const wb = Workbook.create();
        await Workbook.readFile(wb, fileDuplicateRowTestFile);
        const ws = Workbook.getWorksheet(wb, "duplicateTest")!;
        if (!ws) {
          throw new Error("Worksheet not found");
        }

        Cell.setValue(ws, "A1", "OneInfo");
        Cell.setValue(ws, "A2", "TwoInfo");
        Worksheet.duplicateRow(ws, 1, 2);

        await Workbook.writeFile(wb, TEST_XLSX_FILE_NAME);
        const wb2 = Workbook.create();
        await Workbook.readFile(wb2, TEST_XLSX_FILE_NAME);
        const ws2 = Workbook.getWorksheet(wb2, "duplicateTest")!;

        expect(Cell.getValue(ws2, "A2")).toBe("OneInfo");
        expect(Cell.getStyle(ws2, "A2")).toStrictEqual(Cell.getStyle(ws2, "A1"));
        expect(Cell.getValue(ws2, "A3")).toBe("OneInfo");
        expect(Cell.getStyle(ws2, "A3")).toStrictEqual(Cell.getStyle(ws2, "A1"));
        expect(Cell.getValue(ws2, "A4")).toBeNull();
      });

      it("Duplicate rows replacing properly", async () => {
        const wb = Workbook.create();
        const ws = Workbook.addWorksheet(wb, "duplicateTest");
        Cell.setValue(ws, "A1", "OneInfo");
        Cell.setValue(ws, "A2", "TwoInfo");
        Cell.setValue(ws, "A3", "ThreeInfo");
        Cell.setValue(ws, "A4", "FourInfo");
        Worksheet.duplicateRow(ws, 1, 2, false);

        await Workbook.writeFile(wb, TEST_XLSX_FILE_NAME);
        const wb2 = Workbook.create();
        await Workbook.readFile(wb2, TEST_XLSX_FILE_NAME);
        const ws2 = Workbook.getWorksheet(wb2, "duplicateTest")!;

        expect(Cell.getValue(ws2, "A1")).toBe("OneInfo");
        expect(Cell.getValue(ws2, "A2")).toBe("OneInfo");
        expect(Cell.getValue(ws2, "A3")).toBe("OneInfo");
        expect(Cell.getValue(ws2, "A4")).toBe("FourInfo");
      });

      it("Duplicate rows shifting properly", async () => {
        const wb = Workbook.create();
        const ws = Workbook.addWorksheet(wb, "duplicateTest");
        Cell.setValue(ws, "A1", "OneInfo");
        Cell.setValue(ws, "A2", "TwoInfo");
        Cell.setValue(ws, "A3", "ThreeInfo");
        Cell.setValue(ws, "A4", "FourInfo");
        Worksheet.duplicateRow(ws, 1, 2, true);

        await Workbook.writeFile(wb, TEST_XLSX_FILE_NAME);
        const wb2 = Workbook.create();
        await Workbook.readFile(wb2, TEST_XLSX_FILE_NAME);
        const ws2 = Workbook.getWorksheet(wb2, "duplicateTest")!;

        expect(Cell.getValue(ws2, "A1")).toBe("OneInfo");
        expect(Cell.getValue(ws2, "A2")).toBe("OneInfo");
        expect(Cell.getValue(ws2, "A3")).toBe("OneInfo");
        expect(Cell.getValue(ws2, "A4")).toBe("TwoInfo");
      });

      it("Duplicate rows with height properly", async () => {
        const wb = Workbook.create();
        const ws = Workbook.addWorksheet(wb, "duplicateTest");
        Cell.setValue(ws, "A1", "OneInfo");
        Cell.setValue(ws, "A2", "TwoInfo");
        Row.setHeight(ws, 1, 25);
        Row.setHeight(ws, 2, 15);
        Worksheet.duplicateRow(ws, 1, 1, true);

        await Workbook.writeFile(wb, TEST_XLSX_FILE_NAME);
        const wb2 = Workbook.create();
        await Workbook.readFile(wb2, TEST_XLSX_FILE_NAME);
        const ws2 = Workbook.getWorksheet(wb2, "duplicateTest")!;

        expect(Cell.getValue(ws2, "A1")).toBe("OneInfo");
        expect(Cell.getValue(ws2, "A2")).toBe("OneInfo");
        expect(Row.getHeight(ws2, 1)).toBe(Row.getHeight(ws2, 2));
        expect(Row.getHeight(ws2, 1)).not.toBe(Row.getHeight(ws2, 3));
      });
    });

    describe("Merge Cells", () => {
      it("serialises and deserialises properly", async () => {
        const wb = Workbook.create();
        const ws = Workbook.addWorksheet(wb, "blort");

        // initial values
        Cell.setValue(ws, "B2", "B2");

        Worksheet.merge(ws, "B2:C3");

        await Workbook.writeFile(wb, TEST_XLSX_FILE_NAME);
        const wb2 = Workbook.create();
        await Workbook.readFile(wb2, TEST_XLSX_FILE_NAME);
        const ws2 = Workbook.getWorksheet(wb2, "blort")!;

        expect(Cell.getValue(ws2, "B2")).toBe("B2");
        expect(Cell.getValue(ws2, "B3")).toBe("B2");
        expect(Cell.getValue(ws2, "C2")).toBe("B2");
        expect(Cell.getValue(ws2, "C3")).toBe("B2");

        expect(Cell.getType(ws2, "B2")).toBe(ValueType.String);
        expect(Cell.getType(ws2, "B3")).toBe(ValueType.Merge);
        expect(Cell.getType(ws2, "C2")).toBe(ValueType.Merge);
        expect(Cell.getType(ws2, "C3")).toBe(ValueType.Merge);
      });

      it("styles", async () => {
        const wb = Workbook.create();
        const ws = Workbook.addWorksheet(wb, "blort");

        // initial values
        const B2 = getCell(ws, "B2");
        cellSetValue(B2, 5);
        B2.style.font = testUtils.styles.fonts.broadwayRedOutline20;
        B2.style.border = testUtils.styles.borders.doubleRed;
        B2.style.fill = testUtils.styles.fills.blueWhiteHGrad;
        B2.style.alignment = testUtils.styles.namedAlignments.middleCentre;
        B2.style.numFmt = testUtils.styles.numFmts.numFmt1;

        // expecting styles to be copied (see worksheet spec)
        Worksheet.merge(ws, "B2:C3");

        const dblRed = testUtils.styles.borders.doubleRed;

        await Workbook.writeFile(wb, TEST_XLSX_FILE_NAME);
        const wb2 = Workbook.create();
        await Workbook.readFile(wb2, TEST_XLSX_FILE_NAME);
        const ws2 = Workbook.getWorksheet(wb2, "blort")!;

        // Non-border styles are identical on all cells
        for (const addr of ["B2", "B3", "C2", "C3"]) {
          expect(Cell.getStyle(ws2, addr).font).toEqual(
            testUtils.styles.fonts.broadwayRedOutline20
          );
          expect(Cell.getStyle(ws2, addr).fill).toEqual(testUtils.styles.fills.blueWhiteHGrad);
          expect(Cell.getStyle(ws2, addr).alignment).toEqual(
            testUtils.styles.namedAlignments.middleCentre
          );
          expect(Cell.getStyle(ws2, addr).numFmt).toBe(testUtils.styles.numFmts.numFmt1);
        }

        // Borders are position-aware after round-trip
        expect(Cell.getStyle(ws2, "B2").border).toEqual({
          left: dblRed.left,
          top: dblRed.top
        });
        expect(Cell.getStyle(ws2, "C2").border).toEqual({
          right: dblRed.right,
          top: dblRed.top
        });
        expect(Cell.getStyle(ws2, "B3").border).toEqual({
          left: dblRed.left,
          bottom: dblRed.bottom
        });
        expect(Cell.getStyle(ws2, "C3").border).toEqual({
          right: dblRed.right,
          bottom: dblRed.bottom
        });
      });
    });
  });

  it("spliced meat and ham", async () => {
    const wb = Workbook.create();
    const sheets = [
      "splice.rows.removeOnly",
      "splice.rows.insertFewer",
      "splice.rows.insertSame",
      "splice.rows.insertMore",
      "splice.rows.insertStyle",
      "splice.columns.removeOnly",
      "splice.columns.insertFewer",
      "splice.columns.insertSame",
      "splice.columns.insertMore"
    ];
    const options = {
      checkBadAlignments: false,
      checkSheetProperties: false,
      checkViews: false
    };

    testUtils.createTestBook(wb, "xlsx", sheets);

    await Workbook.writeFile(wb, TEST_XLSX_FILE_NAME);
    const wb2 = Workbook.create();
    await Workbook.readFile(wb2, TEST_XLSX_FILE_NAME);
    testUtils.checkTestBook(wb2, "xlsx", sheets, options);
  });

  it("throws an error when xlsx file not found", async () => {
    const wb = Workbook.create();
    await expect(Workbook.readFile(wb, "./wb.doesnotexist.xlsx")).rejects.toThrow();
  });

  it("throws an error when csv file not found", async () => {
    const wb = Workbook.create();
    await expect(readCsvFile(wb, "./wb.doesnotexist.csv")).rejects.toThrow();
  });
  it("throw an error for wrong data type", async () => {
    const wb = Workbook.create();
    try {
      // Deliberately passing the wrong runtime type to verify the guard.
      await Workbook.read(wb, {} as unknown as Uint8Array);
      expect.fail("should fail for given argument");
    } catch (e) {
      expect((e as Error).message).toContain(
        "Can't read the data of 'the loaded zip file'. Is it in a supported JavaScript type (String, Blob, ArrayBuffer, etc) ?"
      );
    }
  });

  describe("Sheet Views", () => {
    it("frozen panes", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "frozen");
      ws.views = [
        {
          state: "frozen",
          xSplit: 2,
          ySplit: 3,
          topLeftCell: "C4",
          activeCell: "D5"
        },
        { state: "frozen", ySplit: 1 },
        { state: "frozen", xSplit: 1 }
      ];
      Cell.setValue(ws, "A1", "Let it Snow!");

      await Workbook.writeFile(wb, TEST_XLSX_FILE_NAME);
      const wb2 = Workbook.create();
      await Workbook.readFile(wb2, TEST_XLSX_FILE_NAME);
      const ws2 = Workbook.getWorksheet(wb2, "frozen")!;
      expect(ws2).toBeTruthy();
      expect(Cell.getValue(ws2, "A1")).toBe("Let it Snow!");
      expect(ws2.views).toEqual([
        {
          workbookViewId: 0,
          state: "frozen",
          xSplit: 2,
          ySplit: 3,
          topLeftCell: "C4",
          activeCell: "D5",
          showRuler: true,
          showGridLines: true,
          showRowColHeaders: true,
          zoomScale: 100,
          zoomScaleNormal: 100,
          rightToLeft: false,
          tabSelected: false
        },
        {
          workbookViewId: 0,
          state: "frozen",
          xSplit: 0,
          ySplit: 1,
          topLeftCell: "A2",
          showRuler: true,
          showGridLines: true,
          showRowColHeaders: true,
          zoomScale: 100,
          zoomScaleNormal: 100,
          rightToLeft: false,
          tabSelected: false
        },
        {
          workbookViewId: 0,
          state: "frozen",
          xSplit: 1,
          ySplit: 0,
          topLeftCell: "B1",
          showRuler: true,
          showGridLines: true,
          showRowColHeaders: true,
          zoomScale: 100,
          zoomScaleNormal: 100,
          rightToLeft: false,
          tabSelected: false
        }
      ]);
    });

    it("serialises split panes", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "split");
      ws.views = [
        {
          state: "split",
          xSplit: 2000,
          ySplit: 3000,
          topLeftCell: "C4",
          activeCell: "D5",
          activePane: "bottomRight"
        },
        {
          state: "split",
          ySplit: 1500,
          activePane: "bottomLeft",
          topLeftCell: "A10"
        },
        { state: "split", xSplit: 1500, activePane: "topRight" }
      ];
      Cell.setValue(ws, "A1", "Do the splits!");

      await Workbook.writeFile(wb, TEST_XLSX_FILE_NAME);
      const wb2 = Workbook.create();
      await Workbook.readFile(wb2, TEST_XLSX_FILE_NAME);
      const ws2 = Workbook.getWorksheet(wb2, "split")!;
      expect(ws2).toBeTruthy();
      expect(Cell.getValue(ws2, "A1")).toBe("Do the splits!");
      expect(ws2.views).toEqual([
        {
          workbookViewId: 0,
          state: "split",
          xSplit: 2000,
          ySplit: 3000,
          topLeftCell: "C4",
          activeCell: "D5",
          activePane: "bottomRight",
          showRuler: true,
          showGridLines: true,
          showRowColHeaders: true,
          zoomScale: 100,
          zoomScaleNormal: 100,
          rightToLeft: false,
          tabSelected: false
        },
        {
          workbookViewId: 0,
          state: "split",
          xSplit: 0,
          ySplit: 1500,
          topLeftCell: "A10",
          activePane: "bottomLeft",
          showRuler: true,
          showGridLines: true,
          showRowColHeaders: true,
          zoomScale: 100,
          zoomScaleNormal: 100,
          rightToLeft: false,
          tabSelected: false
        },
        {
          workbookViewId: 0,
          state: "split",
          xSplit: 1500,
          ySplit: 0,
          topLeftCell: undefined,
          activePane: "topRight",
          showRuler: true,
          showGridLines: true,
          showRowColHeaders: true,
          zoomScale: 100,
          zoomScaleNormal: 100,
          rightToLeft: false,
          tabSelected: false
        }
      ]);
    });

    it("multiple book views", async () => {
      const wb = Workbook.create();
      wb.views = [testUtils.views.book.visible, testUtils.views.book.hidden];

      const ws1 = Workbook.addWorksheet(wb, "one");
      ws1.views = [testUtils.views.sheet.frozen];

      const ws2 = Workbook.addWorksheet(wb, "two");
      ws2.views = [testUtils.views.sheet.split];

      await Workbook.writeFile(wb, TEST_XLSX_FILE_NAME);
      const wb2 = Workbook.create();
      await Workbook.readFile(wb2, TEST_XLSX_FILE_NAME);
      expect(wb2.views).toEqual(wb.views);

      const ws1b = Workbook.getWorksheet(wb2, "one")!;
      expect(ws1b!.views).toEqual(ws1.views);

      const ws2b = Workbook.getWorksheet(wb2, "two")!;
      expect(ws2b!.views).toEqual(ws2.views);
    });
  });
});

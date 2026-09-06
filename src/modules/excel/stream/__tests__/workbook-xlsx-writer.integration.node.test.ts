import fs from "fs";
import { promisify } from "util";

import { testUtils } from "@excel/__tests__/shared";
import type { NoteConfig } from "@excel/core/cell";
import { cellSetNote, cellSetValue, cellGetValue, cellName, cellSetName } from "@excel/core/cell";
import { columnAlignment, columnFont } from "@excel/core/column";
import { rowFont, rowSetFont } from "@excel/core/row";
import { getImage } from "@excel/core/workbook";
import {
  getBackgroundImageId,
  getCell,
  getColumn,
  getImages,
  rowCommit,
  rowGetCell
} from "@excel/core/worksheet";
import { Cell, Column, Workbook, Worksheet } from "@excel/index";
import { WorkbookWriter } from "@excel/stream/workbook-writer";
import { makeTestDataPath, testFilePath } from "@test/utils";
import { beforeEach, describe, it, expect } from "vitest";

const streamTestDataPath = makeTestDataPath(import.meta.url, "./data");

// Each test writes to its OWN output file. Sharing a single path across the
// suite is racy under some runtimes (notably bun on macOS), where a streaming
// WorkbookWriter's file `close` can resolve before the bytes are visible to a
// subsequent test's `readFile`, yielding a truncated read ("invalid signature:
// 0x0"). A per-test filename fully isolates the file lifecycle.
let testFileCounter = 0;
let TEST_XLSX_FILE_NAME = testFilePath("wb-xlsx-writer.test");
beforeEach(() => {
  TEST_XLSX_FILE_NAME = testFilePath(`wb-xlsx-writer.test.${testFileCounter++}`);
});
const IMAGE_FILENAME = streamTestDataPath("image.png");
const fsReadFileAsync = promisify(fs.readFile);

describe("WorkbookWriter", () => {
  it("creates sheets with correct names", () => {
    const wb = new WorkbookWriter();
    const ws1 = wb.addWorksheet("Hello, World!");
    expect(ws1.name).toBe("Hello, World!");

    const ws2 = wb.addWorksheet();
    expect(ws2.name).toMatch(/sheet\d+/);
  });

  describe("Serialise", () => {
    it("xlsx file", async () => {
      const options = {
        filename: TEST_XLSX_FILE_NAME,
        useStyles: true
      };
      const wb = testUtils.createTestBook(new WorkbookWriter(options), "xlsx");

      await wb.commit();
      const wb2 = Workbook.create();
      await Workbook.readFile(wb2, TEST_XLSX_FILE_NAME);
      testUtils.checkTestBook(wb2, "xlsx");
    });

    it("hyperlink with query arguments corrupts workbook", async () => {
      const filename = testFilePath("hyperlink-query-args.workbook-writer");
      const wb = new WorkbookWriter({
        filename,
        useStyles: true
      });
      const ws = wb.addWorksheet("Sheet1");

      const hyperlink = {
        text: "Somewhere with query params",
        hyperlink: 'www.somewhere.com?a=1&b=2&c=<>&d="\'"'
      };

      cellSetValue(ws.getCell("A1"), hyperlink);
      ws.commit();

      await wb.commit();

      const wb2 = Workbook.create();
      await Workbook.readFile(wb2, filename);
      const ws2 = Workbook.getWorksheet(wb2, "Sheet1")!;
      expect(Cell.getValue(ws2, "A1")).toEqual(hyperlink);
    });

    it("special cell values produce a valid file", async () => {
      const filename = testFilePath("special-object-keys.workbook-writer");
      const wb = new WorkbookWriter({
        filename,
        useStyles: true,
        useSharedStrings: true
      });
      const ws = wb.addWorksheet("Sheet1");

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

      for (let i = 0, len = specialValues.length; i < len; i++) {
        const value = specialValues[i];
        ws.addRow([value]);
        cellSetValue(ws.getCell(`B${i + 1}`), value);
      }

      await wb.commit();

      const wb2 = Workbook.create();
      await Workbook.readFile(wb2, filename);
      const ws2 = Workbook.getWorksheet(wb2, "Sheet1")!;
      for (let i = 0, len = specialValues.length; i < len; i++) {
        const value = specialValues[i];
        expect(Cell.getValue(ws2, `A${i + 1}`)).toBe(value);
        expect(Cell.getValue(ws2, `B${i + 1}`)).toBe(value);
      }
    });

    it("shared formula", async () => {
      const options = {
        filename: TEST_XLSX_FILE_NAME,
        useStyles: false
      };
      const wb = new WorkbookWriter(options);
      const ws = wb.addWorksheet("Hello");
      cellSetValue(ws.getCell("A1"), {
        formula: "ROW()+COLUMN()",
        ref: "A1:B2",
        result: 2
      });
      cellSetValue(ws.getCell("B1"), { sharedFormula: "A1", result: 3 });
      cellSetValue(ws.getCell("A2"), { sharedFormula: "A1", result: 3 });
      cellSetValue(ws.getCell("B2"), { sharedFormula: "A1", result: 4 });

      ws.commit();
      await wb.commit();
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
      const options = {
        filename: TEST_XLSX_FILE_NAME,
        useStyles: false
      };
      const wb = new WorkbookWriter(options);
      const ws = wb.addWorksheet("Hello");
      cellSetValue(ws.getCell("A1"), 1);
      cellSetValue(ws.getCell("B1"), 1);
      cellSetValue(ws.getCell("A2"), 2);
      cellSetValue(ws.getCell("B2"), 2);
      cellSetValue(ws.getCell("A3"), 3);
      cellSetValue(ws.getCell("B3"), 3);

      ws.autoFilter = "A1:B1";
      ws.commit();

      await wb.commit();
      const wb2 = Workbook.create();
      await Workbook.readFile(wb2, TEST_XLSX_FILE_NAME);
      const ws2 = Workbook.getWorksheet(wb2, "Hello")!;
      expect(ws2.autoFilter).toBe("A1:B1");
    });

    it("Without styles", async () => {
      const options = {
        filename: TEST_XLSX_FILE_NAME,
        useStyles: false
      };
      const wb = testUtils.createTestBook(new WorkbookWriter(options), "xlsx");

      await wb.commit();
      const wb2 = Workbook.create();
      await Workbook.readFile(wb2, TEST_XLSX_FILE_NAME);
      testUtils.checkTestBook(wb2, "xlsx", undefined, {
        checkStyles: false
      });
    });

    it("serializes row styles and columns properly", async () => {
      const options = {
        filename: TEST_XLSX_FILE_NAME,
        useStyles: true
      };
      const wb = new WorkbookWriter(options);
      const ws = wb.addWorksheet("blort");

      const colStyle = {
        font: testUtils.styles.fonts.comicSansUdB16,
        alignment: testUtils.styles.namedAlignments.middleCentre
      };
      ws.columns = [
        { header: "A1", width: 10 },
        { header: "B1", style: colStyle },
        { header: "C1", width: 30 },
        { header: "D1" }
      ];

      rowSetFont(ws.getRow(2), testUtils.styles.fonts.broadwayRedOutline20);

      cellSetValue(ws.getCell("A2"), "A2");
      cellSetValue(ws.getCell("B2"), "B2");
      cellSetValue(ws.getCell("C2"), "C2");
      cellSetValue(ws.getCell("A3"), "A3");
      cellSetValue(ws.getCell("B3"), "B3");
      cellSetValue(ws.getCell("C3"), "C3");

      await wb.commit();
      const wb2 = Workbook.create();
      await Workbook.readFile(wb2, TEST_XLSX_FILE_NAME);
      const ws2 = Workbook.getWorksheet(wb2, "blort")!;
      ["A1", "B1", "C1", "A2", "B2", "C2", "A3", "B3", "C3"].forEach(address => {
        expect(Cell.getValue(ws2, address)).toBe(address);
      });
      expect(Cell.getStyle(ws2, "B1").font).toEqual(testUtils.styles.fonts.comicSansUdB16);
      expect(Cell.getStyle(ws2, "B1").alignment).toEqual(
        testUtils.styles.namedAlignments.middleCentre
      );
      expect(Cell.getStyle(ws2, "A2").font).toEqual(testUtils.styles.fonts.broadwayRedOutline20);
      expect(Cell.getStyle(ws2, "B2").font).toEqual(testUtils.styles.fonts.broadwayRedOutline20);
      expect(Cell.getStyle(ws2, "C2").font).toEqual(testUtils.styles.fonts.broadwayRedOutline20);
      expect(Cell.getStyle(ws2, "B3").font).toEqual(testUtils.styles.fonts.comicSansUdB16);
      expect(Cell.getStyle(ws2, "B3").alignment).toEqual(
        testUtils.styles.namedAlignments.middleCentre
      );

      expect(columnFont(getColumn(ws2, 2))).toEqual(testUtils.styles.fonts.comicSansUdB16);
      expect(columnAlignment(getColumn(ws2, 2))).toEqual(
        testUtils.styles.namedAlignments.middleCentre
      );
      expect(Column.getWidth(ws2, 2)).toBe(9);

      expect(Column.getWidth(ws2, 4)).toBe(undefined);

      expect(rowFont(Worksheet.getRow(ws2, 2))).toEqual(
        testUtils.styles.fonts.broadwayRedOutline20
      );
    });

    it("rich text", async () => {
      const options = {
        filename: TEST_XLSX_FILE_NAME,
        useStyles: true
      };
      const wb = new WorkbookWriter(options);
      const ws = wb.addWorksheet("Hello");

      cellSetValue(ws.getCell("A1"), {
        richText: [
          {
            font: { color: { argb: "FF0000" } },
            text: "red "
          },
          {
            font: { color: { argb: "00FF00" }, bold: true },
            text: " bold green"
          }
        ]
      });

      cellSetValue(ws.getCell("B1"), "plain text");

      ws.commit();
      await wb.commit();
      const wb2 = Workbook.create();
      await Workbook.readFile(wb2, TEST_XLSX_FILE_NAME);
      const ws2 = Workbook.getWorksheet(wb2, "Hello")!;
      expect(Cell.getValue(ws2, "A1")).toEqual({
        richText: [
          {
            font: { color: { argb: "FF0000" } },
            text: "red "
          },
          {
            font: { color: { argb: "00FF00" }, bold: true },
            text: " bold green"
          }
        ]
      });
      expect(Cell.getValue(ws2, "B1")).toBe("plain text");
    });

    it("A lot of sheets", async () => {
      const wb = new WorkbookWriter({
        filename: TEST_XLSX_FILE_NAME
      });
      const numSheets = 90;
      for (let i = 1; i <= numSheets; i++) {
        const ws = wb.addWorksheet(`sheet${i}`);
        cellSetValue(ws.getCell("A1"), i);
      }
      await wb.commit();
      const wb2 = Workbook.create();
      await Workbook.readFile(wb2, TEST_XLSX_FILE_NAME);
      for (let i = 1; i <= numSheets; i++) {
        const ws2 = Workbook.getWorksheet(wb2, `sheet${i}`)!;
        expect(ws2).toBeTruthy();
        expect(Cell.getValue(ws2, "A1")).toBe(i);
      }
    });

    it("addRow", async () => {
      const options = {
        stream: fs.createWriteStream(TEST_XLSX_FILE_NAME, { flags: "w" }),
        useStyles: true,
        useSharedStrings: true
      };
      const workbook = new WorkbookWriter(options);
      const worksheet = workbook.addWorksheet("test");
      const newRow = worksheet.addRow(["hello"]);
      rowCommit(newRow);
      worksheet.commit();
      await workbook.commit();

      // Verify the written file is a valid XLSX
      const wb2 = Workbook.create();
      await Workbook.readFile(wb2, TEST_XLSX_FILE_NAME);
      expect(Cell.getValue(Workbook.getWorksheet(wb2, "test")!, "A1")).toBe("hello");
    });

    it("defined names", async () => {
      const wb = new WorkbookWriter({
        filename: TEST_XLSX_FILE_NAME
      });
      const ws = wb.addWorksheet("blort");
      cellSetValue(ws.getCell("A1"), 5);
      cellSetName(ws.getCell("A1"), "five");

      cellSetValue(ws.getCell("A3"), "drei");
      cellSetName(ws.getCell("A3"), "threes");
      cellSetValue(ws.getCell("B3"), "trois");
      cellSetName(ws.getCell("B3"), "threes");
      cellSetValue(ws.getCell("B3"), "san");
      cellSetName(ws.getCell("B3"), "threes");

      cellSetValue(ws.getCell("E1"), "grün");
      cellSetName(ws.getCell("E1"), "greens");
      cellSetValue(ws.getCell("E2"), "vert");
      cellSetName(ws.getCell("E2"), "greens");
      cellSetValue(ws.getCell("E3"), "verde");
      cellSetName(ws.getCell("E3"), "greens");

      await wb.commit();
      const wb2 = Workbook.create();
      await Workbook.readFile(wb2, TEST_XLSX_FILE_NAME);
      const ws2 = Workbook.getWorksheet(wb2, "blort")!;
      expect(cellName(getCell(ws2, "A1"))).toBe("five");

      expect(cellName(getCell(ws2, "A3"))).toBe("threes");
      expect(cellName(getCell(ws2, "B3"))).toBe("threes");
      expect(cellName(getCell(ws2, "B3"))).toBe("threes");

      expect(cellName(getCell(ws2, "E1"))).toBe("greens");
      expect(cellName(getCell(ws2, "E2"))).toBe("greens");
      expect(cellName(getCell(ws2, "E3"))).toBe("greens");
    });

    it("does not escape special xml characters", async () => {
      const wb = new WorkbookWriter({
        filename: TEST_XLSX_FILE_NAME,
        useSharedStrings: true
      });
      const ws = wb.addWorksheet("blort");
      const xmlCharacters = 'xml characters: & < > "';

      cellSetValue(ws.getCell("A1"), xmlCharacters);

      await wb.commit();
      const wb2 = Workbook.create();
      await Workbook.readFile(wb2, TEST_XLSX_FILE_NAME);
      const ws2 = Workbook.getWorksheet(wb2, "blort")!;
      expect(Cell.getValue(ws2, "A1")).toBe(xmlCharacters);
    });

    it("serializes and deserializes dataValidations", async () => {
      const options = { filename: TEST_XLSX_FILE_NAME };
      const wb = testUtils.createTestBook(new WorkbookWriter(options), "xlsx", ["dataValidations"]);

      await wb.commit();
      const wb2 = Workbook.create();
      await Workbook.readFile(wb2, TEST_XLSX_FILE_NAME);
      testUtils.checkTestBook(wb2, "xlsx", ["dataValidations"]);
    });

    it("with zip compression option", async () => {
      const options = {
        filename: TEST_XLSX_FILE_NAME,
        useStyles: true,
        zip: {
          zlib: { level: 9 }
        }
      };
      const wb = testUtils.createTestBook(new WorkbookWriter(options), "xlsx", ["dataValidations"]);

      await wb.commit();
      const wb2 = Workbook.create();
      await Workbook.readFile(wb2, TEST_XLSX_FILE_NAME);
      testUtils.checkTestBook(wb2, "xlsx", ["dataValidations"]);
    });

    it("writes notes", async () => {
      const options = {
        filename: TEST_XLSX_FILE_NAME
      };
      const wb = new WorkbookWriter(options);
      const ws = wb.addWorksheet("Hello");
      cellSetValue(ws.getCell("B2"), 5);
      cellSetNote(ws.getCell("B2"), "five");

      const note: NoteConfig = {
        texts: [
          {
            font: {
              size: 12,
              color: { argb: "FFFF6600" },
              name: "Calibri",
              scheme: "minor"
            },
            text: "seven"
          }
        ],
        margins: {
          insetmode: "auto",
          inset: [0.13, 0.13, 0.25, 0.25]
        },
        protection: {
          locked: "True",
          lockText: "True"
        },
        editAs: "twoCells"
      };
      cellSetValue(ws.getCell("D2"), 7);
      cellSetNote(ws.getCell("D2"), note);

      await wb.commit();

      const wb2 = Workbook.create();
      await Workbook.readFile(wb2, TEST_XLSX_FILE_NAME);
      const ws2 = Workbook.getWorksheet(wb2, "Hello")!;

      expect(Cell.getValue(ws2, "B2")).toBe(5);
      expect(Cell.getNote(ws2, "B2")).toBe("five");
      expect(Cell.getValue(ws2, "D2")).toBe(7);
      const note2 = Cell.getNote(ws2, "D2") as typeof note;
      expect(note2.texts).toEqual(note.texts);
      expect(note2.margins).toEqual(note.margins);
      expect(note2.protection).toEqual(note.protection);
      expect(note2.editAs).toEqual(note.editAs);
    });

    it("Cell annotation supports setting margins and protection properties", async () => {
      const options = {
        filename: TEST_XLSX_FILE_NAME
      };
      const wb = new WorkbookWriter(options);
      const ws = wb.addWorksheet("Hello");
      cellSetValue(ws.getCell("B2"), 5);
      cellSetNote(ws.getCell("B2"), "five");
      const note: NoteConfig = {
        texts: [
          {
            font: {
              size: 12,
              color: { argb: "FFFF6600" },
              name: "Calibri",
              scheme: "minor"
            },
            text: "seven"
          }
        ],
        margins: {
          insetmode: "custom",
          inset: [0.25, 0.25, 0.35, 0.35]
        },
        protection: {
          locked: "False",
          lockText: "False"
        },
        editAs: "oneCells"
      };
      cellSetValue(ws.getCell("D2"), 7);
      cellSetNote(ws.getCell("D2"), note);

      await wb.commit();

      const wb2 = Workbook.create();
      await Workbook.readFile(wb2, TEST_XLSX_FILE_NAME);
      const ws2 = Workbook.getWorksheet(wb2, "Hello")!;
      expect(Cell.getValue(ws2, "B2")).toBe(5);
      expect(Cell.getNote(ws2, "B2")).toBe("five");

      expect(Cell.getValue(ws2, "D2")).toBe(7);
      const note2 = Cell.getNote(ws2, "D2") as typeof note;
      expect(note2.texts).toEqual(note.texts);
      expect(note2.margins).toEqual(note.margins);
      expect(note2.protection).toEqual(note.protection);
      expect(note2.editAs).toEqual(note.editAs);
    });

    it("with background image", async () => {
      const options = {
        filename: TEST_XLSX_FILE_NAME
      };
      const wb = new WorkbookWriter(options);
      const ws = wb.addWorksheet("Hello");

      const imageId = wb.addImage({
        filename: IMAGE_FILENAME,
        extension: "jpeg"
      });
      cellSetValue(ws.getCell("A1"), "Hello, World!");
      ws.addBackgroundImage(imageId);

      await wb.commit();

      const wb2 = Workbook.create();
      await Workbook.readFile(wb2, TEST_XLSX_FILE_NAME);
      const ws2 = Workbook.getWorksheet(wb2, "Hello")!;

      const backgroundId2 = getBackgroundImageId(ws2);
      const image = getImage(wb2, backgroundId2!);
      const imageData = await fsReadFileAsync(IMAGE_FILENAME);
      expect(Buffer.compare(imageData, image!.buffer!)).toBe(0);
    });

    it("with background image where worksheet is commited in advance", async () => {
      const options = {
        filename: TEST_XLSX_FILE_NAME
      };
      const wb = new WorkbookWriter(options);
      const ws = wb.addWorksheet("Hello");

      const imageId = wb.addImage({
        filename: IMAGE_FILENAME,
        extension: "jpeg"
      });
      cellSetValue(ws.getCell("A1"), "Hello, World!");
      ws.addBackgroundImage(imageId);

      ws.commit();
      await wb.commit();

      const wb2 = Workbook.create();
      await Workbook.readFile(wb2, TEST_XLSX_FILE_NAME);
      const ws2 = Workbook.getWorksheet(wb2, "Hello")!;

      const backgroundId2 = getBackgroundImageId(ws2);
      const image = getImage(wb2, backgroundId2!);
      const imageData = await fsReadFileAsync(IMAGE_FILENAME);
      expect(Buffer.compare(imageData, image!.buffer!)).toBe(0);
    });

    it("with conditional formatting", async () => {
      const options = {
        filename: TEST_XLSX_FILE_NAME,
        useStyles: true,
        useSharedStrings: true
      };
      const wb = testUtils.createTestBook(new WorkbookWriter(options), "xlsx", [
        "conditionalFormatting"
      ]);

      await wb.commit();
      const wb2 = Workbook.create();
      await Workbook.readFile(wb2, TEST_XLSX_FILE_NAME);
      testUtils.checkTestBook(wb2, "xlsx", ["conditionalFormatting"]);
    });

    it("with conditional formatting that contains numFmt (#1814)", async () => {
      const sheet = "conditionalFormatting";
      const options = { filename: TEST_XLSX_FILE_NAME, useStyles: true };

      // generate file with conditional formatting that contains styles with numFmt
      const wb1 = new WorkbookWriter(options);
      const ws1 = wb1.addWorksheet(sheet);
      const cf1 = testUtils.conditionalFormatting.abbreviation;
      ws1.addConditionalFormatting(cf1);
      await wb1.commit();

      // read generated file and extract saved conditional formatting rule
      const wb2 = Workbook.create();
      await Workbook.readFile(wb2, TEST_XLSX_FILE_NAME);
      const ws2 = Workbook.getWorksheet(wb2, sheet)!;
      const [cf2] = ws2.conditionalFormattings;

      // verify that rules from generated file contain styles with valid numFmt
      expect(cf2.rules.length).toBeGreaterThan(0);
      cf2.rules.forEach(rule => {
        const numFmt = rule.style?.numFmt;
        expect(numFmt).toBeDefined();
        // After reading from file, numFmt is always a NumFmt object (not string)
        expect(typeof numFmt).toBe("object");
        if (typeof numFmt === "object" && numFmt !== null) {
          expect(numFmt.id).toBeTypeOf("number");
          expect(numFmt.formatCode).toBeTypeOf("string");
        }
      });
    });
  });

  // ==========================================================================
  // Regression tests for Issue #88 (memory leak) and Issue #89 (RangeError)
  // ==========================================================================

  describe("Streaming memory behavior", () => {
    /** Write to a WorkbookWriter that streams to an in-memory buffer, then read it back. */
    async function writeAndReadBack(
      options: Record<string, any>,
      populate: (ws: any) => void
    ): Promise<any> {
      const { PassThrough } = await import("@stream");
      const output = new PassThrough();
      const chunks: Uint8Array[] = [];
      output.on("data", (chunk: Uint8Array) => chunks.push(chunk));

      const workbook = new WorkbookWriter({
        stream: output,
        useSharedStrings: false,
        ...options
      });
      const worksheet = workbook.addWorksheet("Sheet 1");
      populate(worksheet);
      await workbook.commit();

      const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
      const xlsxBuffer = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        xlsxBuffer.set(chunk, offset);
        offset += chunk.length;
      }

      const readBack = Workbook.create();
      await Workbook.read(readBack, xlsxBuffer);
      return Workbook.getWorksheet(readBack, "Sheet 1");
    }

    it("does not accumulate worksheet data in memory with trueStreaming (#88)", async () => {
      const cellValue = "abcdefghij".repeat(40); // 400 chars per cell
      const ws = await writeAndReadBack({ trueStreaming: true }, worksheet => {
        for (let i = 0; i < 5000; i++) {
          const row = Worksheet.getRow(worksheet, i + 1);
          for (let c = 1; c <= 9; c++) {
            cellSetValue(rowGetCell(row, c), cellValue);
          }
          rowCommit(row);
        }
      });

      expect(Worksheet.rowCount(ws)).toBe(5000);
      expect(cellGetValue(getCell(ws, "A1"))).toBe(cellValue);
    }, 30000);

    it("does not accumulate worksheet data in memory with default streaming (#88)", async () => {
      const ws = await writeAndReadBack({}, worksheet => {
        for (let i = 0; i < 5000; i++) {
          const row = Worksheet.getRow(worksheet, i + 1);
          for (let c = 1; c <= 9; c++) {
            cellSetValue(rowGetCell(row, c), "abcdefghij".repeat(40));
          }
          rowCommit(row);
        }
      });

      expect(Worksheet.rowCount(ws)).toBe(5000);
    }, 30000);

    it("handles very large cell values in trueStreaming mode without crashing (#89)", async () => {
      const largeCellValue = "x".repeat(36_000); // ~36KB per cell × 9 cells = ~324KB per row
      const ws = await writeAndReadBack({ trueStreaming: true }, worksheet => {
        for (let i = 0; i < 100; i++) {
          const row = Worksheet.getRow(worksheet, i + 1);
          for (let c = 1; c <= 9; c++) {
            cellSetValue(rowGetCell(row, c), largeCellValue);
          }
          rowCommit(row);
        }
      });

      expect(Worksheet.rowCount(ws)).toBe(100);
      expect(cellGetValue(getCell(ws, "A1"))).toBe(largeCellValue);
    }, 30000);

    it("maintains constant memory during streaming with large row count (#88)", async () => {
      const { PassThrough } = await import("@stream");
      const output = new PassThrough();
      const chunks: Uint8Array[] = [];
      output.on("data", (chunk: Uint8Array) => chunks.push(chunk));

      const workbook = new WorkbookWriter({
        stream: output,
        useSharedStrings: false,
        trueStreaming: true
      });
      const worksheet = workbook.addWorksheet("Sheet 1");

      const bigValue = "abcdefghij".repeat(40); // 400 chars per cell

      // Warm up — write initial rows to stabilize JIT, GC, and internal structures
      for (let i = 0; i < 2000; i++) {
        const row = worksheet.getRow(i + 1);
        for (let c = 1; c <= 9; c++) {
          cellSetValue(rowGetCell(row, c), bigValue);
        }
        rowCommit(row);
      }
      if (global.gc) {
        global.gc();
      }
      const baselineRSS = process.memoryUsage().rss;

      // Steady-state — write many more rows
      for (let i = 2000; i < 20_000; i++) {
        const row = worksheet.getRow(i + 1);
        for (let c = 1; c <= 9; c++) {
          cellSetValue(rowGetCell(row, c), bigValue);
        }
        rowCommit(row);
      }
      if (global.gc) {
        global.gc();
      }
      const finalRSS = process.memoryUsage().rss;
      const growthMB = (finalRSS - baselineRSS) / 1024 / 1024;

      await workbook.commit();

      // Verify the file is valid by reading it back
      const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
      expect(totalLength).toBeGreaterThan(0);

      const xlsxBuffer = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        xlsxBuffer.set(chunk, offset);
        offset += chunk.length;
      }

      const readBack = Workbook.create();
      await Workbook.read(readBack, xlsxBuffer);
      const ws = Workbook.getWorksheet(readBack, "Sheet 1")!;
      expect(Worksheet.rowCount(ws!)).toBe(20_000);
      expect(Cell.getValue(ws!, "A1")).toBe(bigValue);
      expect(Cell.getValue(ws!, "I20000")).toBe(bigValue);

      // Memory assertion: 18K rows × 9 cells × 400 chars should NOT cause
      // significant memory growth when streaming. Before the fix, this would
      // accumulate ~300MB+ in push chain closures. With the fix, growth should
      // be minimal (< 100MB allows for GC timing, V8 overhead, and output buffer).
      expect(growthMB).toBeLessThan(100);
    }, 30000);

    it("correctly handles small worksheets via pushSync smart-store path (#88)", async () => {
      // Small worksheets (< 16KB total) exercise the smart-store sampling path
      // in pushSync where data is buffered in _pendingChunks before compression
      // mode is decided. This verifies the sampling → decision → flush cycle.
      const ws = await writeAndReadBack({ trueStreaming: true }, worksheet => {
        for (let i = 0; i < 5; i++) {
          const row = Worksheet.getRow(worksheet, i + 1);
          cellSetValue(rowGetCell(row, 1), "tiny");
          rowCommit(row);
        }
      });

      expect(Worksheet.rowCount(ws)).toBe(5);
      expect(cellGetValue(getCell(ws, "A1"))).toBe("tiny");
      expect(cellGetValue(getCell(ws, "A5"))).toBe("tiny");
    });
  });

  // ==========================================================================
  // WorksheetWriter.addImage tests (Issue #108)
  // ==========================================================================

  describe("WorksheetWriter.addImage", () => {
    it("stores embedded image with string range (two-cell anchor)", async () => {
      const options = {
        filename: TEST_XLSX_FILE_NAME
      };
      const wb = new WorkbookWriter(options);
      const ws = wb.addWorksheet("Hello");

      const imageId = wb.addImage({
        filename: IMAGE_FILENAME,
        extension: "png"
      });

      cellSetValue(ws.getCell("A1"), "Hello, World!");
      ws.addImage(imageId, "C3:E6");

      await wb.commit();

      // Read back and verify
      const wb2 = Workbook.create();
      await Workbook.readFile(wb2, TEST_XLSX_FILE_NAME);
      const ws2 = Workbook.getWorksheet(wb2, "Hello")!;
      expect(ws2).toBeDefined();

      const images = getImages(ws2);
      expect(images.length).toBe(1);

      const imageDesc = images[0];
      // String range "C3:E6" => tl: col 2, row 2 (with offset -1: nativeCol=2, nativeRow=2)
      expect(imageDesc.range!.tl.nativeCol).toBe(2);
      expect(imageDesc.range!.tl.nativeRow).toBe(2);
      expect(imageDesc.range!.br!.nativeCol).toBe(5);
      expect(imageDesc.range!.br!.nativeRow).toBe(6);

      const imageData = await fsReadFileAsync(IMAGE_FILENAME);
      const image = getImage(wb2, imageDesc.imageId!);
      expect(Buffer.compare(imageData, image!.buffer!)).toBe(0);
    });

    it("stores embedded image with object range (two-cell anchor)", async () => {
      const options = {
        filename: TEST_XLSX_FILE_NAME
      };
      const wb = new WorkbookWriter(options);
      const ws = wb.addWorksheet("Hello");

      const imageId = wb.addImage({
        filename: IMAGE_FILENAME,
        extension: "png"
      });

      ws.addImage(imageId, {
        tl: { col: 0.1125, row: 0.4 },
        br: { col: 2.101046875, row: 3.4 },
        editAs: "oneCell"
      });

      await wb.commit();

      const wb2 = Workbook.create();
      await Workbook.readFile(wb2, TEST_XLSX_FILE_NAME);
      const ws2 = Workbook.getWorksheet(wb2, "Hello")!;

      const images = getImages(ws2);
      expect(images.length).toBe(1);

      const imageDesc = images[0];
      expect(imageDesc.range!.editAs).toBe("oneCell");

      const imageData = await fsReadFileAsync(IMAGE_FILENAME);
      const image = getImage(wb2, imageDesc.imageId!);
      expect(Buffer.compare(imageData, image!.buffer!)).toBe(0);
    });

    it("stores embedded image with one-cell anchor (ext)", async () => {
      const options = {
        filename: TEST_XLSX_FILE_NAME
      };
      const wb = new WorkbookWriter(options);
      const ws = wb.addWorksheet("Hello");

      const imageId = wb.addImage({
        filename: IMAGE_FILENAME,
        extension: "png"
      });

      ws.addImage(imageId, {
        tl: { col: 0.1125, row: 0.4 },
        ext: { width: 100, height: 100 },
        editAs: "oneCell"
      });

      await wb.commit();

      const wb2 = Workbook.create();
      await Workbook.readFile(wb2, TEST_XLSX_FILE_NAME);
      const ws2 = Workbook.getWorksheet(wb2, "Hello")!;

      const images = getImages(ws2);
      expect(images.length).toBe(1);

      const imageDesc = images[0];
      expect(imageDesc.range!.editAs).toBe("oneCell");
      expect(imageDesc.range!.ext!.width).toBe(100);
      expect(imageDesc.range!.ext!.height).toBe(100);

      const imageData = await fsReadFileAsync(IMAGE_FILENAME);
      const image = getImage(wb2, imageDesc.imageId!);
      expect(Buffer.compare(imageData, image!.buffer!)).toBe(0);
    });

    it("stores embedded image with hyperlinks", async () => {
      const options = {
        filename: TEST_XLSX_FILE_NAME
      };
      const wb = new WorkbookWriter(options);
      const ws = wb.addWorksheet("Hello");

      const imageId = wb.addImage({
        filename: IMAGE_FILENAME,
        extension: "png"
      });

      ws.addImage(imageId, {
        tl: { col: 0.1125, row: 0.4 },
        ext: { width: 100, height: 100 },
        editAs: "absolute",
        hyperlinks: {
          hyperlink: "http://www.somewhere.com",
          tooltip: "www.somewhere.com"
        }
      });

      await wb.commit();

      const wb2 = Workbook.create();
      await Workbook.readFile(wb2, TEST_XLSX_FILE_NAME);
      const ws2 = Workbook.getWorksheet(wb2, "Hello")!;

      const images = getImages(ws2);
      expect(images.length).toBe(1);

      const imageDesc = images[0];
      // `"oneCell"`, because a `tl` + `ext` range *is* a one-cell anchor whatever `editAs` was asked for — see
      // the same assertion in `core/__tests__/workbook-images.integration.node.test.ts` for why the previous
      // `"absolute"` depended on writing an attribute `CT_OneCellAnchor` does not define.
      expect(imageDesc.range!.editAs).toBe("oneCell");
      expect(imageDesc.range!.hyperlinks).toEqual({
        hyperlink: "http://www.somewhere.com",
        tooltip: "www.somewhere.com"
      });

      const imageData = await fsReadFileAsync(IMAGE_FILENAME);
      const image = getImage(wb2, imageDesc.imageId!);
      expect(Buffer.compare(imageData, image!.buffer!)).toBe(0);
    });

    it("stores multiple images on the same worksheet", async () => {
      const options = {
        filename: TEST_XLSX_FILE_NAME
      };
      const wb = new WorkbookWriter(options);
      const ws = wb.addWorksheet("Hello");

      const imageId1 = wb.addImage({
        filename: IMAGE_FILENAME,
        extension: "png"
      });
      const imageId2 = wb.addImage({
        filename: IMAGE_FILENAME,
        extension: "jpeg"
      });

      ws.addImage(imageId1, {
        tl: { col: 0.1125, row: 0.4 },
        ext: { width: 100, height: 100 }
      });
      ws.addImage(imageId2, {
        tl: { col: 0.1125, row: 0.4 },
        br: { col: 2.101046875, row: 3.4 },
        editAs: "oneCell"
      });

      await wb.commit();

      const wb2 = Workbook.create();
      await Workbook.readFile(wb2, TEST_XLSX_FILE_NAME);
      const ws2 = Workbook.getWorksheet(wb2, "Hello")!;

      const images = getImages(ws2);
      expect(images.length).toBe(2);

      const imageData = await fsReadFileAsync(IMAGE_FILENAME);
      const image1 = getImage(wb2, images[0].imageId!);
      const image2 = getImage(wb2, images[1].imageId!);
      expect(Buffer.compare(imageData, image1!.buffer!)).toBe(0);
      expect(Buffer.compare(imageData, image2!.buffer!)).toBe(0);
    });

    it("stores images on multiple worksheets", async () => {
      const options = {
        filename: TEST_XLSX_FILE_NAME
      };
      const wb = new WorkbookWriter(options);

      const imageId = wb.addImage({
        filename: IMAGE_FILENAME,
        extension: "png"
      });

      const ws1 = wb.addWorksheet("Sheet1");
      cellSetValue(ws1.getCell("A1"), "Sheet 1");
      ws1.addImage(imageId, "A1:B2");

      const ws2 = wb.addWorksheet("Sheet2");
      cellSetValue(ws2.getCell("A1"), "Sheet 2");
      ws2.addImage(imageId, "C3:D4");

      await wb.commit();

      const wb2 = Workbook.create();
      await Workbook.readFile(wb2, TEST_XLSX_FILE_NAME);

      const ws2Sheet1 = Workbook.getWorksheet(wb2, "Sheet1")!;
      const ws2Sheet2 = Workbook.getWorksheet(wb2, "Sheet2")!;

      expect(getImages(ws2Sheet1).length).toBe(1);
      expect(getImages(ws2Sheet2).length).toBe(1);

      const imageData = await fsReadFileAsync(IMAGE_FILENAME);
      const img1 = getImage(wb2, getImages(ws2Sheet1)[0].imageId!);
      const img2 = getImage(wb2, getImages(ws2Sheet2)[0].imageId!);
      expect(Buffer.compare(imageData, img1!.buffer!)).toBe(0);
      expect(Buffer.compare(imageData, img2!.buffer!)).toBe(0);
    });

    it("works when worksheet is committed before workbook", async () => {
      const options = {
        filename: TEST_XLSX_FILE_NAME
      };
      const wb = new WorkbookWriter(options);
      const ws = wb.addWorksheet("Hello");

      const imageId = wb.addImage({
        filename: IMAGE_FILENAME,
        extension: "png"
      });

      cellSetValue(ws.getCell("A1"), "Hello, World!");
      ws.addImage(imageId, "C3:E6");
      ws.commit();

      await wb.commit();

      const wb2 = Workbook.create();
      await Workbook.readFile(wb2, TEST_XLSX_FILE_NAME);
      const ws2 = Workbook.getWorksheet(wb2, "Hello")!;

      const images = getImages(ws2);
      expect(images.length).toBe(1);

      const imageData = await fsReadFileAsync(IMAGE_FILENAME);
      const image = getImage(wb2, images[0].imageId!);
      expect(Buffer.compare(imageData, image!.buffer!)).toBe(0);
    });

    it("works with both background and embedded images", async () => {
      const options = {
        filename: TEST_XLSX_FILE_NAME
      };
      const wb = new WorkbookWriter(options);
      const ws = wb.addWorksheet("Hello");

      const imageId = wb.addImage({
        filename: IMAGE_FILENAME,
        extension: "png"
      });

      cellSetValue(ws.getCell("A1"), "Hello, World!");
      ws.addBackgroundImage(imageId);
      ws.addImage(imageId, "C3:E6");

      await wb.commit();

      const wb2 = Workbook.create();
      await Workbook.readFile(wb2, TEST_XLSX_FILE_NAME);
      const ws2 = Workbook.getWorksheet(wb2, "Hello")!;

      // Check background image
      const backgroundId = getBackgroundImageId(ws2);
      expect(backgroundId).toBeDefined();

      // Check embedded image
      const images = getImages(ws2);
      expect(images.length).toBe(1);

      const imageData = await fsReadFileAsync(IMAGE_FILENAME);
      const image = getImage(wb2, images[0].imageId!);
      expect(Buffer.compare(imageData, image!.buffer!)).toBe(0);
    });

    it("works with base64 image data", async () => {
      const imageData = await fsReadFileAsync(IMAGE_FILENAME);
      const base64 = imageData.toString("base64");

      const options = {
        filename: TEST_XLSX_FILE_NAME
      };
      const wb = new WorkbookWriter(options);
      const ws = wb.addWorksheet("Hello");

      const imageId = wb.addImage({
        base64,
        extension: "png"
      });

      ws.addImage(imageId, "A1:B2");

      await wb.commit();

      const wb2 = Workbook.create();
      await Workbook.readFile(wb2, TEST_XLSX_FILE_NAME);
      const ws2 = Workbook.getWorksheet(wb2, "Hello")!;

      const images = getImages(ws2);
      expect(images.length).toBe(1);

      const image = getImage(wb2, images[0].imageId!);
      expect(Buffer.compare(imageData, image!.buffer!)).toBe(0);
    });

    it("works with buffer image data", async () => {
      const imageData = await fsReadFileAsync(IMAGE_FILENAME);

      const options = {
        filename: TEST_XLSX_FILE_NAME
      };
      const wb = new WorkbookWriter(options);
      const ws = wb.addWorksheet("Hello");

      const imageId = wb.addImage({
        buffer: imageData,
        extension: "png"
      });

      ws.addImage(imageId, "A1:B2");

      await wb.commit();

      const wb2 = Workbook.create();
      await Workbook.readFile(wb2, TEST_XLSX_FILE_NAME);
      const ws2 = Workbook.getWorksheet(wb2, "Hello")!;

      const images = getImages(ws2);
      expect(images.length).toBe(1);

      const image = getImage(wb2, images[0].imageId!);
      expect(Buffer.compare(imageData, image!.buffer!)).toBe(0);
    });

    it("deduplicates drawing rels for same imageId used twice", async () => {
      const options = {
        filename: TEST_XLSX_FILE_NAME
      };
      const wb = new WorkbookWriter(options);
      const ws = wb.addWorksheet("Hello");

      const imageId = wb.addImage({
        filename: IMAGE_FILENAME,
        extension: "png"
      });

      // Add the same image twice with different positions
      ws.addImage(imageId, "A1:B2");
      ws.addImage(imageId, "D4:E5");

      await wb.commit();

      const wb2 = Workbook.create();
      await Workbook.readFile(wb2, TEST_XLSX_FILE_NAME);
      const ws2 = Workbook.getWorksheet(wb2, "Hello")!;

      const images = getImages(ws2);
      expect(images.length).toBe(2);

      const imageData = await fsReadFileAsync(IMAGE_FILENAME);
      for (const img of images) {
        const imgBuffer = getImage(wb2, img.imageId!);
        expect(Buffer.compare(imageData, imgBuffer!.buffer!)).toBe(0);
      }
    });

    it("works on a worksheet with only images and no cell data", async () => {
      const options = {
        filename: TEST_XLSX_FILE_NAME
      };
      const wb = new WorkbookWriter(options);
      const ws = wb.addWorksheet("Empty");

      const imageId = wb.addImage({
        filename: IMAGE_FILENAME,
        extension: "png"
      });

      // No cell data — only an image
      ws.addImage(imageId, "A1:B2");

      await wb.commit();

      const wb2 = Workbook.create();
      await Workbook.readFile(wb2, TEST_XLSX_FILE_NAME);
      const ws2 = Workbook.getWorksheet(wb2, "Empty")!;
      expect(ws2).toBeDefined();

      const images = getImages(ws2);
      expect(images.length).toBe(1);

      const imageData = await fsReadFileAsync(IMAGE_FILENAME);
      const image = getImage(wb2, images[0].imageId!);
      expect(Buffer.compare(imageData, image!.buffer!)).toBe(0);
    });

    it("works with native anchor coordinates (nativeCol/nativeRow/nativeColOff/nativeRowOff)", async () => {
      const options = {
        filename: TEST_XLSX_FILE_NAME
      };
      const wb = new WorkbookWriter(options);
      const ws = wb.addWorksheet("Hello");

      const imageId = wb.addImage({
        filename: IMAGE_FILENAME,
        extension: "png"
      });

      ws.addImage(imageId, {
        tl: {
          nativeCol: 1,
          nativeRow: 2,
          nativeColOff: 100000,
          nativeRowOff: 50000
        } as any,
        br: {
          nativeCol: 3,
          nativeRow: 5,
          nativeColOff: 200000,
          nativeRowOff: 80000
        } as any,
        editAs: "twoCell"
      });

      await wb.commit();

      const wb2 = Workbook.create();
      await Workbook.readFile(wb2, TEST_XLSX_FILE_NAME);
      const ws2 = Workbook.getWorksheet(wb2, "Hello")!;

      const images = getImages(ws2);
      expect(images.length).toBe(1);

      const imageDesc = images[0];
      expect(imageDesc.range!.tl.nativeCol).toBe(1);
      expect(imageDesc.range!.tl.nativeRow).toBe(2);
      expect(imageDesc.range!.tl.nativeColOff).toBe(100000);
      expect(imageDesc.range!.tl.nativeRowOff).toBe(50000);
      expect(imageDesc.range!.br!.nativeCol).toBe(3);
      expect(imageDesc.range!.br!.nativeRow).toBe(5);
    });

    it("works via stream output (non-filename)", async () => {
      const { PassThrough } = await import("@stream");
      const output = new PassThrough();
      const chunks: Uint8Array[] = [];
      output.on("data", (chunk: Uint8Array) => chunks.push(chunk));

      const imageData = await fsReadFileAsync(IMAGE_FILENAME);

      const wb = new WorkbookWriter({ stream: output });
      const ws = wb.addWorksheet("Hello");

      const imageId = wb.addImage({
        buffer: imageData,
        extension: "png"
      });

      cellSetValue(ws.getCell("A1"), "Hello");
      ws.addImage(imageId, "C3:E6");

      await wb.commit();

      const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
      const xlsxBuffer = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        xlsxBuffer.set(chunk, offset);
        offset += chunk.length;
      }

      const wb2 = Workbook.create();
      await Workbook.read(wb2, xlsxBuffer);
      const ws2 = Workbook.getWorksheet(wb2, "Hello")!;

      expect(Cell.getValue(ws2, "A1")).toBe("Hello");
      const images = getImages(ws2);
      expect(images.length).toBe(1);

      const image = getImage(wb2, images[0].imageId!);
      expect(Buffer.compare(imageData, image!.buffer!)).toBe(0);
    });

    it("getImages() returns added images before commit", () => {
      const wb = new WorkbookWriter({ filename: TEST_XLSX_FILE_NAME });
      const ws = wb.addWorksheet("Hello");

      const imageId = wb.addImage({
        filename: IMAGE_FILENAME,
        extension: "png"
      });

      expect(ws.getImages().length).toBe(0);

      ws.addImage(imageId, "A1:B2");
      expect(ws.getImages().length).toBe(1);
      expect(ws.getImages()[0].type).toBe("image");
      expect(ws.getImages()[0].imageId).toBe(String(imageId));

      ws.addImage(imageId, "C3:D4");
      expect(ws.getImages().length).toBe(2);
    });

    it("throws error for invalid single-cell string range", () => {
      const wb = new WorkbookWriter({ filename: TEST_XLSX_FILE_NAME });
      const ws = wb.addWorksheet("Hello");

      const imageId = wb.addImage({
        filename: IMAGE_FILENAME,
        extension: "png"
      });

      // "A1" is a single cell, not a range — should throw
      expect(() => ws.addImage(imageId, "A1")).toThrow('Invalid image range: "A1"');
    });

    it("addBackgroundImage accepts string imageId", async () => {
      const wb = new WorkbookWriter({ filename: TEST_XLSX_FILE_NAME });
      const ws = wb.addWorksheet("Hello");

      const imageId = wb.addImage({
        filename: IMAGE_FILENAME,
        extension: "jpeg"
      });

      cellSetValue(ws.getCell("A1"), "Hello");
      // Pass imageId as string (same as Worksheet API allows)
      ws.addBackgroundImage(String(imageId));

      await wb.commit();

      const wb2 = Workbook.create();
      await Workbook.readFile(wb2, TEST_XLSX_FILE_NAME);
      const ws2 = Workbook.getWorksheet(wb2, "Hello")!;

      const backgroundId = getBackgroundImageId(ws2);
      expect(backgroundId).toBeDefined();

      const imageData = await fsReadFileAsync(IMAGE_FILENAME);
      const image = getImage(wb2, backgroundId!);
      expect(Buffer.compare(imageData, image!.buffer!)).toBe(0);
    });

    it("works when individual rows are committed before addImage (string range)", async () => {
      const wb = new WorkbookWriter({ filename: TEST_XLSX_FILE_NAME });
      const ws = wb.addWorksheet("Hello");

      const imageId = wb.addImage({
        filename: IMAGE_FILENAME,
        extension: "png"
      });

      // Commit rows individually first — this advances _rowZero
      const row1 = ws.getRow(1);
      cellSetValue(rowGetCell(row1, 1), "data1");
      rowCommit(row1);
      const row2 = ws.getRow(2);
      cellSetValue(rowGetCell(row2, 1), "data2");
      rowCommit(row2);

      // Should NOT throw RowOutOfBoundsError even though rows 1-2 are committed
      ws.addImage(imageId, "A1:C3");

      await wb.commit();

      const wb2 = Workbook.create();
      await Workbook.readFile(wb2, TEST_XLSX_FILE_NAME);
      const ws2 = Workbook.getWorksheet(wb2, "Hello")!;

      expect(getImages(ws2).length).toBe(1);

      const imageData = await fsReadFileAsync(IMAGE_FILENAME);
      const image = getImage(wb2, getImages(ws2)[0].imageId!);
      expect(Buffer.compare(imageData, image!.buffer!)).toBe(0);
    });

    it("works when all rows are committed before addImage via addRow pattern", async () => {
      const wb = new WorkbookWriter({ filename: TEST_XLSX_FILE_NAME });
      const ws = wb.addWorksheet("Hello");

      const imageId = wb.addImage({
        filename: IMAGE_FILENAME,
        extension: "png"
      });

      // Typical streaming pattern: addRow auto-commits previous rows
      for (let i = 1; i <= 10; i++) {
        rowCommit(ws.addRow([`row ${i}`]));
      }

      // Add image referencing rows that are all committed
      ws.addImage(imageId, "B2:D8");

      await wb.commit();

      const wb2 = Workbook.create();
      await Workbook.readFile(wb2, TEST_XLSX_FILE_NAME);
      const ws2 = Workbook.getWorksheet(wb2, "Hello")!;

      expect(getImages(ws2).length).toBe(1);
      expect(Cell.getValue(ws2, "A1")).toBe("row 1");
      expect(Cell.getValue(ws2, "A10")).toBe("row 10");
    });
  });
});

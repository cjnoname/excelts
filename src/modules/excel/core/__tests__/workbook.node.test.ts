import { testUtils } from "@excel/__tests__/shared";
import {
  definedNamesAdd,
  definedNamesAddFormula,
  definedNamesGetRanges
} from "@excel/core/defined-names";
import { ValueType } from "@excel/core/enums";
import { rowFont, rowNumFmt, rowSetFont, rowSetNumFmt, rowValues } from "@excel/core/row";
import {
  clearThemes,
  getDefaultFont,
  getDefinedNames,
  getImage,
  getWorkbookModel,
  getWorksheets,
  getXlsxIo,
  protectWorkbook,
  setDefaultFont,
  setWorkbookModel,
  unprotectWorkbook
} from "@excel/core/workbook";
import { addWorkbookImage } from "@excel/core/workbook-core";
import { getSheetName, setSheetName } from "@excel/core/worksheet";
import { Cell, Workbook, Worksheet } from "@excel/index";
import { describe, it, expect } from "vitest";

// =============================================================================
// Tests
// =============================================================================

describe("Workbook", () => {
  // ===========================================================================
  // Worksheet Access
  // ===========================================================================

  describe("worksheet access", () => {
    it("returns undefined for non-existent sheet by name", () => {
      const wb = Workbook.create();
      Workbook.addWorksheet(wb, "first");
      expect(Workbook.getWorksheet(wb, "w00t")).toBeUndefined();
    });

    it("returns undefined for sheet 0", () => {
      const wb = Workbook.create();
      Workbook.addWorksheet(wb, "first");
      expect(Workbook.getWorksheet(wb, 0)).toBeUndefined();
    });

    it("returns correct sheet by id after accessing worksheets or eachSheet", () => {
      const wb = Workbook.create();
      const sheet = Workbook.addWorksheet(wb, "first");

      Workbook.eachSheet(wb, () => {});
      const numSheets = getWorksheets(wb).length;

      expect(numSheets).toBe(1);
      expect(Workbook.getWorksheet(wb, 0)).toBeUndefined();
      expect(Workbook.getWorksheet(wb, 1) === sheet).toBe(true);
    });

    it("returns first worksheet when called with no arguments", () => {
      const wb = Workbook.create();
      const ws1 = Workbook.addWorksheet(wb, "first");
      Workbook.addWorksheet(wb, "second");

      expect(Workbook.getWorksheet(wb)).toBe(ws1);
    });

    it("returns worksheet by name", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "target");
      Workbook.addWorksheet(wb, "other");

      expect(Workbook.getWorksheet(wb, "target")).toBe(ws);
    });

    it("returns worksheet by name case-insensitively", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "MySheet");

      expect(Workbook.getWorksheet(wb, "MySheet")).toBe(ws);
      expect(Workbook.getWorksheet(wb, "mysheet")).toBe(ws);
      expect(Workbook.getWorksheet(wb, "MYSHEET")).toBe(ws);
      expect(Workbook.getWorksheet(wb, "mySheet")).toBe(ws);
    });

    it("getWorksheet finds sheet that addWorksheet would reject as duplicate", () => {
      const wb = Workbook.create();
      Workbook.addWorksheet(wb, "Sheet");

      // getWorksheet should find the existing sheet with different casing,
      // consistent with addWorksheet which would reject "sheet" as a duplicate
      const existing = Workbook.getWorksheet(wb, "sheet")!;
      expect(existing).toBeDefined();
      expect(getSheetName(existing!)).toBe("Sheet");
    });

    it("returns worksheet by numeric id", () => {
      const wb = Workbook.create();
      const ws1 = Workbook.addWorksheet(wb, "first");
      const ws2 = Workbook.addWorksheet(wb, "second");

      expect(Workbook.getWorksheet(wb, ws1.id)).toBe(ws1);
      expect(Workbook.getWorksheet(wb, ws2.id)).toBe(ws2);
    });
  });

  // ===========================================================================
  // Worksheet Management
  // ===========================================================================

  describe("worksheet management", () => {
    it("removeWorksheet by id", () => {
      const wb = Workbook.create();
      Workbook.addWorksheet(wb, "first");
      const ws2 = Workbook.addWorksheet(wb, "second");
      Workbook.addWorksheet(wb, "third");

      expect(getWorksheets(wb).length).toBe(3);

      Workbook.removeWorksheet(wb, ws2.id);
      expect(getWorksheets(wb).length).toBe(2);
      expect(Workbook.getWorksheet(wb, "second")).toBeUndefined();
      expect(Workbook.getWorksheet(wb, "first")).toBeDefined();
      expect(Workbook.getWorksheet(wb, "third")).toBeDefined();
    });

    it("removeWorksheet by name (string id)", () => {
      const wb = Workbook.create();
      Workbook.addWorksheet(wb, "alpha");
      Workbook.addWorksheet(wb, "beta");

      Workbook.removeWorksheet(wb, "alpha");
      expect(getWorksheets(wb).length).toBe(1);
      expect(Workbook.getWorksheet(wb, "alpha")).toBeUndefined();
      expect(Workbook.getWorksheet(wb, "beta")).toBeDefined();
    });

    it("removeWorksheet by name case-insensitively", () => {
      const wb = Workbook.create();
      Workbook.addWorksheet(wb, "Alpha");
      Workbook.addWorksheet(wb, "Beta");

      Workbook.removeWorksheet(wb, "alpha");
      expect(getWorksheets(wb).length).toBe(1);
      expect(Workbook.getWorksheet(wb, "Alpha")).toBeUndefined();
      expect(Workbook.getWorksheet(wb, "Beta")).toBeDefined();
    });

    it("worksheets getter returns sheets in order", () => {
      const wb = Workbook.create();
      Workbook.addWorksheet(wb, "A");
      Workbook.addWorksheet(wb, "B");
      Workbook.addWorksheet(wb, "C");

      const names = getWorksheets(wb).map(ws => getSheetName(ws));
      expect(names).toEqual(["A", "B", "C"]);
    });

    it("eachSheet iterates all worksheets", () => {
      const wb = Workbook.create();
      Workbook.addWorksheet(wb, "one");
      Workbook.addWorksheet(wb, "two");
      Workbook.addWorksheet(wb, "three");

      const names: string[] = [];
      Workbook.eachSheet(wb, ws => names.push(getSheetName(ws)));
      expect(names).toEqual(["one", "two", "three"]);
    });

    it("addWorksheet rejects case-insensitive duplicate names", () => {
      const wb = Workbook.create();
      Workbook.addWorksheet(wb, "Sheet");

      expect(() => Workbook.addWorksheet(wb, "sheet")).toThrow(/already exists/i);
      expect(() => Workbook.addWorksheet(wb, "SHEET")).toThrow(/already exists/i);
    });

    it("allows renaming a worksheet to a different casing of the same name", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet");

      // Renaming "Sheet" to "SHEET" should not throw -- it's the same sheet
      setSheetName(ws, "SHEET");
      expect(getSheetName(ws)).toBe("SHEET");

      setSheetName(ws, "sheet");
      expect(getSheetName(ws)).toBe("sheet");
    });

    it("renaming a worksheet still rejects duplicate names with other sheets", () => {
      const wb = Workbook.create();
      Workbook.addWorksheet(wb, "Alpha");
      const ws2 = Workbook.addWorksheet(wb, "Beta");

      // Renaming Beta to "alpha" (case-insensitive match with Alpha) should throw
      expect(() => {
        setSheetName(ws2, "alpha");
      }).toThrow(/already exists/i);
    });
  });

  // ===========================================================================
  // Cell Types & Values
  // ===========================================================================

  describe("cell types", () => {
    it("stores shared string values properly", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "blort");

      Cell.setValue(ws, "A1", "Hello, World!");
      Cell.setValue(ws, "A2", "Hello");
      Cell.setValue(ws, "B2", "World");
      Cell.setValue(ws, "C2", {
        formula: 'CONCATENATE(A2, ", ", B2, "!")',
        result: "Hello, World!"
      });
      Cell.setValue(ws, "A3", `${["Hello", "World"].join(", ")}!`);

      // A1 and A3 should reference the same string object
      expect(Cell.getValue(ws, "A1")).toBe(Cell.getValue(ws, "A3"));
      // A1 and C2 result should share the same string
      expect(Cell.getValue(ws, "A1")).toBe(Cell.getResult(ws, "C2"));
    });

    it("assigns cell types properly", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "blort");

      Cell.setValue(ws, "A1", 7);
      Cell.setValue(ws, "B1", "Hello, World!");
      Cell.setValue(ws, "C1", 3.14);
      Cell.setValue(ws, "D1", new Date());
      Cell.setValue(ws, "E1", {
        text: "www.google.com",
        hyperlink: "http://www.google.com"
      });
      Cell.setValue(ws, "A2", { formula: "A1", result: 7 });
      Cell.setValue(ws, "B2", {
        formula: 'CONCATENATE("Hello", ", ", "World!")',
        result: "Hello, World!"
      });
      Cell.setValue(ws, "C2", { formula: "D1", result: new Date() });

      expect(Cell.getType(ws, "A1")).toBe(ValueType.Number);
      expect(Cell.getType(ws, "B1")).toBe(ValueType.String);
      expect(Cell.getType(ws, "C1")).toBe(ValueType.Number);
      expect(Cell.getType(ws, "D1")).toBe(ValueType.Date);
      expect(Cell.getType(ws, "E1")).toBe(ValueType.Hyperlink);
      expect(Cell.getType(ws, "A2")).toBe(ValueType.Formula);
      expect(Cell.getType(ws, "B2")).toBe(ValueType.Formula);
      expect(Cell.getType(ws, "C2")).toBe(ValueType.Formula);
    });

    it("assigns rich text", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "blort");
      Cell.setValue(ws, "A1", {
        richText: [
          {
            font: { size: 12, color: { theme: 0 }, name: "Calibri", family: 2, scheme: "minor" },
            text: "This is "
          },
          {
            font: { italic: true, size: 12, color: { theme: 0 }, name: "Calibri", scheme: "minor" },
            text: "a"
          },
          {
            font: { size: 12, color: { theme: 1 }, name: "Calibri", family: 2, scheme: "minor" },
            text: " "
          },
          {
            font: { size: 12, color: { argb: "FFFF6600" }, name: "Calibri", scheme: "minor" },
            text: "colorful"
          },
          {
            font: { size: 12, color: { theme: 1 }, name: "Calibri", family: 2, scheme: "minor" },
            text: " text "
          },
          {
            font: { size: 12, color: { argb: "FFCCFFCC" }, name: "Calibri", scheme: "minor" },
            text: "with"
          },
          {
            font: { size: 12, color: { theme: 1 }, name: "Calibri", family: 2, scheme: "minor" },
            text: " in-cell "
          },
          {
            font: {
              bold: true,
              size: 12,
              color: { theme: 1 },
              name: "Calibri",
              family: 2,
              scheme: "minor"
            },
            text: "format"
          }
        ]
      });

      expect(Cell.getText(ws, "A1")).toBe("This is a colorful text with in-cell format");
      expect(Cell.getType(ws, "A1")).toBe(ValueType.RichText);
    });
  });

  // ===========================================================================
  // Images
  // ===========================================================================

  describe("images", () => {
    it("addImage and getImage round-trip", () => {
      const wb = Workbook.create();
      const imageBuffer = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

      const id = addWorkbookImage(wb, {
        buffer: imageBuffer,
        extension: "png"
      });

      expect(typeof id).toBe("number");
      const img = getImage(wb, id);
      expect(img).toBeDefined();
      expect(img!.extension).toBe("png");
    });

    it("getImage returns undefined for invalid id", () => {
      const wb = Workbook.create();
      expect(getImage(wb, 999)).toBeUndefined();
    });
  });

  // ===========================================================================
  // Metadata
  // ===========================================================================

  describe("metadata", () => {
    it("creator and dates can be set and read", () => {
      const wb = Workbook.create();
      wb.creator = "Test Author";
      wb.created = new Date(2024, 0, 1);
      wb.modified = new Date(2024, 5, 15);

      expect(wb.creator).toBe("Test Author");
      expect(wb.created).toEqual(new Date(2024, 0, 1));
      expect(wb.modified).toEqual(new Date(2024, 5, 15));
    });

    it("properties can be set", () => {
      const wb = Workbook.create();
      wb.title = "My Workbook";
      wb.subject = "Testing";

      expect(wb.title).toBe("My Workbook");
      expect(wb.subject).toBe("Testing");
    });
  });

  // ===========================================================================
  // Defined Names
  // ===========================================================================

  describe("defined names", () => {
    it("definedNames is accessible", () => {
      const wb = Workbook.create();
      expect(getDefinedNames(wb)).toBeDefined();
    });
  });

  // ===========================================================================
  // Views
  // ===========================================================================

  describe("views", () => {
    it("views can be set and read", () => {
      const wb = Workbook.create();
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
  // Duplicate Rows
  // ===========================================================================

  describe("duplicateRows", () => {
    it("inserts duplicates", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "blort");
      Cell.setValue(ws, "A1", "1.1");
      Cell.setStyle(ws, "A1", { font: testUtils.styles.fonts.arialBlackUI14 });
      Cell.setValue(ws, "B1", "1.2");
      Cell.setStyle(ws, "B1", { font: testUtils.styles.fonts.comicSansUdB16 });
      Cell.setValue(ws, "C1", "1.3");
      Cell.setStyle(ws, "C1", { fill: testUtils.styles.fills.redDarkVertical });
      rowSetNumFmt(Worksheet.getRow(ws, 1), testUtils.styles.numFmts.numFmt1);

      Cell.setValue(ws, "A2", "2.1");
      Cell.setStyle(ws, "A2", { alignment: testUtils.styles.namedAlignments.topLeft });
      Cell.setValue(ws, "B2", "2.2");
      Cell.setStyle(ws, "B2", { alignment: testUtils.styles.namedAlignments.middleCentre });
      Cell.setValue(ws, "C2", "2.3");
      Cell.setStyle(ws, "C2", { alignment: testUtils.styles.namedAlignments.bottomRight });
      rowSetNumFmt(Worksheet.getRow(ws, 2), testUtils.styles.numFmts.numFmt2);

      Worksheet.duplicateRow(ws, 1, 2, true);
      expect(rowValues(Worksheet.getRow(ws, 1))).toEqual([, "1.1", "1.2", "1.3"]);
      expect(rowValues(Worksheet.getRow(ws, 2))).toEqual([, "1.1", "1.2", "1.3"]);
      expect(rowValues(Worksheet.getRow(ws, 3))).toEqual([, "1.1", "1.2", "1.3"]);
      expect(rowValues(Worksheet.getRow(ws, 4))).toEqual([, "2.1", "2.2", "2.3"]);

      for (let i = 1; i <= 3; i++) {
        expect(Cell.getStyle(ws, `A${i}`).font).toEqual(testUtils.styles.fonts.arialBlackUI14);
        expect(Cell.getStyle(ws, `B${i}`).font).toEqual(testUtils.styles.fonts.comicSansUdB16);
        expect(Cell.getStyle(ws, `C${i}`).fill).toEqual(testUtils.styles.fills.redDarkVertical);
      }
      expect(Cell.getStyle(ws, "A4").alignment).toEqual(testUtils.styles.namedAlignments.topLeft);
      expect(Cell.getStyle(ws, "B4").alignment).toEqual(
        testUtils.styles.namedAlignments.middleCentre
      );
      expect(Cell.getStyle(ws, "C4").alignment).toEqual(
        testUtils.styles.namedAlignments.bottomRight
      );

      expect(rowNumFmt(Worksheet.getRow(ws, 1))).toBe(testUtils.styles.numFmts.numFmt1);
      expect(rowNumFmt(Worksheet.getRow(ws, 2))).toBe(testUtils.styles.numFmts.numFmt1);
      expect(rowNumFmt(Worksheet.getRow(ws, 3))).toBe(testUtils.styles.numFmts.numFmt1);
      expect(rowNumFmt(Worksheet.getRow(ws, 4))).toBe(testUtils.styles.numFmts.numFmt2);
    });

    it("overwrites with duplicates", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "blort");
      Cell.setValue(ws, "A1", "1.1");
      Cell.setStyle(ws, "A1", { font: testUtils.styles.fonts.arialBlackUI14 });
      Cell.setValue(ws, "B1", "1.2");
      Cell.setStyle(ws, "B1", { font: testUtils.styles.fonts.comicSansUdB16 });
      Cell.setValue(ws, "C1", "1.3");
      Cell.setStyle(ws, "C1", { fill: testUtils.styles.fills.redDarkVertical });
      rowSetNumFmt(Worksheet.getRow(ws, 1), testUtils.styles.numFmts.numFmt1);

      Cell.setValue(ws, "A2", "2.1");
      Cell.setStyle(ws, "A2", { alignment: testUtils.styles.namedAlignments.topLeft });
      Cell.setValue(ws, "B2", "2.2");
      Cell.setStyle(ws, "B2", { alignment: testUtils.styles.namedAlignments.middleCentre });
      Cell.setValue(ws, "C2", "2.3");
      Cell.setStyle(ws, "C2", { alignment: testUtils.styles.namedAlignments.bottomRight });
      rowSetNumFmt(Worksheet.getRow(ws, 2), testUtils.styles.numFmts.numFmt2);

      Cell.setValue(ws, "A3", "3.1");
      Cell.setStyle(ws, "A3", { fill: testUtils.styles.fills.redGreenDarkTrellis });
      Cell.setValue(ws, "B3", "3.2");
      Cell.setStyle(ws, "B3", { fill: testUtils.styles.fills.blueWhiteHGrad });
      Cell.setValue(ws, "C3", "3.3");
      Cell.setStyle(ws, "C3", { fill: testUtils.styles.fills.rgbPathGrad });
      rowSetFont(Worksheet.getRow(ws, 3), testUtils.styles.fonts.broadwayRedOutline20);

      Worksheet.duplicateRow(ws, 1, 1, false);
      expect(rowValues(Worksheet.getRow(ws, 1))).toEqual([, "1.1", "1.2", "1.3"]);
      expect(rowValues(Worksheet.getRow(ws, 2))).toEqual([, "1.1", "1.2", "1.3"]);
      expect(rowValues(Worksheet.getRow(ws, 3))).toEqual([, "3.1", "3.2", "3.3"]);

      for (let i = 1; i <= 2; i++) {
        expect(Cell.getStyle(ws, `A${i}`).font).toEqual(testUtils.styles.fonts.arialBlackUI14);
        expect(Cell.getStyle(ws, `A${i}`).alignment).toBeUndefined();
        expect(Cell.getStyle(ws, `B${i}`).font).toEqual(testUtils.styles.fonts.comicSansUdB16);
        expect(Cell.getStyle(ws, `B${i}`).alignment).toBeUndefined();
        expect(Cell.getStyle(ws, `C${i}`).fill).toEqual(testUtils.styles.fills.redDarkVertical);
        expect(Cell.getStyle(ws, `C${i}`).alignment).toBeUndefined();
      }

      expect(rowNumFmt(Worksheet.getRow(ws, 1))).toBe(testUtils.styles.numFmts.numFmt1);
      expect(rowNumFmt(Worksheet.getRow(ws, 2))).toBe(testUtils.styles.numFmts.numFmt1);
      expect(rowNumFmt(Worksheet.getRow(ws, 3))).toBeUndefined();
      expect(rowFont(Worksheet.getRow(ws, 3))).toEqual(testUtils.styles.fonts.broadwayRedOutline20);
    });
  });

  // ===========================================================================
  // Themes
  // ===========================================================================

  describe("themes", () => {
    it("clearThemes removes internal themes", () => {
      const wb = Workbook.create();
      // Themes exist by default as undefined, but after loading an XLSX they'd be set.
      // clearThemes() should set _themes to undefined without throwing.
      clearThemes(wb);
      expect((wb as any)._themes).toBeUndefined();
    });
  });

  // ===========================================================================
  // Workbook Protection
  // ===========================================================================

  describe("workbook protection", () => {
    it("protect() sets lockStructure by default", async () => {
      const wb = Workbook.create();
      Workbook.addWorksheet(wb, "Sheet1");
      await protectWorkbook(wb);

      expect(wb.protection).toBeDefined();
      expect(wb.protection!.lockStructure).toBe(true);
      // No password → no hash fields
      expect(wb.protection!.algorithmName).toBeUndefined();
      expect(wb.protection!.hashValue).toBeUndefined();
    });

    it("protect() with password generates hash fields", async () => {
      const wb = Workbook.create();
      Workbook.addWorksheet(wb, "Sheet1");
      await protectWorkbook(wb, "secret");

      expect(wb.protection).toBeDefined();
      expect(wb.protection!.lockStructure).toBe(true);
      expect(wb.protection!.algorithmName).toBe("SHA-512");
      expect(wb.protection!.hashValue).toBeTruthy();
      expect(wb.protection!.saltValue).toBeTruthy();
      expect(wb.protection!.spinCount).toBe(100000);
    });

    it("protect() with options overrides defaults", async () => {
      const wb = Workbook.create();
      Workbook.addWorksheet(wb, "Sheet1");
      await protectWorkbook(wb, "pass", {
        lockStructure: false,
        lockWindows: true,
        spinCount: 50000
      });

      expect(wb.protection!.lockStructure).toBe(false);
      expect(wb.protection!.lockWindows).toBe(true);
      expect(wb.protection!.spinCount).toBe(50000);
    });

    it("protect() normalizes spinCount edge cases", async () => {
      const wb = Workbook.create();
      Workbook.addWorksheet(wb, "Sheet1");

      // undefined → default 100000
      await protectWorkbook(wb, "a", { lockStructure: true });
      expect(wb.protection!.spinCount).toBe(100000);

      // negative → 0
      await protectWorkbook(wb, "a", { spinCount: -1 });
      expect(wb.protection!.spinCount).toBe(0);

      // fractional → rounded
      await protectWorkbook(wb, "a", { spinCount: 1.8 });
      expect(wb.protection!.spinCount).toBe(2);
    });

    it("unprotect() removes protection", async () => {
      const wb = Workbook.create();
      Workbook.addWorksheet(wb, "Sheet1");
      await protectWorkbook(wb, "secret");
      expect(wb.protection).toBeDefined();

      unprotectWorkbook(wb);
      expect(wb.protection).toBeUndefined();
    });

    it("protection survives model round-trip", async () => {
      const wb = Workbook.create();
      Workbook.addWorksheet(wb, "Sheet1");
      await protectWorkbook(wb, "secret", { lockWindows: true });

      const model = getWorkbookModel(wb);
      expect(model.protection).toBeDefined();
      expect(model.protection!.lockStructure).toBe(true);
      expect(model.protection!.lockWindows).toBe(true);

      const wb2 = Workbook.create();
      Workbook.addWorksheet(wb2, "Sheet1");
      setWorkbookModel(wb2, model);
      expect(wb2.protection).toBeDefined();
      expect(wb2.protection!.lockStructure).toBe(true);
      expect(wb2.protection!.lockWindows).toBe(true);
      expect(wb2.protection!.algorithmName).toBe("SHA-512");
    });

    it("protection round-trips through XLSX write/load", async () => {
      const wb = Workbook.create();
      Workbook.addWorksheet(wb, "Sheet1");
      await protectWorkbook(wb, "test123", { lockStructure: true });

      const buffer = await getXlsxIo(wb).writeBuffer();
      const wb2 = Workbook.create();
      await getXlsxIo(wb2).load(buffer);

      expect(wb2.protection).toBeDefined();
      expect(wb2.protection!.lockStructure).toBe(true);
      expect(wb2.protection!.algorithmName).toBe("SHA-512");
      expect(wb2.protection!.hashValue).toBe(wb.protection!.hashValue);
      expect(wb2.protection!.saltValue).toBe(wb.protection!.saltValue);
      expect(wb2.protection!.spinCount).toBe(100000);
    });

    it("unprotected workbook has no protection in XLSX", async () => {
      const wb = Workbook.create();
      Workbook.addWorksheet(wb, "Sheet1");

      const buffer = await getXlsxIo(wb).writeBuffer();
      const wb2 = Workbook.create();
      await getXlsxIo(wb2).load(buffer);

      expect(wb2.protection).toBeUndefined();
    });
  });

  // ===========================================================================
  // Default Font
  // ===========================================================================

  describe("defaultFont", () => {
    it("is undefined by default", () => {
      const wb = Workbook.create();
      expect(getDefaultFont(wb)).toBeUndefined();
    });

    it("can be set and read back", () => {
      const wb = Workbook.create();
      setDefaultFont(wb, { name: "Arial", size: 12 });

      expect(getDefaultFont(wb)).toEqual({ name: "Arial", size: 12 });
    });

    it("can be cleared by setting to undefined", () => {
      const wb = Workbook.create();
      setDefaultFont(wb, { name: "Arial", size: 12 });
      expect(getDefaultFont(wb)).toEqual({ name: "Arial", size: 12 });

      setDefaultFont(wb, undefined);
      expect(getDefaultFont(wb)).toBeUndefined();
    });

    it("survives model round-trip", () => {
      const wb = Workbook.create();
      Workbook.addWorksheet(wb, "Sheet1");
      setDefaultFont(wb, { name: "Times New Roman", size: 14 });

      const model = getWorkbookModel(wb);
      expect(model.defaultFont).toEqual({ name: "Times New Roman", size: 14 });

      const wb2 = Workbook.create();
      Workbook.addWorksheet(wb2, "Sheet1");
      setWorkbookModel(wb2, model);
      expect(getDefaultFont(wb2)).toEqual({ name: "Times New Roman", size: 14 });
    });

    it("round-trips through XLSX write/load", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Cell.setValue(ws, "A1", "test");
      setDefaultFont(wb, { name: "Arial", size: 12, family: 2 });

      const buffer = await getXlsxIo(wb).writeBuffer();
      const wb2 = Workbook.create();
      await getXlsxIo(wb2).load(buffer);

      // After round-trip, the default font should be preserved
      expect(getDefaultFont(wb2)).toBeDefined();
      expect(getDefaultFont(wb2)!.name).toBe("Arial");
      expect(getDefaultFont(wb2)!.size).toBe(12);
    });

    it("writes defaultFont as fontId=0 in styles.xml", async () => {
      const { extractAll } = await import("@archive/unzip/extract");

      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Cell.setValue(ws, "A1", "test");
      setDefaultFont(wb, { name: "Arial", size: 12 });

      const buffer = await getXlsxIo(wb).writeBuffer();
      const entries = await extractAll(buffer as Uint8Array);
      const stylesXml = new TextDecoder().decode(entries.get("xl/styles.xml")!.data);

      // The first <font> in styles.xml should be Arial 12, not Calibri 11
      const firstFontMatch = stylesXml.match(/<font>([\s\S]*?)<\/font>/);
      expect(firstFontMatch).toBeTruthy();
      const firstFont = firstFontMatch![1];
      expect(firstFont).toContain('val="Arial"');
      expect(firstFont).toContain('val="12"');
      expect(firstFont).not.toContain('val="Calibri"');
    });
  });

  // ===========================================================================
  // calcProperties XLSX Round-Trip
  // ===========================================================================

  describe("calcProperties", () => {
    it("round-trips iterate/iterateCount/iterateDelta through XLSX write/load", async () => {
      const wb = Workbook.create();
      Workbook.addWorksheet(wb, "Sheet1");
      wb.calcProperties = {
        fullCalcOnLoad: true,
        iterate: true,
        iterateCount: 200,
        iterateDelta: 0.01
      };

      const buffer = await getXlsxIo(wb).writeBuffer();
      const wb2 = Workbook.create();
      await getXlsxIo(wb2).load(buffer);

      expect(wb2.calcProperties).toBeDefined();
      expect(wb2.calcProperties.fullCalcOnLoad).toBe(true);
      expect(wb2.calcProperties.iterate).toBe(true);
      expect(wb2.calcProperties.iterateCount).toBe(200);
      expect(wb2.calcProperties.iterateDelta).toBe(0.01);
    });

    it("preserves default calcProperties when not explicitly set", async () => {
      const wb = Workbook.create();
      Workbook.addWorksheet(wb, "Sheet1");

      const buffer = await getXlsxIo(wb).writeBuffer();
      const wb2 = Workbook.create();
      await getXlsxIo(wb2).load(buffer);

      // **`fullCalcOnLoad` is now true by default.** This writer produces no `calcChain`, so it cannot claim
      // its cached formula results are Excel's — the flag is how a file says "recalculate these". The XLSB
      // container has always done the equivalent through `recalcID = 0`.
      expect(wb2.calcProperties).toBeDefined();
      expect(wb2.calcProperties.fullCalcOnLoad).toBe(true);
      expect(wb2.calcProperties.iterate).toBeUndefined();
      expect(wb2.calcProperties.iterateCount).toBeUndefined();
      expect(wb2.calcProperties.iterateDelta).toBeUndefined();
    });
  });

  // ===========================================================================
  // Formula-based Defined Names XLSX Round-Trip
  // ===========================================================================

  describe("formula-based defined names", () => {
    it("round-trips formula-based defined names through XLSX write/load", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Cell.setValue(ws, "A1", 1);

      // Register a formula-based defined name
      definedNamesAddFormula(getDefinedNames(wb), "MyFormula", "OFFSET(Sheet1!$A$1,0,0,3,1)");

      const buffer = await getXlsxIo(wb).writeBuffer();
      const wb2 = Workbook.create();
      await getXlsxIo(wb2).load(buffer);

      // The formula-based name should survive round-trip
      const { ranges } = definedNamesGetRanges(getDefinedNames(wb2), "MyFormula");
      expect(ranges).toHaveLength(1);
      expect(ranges[0]).toBe("OFFSET(Sheet1!$A$1,0,0,3,1)");
    });

    it("preserves addFormula names alongside cell-reference names", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Cell.setValue(ws, "A1", 1);

      definedNamesAdd(getDefinedNames(wb), "Sheet1!$A$1:$A$3", "CellRange");
      definedNamesAddFormula(getDefinedNames(wb), "FormulaName", "SUM(Sheet1!$A$1:$A$3)");

      const buffer = await getXlsxIo(wb).writeBuffer();
      const wb2 = Workbook.create();
      await getXlsxIo(wb2).load(buffer);

      // Cell-reference name
      const cellRange = definedNamesGetRanges(getDefinedNames(wb2), "CellRange");
      expect(cellRange.ranges).toHaveLength(1);
      expect(cellRange.ranges[0]).toContain("$A$1");

      // Formula name
      const formulaName = definedNamesGetRanges(getDefinedNames(wb2), "FormulaName");
      expect(formulaName.ranges).toHaveLength(1);
      expect(formulaName.ranges[0]).toBe("SUM(Sheet1!$A$1:$A$3)");
    });

    it("does not misclassify sheet names with parentheses as formulas", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Budget (2024)");
      Cell.setValue(ws, "A1", 100);

      definedNamesAdd(getDefinedNames(wb), "'Budget (2024)'!$A$1", "MyCell");

      const buffer = await getXlsxIo(wb).writeBuffer();
      const wb2 = Workbook.create();
      await getXlsxIo(wb2).load(buffer);

      const result = definedNamesGetRanges(getDefinedNames(wb2), "MyCell");
      expect(result.ranges).toHaveLength(1);
      expect(result.ranges[0]).toContain("$A$1");
      // Must NOT be treated as a formula expression
      expect(result.formulaExpression).toBeUndefined();
    });
  });
});

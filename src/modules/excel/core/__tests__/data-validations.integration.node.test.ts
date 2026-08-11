import { readFileSync } from "fs";

import { expectValidXlsx } from "@excel/__tests__/helpers/expect-valid-xlsx";
import { getWorksheets } from "@excel/core/workbook";
import { DataValidation, Workbook } from "@excel/index";
import type { DataValidationRule } from "@excel/types";
import { makeTestDataPath, testFilePath } from "@test/utils";
import { describe, it, expect } from "vitest";

const excelTestDataPath = makeTestDataPath(import.meta.url, "../../__tests__/data");

describe("DataValidations", () => {
  it("reads a workbook with dataValidation missing type", async () => {
    const wb = Workbook.create();
    await Workbook.readFile(wb, excelTestDataPath("data-validation-missing-type.xlsx"));

    // Should load without error and have at least one worksheet
    expect(getWorksheets(wb).length).toBeGreaterThan(0);
  });

  it("writes a full-column validation without throwing", async () => {
    const TEST_XLSX_FILE_NAME = testFilePath("data-validation-full-column.test");

    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");

    const range = "A2:A1048576";
    ws.dataValidations.model[range] = {
      allowBlank: true,
      error: "Please use the drop down to select a valid value",
      errorTitle: "Invalid Selection",
      formulae: ['"Apples,Bananas,Oranges"'],
      showErrorMessage: true,
      type: "list"
    };

    await Workbook.writeFile(wb, TEST_XLSX_FILE_NAME);
    await expectValidXlsx(new Uint8Array(await Workbook.toBuffer(wb)));

    // Read back and verify validation survived
    const wb2 = Workbook.create();
    await Workbook.readFile(wb2, TEST_XLSX_FILE_NAME);
    const ws2 = Workbook.getWorksheet(wb2, "Sheet1")!;
    const dvKeys = Object.keys(ws2.dataValidations.model);
    expect(dvKeys.length).toBe(1);
    expect(ws2.dataValidations.model[dvKeys[0]]?.type).toBe("list");
  });

  it("reads and writes data validations", async () => {
    const TEST_XLSX_FILE_NAME = testFilePath("pr-1204.data-validations.test");

    const wb = Workbook.create();
    await Workbook.readFile(wb, excelTestDataPath("data-validation-text-length.xlsx"));

    const expected = {
      E1: {
        type: "textLength",
        formulae: [2],
        showInputMessage: true,
        showErrorMessage: true,
        operator: "greaterThan"
      },
      E4: {
        type: "textLength",
        formulae: [2],
        showInputMessage: true,
        showErrorMessage: true,
        operator: "greaterThan"
      }
    };

    const ws = Workbook.getWorksheet(wb, 1)!;
    expect(ws!.dataValidations.model).toEqual(expected);

    await Workbook.writeFile(wb, TEST_XLSX_FILE_NAME);
    await expectValidXlsx(new Uint8Array(await Workbook.toBuffer(wb)));
  });

  describe("range validation", () => {
    const rule: DataValidationRule = {
      type: "list",
      allowBlank: true,
      formulae: ['"Apples,Bananas,Oranges"']
    };

    it("DataValidation.add applies a validation to a range as one entry", async () => {
      const TEST_XLSX_FILE_NAME = testFilePath("data-validation-range.test");

      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      DataValidation.add(ws.dataValidations, "X2:X9999", rule);

      expect(ws.dataValidations.model["range:X2:X9999"]?.type).toBe("list");

      await Workbook.writeFile(wb, TEST_XLSX_FILE_NAME);
      await expectValidXlsx(new Uint8Array(await Workbook.toBuffer(wb)));

      const wb2 = Workbook.create();
      await Workbook.readFile(wb2, TEST_XLSX_FILE_NAME);
      const ws2 = Workbook.getWorksheet(wb2, "Sheet1")!;
      const dvKeys = Object.keys(ws2.dataValidations.model);
      expect(dvKeys.length).toBe(1);
      expect(dvKeys[0]).toBe("range:X2:X9999");
    });
  });

  describe("ignoreNodes", () => {
    it("readFile ignores dataValidations without blowing up memory", async () => {
      const wb = Workbook.create();
      await Workbook.readFile(wb, excelTestDataPath("data-validations-large.xlsx"), {
        ignoreNodes: ["dataValidations"]
      });
      // Should load successfully and have worksheets, but no data validations
      expect(getWorksheets(wb).length).toBeGreaterThan(0);
    });

    it("load(buffer) ignores dataValidations without blowing up memory", async () => {
      const buffer = readFileSync(excelTestDataPath("data-validations-large.xlsx"));
      const wb = Workbook.create();
      await Workbook.read(wb, buffer, {
        ignoreNodes: ["dataValidations"]
      });
      expect(getWorksheets(wb).length).toBeGreaterThan(0);
    });
  });
});

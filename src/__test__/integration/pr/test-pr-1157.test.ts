import { describe, it, expect } from "vitest";
import { testDataPath, testFilePath } from "../../utils/test-file-helper.js";
import { Workbook } from "../../../index.js";

const TEST_XLSX_FILE_NAME = testFilePath("pr-1157.test");

describe("github issues", () => {
  it("pull request 1204 - Read and write data validation should be successful", async () => {
    const wb = new Workbook();
    await wb.xlsx.readFile(testDataPath("test-pr-1204.xlsx"));
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
    const ws = wb.getWorksheet(1);
    expect(ws.dataValidations.model).toEqual(expected);
    await wb.xlsx.writeFile(TEST_XLSX_FILE_NAME);
  });
});

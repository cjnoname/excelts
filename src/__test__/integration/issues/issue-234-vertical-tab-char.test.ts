import { describe, it, expect } from "vitest";
import { Workbook } from "../../../index.js";
// this file to contain integration tests created from github issues
import { testFilePath } from "../../utils/test-file-helper.js";

const TEST_XLSX_FILE_NAME = testFilePath("issue-234.test");

describe("github issues", () => {
  it('issue 234 - Broken XLSX because of "vertical tab" ascii character in a cell', () => {
    const wb = new Workbook();
    const ws = wb.addWorksheet("Sheet1");

    // Start of Heading
    ws.getCell("A1").value = "Hello, \x01World!";

    // Vertical Tab
    ws.getCell("A2").value = "Hello, \x0bWorld!";

    return wb.xlsx
      .writeFile(TEST_XLSX_FILE_NAME)
      .then(() => {
        const wb2 = new Workbook();
        return wb2.xlsx.readFile(TEST_XLSX_FILE_NAME);
      })
      .then(wb2 => {
        const ws2 = wb2.getWorksheet("Sheet1");
        expect(ws2.getCell("A1").value).toBe("Hello, World!");
        expect(ws2.getCell("A2").value).toBe("Hello, World!");
      });
  });
});

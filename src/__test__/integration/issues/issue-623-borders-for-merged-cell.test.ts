import { describe, it, expect } from "vitest";
import { testDataPath, testFilePath } from "../../utils/test-file-helper.js";
import { Workbook } from "../../../index.js";

const TEST_XLSX_FILE_NAME = testFilePath("test-issue-623");

describe("github issues", () => {
  it("issue 623 - Issue with borders for merged cell when rewriting an excel workbook", () => {
    const wb = new Workbook();
    return wb.xlsx
      .readFile(testDataPath("test-issue-623.xlsx"))
      .then(() => {
        // styles of each cell should be read as is without merging
        const worksheet = wb.getWorksheet(1);
        checkBorder(worksheet.getCell("B2"), ["left", "top"]);
        checkBorder(worksheet.getCell("B3"), ["left", "bottom"]);
        checkBorder(worksheet.getCell("C2"), ["right", "top"]);
        checkBorder(worksheet.getCell("C3"), ["right", "bottom"]);
        return wb.xlsx.writeFile(TEST_XLSX_FILE_NAME);
      })
      .then(() => {
        const wb2 = new Workbook();
        return wb2.xlsx.readFile(TEST_XLSX_FILE_NAME);
      })
      .then(wb2 => {
        // written file should have same borders
        const worksheet = wb2.getWorksheet(1);
        checkBorder(worksheet.getCell("B2"), ["left", "top"]);
        checkBorder(worksheet.getCell("B3"), ["left", "bottom"]);
        checkBorder(worksheet.getCell("C2"), ["right", "top"]);
        checkBorder(worksheet.getCell("C3"), ["right", "bottom"]);
      });
  });
});

function checkBorder(cell, borders) {
  borders.forEach(b => {
    expect(cell.style.border).toHaveProperty(b);
  });
}

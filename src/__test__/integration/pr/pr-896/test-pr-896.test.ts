import { describe, it, expect } from "vitest";
import { Workbook } from "../../../../index.js";
import { fix } from "../../../utils/tools.js";
import { testFilePath } from "../../../utils/test-file-helper.js";
import sheetProperties from "../../../utils/data/sheet-properties.json" with { type: "json" };
import pageSetup from "../../../utils/data/page-setup.json" with { type: "json" };

process.env.EXCEL_NATIVE = "yes";

const TEST_XLSX_FILE_NAME = testFilePath("pr-896-dir.test");
const RT_ARR = [
  { text: "First Line:\n", font: { bold: true } },
  { text: "Second Line\n" },
  { text: "Third Line\n" },
  { text: "Last Line" }
];
const TEST_VALUE = {
  richText: RT_ARR
};
const TEST_NOTE = {
  texts: RT_ARR
};

describe("pr related issues", () => {
  describe('pr 896 add xml:space="preserve" for all whitespaces', () => {
    it("should store cell text and comment with leading new line", () => {
      const properties = fix(sheetProperties);
      const pageSetup2 = fix(pageSetup);

      const wb = new Workbook();
      const ws = wb.addWorksheet("sheet1", {
        properties,
        pageSetup: pageSetup2
      });

      ws.getColumn(1).width = 20;
      ws.getCell("A1").value = TEST_VALUE;
      ws.getCell("A1").note = TEST_NOTE;
      ws.getCell("A1").alignment = { wrapText: true };

      return wb.xlsx
        .writeFile(TEST_XLSX_FILE_NAME)
        .then(() => {
          const wb2 = new Workbook();
          return wb2.xlsx.readFile(TEST_XLSX_FILE_NAME);
        })
        .then(wb2 => {
          const ws2 = wb2.getWorksheet("sheet1");
          expect(ws2).toBeDefined();
          expect(ws2.getCell("A1").value).toEqual(TEST_VALUE);
        });
    });
  });
});

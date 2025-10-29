import { describe, it, expect } from "vitest";
import { Workbook } from "../../../index.js";
import { testFilePath } from "../../utils/test-file-helper.js";

const TEST_XLSX_FILE_NAME = testFilePath("pr-896.test");

describe("pr related issues", () => {
  describe("pr 896 leading and trailing whitespace", () => {
    it("Should preserve leading and trailing whitespace", () => {
      const wb = new Workbook();
      const ws = wb.addWorksheet("foo");
      ws.getCell("A1").value = " leading";
      ws.getCell("A1").note = " leading";
      ws.getCell("B1").value = "trailing ";
      ws.getCell("B1").note = "trailing ";
      ws.getCell("C1").value = " both ";
      ws.getCell("C1").note = " both ";
      return wb.xlsx
        .writeFile(TEST_XLSX_FILE_NAME)
        .then(() => {
          const wb2 = new Workbook();
          return wb2.xlsx.readFile(TEST_XLSX_FILE_NAME);
        })
        .then(wb2 => {
          const ws2 = wb2.getWorksheet("foo");
          expect(ws2.getCell("A1").value).toBe(" leading");
          expect(ws2.getCell("A1").note).toBe(" leading");
          expect(ws2.getCell("B1").value).toBe("trailing ");
          expect(ws2.getCell("B1").note).toBe("trailing ");
          expect(ws2.getCell("C1").value).toBe(" both ");
          expect(ws2.getCell("C1").note).toBe(" both ");
        });
    });

    it("Should preserve newlines", () => {
      const wb = new Workbook();
      const ws = wb.addWorksheet("foo");
      ws.getCell("A1").value = "Hello,\nWorld!";
      ws.getCell("A1").note = "Later,\nAlligator!";
      ws.getCell("B1").value = " Hello, \n World! ";
      ws.getCell("B1").note = " Later, \n Alligator! ";
      return wb.xlsx
        .writeFile(TEST_XLSX_FILE_NAME)
        .then(() => {
          const wb2 = new Workbook();
          return wb2.xlsx.readFile(TEST_XLSX_FILE_NAME);
        })
        .then(wb2 => {
          const ws2 = wb2.getWorksheet("foo");
          expect(ws2.getCell("A1").value).toBe("Hello,\nWorld!");
          expect(ws2.getCell("A1").note).toBe("Later,\nAlligator!");
          expect(ws2.getCell("B1").value).toBe(" Hello, \n World! ");
          expect(ws2.getCell("B1").note).toBe(" Later, \n Alligator! ");
        });
    });
  });
});

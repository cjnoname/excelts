import { describe, it, expect } from "vitest";
import { Workbook } from "../../../index.js";
// this file to contain integration tests created from github issues
import { testFilePath } from "../../utils/test-file-helper.js";

const TEST_XLSX_FILE_NAME = testFilePath("issue-703.test");

describe("github issues", () => {
  it("issue 703 - Special cell value results invalid file", () => {
    const wb = new Workbook();
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
    for (let i = 0; i < specialValues.length; i++) {
      const value = specialValues[i];
      ws.addRow([value]);
      ws.getCell(`B${i + 1}`).value = value;
    }
    return wb.xlsx
      .writeFile(TEST_XLSX_FILE_NAME)
      .then(() => {
        const wb2 = new Workbook();
        return wb2.xlsx.readFile(TEST_XLSX_FILE_NAME);
      })
      .then(wb2 => {
        const ws2 = wb2.getWorksheet("Sheet1");
        for (let i = 0; i < specialValues.length; i++) {
          const value = specialValues[i];
          expect(ws2.getCell(`A${i + 1}`).value).toBe(value);
          expect(ws2.getCell(`B${i + 1}`).value).toBe(value);
        }
      });
  });
});

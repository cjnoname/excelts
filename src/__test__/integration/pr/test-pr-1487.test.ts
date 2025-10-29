import { describe, it, expect } from "vitest";
import { testDataPath } from "../../utils/test-file-helper.js";
import { Workbook } from "../../../index.js";

describe("github issues", () => {
  describe("pull request 1487 - lastColumn with an empty column", () => {
    it("Reading 1904.xlsx", () => {
      const wb = new Workbook();
      return wb.xlsx.readFile(testDataPath("1904.xlsx")).then(() => {
        const ws = wb.getWorksheet("Sheet1");
        expect(ws.lastColumn).toBe(ws.getColumn(2));
      });
    });
  });
  // the new property is also tested in gold.spec.js
});

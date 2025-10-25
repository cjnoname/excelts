import { describe, it, expect } from "vitest";
import { testDataPath } from "../../utils/test-file-helper.js";
import { Workbook } from "../../../index.js";

describe("github issues", () => {
  describe("pull request 1576 - inlineStr cell type support", () => {
    it("Reading test-issue-1575.xlsx", () => {
      const wb = new Workbook();
      return wb.xlsx.readFile(testDataPath("test-issue-1575.xlsx")).then(() => {
        const ws = wb.getWorksheet("Sheet1");
        expect(ws.getCell("A1").value).toBe("A");
        expect(ws.getCell("B1").value).toBe("B");
        expect(ws.getCell("C1").value).toBe("C");
        expect(ws.getCell("A2").value).toBe("1.0");
        expect(ws.getCell("B2").value).toBe("2.0");
        expect(ws.getCell("C2").value).toBe("3.0");
        expect(ws.getCell("A3").value).toBe("4.0");
        expect(ws.getCell("B3").value).toBe("5.0");
        expect(ws.getCell("C3").value).toBe("6.0");
      });
    });
  });
});

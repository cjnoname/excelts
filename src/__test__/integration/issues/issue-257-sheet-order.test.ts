import { describe, it, expect } from "vitest";
import { Workbook } from "../../../index.js";
import { testDataPath } from "../../utils/test-file-helper.js";

describe("github issues", () => {
  it("257 - Sheet Order", () => {
    const wb = new Workbook();
    return wb.xlsx.readFile(testDataPath("test-issue-257.xlsx")).then(() => {
      expect(wb.worksheets.map(ws => ws.name)).toEqual(["First", "Second"]);
    });
  });
});

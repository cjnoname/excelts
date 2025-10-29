import { describe, it, expect } from "vitest";
import { testDataPath } from "../../utils/test-file-helper.js";
import { Workbook } from "../../../index.js";

describe("github issues", () => {
  it("pull request 728 - Read worksheet hidden state", () => {
    const wb = new Workbook();
    return wb.xlsx.readFile(testDataPath("test-pr-728.xlsx")).then(() => {
      const expected = { 1: "visible", 2: "hidden", 3: "visible" };
      wb.eachSheet((ws, sheetId) => {
        expect(ws.state).toBe(expected[sheetId]);
      });
    });
  });
});

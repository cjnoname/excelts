import { describe, it, expect } from "vitest";
import { testDataPath } from "../../utils/test-file-helper.js";
import { Workbook } from "../../../index.js";

describe("github issues", () => {
  it("issue 163 - Error while using xslx readFile method", () => {
    const wb = new Workbook();
    return wb.xlsx.readFile(testDataPath("test-issue-163.xlsx")).then(() => {
      // arriving here is success
      expect(true).toBe(true);
    });
  });
});

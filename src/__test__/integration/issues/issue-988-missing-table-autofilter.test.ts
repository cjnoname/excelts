import { describe, it } from "vitest";
import { testDataPath } from "../../utils/test-file-helper.js";
import { Workbook } from "../../../index.js";

describe("github issues", () => {
  it("issue 988 - table without autofilter model", () => {
    const wb = new Workbook();
    return wb.xlsx.readFile(testDataPath("test-issue-988.xlsx"));
  }, 6000);
});

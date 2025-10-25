import { describe, it } from "vitest";
import { testDataPath } from "../../utils/test-file-helper.js";
import { Workbook } from "../../../index.js";

describe("github issues", () => {
  it("issue 1669 - optional autofilter and custom autofilter on tables", async () => {
    const wb = new Workbook();
    return wb.xlsx.readFile(testDataPath("test-issue-1669.xlsx"));
  }, 6000);
});

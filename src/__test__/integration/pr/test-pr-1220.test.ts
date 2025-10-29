import { describe, it, expect } from "vitest";
import { testDataPath } from "../../utils/test-file-helper.js";
import { Workbook } from "../../../index.js";

describe("github issues", () => {
  it("pull request 1220 - The worksheet should not be undefined", async () => {
    const wb = new Workbook();
    await wb.xlsx.readFile(testDataPath("test-pr-1220.xlsx"));
    const ws = wb.getWorksheet(1);
    expect(ws).to.not.equal(undefined);
  });
});

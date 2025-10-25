import { describe, it, expect } from "vitest";
import { Workbook } from "../../../index.js";

describe("github issues", () => {
  it("issue 2125 - spliceRows remove last row", () => {
    const wb = new Workbook();
    const ws = wb.addWorksheet();
    ws.addRows([["1st"], ["2nd"], ["3rd"]]);

    ws.spliceRows(ws.rowCount, 1);

    expect(ws.getRow(ws.rowCount).getCell(1).value).toBe("2nd");
  });
});

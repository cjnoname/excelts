import { describe, it, expect } from "vitest";
import { CellMatrix } from "../../../utils/cell-matrix.js";

describe("CellMatrix", () => {
  it("getCell always returns a cell", () => {
    const cm = new CellMatrix();
    expect(cm.getCell("A1")).toBeTruthy();
    expect(cm.getCell("$B$2")).toBeTruthy();
    expect(cm.getCell("Sheet!$C$3")).toBeTruthy();
  });
  it("findCell only returns known cells", () => {
    const cm = new CellMatrix();
    expect(cm.findCell("A1")).toBeUndefined();
    expect(cm.findCell("$B$2")).toBeUndefined();
    expect(cm.findCell("Sheet!$C$3")).toBeUndefined();
  });
});

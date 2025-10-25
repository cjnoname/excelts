import { describe, it, expect } from "vitest";
import { Stream } from "stream";
import { WorkbookWriter } from "../../../index.js";

describe("Workbook Writer", () => {
  it("returns undefined for non-existant sheet", () => {
    const stream = new Stream.Writable({
      write: function noop() {}
    });
    const wb = new WorkbookWriter({
      stream
    });
    wb.addWorksheet("first");
    expect(wb.getWorksheet("w00t")).toBeUndefined();
  });
});

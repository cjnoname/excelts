import { describe, it, expect } from "vitest";
import { WorksheetWriter } from "../../../stream/xlsx/worksheet-writer.js";
import { StreamBuf } from "../../../utils/stream-buf.js";

describe("Workbook Writer", () => {
  it("generates valid xml even when there is no data", () =>
    // issue: https://github.com/guyonroche/exceljs/issues/99
    // PR: https://github.com/guyonroche/exceljs/pull/255
    new Promise((resolve, reject) => {
      const mockWorkbook: any = {
        _openStream() {
          return this.stream;
        },
        stream: new StreamBuf()
      };
      mockWorkbook.stream.on("finish", () => {
        try {
          const xml = mockWorkbook.stream.read().toString();
          // Basic XML validation: check for proper opening/closing tags
          expect(xml).toContain("<?xml");
          expect(xml).toContain("</worksheet>");
          resolve(undefined);
        } catch (error) {
          reject(error);
        }
      });

      const writer = new WorksheetWriter({
        id: 1,
        workbook: mockWorkbook
      });

      writer.commit();
    }));
});

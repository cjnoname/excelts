import { describe, it } from "vitest";
import { testDataPath } from "../../utils/test-file-helper.js";
import { Workbook } from "../../../index.js";

const TEST_567_XLSX_FILE_NAME = testDataPath("test-pr-567.xlsx");

describe("pr related issues", () => {
  describe("pr 5676 whole column defined names", () => {
    it("Should be able to read this file", () => {
      const wb = new Workbook();
      return wb.xlsx.readFile(TEST_567_XLSX_FILE_NAME);
    });
  });
});

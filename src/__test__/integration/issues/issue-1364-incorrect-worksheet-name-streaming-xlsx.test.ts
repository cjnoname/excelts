import { describe, it, expect } from "vitest";
import { testDataPath } from "../../utils/test-file-helper.js";
import { WorkbookReader } from "../../../index.js";

const TEST_XLSX_FILE_NAME = testDataPath("test-issue-1364.xlsx");

describe("github issues", () => {
  it("issue 1364 - Incorrect Worksheet Name on Streaming XLSX Reader", async () => {
    const workbookReader = new WorkbookReader(TEST_XLSX_FILE_NAME, {});
    workbookReader.read();
    workbookReader.on("worksheet", worksheet => {
      expect(worksheet.name).toBe("Sum Worksheet");
    });
  });
});

import { describe, it, expect } from "vitest";
import { testDataPath } from "../../utils/test-file-helper.js";
import { Workbook } from "../../../index.js";

describe("github issues", () => {
  it("issue 991 - differentiates between strings with leading numbers and dates when reading csv files", () => {
    const wb = new Workbook();
    return wb.csv.readFile(testDataPath("test-issue-991.csv")).then(worksheet => {
      expect(worksheet.getCell("A1").value.toString()).toBe(
        new Date("2019-11-04T00:00:00").toString()
      );
      expect(worksheet.getCell("A2").value.toString()).toBe(
        new Date("2019-11-04T00:00:00").toString()
      );
      expect(worksheet.getCell("A3").value.toString()).toBe(
        new Date("2019-11-04T10:17:55").toString()
      );
      expect(worksheet.getCell("A4").value).toBe("00210PRG1");
      expect(worksheet.getCell("A5").value).toBe("1234-5thisisnotadate");
    });
  });
});

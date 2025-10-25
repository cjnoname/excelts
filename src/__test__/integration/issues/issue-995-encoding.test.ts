import { describe, it, expect } from "vitest";
import { Workbook } from "../../../index.js";
import { testFilePath } from "../../utils/test-file-helper.js";

const TEST_CSV_FILE_NAME = testFilePath("issue-995-encoding.test", ".csv");
const HEBREW_TEST_STRING = "משהו שכתוב בעברית";

describe("github issues", () => {
  it("issue 995 - encoding option works fine", () => {
    const wb = new Workbook();
    const ws = wb.addWorksheet("wheee");
    ws.getCell("A1").value = HEBREW_TEST_STRING;

    const options = {
      encoding: "UTF-8"
    };
    return wb.csv
      .writeFile(TEST_CSV_FILE_NAME, options)
      .then(() => {
        const ws2 = new Workbook();
        return ws2.csv.readFile(TEST_CSV_FILE_NAME);
      })
      .then(ws2 => {
        expect(ws2.getCell("A1").value).toBe(HEBREW_TEST_STRING);
      });
  }, 6000);
});

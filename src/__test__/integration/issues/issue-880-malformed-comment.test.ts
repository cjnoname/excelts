import { describe, it } from "vitest";
import fs from "fs";
import { Workbook } from "../../../index.js";
// this file to contain integration tests created from github issues
import { testFilePath, testDataPath } from "../../utils/test-file-helper.js";

const TEST_XLSX_FILE_NAME = testFilePath("wb-issue-880.test");

describe("github issues", () => {
  it("issue 880 - malformed comment crashes on write", () => {
    const wb = new Workbook();
    return wb.xlsx.readFile(testDataPath("test-issue-880.xlsx")).then(() => {
      wb.xlsx
        .writeBuffer({
          useStyles: true,
          useSharedStrings: true
        })
        .then(function (buffer) {
          const wstream = fs.createWriteStream(TEST_XLSX_FILE_NAME);
          wstream.write(buffer);
          wstream.end();
        });
    });
  }, 6000);
});

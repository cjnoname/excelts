import { describe, it } from "vitest";
import { testDataPath, testFilePath } from "../../utils/test-file-helper.js";
import fs from "fs";
import { Workbook } from "../../../index.js";

// this file to contain integration tests created from github issues

const TEST_XLSX_FILE_NAME = testFilePath("wb-issue-877.test");

describe("github issues", () => {
  it("issue 877 - hyperlink without text crashes on write", () => {
    const wb = new Workbook();
    return wb.xlsx.readFile(testDataPath("test-issue-877.xlsx")).then(() => {
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
  });
});

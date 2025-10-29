import { describe, it } from "vitest";
import { Workbook } from "../../../index.js";
import { testFilePath } from "../../utils/test-file-helper.js";

const TEST_XLSX_FILE_NAME = testFilePath("issue-1027.test");

describe("github issues", () => {
  it("issue 1027 - Broken due to Cannot set property 'marked' of undefined error", () => {
    const wb = new Workbook();
    const ws = wb.addWorksheet("Sheet1");

    const range = "A2:A1048576";

    ws.dataValidations.model[range] = {
      allowBlank: true,
      error: "Please use the drop down to select a valid value",
      errorTitle: "Invalid Selection",
      formulae: ['"Apples,Bananas,Oranges"'],
      showErrorMessage: true,
      type: "list"
    };

    return wb.xlsx.writeFile(TEST_XLSX_FILE_NAME);
  });
});

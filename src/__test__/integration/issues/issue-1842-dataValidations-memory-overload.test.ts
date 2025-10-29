import { describe, it, expect } from "vitest";
import { join } from "path";
import { readFileSync } from "fs";
import { Workbook } from "../../../index.js";
import { testDataPath } from "../../utils/test-file-helper.js";

const fileName = testDataPath("test-issue-1842.xlsx");

describe("github issues", () => {
  describe("issue 1842 - Memory overload when unnecessary dataValidations apply", () => {
    it("when using readFile", async () => {
      const wb = new Workbook();
      await wb.xlsx.readFile(fileName, {
        ignoreNodes: ["dataValidations"]
      });

      // arriving here is success
      expect(true).toBe(true);
    });

    it("when loading an in memory buffer", async () => {
      const filePath = join(process.cwd(), fileName);
      const buffer = readFileSync(filePath);
      const wb = new Workbook();
      await wb.xlsx.load(buffer, {
        ignoreNodes: ["dataValidations"]
      });

      // arriving here is success
      expect(true).toBe(true);
    });
  });
});

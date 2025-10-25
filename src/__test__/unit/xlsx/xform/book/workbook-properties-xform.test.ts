import { describe } from "vitest";
import { testXformHelper } from "../test-xform-helper.js";
import { WorkbookPropertiesXform } from "../../../../../xlsx/xform/book/workbook-properties-xform.js";

const expectations = [
  {
    title: "default",
    create() {
      return new WorkbookPropertiesXform();
    },
    preparedModel: {},
    xml: '<workbookPr defaultThemeVersion="164011" filterPrivacy="1"/>',
    parsedModel: {},
    tests: ["render", "renderIn"]
  },
  {
    title: "date1904",
    create() {
      return new WorkbookPropertiesXform();
    },
    preparedModel: { date1904: true },
    xml: '<workbookPr date1904="1" defaultThemeVersion="164011" filterPrivacy="1"/>',
    parsedModel: { date1904: true },
    tests: ["render", "renderIn", "parse"]
  }
];

describe("WorkbookPropertiesXform", () => {
  testXformHelper(expectations);
});

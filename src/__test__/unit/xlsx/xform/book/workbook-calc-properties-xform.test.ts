import { describe } from "vitest";
import { testXformHelper } from "../test-xform-helper.js";
import { WorkbookCalcPropertiesXform } from "../../../../../xlsx/xform/book/workbook-calc-properties-xform.js";

const expectations = [
  {
    title: "default",
    create() {
      return new WorkbookCalcPropertiesXform();
    },
    preparedModel: {},
    xml: '<calcPr calcId="171027"/>',
    parsedModel: {},
    tests: ["render", "renderIn"]
  },
  {
    title: "fullCalcOnLoad",
    create() {
      return new WorkbookCalcPropertiesXform();
    },
    preparedModel: { fullCalcOnLoad: true },
    xml: '<calcPr calcId="171027" fullCalcOnLoad="1"/>',
    parsedModel: {},
    tests: ["render", "renderIn", "parse"]
  }
];

describe("WorkbookCalcPropertiesXform", () => {
  testXformHelper(expectations);
});

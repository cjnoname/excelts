import { describe } from "vitest";
import { testXformHelper } from "../test-xform-helper.js";
import { AutoFilterXform } from "../../../../../xlsx/xform/sheet/auto-filter-xform.js";

const expectations = [
  {
    title: "Range",
    create() {
      return new AutoFilterXform();
    },
    preparedModel: "A1:C1",
    xml: '<autoFilter ref="A1:C1"/>',
    parsedModel: "A1:C1",
    tests: ["render", "renderIn", "parse"]
  },
  {
    title: "Row and Column Address",
    create() {
      return new AutoFilterXform();
    },
    preparedModel: { from: { row: 1, column: 1 }, to: { row: 1, column: 3 } },
    xml: '<autoFilter ref="A1:C1"/>',
    tests: ["render", "renderIn"]
  },
  {
    title: "String address",
    create() {
      return new AutoFilterXform();
    },
    preparedModel: { from: "A1", to: "C1" },
    xml: '<autoFilter ref="A1:C1"/>',
    tests: ["render", "renderIn"]
  }
];

describe("AutoFilterXform", () => {
  testXformHelper(expectations);
});

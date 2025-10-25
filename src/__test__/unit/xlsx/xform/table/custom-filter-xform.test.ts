import { describe } from "vitest";
import { testXformHelper } from "../test-xform-helper.js";
import { CustomFilterXform } from "../../../../../xlsx/xform/table/custom-filter-xform.js";

const expectations = [
  {
    title: "custom filter",
    create() {
      return new CustomFilterXform();
    },
    preparedModel: { val: "*brandywine*" },
    xml: '<customFilter val="*brandywine*"/>',
    parsedModel: { val: "*brandywine*" },
    tests: ["render", "renderIn", "parse"]
  },
  {
    title: "custom filter with operator",
    create() {
      return new CustomFilterXform();
    },
    preparedModel: { operator: "notEqual", val: "4" },
    xml: '<customFilter operator="notEqual" val="4"/>',
    parsedModel: { operator: "notEqual", val: "4" },
    tests: ["render", "renderIn", "parse"]
  }
];

describe("CustomFilterXform", () => {
  testXformHelper(expectations);
});

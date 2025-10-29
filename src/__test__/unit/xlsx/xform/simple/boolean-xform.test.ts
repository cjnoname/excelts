import { describe } from "vitest";
import { testXformHelper } from "../test-xform-helper.js";
import { BooleanXform } from "../../../../../xlsx/xform/simple/boolean-xform.js";

const expectations = [
  {
    title: "true",
    create() {
      return new BooleanXform({ tag: "boolean", attr: "val" });
    },
    preparedModel: true,
    get parsedModel() {
      return this.preparedModel;
    },
    xml: "<boolean/>",
    tests: ["render", "renderIn", "parse"]
  },
  {
    title: "false",
    create() {
      return new BooleanXform({ tag: "boolean", attr: "val" });
    },
    preparedModel: false,
    xml: "",
    tests: ["render", "renderIn"]
  },
  {
    title: "undefined",
    create() {
      return new BooleanXform({ tag: "boolean", attr: "val" });
    },
    preparedModel: undefined,
    xml: "",
    tests: ["render", "renderIn"]
  }
];

describe("BooleanXform", () => {
  testXformHelper(expectations);
});

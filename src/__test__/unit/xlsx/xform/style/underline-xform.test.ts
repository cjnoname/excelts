import { describe } from "vitest";
import { testXformHelper } from "../test-xform-helper.js";
import { UnderlineXform } from "../../../../../xlsx/xform/style/underline-xform.js";

const expectations = [
  {
    title: "single",
    create() {
      return new UnderlineXform();
    },
    preparedModel: true,
    get parsedModel() {
      return this.preparedModel;
    },
    xml: "<u/>",
    tests: ["render", "renderIn", "parse"]
  },
  {
    title: "double",
    create() {
      return new UnderlineXform();
    },
    preparedModel: "double",
    get parsedModel() {
      return this.preparedModel;
    },
    xml: '<u val="double"/>',
    tests: ["render", "renderIn", "parse"]
  },
  {
    title: "false",
    create() {
      return new UnderlineXform();
    },
    preparedModel: false,
    get parsedModel() {
      return this.preparedModel;
    },
    xml: "",
    tests: ["render", "renderIn"]
  }
];

describe("UnderlineXform", () => {
  testXformHelper(expectations);
});

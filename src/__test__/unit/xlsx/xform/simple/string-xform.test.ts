import { describe } from "vitest";
import { testXformHelper } from "../test-xform-helper.js";
import { StringXform } from "../../../../../xlsx/xform/simple/string-xform.js";

const expectations = [
  {
    title: "hello",
    create() {
      return new StringXform({ tag: "string", attr: "val" });
    },
    preparedModel: "Hello, World!",
    xml: '<string val="Hello, World!"/>',
    parsedModel: "Hello, World!",
    tests: ["render", "renderIn", "parse"]
  },
  {
    title: "empty",
    create() {
      return new StringXform({ tag: "string", attr: "val" });
    },
    preparedModel: "",
    xml: '<string val=""/>',
    parsedModel: "",
    tests: ["render", "renderIn", "parse"]
  },
  {
    title: "undefined",
    create() {
      return new StringXform({ tag: "string", attr: "val" });
    },
    preparedModel: undefined,
    xml: "",
    tests: ["render", "renderIn"]
  }
];

describe("StringXform", () => {
  testXformHelper(expectations);
});

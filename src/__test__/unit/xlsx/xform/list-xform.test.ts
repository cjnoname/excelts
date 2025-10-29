import { describe } from "vitest";
import { testXformHelper } from "./test-xform-helper.js";
import { ListXform } from "../../../../xlsx/xform/list-xform.js";
import { IntegerXform } from "../../../../xlsx/xform/simple/integer-xform.js";

const expectations = [
  {
    title: "Tagged",
    create() {
      return new ListXform({
        tag: "ints",
        childXform: new IntegerXform({ tag: "int", attr: "val" })
      });
    },
    preparedModel: [1, 2, 3],
    get parsedModel() {
      return this.preparedModel;
    },
    xml: '<ints><int val="1"/><int val="2"/><int val="3"/></ints>',
    tests: ["render", "renderIn", "parse"]
  },
  {
    title: "Tagged and Counted",
    create() {
      return new ListXform({
        tag: "ints",
        count: true,
        childXform: new IntegerXform({ tag: "int", attr: "val" })
      });
    },
    preparedModel: [1, 2, 3],
    get parsedModel() {
      return this.preparedModel;
    },
    xml: '<ints count="3"><int val="1"/><int val="2"/><int val="3"/></ints>',
    tests: ["render", "renderIn", "parse"]
  }
];

describe("ListXform", () => {
  testXformHelper(expectations);
});

import { describe } from "vitest";
import { testXformHelper } from "../test-xform-helper.js";
import { TableColumnXform } from "../../../../../xlsx/xform/table/table-column-xform.js";

const expectations = [
  {
    title: "label",
    create() {
      return new TableColumnXform();
    },
    preparedModel: { id: 1, name: "Foo", totalsRowLabel: "Bar" },
    xml: '<tableColumn id="1" name="Foo" totalsRowLabel="Bar" />',
    parsedModel: { name: "Foo", totalsRowLabel: "Bar" },
    tests: ["render", "renderIn", "parse"]
  },
  {
    title: "function",
    create() {
      return new TableColumnXform();
    },
    preparedModel: { id: 1, name: "Foo", totalsRowFunction: "Baz" },
    xml: '<tableColumn id="1" name="Foo" totalsRowFunction="Baz" />',
    parsedModel: { name: "Foo", totalsRowFunction: "Baz" },
    tests: ["render", "renderIn", "parse"]
  }
];

describe("TableColumnXform", () => {
  testXformHelper(expectations);
});

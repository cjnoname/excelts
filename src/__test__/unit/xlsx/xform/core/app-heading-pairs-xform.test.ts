import { describe } from "vitest";
import { testXformHelper } from "../test-xform-helper.js";
import { AppHeadingPairsXform } from "../../../../../xlsx/xform/core/app-heading-pairs-xform.js";

const expectations = [
  {
    title: "app.01",
    create() {
      return new AppHeadingPairsXform();
    },
    preparedModel: [{ name: "Sheet1" }],
    xml: '<HeadingPairs><vt:vector size="2" baseType="variant"><vt:variant><vt:lpstr>Worksheets</vt:lpstr></vt:variant><vt:variant><vt:i4>1</vt:i4></vt:variant></vt:vector></HeadingPairs>',
    tests: ["render", "renderIn"]
  },
  {
    title: "app.02",
    create() {
      return new AppHeadingPairsXform();
    },
    preparedModel: [{ name: "Sheet1" }, { name: "Sheet2" }],
    xml: '<HeadingPairs><vt:vector size="2" baseType="variant"><vt:variant><vt:lpstr>Worksheets</vt:lpstr></vt:variant><vt:variant><vt:i4>2</vt:i4></vt:variant></vt:vector></HeadingPairs>',
    tests: ["render", "renderIn"]
  }
];

describe("AppHeadingPairsXform", () => {
  testXformHelper(expectations);
});

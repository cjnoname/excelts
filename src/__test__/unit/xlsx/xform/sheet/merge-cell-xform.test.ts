import { describe } from "vitest";
import { testXformHelper } from "../test-xform-helper.js";
import { MergeCellXform } from "../../../../../xlsx/xform/sheet/merge-cell-xform.js";

const expectations = [
  {
    title: "Merge",
    create() {
      return new MergeCellXform();
    },
    preparedModel: "B2:C4",
    xml: '<mergeCell ref="B2:C4"/>',
    parsedModel: "B2:C4",
    tests: ["render", "renderIn", "parse"]
  }
];

describe("MergeCellXform", () => {
  testXformHelper(expectations);
});

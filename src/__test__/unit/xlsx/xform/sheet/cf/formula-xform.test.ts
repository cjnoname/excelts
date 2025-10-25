import { describe } from "vitest";
import { testXformHelper } from "../../test-xform-helper.js";
import { FormulaXform } from "../../../../../../xlsx/xform/sheet/cf/formula-xform.js";

const expectations = [
  {
    title: "formula",
    create() {
      return new FormulaXform();
    },
    preparedModel: "ROW()",
    xml: "<formula>ROW()</formula>",
    parsedModel: "ROW()",
    tests: ["render", "parse"]
  }
];

describe("FormulaXform", () => {
  testXformHelper(expectations);
});

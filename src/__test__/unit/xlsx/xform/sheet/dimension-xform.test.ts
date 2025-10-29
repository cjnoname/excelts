import { describe } from "vitest";
import { testXformHelper } from "../test-xform-helper.js";
import { DimensionXform } from "../../../../../xlsx/xform/sheet/dimension-xform.js";

const expectations = [
  {
    title: "Dimension",
    create() {
      return new DimensionXform();
    },
    preparedModel: "A1:F5",
    get parsedModel() {
      return this.preparedModel;
    },
    xml: '<dimension ref="A1:F5"/>',
    tests: ["render", "renderIn", "parse"]
  }
];

describe("DimensionXform", () => {
  testXformHelper(expectations);
});

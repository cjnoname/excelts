import { describe } from "vitest";
import { testXformHelper } from "../test-xform-helper.js";
import { ColXform } from "../../../../../xlsx/xform/sheet/col-xform.js";

const expectations = [
  {
    title: "Best Fit",
    create: () => new ColXform(),
    preparedModel: { min: 2, max: 2, width: 10.15625, bestFit: true },
    get parsedModel() {
      return this.preparedModel;
    },
    xml: '<col min="2" max="2" width="10.15625" bestFit="1" customWidth="1"/>',
    tests: ["render", "renderIn", "parse"]
  },
  {
    title: "Outline",
    create: () => new ColXform(),
    preparedModel: {
      min: 2,
      max: 2,
      width: 10.15625,
      bestFit: true,
      outlineLevel: 1,
      collapsed: true
    },
    xml: '<col min="2" max="2" width="10.15625" bestFit="1" customWidth="1" outlineLevel="1" collapsed="1"/>',
    parsedModel: {
      min: 2,
      max: 2,
      width: 10.15625,
      bestFit: true,
      outlineLevel: 1,
      collapsed: true
    },
    tests: ["render", "renderIn", "parse"]
  }
];

describe("ColXform", () => {
  testXformHelper(expectations);
});

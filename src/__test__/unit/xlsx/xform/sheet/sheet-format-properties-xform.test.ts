import { describe } from "vitest";
import { testXformHelper } from "../test-xform-helper.js";
import { SheetFormatPropertiesXform } from "../../../../../xlsx/xform/sheet/sheet-format-properties-xform.js";

const expectations = [
  {
    title: "full",
    create() {
      return new SheetFormatPropertiesXform();
    },
    preparedModel: {
      defaultRowHeight: 14.4,
      defaultColWidth: 2.17,
      dyDescent: 0.55,
      outlineLevelRow: 5,
      outlineLevelCol: 2
    },
    xml: '<sheetFormatPr defaultRowHeight="14.4" defaultColWidth="2.17" customHeight="1" outlineLevelRow="5" outlineLevelCol="2" x14ac:dyDescent="0.55"/>',
    parsedModel: {
      defaultRowHeight: 14.4,
      defaultColWidth: 2.17,
      dyDescent: 0.55,
      outlineLevelRow: 5,
      outlineLevelCol: 2
    },
    tests: ["render", "renderIn", "parse"]
  },
  {
    title: "default",
    create() {
      return new SheetFormatPropertiesXform();
    },
    preparedModel: { defaultRowHeight: 14.4, dyDescent: 0.55 },
    xml: '<sheetFormatPr defaultRowHeight="14.4" customHeight="1" x14ac:dyDescent="0.55"/>',
    parsedModel: {
      defaultRowHeight: 14.4,
      dyDescent: 0.55,
      outlineLevelRow: 0,
      outlineLevelCol: 0
    },
    tests: ["render", "renderIn", "parse"]
  }
];

describe("SheetFormatPropertiesXform", () => {
  testXformHelper(expectations);
});

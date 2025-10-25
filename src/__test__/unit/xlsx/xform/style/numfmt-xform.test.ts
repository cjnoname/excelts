import { describe } from "vitest";
import { testXformHelper } from "../test-xform-helper.js";
import { NumFmtXform } from "../../../../../xlsx/xform/style/numfmt-xform.js";

const expectations = [
  {
    title: "date",
    create: () => new NumFmtXform(),
    preparedModel: { id: 165, formatCode: "d-mmm-yyyy" },
    xml: '<numFmt numFmtId="165" formatCode="d-mmm-yyyy"/>',
    get parsedModel() {
      return this.preparedModel;
    },
    tests: ["render", "renderIn", "parse"]
  },
  {
    title: "thing",
    create: () => new NumFmtXform(),
    preparedModel: { id: 165, formatCode: "[Green]#,##0 ;[Red](#,##0)" },
    xml: '<numFmt numFmtId="165" formatCode="[Green]#,##0 ;[Red](#,##0)"/>',
    get parsedModel() {
      return this.preparedModel;
    },
    tests: ["render", "renderIn", "parse"]
  }
];

describe("NumFmtXform", () => {
  testXformHelper(expectations);
});

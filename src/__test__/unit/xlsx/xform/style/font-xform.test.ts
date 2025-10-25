import { describe } from "vitest";
import { testXformHelper } from "../test-xform-helper.js";
import { FontXform } from "../../../../../xlsx/xform/style/font-xform.js";

const expectations = [
  {
    title: "green bold",
    create() {
      return new FontXform();
    },
    preparedModel: {
      bold: true,
      size: 14,
      color: { argb: "FF00FF00" },
      name: "Calibri",
      family: 2,
      scheme: "minor"
    },
    xml: '<font><b/><color rgb="FF00FF00"/><family val="2"/><scheme val="minor"/><sz val="14"/><name val="Calibri"/></font>',
    get parsedModel() {
      return this.preparedModel;
    },
    tests: ["render", "renderIn", "parse"]
  },
  {
    title: "rPr tag",
    create() {
      return new FontXform({ tagName: "rPr", fontNameTag: "rFont" });
    },
    preparedModel: {
      italic: true,
      size: 14,
      color: { argb: "FF00FF00" },
      name: "Calibri",
      family: 2,
      scheme: "minor"
    },
    xml: '<rPr><i/><color rgb="FF00FF00"/><family val="2"/><scheme val="minor"/><sz val="14"/><rFont val="Calibri"/></rPr>',
    get parsedModel() {
      return this.preparedModel;
    },
    tests: ["render", "renderIn", "parse"]
  }
];

describe("FontXform", () => {
  testXformHelper(expectations);
});

import { describe } from "vitest";
import { testXformHelper } from "../test-xform-helper.js";
import { BlipFillXform } from "../../../../../xlsx/xform/drawing/blip-fill-xform.js";

const expectations = [
  {
    title: "normal",
    create() {
      return new BlipFillXform();
    },
    preparedModel: { rId: "rId1" },
    xml:
      "<xdr:blipFill>" +
      '<a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="rId1" cstate="print" />' +
      "<a:stretch><a:fillRect /></a:stretch>" +
      "</xdr:blipFill>",
    parsedModel: { rId: "rId1" },
    tests: ["render", "renderIn", "parse"]
  }
];

describe("BlipFillXform", () => {
  testXformHelper(expectations);
});

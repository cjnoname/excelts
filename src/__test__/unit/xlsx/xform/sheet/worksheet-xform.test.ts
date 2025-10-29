import fs from "fs";
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { testXformHelper } from "../test-xform-helper.js";
import { Enums } from "../../../../../doc/enums.js";
import { XmlStream } from "../../../../../utils/xml-stream.js";
import { WorkSheetXform } from "../../../../../xlsx/xform/sheet/worksheet-xform.js";
import { SharedStringsXform } from "../../../../../xlsx/xform/strings/shared-strings-xform.js";
import { StylesXform } from "../../../../../xlsx/xform/style/styles-xform.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const fakeStyles = {
  addStyleModel(style: any, cellType: any) {
    if (cellType === Enums.ValueType.Date) {
      return 1;
    }
    if (style && style.font) {
      return 2;
    }
    return 0;
  },
  getStyleModel(id: number) {
    switch (id) {
      case 1:
        return { numFmt: "mm-dd-yy" };
      case 2:
        return {
          font: {
            underline: true,
            size: 11,
            color: { theme: 10 },
            name: "Calibri",
            family: 2,
            scheme: "minor"
          }
        };
      default:
        return null;
    }
  }
};

const fakeHyperlinkMap = {
  B6: "https://www.npmjs.com/package/excelts"
};

function fixDate(model: any) {
  model.rows[3].cells[1].value = new Date(model.rows[3].cells[1].value);
  return model;
}

const expectations = [
  {
    title: "Sheet 1",
    create: () => new WorkSheetXform(),
    initialModel: fixDate(
      JSON.parse(fs.readFileSync(join(__dirname, "data/sheet.1.0.json")).toString())
    ),
    preparedModel: fixDate(
      JSON.parse(fs.readFileSync(join(__dirname, "data/sheet.1.1.json")).toString())
    ),
    xml: fs.readFileSync(join(__dirname, "data/sheet.1.2.xml")).toString(),
    parsedModel: JSON.parse(fs.readFileSync(join(__dirname, "data/sheet.1.3.json")).toString()),
    reconciledModel: fixDate(
      JSON.parse(fs.readFileSync(join(__dirname, "data/sheet.1.4.json")).toString())
    ),
    tests: ["prepare", "render", "parse"],
    options: {
      sharedStrings: new SharedStringsXform(),
      hyperlinks: [],
      hyperlinkMap: fakeHyperlinkMap,
      styles: fakeStyles,
      formulae: {},
      siFormulae: 0
    }
  },
  {
    title: "Sheet 2 - Data Validations",
    create: () => new WorkSheetXform(),
    initialModel: JSON.parse(fs.readFileSync(join(__dirname, "data/sheet.2.0.json")).toString()),
    preparedModel: JSON.parse(fs.readFileSync(join(__dirname, "data/sheet.2.1.json")).toString()),
    xml: fs.readFileSync(join(__dirname, "data/sheet.2.2.xml")).toString(),
    tests: ["prepare", "render"],
    options: {
      styles: new StylesXform(true),
      sharedStrings: new SharedStringsXform(),
      hyperlinks: [],
      formulae: {},
      siFormulae: 0
    }
  },
  {
    title: "Sheet 3 - Empty Sheet",
    create: () => new WorkSheetXform(),
    preparedModel: JSON.parse(fs.readFileSync(join(__dirname, "data/sheet.3.1.json")).toString()),
    xml: fs.readFileSync(join(__dirname, "data/sheet.3.2.xml")).toString(),
    tests: ["render"],
    options: {
      styles: new StylesXform(true),
      sharedStrings: new SharedStringsXform(),
      hyperlinks: []
    }
  },
  {
    title: "Sheet 5 - Shared Formulas",
    create: () => new WorkSheetXform(),
    initialModel: JSON.parse(fs.readFileSync(join(__dirname, "data/sheet.5.0.json")).toString()),
    preparedModel: JSON.parse(fs.readFileSync(join(__dirname, "data/sheet.5.1.json")).toString()),
    xml: fs.readFileSync(join(__dirname, "data/sheet.5.2.xml")).toString(),
    parsedModel: JSON.parse(fs.readFileSync(join(__dirname, "data/sheet.5.3.json")).toString()),
    reconciledModel: JSON.parse(fs.readFileSync(join(__dirname, "data/sheet.5.4.json")).toString()),
    tests: ["prepare-render", "parse"],
    options: {
      sharedStrings: new SharedStringsXform(),
      hyperlinks: [],
      hyperlinkMap: fakeHyperlinkMap,
      styles: fakeStyles,
      formulae: {},
      siFormulae: 0
    }
  },
  {
    title: "Sheet 6 - AutoFilter",
    create: () => new WorkSheetXform(),
    preparedModel: JSON.parse(fs.readFileSync(join(__dirname, "data/sheet.6.1.json")).toString()),
    xml: fs.readFileSync(join(__dirname, "data/sheet.6.2.xml")).toString(),
    parsedModel: JSON.parse(fs.readFileSync(join(__dirname, "data/sheet.6.3.json")).toString()),
    tests: ["render", "parse"],
    options: {
      sharedStrings: new SharedStringsXform(),
      hyperlinks: [],
      hyperlinkMap: fakeHyperlinkMap,
      styles: fakeStyles,
      formulae: {},
      siFormulae: 0
    }
  },
  {
    title: "Sheet 7 - Row Breaks",
    create: () => new WorkSheetXform(),
    initialModel: JSON.parse(fs.readFileSync(join(__dirname, "data/sheet.7.0.json")).toString()),
    preparedModel: JSON.parse(fs.readFileSync(join(__dirname, "data/sheet.7.1.json")).toString()),
    xml: fs.readFileSync(join(__dirname, "data/sheet.7.2.xml")).toString(),
    tests: ["prepare", "render"],
    options: {
      sharedStrings: new SharedStringsXform(),
      hyperlinks: [],
      hyperlinkMap: fakeHyperlinkMap,
      styles: fakeStyles,
      formulae: {},
      siFormulae: 0
    }
  }
];

describe("WorksheetXform", () => {
  testXformHelper(expectations);

  it("hyperlinks must be after dataValidations", () => {
    const xform = new WorkSheetXform();
    const model = JSON.parse(fs.readFileSync(join(__dirname, "data/sheet.4.0.json")).toString());
    const xmlStream = new XmlStream();
    const options = {
      styles: new StylesXform(true),
      sharedStrings: new SharedStringsXform(),
      hyperlinks: []
    };
    xform.prepare(model, options);
    xform.render(xmlStream, model);

    const { xml } = xmlStream;
    const iHyperlinks = xml.indexOf("hyperlinks");
    const iDataValidations = xml.indexOf("dataValidations");
    expect(iHyperlinks).not.toBe(-1);
    expect(iDataValidations).not.toBe(-1);
    expect(iHyperlinks).toBeGreaterThan(iDataValidations);
  });

  it("conditionalFormattings must be before dataValidations", () => {
    const xform = new WorkSheetXform();
    const model = JSON.parse(fs.readFileSync(join(__dirname, "data/sheet.4.0.json")).toString());
    const xmlStream = new XmlStream();
    const options = {
      styles: new StylesXform(true),
      hyperlinks: []
    };
    xform.prepare(model, options);
    xform.render(xmlStream, model);

    const { xml } = xmlStream;
    const iConditionalFormatting = xml.indexOf("conditionalFormatting");
    const iDataValidations = xml.indexOf("dataValidations");
    expect(iConditionalFormatting).not.toBe(-1);
    expect(iDataValidations).not.toBe(-1);
    expect(iConditionalFormatting).toBeLessThan(iDataValidations);
  });
});

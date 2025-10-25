import fs from "fs";
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { testXformHelper, normalizeXml } from "../test-xform-helper.js";
import { StylesXform } from "../../../../../xlsx/xform/style/styles-xform.js";
import { XmlStream } from "../../../../../utils/xml-stream.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const expectations = [
  {
    title: "Styles with fonts",
    create() {
      return new StylesXform();
    },
    preparedModel: JSON.parse(fs.readFileSync(join(__dirname, "data/styles.1.1.json")).toString()),
    xml: fs.readFileSync(join(__dirname, "data/styles.1.2.xml")).toString(),
    get parsedModel() {
      return this.preparedModel;
    },
    tests: ["render", "renderIn", "parse"]
  }
];

describe("StylesXform", () => {
  testXformHelper(expectations);

  describe("As StyleManager", () => {
    it("Renders empty model", () => {
      const stylesXform = new StylesXform(true);
      const expectedXml = fs.readFileSync(join(__dirname, "data/styles.2.2.xml")).toString();

      const xmlStream = new XmlStream();
      stylesXform.render(xmlStream);

      // Use normalizeXml from test-xform-helper for consistent XML comparison
      expect(normalizeXml(xmlStream.xml)).toBe(normalizeXml(expectedXml));
    });
  });
});

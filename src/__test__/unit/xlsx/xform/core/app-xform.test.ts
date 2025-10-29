import { describe } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { testXformHelper } from "../test-xform-helper.js";
import { AppXform } from "../../../../../xlsx/xform/core/app-xform.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const expectations = [
  {
    title: "app.01",
    create() {
      return new AppXform();
    },
    preparedModel: { worksheets: [{ name: "Sheet1" }] },
    xml: readFileSync(join(__dirname, "./data/app.01.xml")).toString().replace(/\r\n/g, "\n"),
    tests: ["render", "renderIn"]
  },
  {
    title: "app.02",
    create() {
      return new AppXform();
    },
    preparedModel: {
      worksheets: [{ name: "Sheet1" }, { name: "Sheet2" }],
      company: "Cyber Sapiens, Ltd.",
      manager: "Guyon Roche"
    },
    xml: readFileSync(join(__dirname, "./data/app.02.xml")).toString().replace(/\r\n/g, "\n"),
    tests: ["render", "renderIn"]
  }
];

describe("AppXform", () => {
  testXformHelper(expectations);
});

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { describe } from "vitest";
import { testXformHelper } from "../test-xform-helper.js";
import { SharedStringsXform } from "../../../../../xlsx/xform/strings/shared-strings-xform.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Import JSON data
const sharedStringsData = JSON.parse(
  fs.readFileSync(path.join(__dirname, "data", "sharedStrings.json"), "utf8")
);

const expectations = [
  {
    title: "Shared Strings",
    create() {
      return new SharedStringsXform();
    },
    preparedModel: sharedStringsData,
    xml: fs.readFileSync(path.join(__dirname, "data", "sharedStrings.xml")).toString(),
    get parsedModel() {
      return this.preparedModel;
    },
    tests: ["render", "renderIn", "parse"]
  }
];

describe("SharedStringsXform", () => {
  testXformHelper(expectations);
});

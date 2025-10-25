import fs from "fs";
import { describe } from "vitest";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { testXformHelper } from "../test-xform-helper.js";
import { TableXform } from "../../../../../xlsx/xform/table/table-xform.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const expectations = [
  {
    title: "showing filter",
    create() {
      return new TableXform();
    },
    initialModel: null,
    preparedModel: JSON.parse(fs.readFileSync(join(__dirname, "data/table.1.1.json")).toString()),
    xml: fs.readFileSync(join(__dirname, "data/table.1.2.xml")).toString(),
    parsedModel: JSON.parse(fs.readFileSync(join(__dirname, "data/table.1.3.json")).toString()),
    tests: ["render", "renderIn", "parse"]
  }
];

describe("TableXform", () => {
  testXformHelper(expectations);
});

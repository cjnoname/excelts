import { describe } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { testXformHelper } from "../test-xform-helper.js";
import { RelationshipsXform } from "../../../../../xlsx/xform/core/relationships-xform.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

import { worksheetRels1 } from "./data/worksheet.rels.1.js";

const expectations: any[] = [
  {
    title: "worksheet.rels",
    create() {
      return new RelationshipsXform();
    },
    preparedModel: worksheetRels1,
    xml: readFileSync(join(__dirname, "./data/worksheet.rels.xml"))
      .toString()
      .replace(/\r\n/g, "\n"),
    get parsedModel() {
      return this.preparedModel;
    },
    tests: ["render", "renderIn", "parse"]
  }
];

describe("RelationshipsXform", () => {
  testXformHelper(expectations);
});

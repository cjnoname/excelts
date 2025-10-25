import { describe } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { testXformHelper } from "../test-xform-helper.js";
import { WorkbookXform } from "../../../../../xlsx/xform/book/workbook-xform.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

import book_1_1 from "./data/book.1.1.json" with { type: "json" };
import book_1_3 from "./data/book.1.3.json" with { type: "json" };
import book_2_3 from "./data/book.2.3.json" with { type: "json" };

const expectations = [
  {
    title: "book.1",
    create() {
      return new WorkbookXform();
    },
    preparedModel: book_1_1,
    xml: readFileSync(join(__dirname, "./data/book.1.2.xml")).toString().replace(/\r\n/g, "\n"),
    parsedModel: book_1_3,
    tests: ["render", "renderIn", "parse"]
  },
  {
    title: "book.2 - no properties",
    create() {
      return new WorkbookXform();
    },
    preparedModel: {},
    xml: readFileSync(join(__dirname, "./data/book.2.2.xml")).toString().replace(/\r\n/g, "\n"),
    parsedModel: book_2_3,
    tests: ["parse"]
  }
];

describe("WorkbookXform", () => {
  testXformHelper(expectations);
});

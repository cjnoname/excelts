import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

import { testXformHelper } from "@excel/xlsx/__tests__/xform/test-xform-helper";
import { ContentTypesXform } from "@excel/xlsx/xform/core/content-types-xform";
import { describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const expectations = [
  {
    title: "Three Sheets with shared strings",
    create() {
      return new ContentTypesXform();
    },
    preparedModel: {
      worksheets: [
        { id: 1, fileIndex: 1 },
        { id: 2, fileIndex: 2 },
        { id: 3, fileIndex: 3 }
      ],
      media: [],
      drawings: [],
      sharedStrings: { count: 1 }
    },
    xml: readFileSync(join(__dirname, "./data/content-types.01.xml"))
      .toString()
      .replace(/\r\n/g, "\n"),
    tests: ["render"]
  },
  {
    title: "Images with shared strings",
    create() {
      return new ContentTypesXform();
    },
    preparedModel: {
      worksheets: [
        { id: 1, fileIndex: 1 },
        { id: 2, fileIndex: 2 }
      ],
      media: [
        { type: "image", extension: "png" },
        // `jpg` on purpose: it is what people write, it is not a registered media type, and the fixture used to pin the
        // unregistered `image/jpg` here while the XLSB writer normalised the same extension to `image/jpeg`. One answer
        // now — see `imageContentTypeFor`.
        { type: "image", extension: "jpg" }
      ],
      drawings: [],
      sharedStrings: { count: 1 }
    },
    xml: readFileSync(join(__dirname, "./data/content-types.02.xml"))
      .toString()
      .replace(/\r\n/g, "\n"),
    tests: ["render"]
  },
  {
    title: "Three Sheets without shared strings",
    create() {
      return new ContentTypesXform();
    },
    preparedModel: {
      worksheets: [
        { id: 1, fileIndex: 1 },
        { id: 2, fileIndex: 2 },
        { id: 3, fileIndex: 3 }
      ],
      media: [],
      drawings: []
    },
    xml: readFileSync(join(__dirname, "./data/content-types.03.xml"))
      .toString()
      .replace(/\r\n/g, "\n"),
    tests: ["render"]
  },
  {
    title: "Images without shared strings",
    create() {
      return new ContentTypesXform();
    },
    preparedModel: {
      worksheets: [
        { id: 1, fileIndex: 1 },
        { id: 2, fileIndex: 2, useSharedStrings: false }
      ],
      media: [
        { type: "image", extension: "png" },
        { type: "image", extension: "jpg" }
      ],
      drawings: []
    },
    xml: readFileSync(join(__dirname, "./data/content-types.04.xml"))
      .toString()
      .replace(/\r\n/g, "\n"),
    tests: ["render"]
  }
];

describe("ContentTypesXform", () => {
  testXformHelper(expectations);

  it("parses a workbook Override when the manifest uses a namespace prefix", async () => {
    async function* xml() {
      yield `<?xml version="1.0"?>
        <ct:Types xmlns:ct="http://schemas.openxmlformats.org/package/2006/content-types">
          <ct:Override PartName="/xl/workbook.xml"
            ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.template.main+xml"/>
        </ct:Types>`;
    }
    const model = await new ContentTypesXform().parseStream(xml());
    expect(model?.workbookContentType).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.template.main+xml"
    );
  });
});

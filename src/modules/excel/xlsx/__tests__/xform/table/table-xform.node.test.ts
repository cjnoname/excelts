import fs from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

import { testXformHelper } from "@excel/xlsx/__tests__/xform/test-xform-helper";
import { TableXform } from "@excel/xlsx/xform/table/table-xform";
import { PassThrough } from "@stream";
import { parseSax } from "@xml/sax";
import { describe, expect, it } from "vitest";

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
  },
  {
    title: "table with calculatedColumnFormula child elements",
    create() {
      return new TableXform();
    },
    xml: fs.readFileSync(join(__dirname, "data/table.2.2.xml")).toString(),
    parsedModel: JSON.parse(fs.readFileSync(join(__dirname, "data/table.2.3.json")).toString()),
    tests: ["parse"]
  }
];

describe("TableXform", () => {
  testXformHelper(expectations);

  it("maps sparse filter columns by colId and preserves their criteria", async () => {
    const xml =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="1" name="Table1" displayName="Table1" ref="A1:C3">' +
      '<autoFilter ref="A1:C3"><filterColumn colId="2" hiddenButton="0"><filters blank="1"><dateGroupItem year="2025" dateTimeGrouping="year"/></filters></filterColumn></autoFilter>' +
      '<tableColumns count="3"><tableColumn id="1" name="A"/><tableColumn id="2" name="B"/><tableColumn id="3" name="C"/></tableColumns>' +
      '<tableStyleInfo name="TableStyleMedium2" showFirstColumn="0" showLastColumn="0" showRowStripes="1" showColumnStripes="0"/>' +
      "</table>";
    const stream = new PassThrough();
    stream.end(xml);
    const xform = new TableXform();
    const model = await xform.parse(parseSax(stream));

    expect(model!.columns![0].filterButton).toBeUndefined();
    expect(model!.columns![1].filterButton).toBeUndefined();
    expect(model!.columns![2]).toMatchObject({
      filterButton: true,
      rawFilterXml: [
        '<filters blank="1"><dateGroupItem year="2025" dateTimeGrouping="year"/></filters>'
      ]
    });

    xform.prepare(model!, {});
    const rendered = xform.toXml(model);
    expect(rendered).toContain(
      '<filterColumn colId="2" hiddenButton="0"><filters blank="1"><dateGroupItem year="2025" dateTimeGrouping="year"/></filters></filterColumn>'
    );
    expect(rendered).not.toContain('<filterColumn colId="0"');
    expect(rendered).not.toContain('<filterColumn colId="1"');
  });

  it("preserves custom filters through parse and render", async () => {
    const xml =
      '<table id="1" name="Table1" displayName="Table1" ref="A1:A3">' +
      '<autoFilter ref="A1:A3"><filterColumn colId="0"><customFilters and="1"><customFilter operator="greaterThan" val="5"/></customFilters></filterColumn></autoFilter>' +
      '<tableColumns count="1"><tableColumn id="1" name="A"/></tableColumns>' +
      '<tableStyleInfo name="TableStyleMedium2" showFirstColumn="0" showLastColumn="0" showRowStripes="1" showColumnStripes="0"/>' +
      "</table>";
    const stream = new PassThrough();
    stream.end(xml);
    const xform = new TableXform();
    const model = await xform.parse(parseSax(stream));

    xform.prepare(model!, {});
    const rendered = xform.toXml(model);
    expect(rendered).toContain(
      '<customFilters and="1"><customFilter operator="greaterThan" val="5"/></customFilters>'
    );
    // `CT_FilterColumn` is a choice: exactly one criteria element must be
    // emitted, never the preserved XML plus a second, re-modelled copy.
    expect(rendered.match(/<customFilters/g)).toHaveLength(1);
  });

  it("falls back to document order when colId is missing", async () => {
    const xml =
      '<table id="1" name="Table1" displayName="Table1" ref="A1:B3">' +
      '<autoFilter ref="A1:B3"><filterColumn hiddenButton="1"/><filterColumn hiddenButton="0"/></autoFilter>' +
      '<tableColumns count="2"><tableColumn id="1" name="A"/><tableColumn id="2" name="B"/></tableColumns>' +
      '<tableStyleInfo name="TableStyleMedium2"/>' +
      "</table>";
    const stream = new PassThrough();
    stream.end(xml);
    const model = await new TableXform().parse(parseSax(stream));

    expect(model!.columns![0].filterButton).toBe(false);
    expect(model!.columns![1].filterButton).toBe(true);
  });

  it("preserves root attributes the model does not interpret", async () => {
    // `totalsRowShown` is a CT_Table attribute this library does not model, and
    // real Excel files carry it. Dropping it changes the table's state.
    const xml =
      '<table id="1" name="T" displayName="T" ref="A1:A2" totalsRowShown="0" tableType="queryTable" connectionId="7">' +
      '<tableColumns count="1"><tableColumn id="1" name="A"/></tableColumns>' +
      '<tableStyleInfo name="TableStyleMedium2"/>' +
      "</table>";
    const stream = new PassThrough();
    stream.end(xml);
    const xform = new TableXform();
    const model = await xform.parse(parseSax(stream));

    xform.prepare(model!, {});
    const rendered = xform.toXml(model);
    expect(rendered).toContain('totalsRowShown="0"');
    // Reference-bearing attributes are unsafe without their connections/
    // query-table parts, which this round trip does not preserve.
    expect(rendered).not.toContain("tableType");
    expect(rendered).not.toContain("connectionId");
  });
});

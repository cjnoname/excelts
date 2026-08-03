import { XlsxParseError } from "@excel/errors";
import { testXformHelper } from "@excel/xlsx/__tests__/xform/test-xform-helper";
import { FilterColumnXform } from "@excel/xlsx/xform/table/filter-column-xform";
import { PassThrough } from "@stream";
import { parseSax } from "@xml/sax";
import { describe, expect, it } from "vitest";

const expectations = [
  {
    title: "showing filter",
    create() {
      return new FilterColumnXform();
    },
    initialModel: { filterButton: true },
    preparedModel: { colId: "0", filterButton: true },
    xml: '<filterColumn colId="0" hiddenButton="0" />',
    parsedModel: { colId: "0", filterButton: true },
    tests: ["prepare", "render", "renderIn", "parse"],
    options: { index: 0 }
  },
  {
    title: "hidden filter",
    create() {
      return new FilterColumnXform();
    },
    initialModel: { filterButton: false },
    preparedModel: { colId: "1", filterButton: false },
    xml: '<filterColumn colId="1" hiddenButton="1" />',
    parsedModel: { colId: "1", filterButton: false },
    tests: ["prepare", "render", "renderIn", "parse"],
    options: { index: 1 }
  },
  {
    title: "with custom filter",
    create() {
      return new FilterColumnXform();
    },
    initialModel: {
      filterButton: false,
      rawFilterXml: ['<customFilters><customFilter val="*brandywine*"/></customFilters>']
    },
    preparedModel: {
      colId: "0",
      filterButton: false,
      rawFilterXml: ['<customFilters><customFilter val="*brandywine*"/></customFilters>']
    },
    xml: '<filterColumn colId="0" hiddenButton="1"><customFilters><customFilter val="*brandywine*"/></customFilters></filterColumn>',
    parsedModel: {
      colId: "0",
      filterButton: false,
      rawFilterXml: ['<customFilters><customFilter val="*brandywine*"/></customFilters>']
    },
    tests: ["prepare", "render", "renderIn", "parse"],
    options: { index: 0 }
  },
  {
    title: "preserves custom filter operators and conjunction",
    create() {
      return new FilterColumnXform();
    },
    xml: '<filterColumn colId="0" hiddenButton="0"><customFilters and="1"><customFilter operator="greaterThan" val="5"/><customFilter operator="lessThan" val="9"/></customFilters></filterColumn>',
    preparedModel: {
      colId: "0",
      filterButton: true,
      rawFilterXml: [
        '<customFilters and="1"><customFilter operator="greaterThan" val="5"/><customFilter operator="lessThan" val="9"/></customFilters>'
      ]
    },
    parsedModel: {
      colId: "0",
      filterButton: true,
      rawFilterXml: [
        '<customFilters and="1"><customFilter operator="greaterThan" val="5"/><customFilter operator="lessThan" val="9"/></customFilters>'
      ]
    },
    tests: ["render", "renderIn", "parse"]
  },
  {
    title: "with multiple date group filters",
    create() {
      return new FilterColumnXform();
    },
    xml: '<filterColumn colId="0" hiddenButton="0"><filters><dateGroupItem year="2025" month="8" dateTimeGrouping="month"/><dateGroupItem year="2024" month="8" dateTimeGrouping="month"/></filters></filterColumn>',
    parsedModel: {
      colId: "0",
      filterButton: true,
      rawFilterXml: [
        '<filters><dateGroupItem year="2025" month="8" dateTimeGrouping="month"/><dateGroupItem year="2024" month="8" dateTimeGrouping="month"/></filters>'
      ]
    },
    tests: ["parse"]
  },
  {
    title: "with value and date group filters",
    create() {
      return new FilterColumnXform();
    },
    xml: '<filterColumn colId="0" hiddenButton="0"><filters><filter val="August"/><dateGroupItem year="2025" month="8" dateTimeGrouping="month"/><filter val="September"/></filters></filterColumn>',
    parsedModel: {
      colId: "0",
      filterButton: true,
      rawFilterXml: [
        '<filters><filter val="August"/><dateGroupItem year="2025" month="8" dateTimeGrouping="month"/><filter val="September"/></filters>'
      ]
    },
    tests: ["parse"]
  },
  ...[
    { name: "dynamic", xml: '<dynamicFilter type="aboveAverage"/>' },
    { name: "top 10", xml: '<top10 val="10" percent="0"/>' },
    { name: "color", xml: '<colorFilter dxfId="1" cellColor="1"/>' },
    { name: "icon", xml: '<iconFilter iconSet="3Arrows" iconId="0"/>' }
  ].map(({ name, xml }) => ({
    title: `with ${name} filter`,
    create() {
      return new FilterColumnXform();
    },
    xml: `<filterColumn colId="0" hiddenButton="0">${xml}</filterColumn>`,
    parsedModel: { colId: "0", filterButton: true, rawFilterXml: [xml] },
    tests: ["parse"]
  })),
  {
    title: "with filter extension data",
    create() {
      return new FilterColumnXform();
    },
    xml: '<filterColumn colId="0" hiddenButton="0"><extLst><ext uri="{12345678-1234-1234-1234-123456789ABC}"><x14:filter xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main" val="August"/></ext></extLst></filterColumn>',
    parsedModel: {
      colId: "0",
      filterButton: true,
      rawFilterXml: [
        '<extLst><ext uri="{12345678-1234-1234-1234-123456789ABC}"><x14:filter xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main" val="August"/></ext></extLst>'
      ]
    },
    tests: ["parse"]
  },
  {
    title: "with default hiddenButton and explicit showButton",
    create() {
      return new FilterColumnXform();
    },
    xml: '<filterColumn colId="0" showButton="0"><top10 val="10"/></filterColumn>',
    parsedModel: {
      colId: "0",
      filterButton: false,
      rawFilterXml: ['<top10 val="10"/>']
    },
    tests: ["parse"]
  },
  {
    title: "with true hiddenButton spelling",
    create() {
      return new FilterColumnXform();
    },
    xml: '<filterColumn colId="0" hiddenButton="true"><top10 val="10"/></filterColumn>',
    parsedModel: {
      colId: "0",
      filterButton: false,
      rawFilterXml: ['<top10 val="10"/>']
    },
    tests: ["parse"]
  },
  {
    title: "with text in extension data",
    create() {
      return new FilterColumnXform();
    },
    xml: '<filterColumn colId="0"><extLst><ext uri="x"><x:payload xmlns:x="urn:test">abc</x:payload></ext></extLst></filterColumn>',
    parsedModel: {
      colId: "0",
      filterButton: true,
      rawFilterXml: [
        '<extLst><ext uri="x"><x:payload xmlns:x="urn:test">abc</x:payload></ext></extLst>'
      ]
    },
    tests: ["parse"]
  }
];

describe("FilterColumnXform", () => {
  testXformHelper(expectations);

  const parseXml = async (xml: string): Promise<unknown> => {
    const stream = new PassThrough();
    stream.write(xml);
    stream.end();
    return new FilterColumnXform().parse(parseSax(stream));
  };

  it("rejects an unknown filter criteria element", async () => {
    await expect(
      parseXml('<filterColumn colId="0" hiddenButton="0"><bogusFilter val="1"/></filterColumn>')
    ).rejects.toThrow(XlsxParseError);
  });

  it("preserves future filter criteria inside filters", async () => {
    const model = (await parseXml(
      '<filterColumn colId="0" hiddenButton="0"><filters><x15:filter xmlns:x15="urn:test" val="1"/></filters></filterColumn>'
    )) as { rawFilterXml?: string[] };

    expect(model.rawFilterXml).toEqual([
      '<filters><x15:filter xmlns:x15="urn:test" val="1"/></filters>'
    ]);
  });

  it("rejects nested content inside an attribute-only criteria element", async () => {
    await expect(
      parseXml(
        '<filterColumn colId="0" hiddenButton="0"><top10 val="10"><bogus/></top10></filterColumn>'
      )
    ).rejects.toThrow(XlsxParseError);
  });

  it("preserves CDATA content inside extension data", async () => {
    const model = (await parseXml(
      '<filterColumn colId="0"><extLst><ext uri="x"><x:payload xmlns:x="urn:test"><![CDATA[a<b]]></x:payload></ext></extLst></filterColumn>'
    )) as { rawFilterXml?: string[] };

    // The lexical CDATA wrapper may normalize to escaped text, but the XML
    // value must survive rather than disappearing.
    expect(model.rawFilterXml).toEqual([
      '<extLst><ext uri="x"><x:payload xmlns:x="urn:test">a&lt;b</x:payload></ext></extLst>'
    ]);
  });
});

import { testXformHelper } from "@excel/xlsx/__tests__/xform/test-xform-helper";
import { AutoFilterXform } from "@excel/xlsx/xform/table/auto-filter-xform";
import { describe } from "vitest";

const expectations = [
  {
    title: "showing filter",
    create() {
      return new AutoFilterXform();
    },
    initialModel: {
      autoFilterRef: "A1:B10",
      columns: [
        { colId: "0", filterButton: false },
        { colId: "1", filterButton: true },
        { colId: "2", filterButton: true }
      ]
    },
    preparedModel: {
      autoFilterRef: "A1:B10",
      columns: [
        { colId: "0", filterButton: false },
        { colId: "1", filterButton: true },
        { colId: "2", filterButton: true }
      ]
    },
    xml:
      '<autoFilter ref="A1:B10">' +
      '<filterColumn colId="0" hiddenButton="1" />' +
      '<filterColumn colId="1" hiddenButton="0" />' +
      '<filterColumn colId="2" hiddenButton="0" />' +
      "</autoFilter>",
    get parsedModel() {
      return this.initialModel;
    },
    tests: ["prepare", "render", "renderIn", "parse"]
  },
  {
    title: "continues after ignored filter extension data",
    create() {
      return new AutoFilterXform();
    },
    xml:
      '<autoFilter ref="A1:B10">' +
      '<filterColumn colId="0" hiddenButton="0"><extLst><ext uri="{12345678-1234-1234-1234-123456789ABC}"><x14:filter xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main" val="August"/></ext></extLst></filterColumn>' +
      '<filterColumn colId="1" hiddenButton="1"/>' +
      "</autoFilter>",
    parsedModel: {
      autoFilterRef: "A1:B10",
      columns: [
        {
          colId: "0",
          filterButton: true,
          rawFilterXml: [
            '<extLst><ext uri="{12345678-1234-1234-1234-123456789ABC}"><x14:filter xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main" val="August"/></ext></extLst>'
          ]
        },
        { colId: "1", filterButton: false }
      ]
    },
    tests: ["parse"]
  },
  {
    title: "does not leak filter criteria between columns",
    create() {
      return new AutoFilterXform();
    },
    xml:
      '<autoFilter ref="A1:B10" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:x="urn:test" mc:Ignorable="x">' +
      '<filterColumn colId="0" hiddenButton="0"><customFilters><customFilter val="*brandywine*"/></customFilters></filterColumn>' +
      '<filterColumn colId="1" hiddenButton="0"/>' +
      "</autoFilter>",
    parsedModel: {
      autoFilterRef: "A1:B10",
      autoFilterNamespaceAttributes: {
        "xmlns:mc": "http://schemas.openxmlformats.org/markup-compatibility/2006",
        "xmlns:x": "urn:test",
        "mc:Ignorable": "x"
      },
      columns: [
        {
          colId: "0",
          filterButton: true,
          rawFilterXml: ['<customFilters><customFilter val="*brandywine*"/></customFilters>']
        },
        { colId: "1", filterButton: true }
      ]
    },
    tests: ["parse"]
  },
  {
    title: "preserves sort state and extensions",
    create() {
      return new AutoFilterXform();
    },
    xml:
      '<autoFilter ref="A1:B10">' +
      '<filterColumn colId="1"><top10 val="10"/></filterColumn>' +
      '<sortState ref="A2:B10"><sortCondition ref="B2:B10"/></sortState>' +
      '<extLst><ext uri="x"><x:data xmlns:x="urn:test">value</x:data></ext></extLst>' +
      "</autoFilter>",
    parsedModel: {
      autoFilterRef: "A1:B10",
      columns: [
        {
          colId: "1",
          filterButton: true,
          rawFilterXml: ['<top10 val="10"/>']
        }
      ],
      autoFilterSortStateXml: '<sortState ref="A2:B10"><sortCondition ref="B2:B10"/></sortState>',
      autoFilterSortStateRef: "A1:B10",
      autoFilterExtLstXml:
        '<extLst><ext uri="x"><x:data xmlns:x="urn:test">value</x:data></ext></extLst>'
    },
    tests: ["parse"]
  }
];

describe("AutoFilterXform", () => {
  testXformHelper(expectations);
});

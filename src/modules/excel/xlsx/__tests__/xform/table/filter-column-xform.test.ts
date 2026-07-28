import { testXformHelper } from "@excel/xlsx/__tests__/xform/test-xform-helper";
import { FilterColumnXform } from "@excel/xlsx/xform/table/filter-column-xform";
import { describe } from "vitest";

const expectations = [
  {
    title: "showing filter",
    create() {
      return new FilterColumnXform();
    },
    initialModel: { filterButton: true },
    preparedModel: { colId: "0", filterButton: true },
    xml: '<filterColumn colId="0" hiddenButton="0" />',
    get parsedModel() {
      return this.initialModel;
    },
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
    get parsedModel() {
      return this.initialModel;
    },
    tests: ["prepare", "render", "renderIn", "parse"],
    options: { index: 1 }
  },
  {
    title: "with custom filter",
    create() {
      return new FilterColumnXform();
    },
    initialModel: { filterButton: false, customFilters: [{ val: "*brandywine*" }] },
    preparedModel: {
      colId: "0",
      filterButton: false,
      customFilters: [{ val: "*brandywine*" }]
    },
    xml: '<filterColumn colId="0" hiddenButton="1"><customFilters><customFilter val="*brandywine*"/></customFilters></filterColumn>',
    get parsedModel() {
      return this.initialModel;
    },
    tests: ["prepare", "render", "renderIn", "parse"],
    options: { index: 0 }
  },
  {
    title: "with dateGroupItem filter",
    create() {
      return new FilterColumnXform();
    },
    initialModel: { filterButton: true },
    preparedModel: { colId: "0", filterButton: true },
    xml: '<filterColumn colId="0" hiddenButton="0"><filters><dateGroupItem year="2025" month="8" dateTimeGrouping="month"/></filters></filterColumn>',
    get parsedModel() {
      return { filterButton: true };
    },
    tests: ["parse"],
    options: { index: 0 }
  }
];

describe("FilterColumnXform", () => {
  testXformHelper(expectations);
});

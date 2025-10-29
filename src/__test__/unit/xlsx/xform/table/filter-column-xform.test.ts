import { describe } from "vitest";
import { testXformHelper } from "../test-xform-helper.js";
import { FilterColumnXform } from "../../../../../xlsx/xform/table/filter-column-xform.js";

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
  }
];

describe("FilterColumnXform", () => {
  testXformHelper(expectations);
});

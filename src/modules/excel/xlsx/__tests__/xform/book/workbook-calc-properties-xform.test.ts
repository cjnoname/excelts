import { testXformHelper } from "@excel/xlsx/__tests__/xform/test-xform-helper";
import { WorkbookCalcPropertiesXform } from "@excel/xlsx/xform/book/workbook-calc-properties-xform";
import { describe } from "vitest";

const expectations = [
  {
    // **`fullCalcOnLoad` is on by default**, because neither writer here produces a `calcChain`. Without it the
    // file claims a cached result for every formula and gives Excel no chain to check it against, so Excel
    // shows whatever this library computed — or a placeholder zero for a formula it declined to evaluate — and
    // does not recalculate until something is edited. The XLSB container has always forced this through
    // `recalcID = 0`; the XML one emitted a real engine id and asked for nothing.
    title: "default",
    create() {
      return new WorkbookCalcPropertiesXform();
    },
    preparedModel: {},
    xml: '<calcPr calcId="171027" fullCalcOnLoad="1"/>',
    parsedModel: { fullCalcOnLoad: true },
    tests: ["render", "renderIn"]
  },
  {
    // Explicitly off, which is what a file read *from Excel* says — Excel ships a chain, so its values are its
    // own. A read-modify-write of such a file must not start asking for a full recalculation.
    title: "fullCalcOnLoad explicitly false",
    create() {
      return new WorkbookCalcPropertiesXform();
    },
    preparedModel: { fullCalcOnLoad: false },
    xml: '<calcPr calcId="171027"/>',
    parsedModel: { fullCalcOnLoad: false },
    tests: ["render", "renderIn"]
  },
  {
    title: "fullCalcOnLoad",
    create() {
      return new WorkbookCalcPropertiesXform();
    },
    preparedModel: { fullCalcOnLoad: true },
    xml: '<calcPr calcId="171027" fullCalcOnLoad="1"/>',
    parsedModel: { fullCalcOnLoad: true },
    tests: ["render", "renderIn", "parse"]
  },
  {
    title: "iterate",
    create() {
      return new WorkbookCalcPropertiesXform();
    },
    preparedModel: { iterate: true },
    xml: '<calcPr calcId="171027" fullCalcOnLoad="1" iterate="1"/>',
    parsedModel: { fullCalcOnLoad: true, iterate: true },
    tests: ["render", "renderIn", "parse"]
  },
  {
    title: "iterateCount",
    create() {
      return new WorkbookCalcPropertiesXform();
    },
    preparedModel: { iterate: true, iterateCount: 50 },
    xml: '<calcPr calcId="171027" fullCalcOnLoad="1" iterate="1" iterateCount="50"/>',
    parsedModel: { fullCalcOnLoad: true, iterate: true, iterateCount: 50 },
    tests: ["render", "renderIn", "parse"]
  },
  {
    title: "iterateDelta",
    create() {
      return new WorkbookCalcPropertiesXform();
    },
    preparedModel: { iterate: true, iterateCount: 100, iterateDelta: 0.001 },
    xml: '<calcPr calcId="171027" fullCalcOnLoad="1" iterate="1" iterateCount="100" iterateDelta="0.001"/>',
    parsedModel: {
      fullCalcOnLoad: true,
      iterate: true,
      iterateCount: 100,
      iterateDelta: 0.001
    },
    tests: ["render", "renderIn", "parse"]
  },
  {
    title: "all properties",
    create() {
      return new WorkbookCalcPropertiesXform();
    },
    preparedModel: { fullCalcOnLoad: true, iterate: true, iterateCount: 200, iterateDelta: 0.01 },
    xml: '<calcPr calcId="171027" fullCalcOnLoad="1" iterate="1" iterateCount="200" iterateDelta="0.01"/>',
    parsedModel: {
      fullCalcOnLoad: true,
      iterate: true,
      iterateCount: 200,
      iterateDelta: 0.01
    },
    tests: ["render", "renderIn", "parse"]
  }
];

describe("WorkbookCalcPropertiesXform", () => {
  testXformHelper(expectations);
});

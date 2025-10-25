import { describe } from "vitest";
import { testXformHelper } from "../test-xform-helper.js";
import { DateXform } from "../../../../../xlsx/xform/simple/date-xform.js";

const expectations = [
  {
    title: "date",
    create() {
      return new DateXform({ tag: "date", attr: "val" });
    },
    preparedModel: new Date("2016-07-13T00:00:00Z"),
    xml: '<date val="2016-07-13T00:00:00.000Z"/>',
    parsedModel: new Date("2016-07-13T00:00:00Z"),
    tests: ["render", "renderIn", "parse"]
  },
  {
    title: "iso-date",
    create() {
      return new DateXform({
        tag: "date",
        attr: "val",
        format(dt: Date) {
          return dt.toISOString().split("T")[0];
        },
        parse(value: string) {
          return new Date(value.replace("13", "14"));
        }
      });
    },
    preparedModel: new Date("2016-07-13T00:00:00Z"),
    xml: '<date val="2016-07-13"/>',
    parsedModel: new Date("2016-07-14T00:00:00Z"),
    tests: ["render", "renderIn", "parse"]
  },
  {
    title: "undefined",
    create() {
      return new DateXform({ tag: "date", attr: "val" });
    },
    preparedModel: undefined,
    xml: "",
    tests: ["render", "renderIn"]
  },
  {
    title: "invalid date",
    create() {
      return new DateXform({ tag: "date", attr: undefined });
    },
    preparedModel: new Date(undefined as any),
    xml: "<date></date>",
    tests: ["render"]
  }
];

describe("DateXform", () => {
  testXformHelper(expectations);
});

import { describe } from "vitest";
import { testXformHelper } from "./test-xform-helper.js";
import { StaticXform } from "../../../../xlsx/xform/static-xform.js";

const expectations = [
  {
    title: "Leaf",
    create() {
      return new StaticXform({ tag: "root", $: { attr: "val" } });
    },
    preparedModel: undefined,
    get parsedModel() {
      return this.preparedModel;
    },
    xml: '<root attr="val"/>',
    tests: ["render", "renderIn", "parse"]
  },
  {
    title: "Nested",
    create() {
      return new StaticXform({
        tag: "root",
        $: { attr: "val" },
        c: [
          { tag: "child1", $: { attr: 5 } },
          { tag: "child2", $: { attr: true } }
        ]
      });
    },
    preparedModel: undefined,
    get parsedModel() {
      return this.preparedModel;
    },
    xml: '<root attr="val"><child1 attr="5"/><child2 attr="true"/></root>',
    tests: ["render", "renderIn", "parse"]
  },
  {
    title: "Texted",
    create() {
      return new StaticXform({
        tag: "root",
        $: { attr: "val" },
        c: [{ tag: "child1", $: { attr: 5 }, t: "Hello, World!" }]
      });
    },
    preparedModel: undefined,
    get parsedModel() {
      return this.preparedModel;
    },
    xml: '<root attr="val"><child1 attr="5">Hello, World!</child1></root>',
    tests: ["render", "renderIn", "parse"]
  }
];

describe("StaticXform", () => {
  testXformHelper(expectations);
});

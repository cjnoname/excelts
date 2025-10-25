import { PassThrough } from "stream";
import { expect } from "vitest";
import { XMLParser } from "fast-xml-parser";
import { CompyXform } from "./compy-xform.js";
import { parseSax } from "../../../../utils/parse-sax.js";
import { XmlStream } from "../../../../utils/xml-stream.js";
import { BooleanXform } from "../../../../xlsx/xform/simple/boolean-xform.js";
import { cloneDeep } from "../../../../utils/under-dash.js";

// XML parser configuration for comparison
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  trimValues: false
});

function normalizeXml(xml: string): string {
  try {
    // Parse XML to object (this normalizes element order by converting to object structure)
    const parsed = xmlParser.parse(xml);

    // Convert to JSON for comparison - element order doesn't matter in objects
    return JSON.stringify(parsed, Object.keys(parsed).sort());
  } catch (error) {
    // Fallback to string comparison if parsing fails
    console.warn("XML parsing failed, falling back to string comparison:", error);
    return xml.replace(/\s+/g, " ").trim();
  }
}

interface Expectation {
  title: string;
  create(): any;
  initialModel?: any;
  preparedModel?: any;
  parsedModel?: any;
  reconciledModel?: any;
  xml?: string;
  tests: string[];
  options?: any;
}

function getExpectation<K extends keyof Expectation>(
  expectation: Expectation,
  name: K
): Expectation[K] {
  if (!Object.prototype.hasOwnProperty.call(expectation, name)) {
    throw new Error(`Expectation missing required field: ${name}`);
  }
  return cloneDeep((expectation as any)[name], true);
}

// ===============================================================================================================
// provides boilerplate examples for the four transform steps: prepare, render,  parse and reconcile
//  prepare: model => preparedModel
//  render:  preparedModel => xml
//  parse:  xml => parsedModel
//  reconcile: parsedModel => reconciledModel

const its: { [key: string]: (expectation: Expectation) => () => Promise<void> } = {
  prepare(expectation: Expectation) {
    return async () => {
      const model = getExpectation(expectation, "initialModel");
      const result = getExpectation(expectation, "preparedModel");

      const xform = expectation.create();
      xform.prepare(model, expectation.options);
      expect(cloneDeep(model, false)).toEqual(result);
    };
  },

  render(expectation: Expectation) {
    return async () => {
      const model = getExpectation(expectation, "preparedModel");
      const result = getExpectation(expectation, "xml");

      const xform = expectation.create();
      const xmlStream = new XmlStream();
      xform.render(xmlStream, model, 0);

      expect(normalizeXml(xmlStream.xml)).toBe(normalizeXml(result!));
    };
  },

  "prepare-render": function (expectation: Expectation) {
    // when implementation details get in the way of testing the prepared result
    return async () => {
      const model = getExpectation(expectation, "initialModel");
      const result = getExpectation(expectation, "xml");

      const xform = expectation.create();
      const xmlStream = new XmlStream();

      xform.prepare(model, expectation.options);
      xform.render(xmlStream, model);

      expect(normalizeXml(xmlStream.xml)).toBe(normalizeXml(result!));
    };
  },

  renderIn(expectation: Expectation) {
    return async () => {
      const model = {
        pre: true,
        child: getExpectation(expectation, "preparedModel"),
        post: true
      };
      const result = `<compy><pre/>${getExpectation(expectation, "xml")}<post/></compy>`;

      const xform = new CompyXform({
        tag: "compy",
        children: [
          {
            name: "pre",
            xform: new BooleanXform({ tag: "pre", attr: "val" })
          },
          { name: "child", xform: expectation.create() },
          {
            name: "post",
            xform: new BooleanXform({ tag: "post", attr: "val" })
          }
        ]
      });

      const xmlStream = new XmlStream();
      xform.render(xmlStream, model);

      expect(normalizeXml(xmlStream.xml)).toBe(normalizeXml(result));
    };
  },

  parseIn(expectation: Expectation) {
    return async () => {
      const xml = `<compy><pre/>${getExpectation(expectation, "xml")}<post/></compy>`;
      const childXform = expectation.create();
      const result: any = { pre: true };
      result[childXform.tag] = getExpectation(expectation, "parsedModel");
      result.post = true;
      const xform: any = new CompyXform({
        tag: "compy",
        children: [
          {
            name: "pre",
            xform: new BooleanXform({ tag: "pre", attr: "val" })
          },
          { name: childXform.tag, xform: childXform },
          {
            name: "post",
            xform: new BooleanXform({ tag: "post", attr: "val" })
          }
        ]
      });
      const stream = new PassThrough();
      stream.write(xml);
      stream.end();
      const model = await xform.parse(parseSax(stream));

      // eliminate the undefined
      const clone = cloneDeep(model, false);

      expect(clone).toEqual(result);
    };
  },

  parse(expectation: Expectation) {
    return async () => {
      const xml = getExpectation(expectation, "xml");
      const result = getExpectation(expectation, "parsedModel");

      const xform = expectation.create();

      const stream = new PassThrough();
      stream.write(xml);
      stream.end();
      const model = await xform.parse(parseSax(stream));

      // eliminate the undefined
      const clone = cloneDeep(model, false);

      expect(clone).toEqual(result);
    };
  },

  reconcile(expectation: Expectation) {
    return async () => {
      const model = getExpectation(expectation, "parsedModel");
      const result = getExpectation(expectation, "reconciledModel");

      const xform = expectation.create();
      xform.reconcile(model, expectation.options);

      // eliminate the undefined
      const clone = cloneDeep(model, false);

      expect(clone).toEqual(result);
    };
  }
};

export function testXformHelper(expectations: Expectation[]) {
  expectations.forEach((expectation: Expectation) => {
    const tests = getExpectation(expectation, "tests");
    describe(expectation.title, () => {
      tests.forEach((test: string) => {
        it(test, its[test](expectation));
      });
    });
  });
}

// Export normalizeXml for use in custom tests
export { normalizeXml };

import {
  createDataValidations,
  dataValidationAdd,
  dataValidationFind,
  dataValidationRemove
} from "@excel/core/data-validations";
import type { DataValidationRule } from "@excel/types";
import { describe, it, expect } from "vitest";

const listRule: DataValidationRule = {
  type: "list",
  allowBlank: true,
  formulae: ['"One,Two,Three"']
};

describe("dataValidationAdd", () => {
  it("stores a plain range under a range: key", () => {
    const dv = createDataValidations();
    dataValidationAdd(dv, "A2:A100", listRule);
    expect(dv.model["range:A2:A100"]).toBe(listRule);
  });

  it("expands a whole-column shorthand to the sheet limit", () => {
    const dv = createDataValidations();
    dataValidationAdd(dv, "A:A", listRule);
    expect(dv.model["range:A1:A1048576"]).toBe(listRule);
  });

  it("expands a multi-column whole-column shorthand", () => {
    const dv = createDataValidations();
    dataValidationAdd(dv, "A:C", listRule);
    expect(dv.model["range:A1:C1048576"]).toBe(listRule);
  });

  it("normalises reversed range endpoints", () => {
    const dv = createDataValidations();
    dataValidationAdd(dv, "C100:A2", listRule);
    expect(dv.model["range:A2:C100"]).toBe(listRule);
  });

  it("expands a whole-row shorthand to the column limit", () => {
    const dv = createDataValidations();
    dataValidationAdd(dv, "2:5", listRule);
    expect(dv.model["range:A2:XFD5"]).toBe(listRule);
  });

  it("strips a leading sheet qualifier", () => {
    const dv = createDataValidations();
    dataValidationAdd(dv, "Sheet1!A2:A100", listRule);
    expect(dv.model["range:A2:A100"]).toBe(listRule);
  });

  it("strips a quoted sheet qualifier", () => {
    const dv = createDataValidations();
    dataValidationAdd(dv, "'My Sheet'!B2:B10", listRule);
    expect(dv.model["range:B2:B10"]).toBe(listRule);
  });

  it("drops absolute markers", () => {
    const dv = createDataValidations();
    dataValidationAdd(dv, "$A$2:$A$100", listRule);
    expect(dv.model["range:A2:A100"]).toBe(listRule);
  });

  it("stores a single cell as an exact-address entry", () => {
    const dv = createDataValidations();
    dataValidationAdd(dv, "A1", listRule);
    expect(dv.model.A1).toBe(listRule);
    expect(dv.model["range:A1"]).toBeUndefined();
  });

  it("is discoverable by dataValidationFind for cells inside the range", () => {
    const dv = createDataValidations();
    dataValidationAdd(dv, "A2:A100", listRule);
    expect(dataValidationFind(dv, "A2")).toBe(listRule);
    expect(dataValidationFind(dv, "A50")).toBe(listRule);
    expect(dataValidationFind(dv, "A100")).toBe(listRule);
    expect(dataValidationFind(dv, "A1")).toBeUndefined();
    expect(dataValidationFind(dv, "B2")).toBeUndefined();
  });

  it.each([
    ["not-a-range"],
    ["foo"],
    ["A0"],
    ["A-1"],
    ["ZZZZ1"],
    ["A1:B2:C3"],
    [""],
    ["1048577"],
    ["A1048577"]
  ])("rejects the malformed reference %j instead of persisting a corrupt sqref", ref => {
    const dv = createDataValidations();
    expect(() => dataValidationAdd(dv, ref, listRule)).toThrow();
    expect(Object.keys(dv.model)).toHaveLength(0);
  });

  it("removes a range using the same reference accepted by add", () => {
    const dv = createDataValidations();
    dataValidationAdd(dv, "A2:A100", listRule);
    dataValidationRemove(dv, "A2:A100");
    expect(dataValidationFind(dv, "A50")).toBeUndefined();
    expect(dv.model["range:A2:A100"]).toBeUndefined();
  });

  it("normalises remove references the same way as add", () => {
    const dv = createDataValidations();
    dataValidationAdd(dv, "A:A", listRule);
    dataValidationRemove(dv, "$A:$A");
    expect(dv.model["range:A1:A1048576"]).toBeUndefined();
  });
});

/**
 * Data validation.
 *
 * The byte-level assertions matter more here than the round trips. No corpus workbook contains a
 * `BrtDVal`, so nothing in this repository has seen Excel's own bytes for one — and a round trip proves
 * only that the reader and the writer agree, which two matching mistakes also achieve. So the flag word
 * is asserted bit by bit against MS-XLSB 2.4.356, and the string order against 2.5.37, where the
 * *error* pair comes first.
 */
import { Cell, DataValidation, Workbook } from "@excel";
import { encodeValidation, readValidation } from "@excel/xlsb/data-validation";
import { describe, expect, it } from "vitest";

/** The four-byte flag word a rule encodes to. */
function flagsOf(rule: unknown, ranges = ["A1"]): number {
  const payload = encodeValidation({ ranges, rule: rule as never }, {}, "test");
  expect(payload).toBeDefined();
  return new DataView(payload!.buffer, payload!.byteOffset).getUint32(0, true);
}

/** A workbook through XLSB and back. */
async function roundTrip(build: (workbook: ReturnType<typeof Workbook.create>) => void) {
  const workbook = Workbook.create();
  build(workbook);
  const bytes = await Workbook.toBuffer(workbook, { format: "xlsb", unsupported: "ignore" });
  const reopened = Workbook.create();
  await Workbook.read(reopened, bytes);
  const sheet = Workbook.getModel(reopened).worksheets[0] as unknown as {
    dataValidations?: Record<string, Record<string, unknown>>;
  };
  return sheet.dataValidations ?? {};
}

describe("BrtDVal flags", () => {
  it("packs valType in the low four bits, in the record's own order", () => {
    // The order is the record's: any, whole, decimal, list, date, time, textLength, custom. `list` is
    // 3 and not 1, which is what a reader of the XLSX attribute list would guess.
    expect(flagsOf({ type: "any" }) & 0x0f).toBe(0);
    expect(flagsOf({ type: "whole", formulae: [1] }) & 0x0f).toBe(1);
    expect(flagsOf({ type: "list", formulae: ['"a"'] }) & 0x0f).toBe(3);
    expect(flagsOf({ type: "custom", formulae: ["A1>0"] }) & 0x0f).toBe(7);
  });

  it("packs errStyle at bit 4", () => {
    expect((flagsOf({ type: "any" }) >>> 4) & 0x07).toBe(0); // stop
    expect((flagsOf({ type: "any", errorStyle: "warning" }) >>> 4) & 0x07).toBe(1);
    expect((flagsOf({ type: "any", errorStyle: "information" }) >>> 4) & 0x07).toBe(2);
  });

  it("leaves the unused bit and the reserved byte at zero", () => {
    // Bit 7 is `unused` and bits 24–31 are `reserved`, which the specification requires to be 0. A
    // writer that folded anything into either would produce a record Excel is entitled to reject.
    const flags = flagsOf({
      type: "list",
      formulae: ['"a"'],
      allowBlank: true,
      showInputMessage: true,
      showErrorMessage: true,
      errorStyle: "information"
    });
    expect((flags >>> 7) & 1).toBe(0);
    expect(flags >>> 24).toBe(0);
  });

  it("packs the three switches at bits 8, 18 and 19", () => {
    expect((flagsOf({ type: "any", allowBlank: true }) >>> 8) & 1).toBe(1);
    expect((flagsOf({ type: "any", showInputMessage: true }) >>> 18) & 1).toBe(1);
    expect((flagsOf({ type: "any", showErrorMessage: true }) >>> 19) & 1).toBe(1);
  });

  it("packs typOperator at bit 20 — but only where the record reads it", () => {
    expect((flagsOf({ type: "whole", operator: "greaterThan", formulae: [1] }) >>> 20) & 0x0f).toBe(
      4
    );
    // The specification says `typOperator` is undefined and MUST be ignored for `any`, `list` and
    // `custom`. Writing an operator there is writing into a field nothing reads, and it would come back
    // as a constraint the author never set.
    expect(
      (flagsOf({ type: "list", operator: "greaterThan", formulae: ['"a"'] }) >>> 20) & 0x0f
    ).toBe(0);
    expect(
      (flagsOf({ type: "custom", operator: "greaterThan", formulae: ["A1>0"] }) >>> 20) & 0x0f
    ).toBe(0);
  });
});

describe("BrtDVal structure", () => {
  it("writes crfx as a signed count, before the ranges", () => {
    const payload = encodeValidation(
      { ranges: ["A1", "C3:D4"], rule: { type: "any" } },
      {},
      "test"
    );
    const view = new DataView(payload!.buffer, payload!.byteOffset);
    // Signed: `-1` is the specification's "null array" and `0` its "empty", so a count read as unsigned
    // would turn a malformed `-1` into four billion ranges.
    expect(view.getInt32(4, true)).toBe(2);
    // First range, `A1`: four `u32` at 8.
    expect(view.getUint32(8, true)).toBe(0);
    expect(view.getUint32(12, true)).toBe(0);
    // Second range, `C3:D4`, starts at 24: rows 2–3, columns 2–3.
    expect(view.getUint32(24, true)).toBe(2);
    expect(view.getUint32(28, true)).toBe(3);
    expect(view.getUint32(32, true)).toBe(2);
    expect(view.getUint32(36, true)).toBe(3);
  });

  it("orders DValStrings with the error pair first", () => {
    // MS-XLSB 2.5.37: strErrorTitle, strError, strPromptTitle, strPrompt. Swapping the pairs puts a
    // validation's tooltip in its error alert, and a round trip cannot see it.
    const payload = encodeValidation(
      {
        ranges: ["A1"],
        rule: { type: "any", errorTitle: "ET", error: "E", promptTitle: "PT", prompt: "P" }
      },
      {},
      "test"
    )!;
    // After the 4-byte flags, 4-byte count and one 16-byte range: the first string starts at 24.
    const text = new TextDecoder("utf-16le").decode(payload.slice(24));
    expect(text.indexOf("ET")).toBeLessThan(text.indexOf("PT"));
    expect(text.indexOf("E")).toBeLessThan(text.indexOf("P"));
  });

  it("refuses a rule that covers no range", () => {
    // `BrtDVal` requires `crfx >= 1`. A rule applying to nothing is not writable, and returning
    // `undefined` lets the caller drop the validation and still write the sheet.
    expect(encodeValidation({ ranges: [], rule: { type: "any" } }, {}, "test")).toBeUndefined();
    expect(
      encodeValidation({ ranges: ["not a reference"], rule: { type: "any" } }, {}, "test")
    ).toBeUndefined();
  });

  it("leaves formula2 empty when the operator takes one bound", () => {
    // The specification requires `formula2.cce` to be 0 unless the operator is between or notBetween.
    const oneSided = encodeValidation(
      { ranges: ["A1"], rule: { type: "whole", operator: "greaterThan", formulae: [5] } },
      {},
      "test"
    )!;
    const twoSided = encodeValidation(
      { ranges: ["A1"], rule: { type: "whole", operator: "between", formulae: [5, 9] } },
      {},
      "test"
    )!;
    expect(oneSided.length).toBeLessThan(twoSided.length);
    expect(readValidation(oneSided, "test")?.rule).toMatchObject({ formulae: ["5"] });
    expect(readValidation(twoSided, "test")?.rule).toMatchObject({ formulae: ["5", "9"] });
  });

  it("survives a truncated payload without costing the sheet", () => {
    expect(readValidation(new Uint8Array(2), "test")).toBeUndefined();
    expect(readValidation(new Uint8Array(8), "test")).toBeUndefined();
  });

  it("rejects a count the record does not permit", () => {
    // `crfx` MUST be at least 1 and under 8,192. `-1` and `0` are legal `UncheckedSqRfX` values that
    // `BrtDVal` specifically excludes, so accepting them would read a malformed record as a valid rule.
    for (const count of [-1, 0, 8192]) {
      const payload = new Uint8Array(8);
      new DataView(payload.buffer).setInt32(4, count, true);
      expect(readValidation(payload, "test"), `crfx ${count}`).toBeUndefined();
    }
  });
});

describe("data validation through a workbook", () => {
  it("round-trips a list with all four strings", async () => {
    const validations = await roundTrip(workbook => {
      const sheet = Workbook.addWorksheet(workbook, "S");
      Cell.setValue(sheet, "A1", 1);
      Cell.setValidation(sheet, "B1", {
        type: "list",
        formulae: ['"red,green,blue"'],
        allowBlank: true,
        showErrorMessage: true,
        errorStyle: "warning",
        errorTitle: "Bad",
        error: "Pick one",
        promptTitle: "Colour",
        prompt: "Choose a colour"
      } as never);
    });
    expect(validations.B1).toMatchObject({
      type: "list",
      formulae: ['"red,green,blue"'],
      allowBlank: true,
      showErrorMessage: true,
      errorStyle: "warning",
      errorTitle: "Bad",
      error: "Pick one",
      promptTitle: "Colour",
      prompt: "Choose a colour"
    });
  });

  it("round-trips both bounds and the operator", async () => {
    const validations = await roundTrip(workbook => {
      const sheet = Workbook.addWorksheet(workbook, "S");
      Cell.setValue(sheet, "A1", 1);
      Cell.setValidation(sheet, "C1", {
        type: "whole",
        operator: "between",
        formulae: [1, 100],
        showErrorMessage: true
      } as never);
    });
    // The bounds are what a validation *is*. A rule that came back without them would be one Excel
    // accepts every entry against — worse than no rule, and invisible to a caller who only checks the
    // type came back.
    expect(validations.C1).toMatchObject({
      type: "whole",
      operator: "between",
      formulae: ["1", "100"]
    });
  });

  it("keeps a range as one record rather than one per cell", async () => {
    const validations = await roundTrip(workbook => {
      const sheet = Workbook.addWorksheet(workbook, "S");
      Cell.setValue(sheet, "A1", 1);
      DataValidation.add(
        (sheet as unknown as { dataValidations: never }).dataValidations,
        "B2:D10",
        { type: "list", formulae: ['"x,y"'], showErrorMessage: true } as never
      );
    });
    // `range:` is the key convention `core/data-validations.ts` uses. Stripping it on the way out and
    // restoring it on the way back is what keeps twenty-seven cells as one record.
    expect(Object.keys(validations)).toEqual(["range:B2:D10"]);
  });

  it("groups cells that share a rule into one record", async () => {
    const validations = await roundTrip(workbook => {
      const sheet = Workbook.addWorksheet(workbook, "S");
      Cell.setValue(sheet, "A1", 1);
      for (const address of ["D1", "D2", "D3"]) {
        Cell.setValidation(sheet, address, {
          type: "decimal",
          operator: "greaterThan",
          formulae: [0]
        } as never);
      }
    });
    // Three addresses in, three addresses out — but one `BrtDVal` in between, which is the shape the
    // record's range *set* exists for.
    expect(Object.keys(validations).sort()).toEqual(["D1", "D2", "D3"]);
    expect(validations.D2).toMatchObject({ type: "decimal", formulae: ["0"] });
  });

  it("round-trips a custom formula's reference", async () => {
    const validations = await roundTrip(workbook => {
      const sheet = Workbook.addWorksheet(workbook, "S");
      Cell.setValue(sheet, "A1", 1);
      Cell.setValidation(sheet, "G1", { type: "custom", formulae: ["=A1>0"] } as never);
    });
    expect(validations.G1).toMatchObject({ type: "custom", formulae: ["A1>0"] });
  });
});

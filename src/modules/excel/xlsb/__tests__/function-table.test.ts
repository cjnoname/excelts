/**
 * The `Ftab` function table and `PtgList`'s identifier, pinned against the specification.
 *
 * Both were wrong in a way no existing test could see, and for the same structural reason: the encoder and
 * the decoder share one table and one bit-mask, so each defect round-tripped through this codec perfectly and
 * only Excel disagreed. A test that writes and reads cannot find that. These assertions therefore compare
 * against **transcribed constants**, not against the codec's own behaviour.
 */
import { FUNCTION_TABLES, encodePtg, type PtgContext } from "@excel/xlsb/formula/ptg";
import { parse } from "@formula/syntax/parser";
import { tokenize } from "@formula/syntax/tokenizer";
import { describe, expect, it } from "vitest";

/**
 * Every pair that was wrong, with what it used to encode.
 *
 * Transcribed from MS-XLSB 2.5.98.10. The third column is the function the old id *actually* named — the
 * point being that each of these silently changed the meaning of a formula rather than failing to write it.
 */
const CORRECTED: readonly (readonly [name: string, id: number, wasActually: string])[] = [
  ["TEXT", 0x0030, "INDIRECT"],
  ["FIND", 0x007c, "SEARCH"],
  ["ISNUMBER", 0x0080, "CHAR"],
  ["STDEVP", 0x00c1, "DEVSQ"],
  ["FINDB", 0x00cd, "FIND"],
  ["ODD", 0x012a, "FISHER"],
  ["GETPIVOTDATA", 0x0166, "STDEVA"],
  ["IFERROR", 0x01e0, "ISEVEN"],
  ["COUNTIFS", 0x01e1, "BESSELY"],
  ["SUMIFS", 0x01e2, "BESSELI"],
  ["AVERAGEIF", 0x01e3, "XNPV"],
  ["AVERAGEIFS", 0x01e4, "PRICEMAT"]
];

/** A handful spread across the table, to catch a wholesale shift that the twelve above would survive. */
const SPOT_CHECKS: readonly (readonly [string, number])[] = [
  ["COUNT", 0x0000],
  ["SUM", 0x0004],
  ["ROUND", 0x001b],
  ["SEARCH", 0x0052],
  ["CHAR", 0x006f],
  ["COUNTA", 0x00a9],
  ["MEDIAN", 0x00e3],
  ["AVEDEV", 0x010d],
  ["CONCATENATE", 0x0150],
  ["SUBTOTAL", 0x0158],
  ["SUMIF", 0x0159],
  ["HYPERLINK", 0x0167],
  ["XIRR", 0x01ad],
  ["NETWORKDAYS", 0x01d8]
];

const CONTEXT: PtgContext = {
  sheetNames: ["S"],
  tables: new Map([["T", { id: 1, columns: ["A", "B"], sheet: "S" }]])
};

/**
 * The `iftab` a call encodes to, whichever call token it uses.
 *
 * **Two tokens, and the difference is one byte.** A variadic function is called through `PtgFuncVar` — ptg
 * `0x42`, an argument count, then the id — and a fixed-arity one through `PtgFunc`, which is ptg `0x41` and the
 * id with *no* count, because the count is implied. This helper asserted `0x42` unconditionally, which was
 * correct only while the encoder emitted `PtgFuncVar` for everything; that was the defect Excel repaired.
 */
function iftabOf(formula: string): number {
  const bytes = encodePtg(parse(tokenize(formula)), CONTEXT, "test");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fixed = bytes[bytes.byteLength - 3] === 0x41;
  expect(
    fixed || bytes[bytes.byteLength - 4] === 0x42,
    `${formula} should end in a call token`
  ).toBe(true);
  return view.getUint16(bytes.byteLength - 2, true);
}

/** Whether a formula's call is encoded as `PtgFunc` — the fixed-arity token. */
function usesFixedArityToken(formula: string): boolean {
  const bytes = encodePtg(parse(tokenize(formula)), CONTEXT, "test");
  return bytes[bytes.byteLength - 3] === 0x41;
}

/**
 * A call with the right number of arguments for `name`.
 *
 * A fixed-arity function cannot be called with the wrong count — the token has nowhere to record one — so the
 * encoder refuses it, and a test that always passed one argument would be testing the refusal. The counts here
 * are the smallest that satisfy each signature.
 */
const ARGUMENTS: ReadonlyMap<string, string> = new Map([
  ["TEXT", "1,1"],
  ["ROUND", "1,1"],
  ["MOD", "1,1"],
  ["ODD", "1"],
  ["CHAR", "1"],
  ["ISNUMBER", "1"],
  ["ISEVEN", "1"],
  ["FISHER", "1"],
  ["INDIRECT", "1"],
  ["SEARCH", "1,1"],
  ["FIND", "1,1"],
  ["FINDB", "1,1"],
  ["STDEVP", "1"],
  ["DEVSQ", "1"],
  ["STDEVA", "1"],
  ["GETPIVOTDATA", "1,1"],
  ["IFERROR", "1,1"],
  ["COUNTIFS", "1,1"],
  ["BESSELY", "1,1"],
  ["SUMIFS", "1,1,1"],
  ["BESSELI", "1,1"],
  ["AVERAGEIF", "1,1"],
  ["XNPV", "1,1,1"],
  ["AVERAGEIFS", "1,1,1"],
  ["PRICEMAT", "1,1,1,1,1"],
  ["CUMIPMT", "1,1,1,1,1,1"],
  ["ODDFYIELD", "1,1,1,1,1,1,1,1"],
  ["THAIYEAR", "1"],
  ["SET.NAME", "1"],
  ["GET.CELL", "1"],
  ["SUBTOTAL", "109,1"],
  ["CUBEVALUE", "1"]
]);

function callTo(name: string): string {
  return `${name}(${ARGUMENTS.get(name) ?? "1"})`;
}

describe("Ftab", () => {
  it.each(CORRECTED)("encodes %s as 0x%s and no longer as %s", (name, id, wasActually) => {
    expect(iftabOf(callTo(name))).toBe(id);
    // The old id belongs to a different function, which is what made the defect silent.
    expect(iftabOf(callTo(wasActually))).not.toBe(iftabOf(callTo(name)));
  });

  it.each(SPOT_CHECKS)("encodes %s as the specification's id", (name, id) => {
    expect(iftabOf(callTo(name))).toBe(id);
  });

  it("covers the whole table rather than a curated subset", () => {
    // The failure mode of a hand-maintained subset is that it stops growing silently: this table sat at 104
    // of 475 entries and refused every other function by name, so a workbook using one simply lost the
    // formula. Probed through the encoder rather than by reading the table, so the assertion is about what a
    // caller gets. Each of these was refused before and is spread across the id space — including the two
    // macro-sheet commands, which are real `iftab` values a macro sheet needs.
    for (const [name, id] of [
      ["SUBTOTAL", 0x0158],
      ["BESSELI", 0x01ac],
      ["PRICEMAT", 0x01af],
      ["CUMIPMT", 0x01c0],
      ["ODDFYIELD", 0x01cf],
      ["THAIYEAR", 0x017a],
      ["CUBEVALUE", 0x017c],
      ["SET.NAME", 0x0058],
      ["GET.CELL", 0x00b9]
    ] as const) {
      // Through `callTo`, because most of these are fixed-arity and a one-argument call to one is now refused —
      // correctly. The first version of this test passed `(1)` to all nine and failed on `BESSELI`.
      expect(iftabOf(callTo(name)), name).toBe(id);
    }
  });

  it("calls a fixed-arity function through PtgFunc and a variadic one through PtgFuncVar", () => {
    // **The two tokens are not interchangeable**, and this encoder used only `PtgFuncVar`. Excel answered
    // `Repaired Records: Conditional formatting` in six sheets of one workbook, because the rule's formula called
    // `MOD` — exactly two arguments — through the variadic token. Its own bytes are `41 27 00` where this wrote
    // `42 02 27 00`.
    expect(usesFixedArityToken("MOD(1,1)")).toBe(true);
    expect(usesFixedArityToken("ROUND(1,1)")).toBe(true);
    expect(usesFixedArityToken("PI()")).toBe(true);
    // Variadic, so the count has to be carried.
    expect(usesFixedArityToken("SUM(1,2,3)")).toBe(false);
    expect(usesFixedArityToken("SUBTOTAL(109,1)")).toBe(false);
  });

  it("refuses a fixed-arity call with the wrong number of arguments", () => {
    // The token has nowhere to put a count, so an arity mismatch cannot be *expressed*. Writing it anyway would
    // silently change what the formula computes — the implied count would win.
    expect(() => encodePtg(parse(tokenize("MOD(1)")), CONTEXT, "test")).toThrow(/exactly 2/);
    expect(() => encodePtg(parse(tokenize("MOD(1,2,3)")), CONTEXT, "test")).toThrow(/exactly 2/);
  });

  it("still refuses a future function, which has no iftab at all", () => {
    // `XLOOKUP` and friends are encoded as a `PtgName` with `fFutureFunction` set, not as an `iftab`. Refusing
    // by name is correct until that machinery exists; encoding one as a nearby id would be the same class of
    // defect the twelve corrections above fix.
    expect(() => iftabOf("XLOOKUP(1)")).toThrow(/XLOOKUP/);
  });
});

describe("PtgList", () => {
  it("writes 0x18 with no operand class", () => {
    const bytes = encodePtg(parse(tokenize("SUM(T[A])")), CONTEXT, "test");
    // **Exactly 0x18.** The `ptg` field is seven bits wide and MUST hold 0x18, so there is no class tag to
    // add; OR-ing one in overwrote bit 5 of the identifier and produced 0x38. The decoder's `raw & 0x1f`
    // mapped that back to 0x18, which is why writing and reading it agreed while Excel did not.
    expect(bytes[0]).toBe(0x18);
    // The mandatory `eptg`. Asserted beside it because the pair is what identifies the token.
    expect(bytes[1]).toBe(0x19);
  });
});

/**
 * The two tables against each other, which nothing checked.
 *
 * **`FUNCTION_TABLE` and `FIXED_ARITY` are two transcriptions of one specification table, related only by a bare
 * number** — one from its name column, the other from a syntax judgement on its `Parameters` column. The decoder looks
 * each up separately and so does the encoder, so an id in one and not the other degrades silently.
 *
 * Why that is worth a structural check rather than more spot values: a wrong arity produces a file Excel opens without
 * complaint and evaluates differently, because `PtgFunc` has nowhere to record the real argument count — and a round
 * trip cannot see it, since encoder and decoder share the same wrong entry. It is the shape of the twelve `iftab`
 * defects this table's own history records. The cases already here pin individual pairs; these pin the *relation*.
 */
describe("the two function tables agree with each other", () => {
  it("gives every id with an arity a name as well", () => {
    // An `iftab` with an arity and no name decodes to nothing while still being encodable, which is a one-way function.
    const names = new Map(FUNCTION_TABLES.names);
    const orphans = FUNCTION_TABLES.arities
      .filter(([id]) => !names.has(id))
      .map(([id]) => `0x${id.toString(16)}`);
    expect(orphans).toEqual([]);
  });

  it("has no duplicate id or name in the name table", () => {
    // A duplicate id means the later entry wins in `FUNCTION_NAME_BY_ID` and the earlier one is unreachable; a duplicate
    // name means two ids claim it and `FUNCTION_ID_BY_NAME` silently picks one. Both are how a rename goes half-applied.
    const ids = FUNCTION_TABLES.names.map(([id]) => id);
    const names = FUNCTION_TABLES.names.map(([, name]) => name);
    expect(ids).toHaveLength(new Set(ids).size);
    expect(names).toHaveLength(new Set(names).size);
  });

  it("has no duplicate id in the arity table", () => {
    const ids = FUNCTION_TABLES.arities.map(([id]) => id);
    expect(ids).toHaveLength(new Set(ids).size);
  });

  it("holds the counts it is expected to hold", () => {
    // Pinned so a bulk edit that drops rows is a failure rather than a quieter table. Update deliberately.
    expect(FUNCTION_TABLES.names).toHaveLength(475);
    expect(FUNCTION_TABLES.arities).toHaveLength(256);
  });

  it("states an arity that is a plausible parameter count", () => {
    // A negative or absurd arity would be a transcription slip that every other check here would pass over.
    for (const [id, arity] of FUNCTION_TABLES.arities) {
      expect(Number.isInteger(arity), `0x${id.toString(16)}`).toBe(true);
      expect(arity, `0x${id.toString(16)}`).toBeGreaterThanOrEqual(0);
      expect(arity, `0x${id.toString(16)}`).toBeLessThanOrEqual(30);
    }
  });
});

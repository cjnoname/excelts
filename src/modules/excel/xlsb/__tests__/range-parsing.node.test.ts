/**
 * One range parser for the whole XLSB writer, and the two policies it replaced.
 *
 * **Five call sites had two different answers about the same reference.** Four of them — conditional formats, data
 * validations, tables and auto filters — carried a byte-identical local `tryDecodeRange` that decoded through
 * `utils/address`'s `decodeRange` and passed an *inverted* range straight into an `RfX`. The fifth, merges, had its own
 * regex-based `parseRange` that refused an inverted range, with a comment explaining that the validator calls it
 * `coordinate-range-inverted`. So one package could carry a refused merge next to four written-inverted records, each
 * justified by the other's absence.
 *
 * The root was inside `utils/` itself: `colCache.decode("B2:A1")` normalises to `A1:B2` while
 * `utils/address.decodeRange("B2:A1")` returns `s = B2, e = A1`. The normalising answer is right — the two spellings name
 * the same rectangle — so refusing lost a range the caller had described perfectly well.
 *
 * **And `decodeCell` throws.** Three guards written as `if (x === undefined) return …` were therefore unreachable, and a
 * malformed `ref` or `sharedFormula` took the whole write down with `InvalidAddressError` instead of degrading to the
 * reported loss the code claimed.
 */
import { Cell, Workbook, Worksheet } from "@excel";
import { tryDecodeRange } from "@excel/xlsb/binary";
import { mergesFromModel } from "@excel/xlsb/write/model-adapter";
import { describe, expect, it } from "vitest";

/** The rectangle `A1:B2` denotes, whichever way it is spelled. */
const A1_B2 = { firstRow: 0, lastRow: 1, firstColumn: 0, lastColumn: 1 };

describe("the shared range parser", () => {
  it.each([
    ["A1:B2", A1_B2, "the ordinary form"],
    ["B2:A1", A1_B2, "inverted — the same rectangle"],
    ["$A$1:$B$2", A1_B2, "absolute markers"],
    ["a1:b2", A1_B2, "lower case"],
    ["A1", { firstRow: 0, lastRow: 0, firstColumn: 0, lastColumn: 0 }, "a single cell, as 1×1"]
  ])("reads %s — %s", (reference, expected) => {
    expect(tryDecodeRange(reference)).toEqual(expected);
  });

  it.each([
    ["1:2", "a whole-row span: no columns"],
    ["A:B", "a whole-column span: no rows"],
    ["", "empty"],
    ["not a range", "nonsense"],
    ["A1:", "a missing second end"]
  ])("refuses %s — %s", reference => {
    // `RfX` carries four bounded indices, so an unbounded reference has nothing to write. `1:2` is the one that matters:
    // a rows-only check let it through with `firstColumn: null`.
    expect(tryDecodeRange(reference)).toBeUndefined();
  });

  it("never throws, whatever it is handed", () => {
    // The property the three unreachable guards assumed and `decodeCell` does not provide.
    for (const reference of ["", "@@", "$", ":", "A0", "AAAAA1", "1", "A", "Sheet1!A1", "🙂"]) {
      expect(() => tryDecodeRange(reference)).not.toThrow();
    }
  });
});

describe("what merges add on top of it", () => {
  it.each(["A1", "1:2", "A:B"])("reports %s", reference => {
    // A single cell is a legitimate 1×1 range for a conditional format and not a merge Excel will make, so the
    // "more than one cell" rule belongs to this caller rather than to the shared parser.
    const result = mergesFromModel({ mergeCells: [reference] } as never);
    expect(result.ranges).toHaveLength(0);
    expect(result.unsupported).toEqual([`${reference}: merge range`]);
  });

  it.each(["A1:B2", "B2:A1", "$A$1:$B$2"])("accepts %s", reference => {
    const result = mergesFromModel({ mergeCells: [reference] } as never);
    expect(result.unsupported).toEqual([]);
    expect(result.ranges).toEqual([A1_B2]);
  });
});

describe("a malformed reference degrades instead of crashing the write", () => {
  it.each([
    [
      "an array formula with no range",
      { formula: "SUM(B1:B2)", result: 3, shareType: "array", ref: "" }
    ],
    ["a follower with an empty master", { formula: "SUM(B1:B2)", result: 3, sharedFormula: "" }],
    ["a follower with a nonsense master", { formula: "SUM(B1:B2)", result: 3, sharedFormula: "@@" }]
  ])("survives %s", async (_label, value) => {
    // Each of these threw `InvalidAddressError` out of `Workbook.toBuffer` — not a reported loss, the entire write.
    const workbook = Workbook.create();
    Cell.setValue(Workbook.addWorksheet(workbook, "S"), "A1", value as never);
    const bytes = await Workbook.toBuffer(workbook, { format: "xlsb", unsupported: "ignore" });
    expect(bytes.length).toBeGreaterThan(0);
    // And the package is still readable, so "degraded" means degraded rather than corrupted.
    const reopened = Workbook.create();
    await Workbook.read(reopened, bytes);
    expect(Workbook.getWorksheets(reopened).map(sheet => Worksheet.getName(sheet))).toEqual(["S"]);
  });

  it("reports the loss rather than passing silently", async () => {
    // The other half: degrading must not be quiet. The default policy refuses, which is how a caller learns.
    //
    // A *follower* carries `sharedFormula` and no `formula` of its own — that is the shape `followerCell` handles, and
    // giving a cell both makes it an ordinary formula cell that never reaches the branch. `"@@"` rather than `""`
    // because `Cell.setValue` treats the empty string as an absent field, so it never reaches the writer either.
    const workbook = Workbook.create();
    Cell.setValue(Workbook.addWorksheet(workbook, "S"), "A1", {
      result: 3,
      sharedFormula: "@@"
    } as never);
    await expect(Workbook.toBuffer(workbook, { format: "xlsb" })).rejects.toThrow(/shared formula/);
  });
});

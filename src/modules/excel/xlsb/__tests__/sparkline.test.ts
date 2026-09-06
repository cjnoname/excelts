import { extractAll } from "@archive/unzip/extract";
/**
 * Sparklines.
 *
 * **Every sparkline record is a *future record*,** which is what sets them apart from everything else this
 * module writes. A future record begins with an `FRTHeader` — four flag bits saying which of four optional
 * blocks follow — and for a sparkline the blocks *are* the content: the cell it occupies is an `FRTSqrefs`
 * and the range it plots is an `FRTFormulas` holding one `PtgArea3d`.
 *
 * The nesting is where this goes wrong quietly. `FRTSqrefs` is a count of `FRTSqref`, and each `FRTSqref`
 * contains an `UncheckedSqRfX` which is *itself* a count of ranges — two levels, both of which the
 * specification requires to be 1, with `rwFirst == rwLast` because a sparkline occupies one cell.
 */
import { Sparkline, Workbook, Worksheet } from "@excel";
import { iterateInterpretableRecords } from "@excel/xlsb/binary";
import { sparklineRecords } from "@excel/xlsb/sparkline";
import { recordSpec } from "@excel/xlsb/spec/records";
import { describe, expect, it } from "vitest";

/** The records a group encodes to, by name. */
function namesOf(group: Parameters<typeof sparklineRecords>[0]): (string | undefined)[] {
  return sparklineRecords(group, { sheetNames: ["S"] }, "S").map(
    entry => recordSpec(entry.id)?.name
  );
}

/** One record's payload, by name. */
function payloadOf(
  group: Parameters<typeof sparklineRecords>[0],
  name: string
): Uint8Array | undefined {
  const found = sparklineRecords(group, { sheetNames: ["S"] }, "S").find(
    entry => recordSpec(entry.id)?.name === name
  );
  return found?.payload;
}

const GROUP = [{ type: "line", sparklines: [{ cellRef: "E1", dataRef: "A1:C1" }] }] as Parameters<
  typeof sparklineRecords
>[0];

describe("sparkline record nesting", () => {
  it("wraps the collection in a future-record block, the way Excel does", () => {
    // **`BrtFRTBegin`/`BrtFRTEnd` were missing.** Verified against a sparkline Excel created itself
    // (`tmp/excel-sparkline-reference.xlsb`): the whole collection sits inside a wrapper. Without one the
    // records lie in the sheet's ordinary stream, where a reader that does not know them cannot step over
    // them — which is the entire purpose of the mechanism.
    expect(namesOf(GROUP)).toEqual([
      "BrtFRTBegin",
      "BrtBeginSparklineGroups",
      "BrtBeginSparklineGroup",
      "BrtBeginSparklines",
      "BrtSparkline",
      "BrtEndSparklines",
      "BrtEndSparklineGroup",
      "BrtEndSparklineGroups",
      "BrtFRTEnd"
    ]);
  });

  it("leaves the collection delimiters empty rather than giving them an FRTHeader", () => {
    // Four zero bytes were written for each, on the reasoning that every record here is a future record and
    // therefore carries a header. Excel writes **nothing** for these two while `BrtBeginSparklineGroup` does
    // carry one, so the reasoning was too uniform. The wrapper marks the block; the delimiters carry no content.
    // `?? 0` because a record emitted with no payload carries `undefined` rather than an empty array, and both
    // spellings mean the same zero bytes on the wire.
    expect(payloadOf(GROUP, "BrtBeginSparklines")?.length ?? 0).toBe(0);
    expect(payloadOf(GROUP, "BrtBeginSparklineGroups")?.length ?? 0).toBe(0);
  });

  it("sets fSqref and fFormula on a sparkline, and nothing else", () => {
    // Bit 1 and bit 2. `fRef` and `fRelID` are the other two, and a sparkline uses neither — setting one
    // would make a reader look for a block that is not there and misread everything after it.
    const payload = payloadOf(GROUP, "BrtSparkline")!;
    expect(new DataView(payload.buffer, payload.byteOffset).getUint32(0, true)).toBe(0x06);
  });

  it("counts one sqref and one range, at the offsets Excel uses", () => {
    // Two levels of counting: `csqref` then `crfx`. Both 1 for a sparkline.
    //
    // **`crfx` follows the flag word directly — there is no reserved word between them.** One was written, and
    // it pushed `crfx` onto the range's first row, so Excel read zero ranges. The record still measured 63
    // bytes, because a missing `cb` further on was also four: two errors cancelling in the total, which is why
    // a length assertion could not see either. The offsets are therefore spelled out here rather than left to
    // a total.
    const payload = payloadOf(GROUP, "BrtSparkline")!;
    const view = new DataView(payload.buffer, payload.byteOffset);
    expect(view.getUint32(4, true)).toBe(1); // csqref
    expect(view.getUint32(8, true)).toBe(1 << 1); // FRTSqref flags, fDoAdjust
    expect(view.getInt32(12, true)).toBe(1); // crfx, immediately after the flags
    // And the cell is one cell: rwFirst == rwLast, colFirst == colLast.
    expect(view.getUint32(16, true)).toBe(view.getUint32(20, true));
    expect(view.getUint32(24, true)).toBe(view.getUint32(28, true));
    // `cformula`, its flag word, then **both lengths before the tokens**: `cce` then `cb`.
    expect(view.getUint32(32, true)).toBe(1); // cformula
    expect(view.getUint32(36, true)).toBe(1 << 1); // FRTFormula flags
    expect(view.getUint32(44, true)).toBe(0); // cb, the ancillary block — empty, and it precedes the tokens
    expect(payload).toHaveLength(48 + view.getUint32(40, true)); // cce accounts for the rest
  });

  it("qualifies the data range with the sheet name", () => {
    // The record requires a `PtgArea3d`, and an unqualified `A1:C1` parses to a plain `PtgArea` — a form
    // this record does not accept. So a group whose model leaves the sheet off still has to produce one.
    const unqualified = payloadOf(GROUP, "BrtSparkline")!;
    const qualified = payloadOf(
      [{ type: "line", sparklines: [{ cellRef: "E1", dataRef: "S!A1:C1" }] }] as never,
      "BrtSparkline"
    )!;
    expect(unqualified.length).toBe(qualified.length);
  });

  it("drops a group with no sparklines rather than writing an empty collection", () => {
    expect(namesOf([{ type: "line", sparklines: [] }] as never)).toEqual([]);
    expect(namesOf([])).toEqual([]);
  });
});

describe("BrtBeginSparklineGroup", () => {
  /** The group record's flag word. */
  function flagsOf(group: Record<string, unknown>): number {
    const payload = payloadOf(
      [{ sparklines: [{ cellRef: "E1", dataRef: "A1:C1" }], ...group }] as never,
      "BrtBeginSparklineGroup"
    )!;
    // Past the empty `FRTHeader`.
    return new DataView(payload.buffer, payload.byteOffset).getUint32(4, true);
  }

  it("treats fShowEmptyCellAsZero as a two-bit enumeration, not a flag", () => {
    // 0 zero, 1 gap, 2 interpolated. Reading it as one bit turns "span" into "gap".
    expect((flagsOf({ displayEmptyCellsAs: "zero" }) >>> 1) & 0x03).toBe(0);
    expect((flagsOf({ displayEmptyCellsAs: "gap" }) >>> 1) & 0x03).toBe(1);
    expect((flagsOf({ displayEmptyCellsAs: "span" }) >>> 1) & 0x03).toBe(2);
  });

  it("packs each display flag at its own bit", () => {
    expect(flagsOf({ markers: true }) & (1 << 3)).not.toBe(0);
    expect(flagsOf({ high: true }) & (1 << 4)).not.toBe(0);
    expect(flagsOf({ low: true }) & (1 << 5)).not.toBe(0);
    expect(flagsOf({ first: true }) & (1 << 6)).not.toBe(0);
    expect(flagsOf({ last: true }) & (1 << 7)).not.toBe(0);
    expect(flagsOf({ negative: true }) & (1 << 8)).not.toBe(0);
    expect(flagsOf({ displayXAxis: true }) & (1 << 9)).not.toBe(0);
    expect(flagsOf({ rightToLeft: true }) & (1 << 15)).not.toBe(0);
  });

  it("picks the individual or the group bit of each axis pair, never both", () => {
    // **Bits 11–14 are two pairs, not four independent flags**: 11/12 are `fIndividualAutoMax`/`Min` and
    // 13/14 the group equivalents, mutually exclusive within a pair. This test used to assert that an
    // unspecified axis set bit 13 — the *group* bit — which is what the writer did and what made every
    // ordinary sparkline group share one vertical axis. `"individual"` is the default in both this model and
    // the XML, so an unspecified axis is bit 11.
    const INDIVIDUAL_MAX = 1 << 11;
    const INDIVIDUAL_MIN = 1 << 12;
    const GROUP_MAX = 1 << 13;
    const GROUP_MIN = 1 << 14;

    expect(flagsOf({}) & INDIVIDUAL_MAX).not.toBe(0);
    expect(flagsOf({}) & INDIVIDUAL_MIN).not.toBe(0);
    expect(flagsOf({}) & (GROUP_MAX | GROUP_MIN)).toBe(0);

    expect(flagsOf({ maxAxisType: "group" } as never) & GROUP_MAX).not.toBe(0);
    expect(flagsOf({ maxAxisType: "group" } as never) & INDIVIDUAL_MAX).toBe(0);

    // A manual bound means custom: neither bit of the pair, because the `Xnum` carries the answer.
    expect(flagsOf({ manualMax: 10 }) & (INDIVIDUAL_MAX | GROUP_MAX)).toBe(0);
    expect(flagsOf({ manualMin: 1 }) & (INDIVIDUAL_MIN | GROUP_MIN)).toBe(0);
    // …and the other axis is unaffected by the one that was set.
    expect(flagsOf({ manualMax: 10 }) & INDIVIDUAL_MIN).not.toBe(0);
  });

  it("zeroes a manual bound whose axis is not custom", () => {
    // The specification requires the `Xnum` to be 0 when either automatic bit of its pair is set. A model
    // stating both `maxAxisType: "group"` and a `manualMax` is contradictory; the flag wins and the number is
    // zeroed, so the record cannot say two things at once.
    const payload = payloadOf(
      [
        {
          sparklines: [{ cellRef: "E1", dataRef: "A1:C1" }],
          maxAxisType: "group",
          manualMax: 42
        }
      ] as never,
      "BrtBeginSparklineGroup"
    )!;
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    // Past the FRTHeader (4), the flags (2) and eight colours (64).
    expect(view.getFloat64(70, true)).toBe(0);
  });

  it("is 98 bytes: a header, flags, eight colours and three numbers", () => {
    // `4 + 2 + 8×8 + 8 + 8 + 8 + 4`. Stating it is how the eight colours are pinned — a missing one shifts
    // every field after it and the line weight reads as a colour.
    //
    // **This said 100, with the arithmetic written out as `4 + 4 + …`.** The flag field is a `u16`
    // (MS-XLSB 2.4.228 lists fifteen bits), and the extra two bytes made Excel discard the worksheet part
    // rather than repair a record. A stated total is only a check if the field widths behind it are right.
    expect(payloadOf(GROUP, "BrtBeginSparklineGroup")).toHaveLength(98);
  });

  it("writes the type and the line weight at the end", () => {
    const payload = payloadOf(
      [
        { type: "column", sparklines: [{ cellRef: "E1", dataRef: "A1:C1" }], lineWeight: 1.5 }
      ] as never,
      "BrtBeginSparklineGroup"
    )!;
    const view = new DataView(payload.buffer, payload.byteOffset);
    expect(view.getFloat64(payload.length - 12, true)).toBe(1.5);
    expect(view.getUint32(payload.length - 4, true)).toBe(1); // column
  });

  it("clamps the line weight to the range the record permits", () => {
    const payload = payloadOf(
      [{ sparklines: [{ cellRef: "E1", dataRef: "A1:C1" }], lineWeight: 5000 }] as never,
      "BrtBeginSparklineGroup"
    )!;
    expect(
      new DataView(payload.buffer, payload.byteOffset).getFloat64(payload.length - 12, true)
    ).toBe(1584);
  });
});

describe("sparklines through a workbook", () => {
  it("writes the whole collection into the sheet", async () => {
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "S");
    Worksheet.addAoa(sheet, [
      [1, 2, 3],
      [4, 5, 6]
    ]);
    Sparkline.add(sheet, {
      type: "line",
      sparklines: [
        { cellRef: "E1", dataRef: "A1:C1" },
        { cellRef: "E2", dataRef: "A2:C2" }
      ],
      markers: true,
      high: true
    } as never);
    const parts = await extractAll(await Workbook.toBuffer(workbook, { format: "xlsb" }));
    const names = [
      ...iterateInterpretableRecords(parts.get("xl/worksheets/sheet1.bin")!.data, "s")
    ].map(entry => recordSpec(entry.id)?.name ?? "");
    expect(names.filter(name => name === "BrtSparkline")).toHaveLength(2);
    expect(names).toContain("BrtBeginSparklineGroups");
  });

  it("no longer reports a sparkline group as a loss", async () => {
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "S");
    Worksheet.addAoa(sheet, [[1, 2, 3]]);
    Sparkline.add(sheet, {
      type: "line",
      sparklines: [{ cellRef: "E1", dataRef: "A1:C1" }]
    } as never);
    await expect(Workbook.toBuffer(workbook, { format: "xlsb" })).resolves.toBeDefined();
  });
});

/**
 * Through the public API, which is the path that was broken.
 *
 * Every assertion above builds a `SheetSparkline` by hand as `{ ref, sqref }`. The model does not use those
 * names — `Sparkline.add` stores `cellRef` and `dataRef` — so the writer's two reads were both `undefined`,
 * `undefined.includes("!")` threw, and a `catch` turned that into a sparkline silently dropped. The group went
 * out with a count of zero and no members, and Excel refused the sheet.
 *
 * So the shape of the gap was: a hand-built fixture agreeing with the writer, and neither agreeing with the
 * model. This closes it by going through `Sparkline.add`.
 */
describe("a sparkline added through the public API reaches the file", () => {
  it("writes a BrtSparkline inside the group", async () => {
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "Sparked");
    Worksheet.addAoa(sheet, [
      ["Region", "Units"],
      ["APAC", 10],
      ["EMEA", 20],
      ["AMER", 30]
    ]);
    Sparkline.add(sheet, {
      type: "column",
      sparklines: [{ dataRef: "Sparked!B2:B4", cellRef: "E2" }]
    });

    const parts = await extractAll(await Workbook.toBuffer(workbook, { format: "xlsb" }));
    const { iterateInterpretableRecords } = await import("@excel/xlsb/binary");
    const { MS_XLSB_RECORD_NAMES } = await import("@excel/xlsb/spec/record-names");
    const names: string[] = [];
    for (const entry of iterateInterpretableRecords(
      parts.get("xl/worksheets/sheet1.bin")!.data,
      "s"
    )) {
      const name = MS_XLSB_RECORD_NAMES.get(entry.id);
      if (name !== undefined && name.includes("Sparkline")) {
        names.push(name);
      }
    }
    expect(names).toEqual([
      "BrtBeginSparklineGroups",
      "BrtBeginSparklineGroup",
      "BrtBeginSparklines",
      // The one that was missing.
      "BrtSparkline",
      "BrtEndSparklines",
      "BrtEndSparklineGroup",
      "BrtEndSparklineGroups"
    ]);
  });

  it("writes no group at all when none of its sparklines can be encoded", async () => {
    // A group with no members is not writable — Excel refuses the sheet rather than showing an empty group —
    // so the collection is dropped as a whole and reported, which is what the caller can act on.
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "Broken");
    Worksheet.addAoa(sheet, [["a"], [1]]);
    Sparkline.add(sheet, {
      type: "column",
      sparklines: [{ dataRef: "not a range at all", cellRef: "still not" }]
    });

    const parts = await extractAll(
      await Workbook.toBuffer(workbook, { format: "xlsb", unsupported: "ignore" })
    );
    const { iterateInterpretableRecords } = await import("@excel/xlsb/binary");
    const { MS_XLSB_RECORD_NAMES } = await import("@excel/xlsb/spec/record-names");
    for (const entry of iterateInterpretableRecords(
      parts.get("xl/worksheets/sheet1.bin")!.data,
      "s"
    )) {
      expect(MS_XLSB_RECORD_NAMES.get(entry.id) ?? "").not.toContain("Sparkline");
    }
  });
});

/**
 * The group record's own shape.
 *
 * Both assertions here failed silently for as long as they were absent, and the second one is the reason the
 * first matters: a wrong *length* is not a wrong value. Excel repaired records with implausible contents all
 * through this module's history, but a record whose length disagrees with the field list makes the whole part
 * unparseable, and Excel answers `Replaced Part` — it discarded the worksheet.
 */
describe("BrtBeginSparklineGroup's fixed shape", () => {
  const groupRecord = async (): Promise<Uint8Array> => {
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "S");
    Worksheet.addAoa(sheet, [
      ["a", "b"],
      [1, 2],
      [3, 4]
    ]);
    Sparkline.add(sheet, {
      type: "column",
      sparklines: [{ dataRef: "S!B2:B3", cellRef: "E2" }]
    });
    const parts = await extractAll(await Workbook.toBuffer(workbook, { format: "xlsb" }));
    const { iterateInterpretableRecords } = await import("@excel/xlsb/binary");
    const { MS_XLSB_RECORD_NAMES } = await import("@excel/xlsb/spec/record-names");
    for (const entry of iterateInterpretableRecords(
      parts.get("xl/worksheets/sheet1.bin")!.data,
      "s"
    )) {
      if (MS_XLSB_RECORD_NAMES.get(entry.id) === "BrtBeginSparklineGroup") {
        return entry.payload!;
      }
    }
    throw new Error("no BrtBeginSparklineGroup");
  };

  it("is ninety-eight bytes, which is what its field list sums to", async () => {
    // 4 for an empty `FRTHeader`, 2 of flags, 8 × 8 for the colours, 3 × 8 for the bounds and line weight,
    // and 4 for `isltype`. The flags were a `u32`, so it was 100 and every field after them was two bytes out.
    expect((await groupRecord()).byteLength).toBe(4 + 2 + 8 * 8 + 3 * 8 + 4);
  });

  it("gives every colour a type the record permits", async () => {
    // "The `xColorType` of this `BrtColor` MUST NOT equal 0x00" — on all eight. The *automatic* colour is
    // type 0, so an unstated colour cannot be written as automatic however non-zero its other bytes are.
    //
    // Asserted as the rule rather than as eight literal 1s. The literal form had to be edited the moment the
    // series colour stopped being palette-indexed, which means it was pinning an implementation detail and not
    // the requirement — and it would have gone on passing if a later change made one of them automatic again
    // by a different route.
    const payload = await groupRecord();
    const types = Array.from({ length: 8 }, (_, index) => (payload[6 + index * 8]! >> 1) & 0x7f);
    expect(types.every(type => type !== 0)).toBe(true);
    // **All eight are concrete sRGB**, which is what Excel writes and what an unstated colour now becomes.
    // Type 2 is `rgb`. The first attempt substituted `theme="4"` for the series and left the other seven as
    // palette index 64 — both were guesses, and reading a sparkline Excel made showed it uses neither.
    expect(types).toEqual([2, 2, 2, 2, 2, 2, 2, 2]);
  });

  it("puts isltype where the field list puts it", async () => {
    // At 94, which only holds once the flags are two bytes. Column sparklines are 1.
    const payload = await groupRecord();
    expect(new DataView(payload.buffer, payload.byteOffset).getUint32(94, true)).toBe(1);
  });
});

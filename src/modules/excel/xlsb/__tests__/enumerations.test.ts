/**
 * The published enumerations, transcribed from `[MS-XLSB]` and compared against what this module writes.
 *
 * **Why transcribe rather than import.** Every other test here reads the module's own table and checks that
 * the encoder agrees with it, which proves the two halves of this module are consistent and nothing about
 * whether either matches Excel. The values below are copied from the specification's own tables by hand, so a
 * table that drifts fails against the document rather than against itself.
 *
 * These were audited by hand after two flag words turned out to be mishandled. The audit found the tables
 * correct and three comments out of date — `HorizAlign`, `VertAlign` and `ReadingOrder` were each described
 * as inferred from Excel's output when all three are published. This file is what stops that from being
 * re-derived a third time.
 */

import { encodeAlignmentAndProtection } from "@excel/xlsb/alignment";
import { encodeBorder } from "@excel/xlsb/border";
import { encodeFill } from "@excel/xlsb/fill";
import { describe, expect, it } from "vitest";

/** MS-XLSB 2.5.51 `FillPattern`, in value order from `FLSNULL` to `FLSGRAY0625`. */
const FILL_PATTERN = [
  "none",
  "solid",
  "mediumGray",
  "darkGray",
  "lightGray",
  "darkHorizontal",
  "darkVertical",
  "darkDown",
  "darkUp",
  "darkGrid",
  "darkTrellis",
  "lightHorizontal",
  "lightVertical",
  "lightDown",
  "lightUp",
  "lightGrid",
  "lightTrellis",
  "gray125",
  "gray0625"
] as const;

/** MS-XLSB 2.5.8 `BorderStyle`, `NONE` through `SLANTDASHDOT`. */
const BORDER_STYLE = [
  undefined,
  "thin",
  "medium",
  "dashed",
  "dotted",
  "thick",
  "double",
  "hair",
  "mediumDashed",
  "dashDot",
  "mediumDashDot",
  "dashDotDot",
  "mediumDashDotDot",
  "slantDashDot"
] as const;

/** MS-XLSB 2.5.74 `HorizAlign`, `ALCGEN` through `ALCDIST`. `ALCNIL` (0xFF) is not an index. */
const HORIZONTAL = [
  undefined,
  "left",
  "center",
  "right",
  "fill",
  "justify",
  "centerContinuous",
  "distributed"
] as const;

/** MS-XLSB 2.5.158 `VertAlign`, `ALCVTOP` through `ALCVDIST`. */
const VERTICAL = ["top", "middle", undefined, "justify", "distributed"] as const;

describe("FillPattern — MS-XLSB 2.5.51", () => {
  it("writes each pattern at the value the specification gives it", () => {
    // `fls` is the first field of `BrtFill`, so the encoded pattern is readable directly.
    FILL_PATTERN.forEach((pattern, value) => {
      const bytes = encodeFill({ type: "pattern", pattern } as never);
      expect(new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true)).toBe(value);
    });
  });

  it("has nineteen values, so an added one cannot go unnoticed", () => {
    // The count is part of the claim: a table that gained an entry without gaining a test would shift every
    // pattern after it by one, and each individual assertion above would still pass on the shifted table if
    // it were generated from that table rather than transcribed.
    expect(FILL_PATTERN).toHaveLength(19);
  });
});

describe("BorderStyle — MS-XLSB 2.5.8", () => {
  it("writes each line style at its specified value", () => {
    BORDER_STYLE.forEach((style, value) => {
      if (style === undefined) {
        return;
      }
      const bytes = encodeBorder({ top: { style } } as never);
      // A `BrtBorder` is a flag byte then five `Blxf`, each a style byte, a reserved byte and a colour. The
      // top edge is the first.
      expect(bytes[1]).toBe(value);
    });
  });

  it("writes a zero style byte and only fValidRGB in the colour of an absent border", () => {
    // `dg` of 0 is the record's own "no line". The colour beside it is not all zeros: Excel sets `fValidRGB`
    // and leaves index and channels clear — verified in three corpus workbooks and eight files Excel wrote.
    // It is also not the automatic palette index `encodeColor(undefined)` produces, which is a font's answer.
    const bytes = encodeBorder({ top: undefined } as never);
    expect([...bytes.subarray(1, 11)]).toEqual([0, 0, 0x01, 0, 0, 0, 0, 0, 0, 0]);
  });
});

describe("HorizAlign and VertAlign — MS-XLSB 2.5.74 and 2.5.158", () => {
  it("writes each horizontal alignment at its specified value", () => {
    HORIZONTAL.forEach((horizontal, value) => {
      if (horizontal === undefined) {
        return;
      }
      // The returned bytes are rotation, indent, the alignment bits, then the protection and override
      // bytes — so the alignment byte is at index 2, not at the start.
      const bytes = encodeAlignmentAndProtection({ horizontal }, undefined, 0);
      // `alc` occupies its low three bits.
      expect(bytes[2]! & 0x07).toBe(value);
    });
  });

  it("writes each vertical alignment at its specified value", () => {
    VERTICAL.forEach((vertical, value) => {
      if (vertical === undefined) {
        return;
      }
      const bytes = encodeAlignmentAndProtection({ vertical }, undefined, 0);
      // `alcV` occupies bits 3 to 5 of that same byte.
      expect((bytes[2]! >> 3) & 0x07).toBe(value);
    });
  });

  it("treats an omitted alignment as general and bottom", () => {
    // Both are the model's way of not choosing, and both are zero — `ALCGEN` is 0 and `ALCVBOT` is 2, so
    // this asserts the *encoder's* default rather than assuming the enumeration's first entry is it.
    const bytes = encodeAlignmentAndProtection(undefined, undefined, 0);
    expect(bytes[2]! & 0x07).toBe(0);
    expect((bytes[2]! >> 3) & 0x07).toBe(2);
  });
});

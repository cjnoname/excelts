import type { Font } from "@excel/types";
import { encodeColor, readColor } from "@excel/xlsb/color";
/**
 * `BrtFont`, `BrtFill` and `BrtColor` against Excel's own bytes.
 *
 * The payloads below are verbatim from the reference corpus, which is what makes this file worth
 * more than a round-trip test: a reader and a writer that agree with each other prove nothing
 * about whether either agrees with Excel. Every hex string here came out of a workbook Excel
 * wrote, and the assertions say what it means.
 */
import { MANDATORY_FILL_PATTERNS, encodeFill, mandatoryFill, readFill } from "@excel/xlsb/fill";
import {
  FONT_HEADER_SIZE,
  GRBIT_OFFSET,
  encodeFont,
  readFont,
  unmodelledFlagsOf
} from "@excel/xlsb/font";
import { hexBytes, toHex } from "@test/biff-fixture";
import { BinaryReader } from "@utils/binary";
import { describe, expect, it } from "vitest";

/** Every `BrtFont` in the nine Excel-authored reference workbooks, with what it is. */
const REAL_FONTS: readonly { file: string; payload: string; expected: Partial<Font> }[] = [
  {
    file: "any_sheets.xlsb",
    payload:
      "f0 00 00 00 90 01 00 00 00 02 cc 00 07 01 00 00 00 00 00 ff 00 05 00 00 00 " +
      "41 00 72 00 69 00 61 00 6c 00",
    // charset 204 is Windows Cyrillic, in the workbook whose style is named `Обычный`.
    expected: { name: "Arial", size: 12, family: 2, charset: 204, color: { theme: 1 } }
  },
  {
    file: "any_sheets.xlsb",
    payload:
      "c8 00 00 00 90 01 00 00 00 00 00 00 03 08 00 00 00 00 00 ff 00 07 00 00 00 " +
      "43 00 61 00 6c 00 69 00 62 00 72 00 69 00",
    // Indexed colour 8 is black, and the RGB companion Excel wrote agrees: `00 00 00 ff`.
    expected: { name: "Calibri", size: 10, color: { indexed: 8 } }
  },
  {
    file: "date.xlsb",
    payload:
      "c8 00 00 00 90 01 00 00 00 02 01 00 01 40 00 00 00 00 00 00 00 05 00 00 00 " +
      "41 00 72 00 69 00 61 00 6c 00",
    // Colour kind 0 with index 64: the automatic colour, which carries no colour of its own.
    expected: { name: "Arial", size: 10, family: 2, charset: 1 }
  },
  {
    file: "issue127.xlsb",
    payload:
      "c8 00 04 00 90 01 00 00 01 02 00 00 01 40 00 00 00 00 00 00 00 08 00 00 00 " +
      "46 00 72 00 65 00 65 00 53 00 61 00 6e 00 73 00",
    expected: { name: "FreeSans", size: 10, family: 2, underline: "single" }
  },
  {
    file: "issue_182.xlsb",
    payload:
      "dc 00 00 00 90 01 00 00 00 02 00 00 07 01 00 00 00 00 00 ff 02 07 00 00 00 " +
      "43 00 61 00 6c 00 69 00 62 00 72 00 69 00",
    // 220 twentieths is 11pt and scheme 2 is `minor`: Excel's default font, exactly.
    expected: { name: "Calibri", size: 11, family: 2, scheme: "minor", color: { theme: 1 } }
  },
  {
    file: "issues.xlsb",
    payload:
      "18 01 00 00 90 01 00 00 00 00 00 00 05 ff 00 00 ff ff ff ff 00 05 00 00 00 " +
      "55 00 32 00 34 00 30 00 30 00",
    // Colour kind 2 carries real bytes. Note the file order is R G B A, not A R G B.
    expected: { name: "U2400", size: 14, color: { argb: "FFFFFFFF" } }
  },
  {
    file: "picture.xlsb",
    payload:
      "dc 00 00 00 90 01 00 00 00 02 86 00 07 01 00 00 00 00 00 ff 02 02 00 00 00 49 7b bf 7e",
    // charset 134 is GB2312, in the workbook whose font is named 等线.
    expected: {
      name: "等线",
      size: 11,
      family: 2,
      charset: 134,
      scheme: "minor",
      color: { theme: 1 }
    }
  }
];

describe("BrtFont read against Excel's own bytes", () => {
  it.each(REAL_FONTS)("reads the $file font as $expected.name", ({ payload, expected }) => {
    expect(readFont(hexBytes(payload), "styles")).toEqual(expected);
  });

  it("has a self-checking header size", () => {
    // The name is an XLWideString at offset 21, so the payload length is fully determined by the
    // character count. This holds for every corpus font at four different name lengths, which is
    // what pins the header at 21 bytes rather than leaving it to be assumed.
    for (const { payload } of REAL_FONTS) {
      const raw = hexBytes(payload);
      const cch = new BinaryReader(raw, FONT_HEADER_SIZE).readUint32();
      expect(FONT_HEADER_SIZE + 4 + cch * 2, payload).toBe(raw.length);
    }
  });

  it("reproduces every byte Excel wrote, except a colour it cannot resolve", () => {
    for (const { file, payload } of REAL_FONTS) {
      const raw = hexBytes(payload);
      const reEncoded = encodeFont(readFont(raw, "styles")!);
      expect(reEncoded.length, file).toBe(raw.length);

      // Which positions may differ depends on the font, and naming them exactly is stronger than
      // asserting equality on the rest — it catches a field quietly moving into the gap:
      //
      // - 12 and 19 are in the colour, and only for a **theme or palette-indexed** colour: those
      //   are the two kinds whose RGB companion Excel resolves and this writer does not, so it
      //   clears `fValidRGB` and leaves the alpha zero. An *automatic* or *RGB* colour has no such
      //   excuse and must match exactly. Allowing 12 unconditionally, as an earlier version of
      //   this test did, meant `fValidRGB` was never checked for any font at all.
      // - 2 is `grbit`, and only for the one font carrying a bit this reader does not model. The
      //   bit is reported through `unmodelledFlagsOf` rather than invented into the model, so the
      //   round trip is honestly lossy instead of quietly so.
      const model = readFont(raw, "styles");
      const unresolvedColour =
        model?.color?.theme !== undefined || model?.color?.indexed !== undefined;
      const allowed = new Set([
        ...(unresolvedColour ? [12, 19] : []),
        ...(unmodelledFlagsOf(raw) > 0 ? [GRBIT_OFFSET] : [])
      ]);
      const differing = [...raw].flatMap((byte, index) =>
        byte === reEncoded[index] ? [] : [index]
      );
      expect(
        differing.filter(index => !allowed.has(index)),
        file
      ).toEqual([]);
    }
  });

  it("counts grbit bits it does not model instead of dropping them", () => {
    // One corpus workbook — the one Excel did not write — sets grbit bit 2, which none of the
    // modelled toggles claims. A reader that silently discarded it would make a lossy round trip
    // look lossless.
    const freeSans = REAL_FONTS.find(font => font.expected.name === "FreeSans")!;
    expect(unmodelledFlagsOf(hexBytes(freeSans.payload))).toBe(1);
    for (const font of REAL_FONTS.filter(entry => entry !== freeSans)) {
      expect(unmodelledFlagsOf(hexBytes(font.payload)), font.file).toBe(0);
    }
  });

  it("round-trips every attribute a caller can set", () => {
    // A BrtFont has no optional fields — it always carries a name, a size and a scheme byte — so
    // the assertion is that nothing the caller set was lost, not that nothing was added.
    for (const font of [
      { bold: true },
      { italic: true, size: 14 },
      { name: "Times New Roman", size: 18, bold: true, italic: true },
      { strike: true, outline: true, shadow: true, condense: true, extend: true },
      { underline: "double" as const },
      { vertAlign: "superscript" as const },
      { color: { argb: "FFFF0000" } },
      { color: { theme: 4 } },
      { color: { indexed: 8 } },
      { charset: 134, family: 2, scheme: "minor" as const, name: "等线" }
    ]) {
      const read = readFont(encodeFont(font), "styles");
      expect(read, JSON.stringify(font)).toMatchObject(font);
    }
  });

  it("treats a truncated font as absent rather than as a font with wrong values", () => {
    expect(readFont(new Uint8Array(10), "styles")).toBeUndefined();
    // Header present, name length claims more bytes than exist.
    expect(
      readFont(
        hexBytes("dc 00 00 00 90 01 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 ff 00 00 00"),
        "styles"
      )
    ).toBeUndefined();
  });
});

describe("BrtColor against Excel's own bytes", () => {
  it.each([
    { payload: "01 40 00 00 00 00 00 00", expected: {}, why: "automatic, index 64" },
    { payload: "03 08 00 00 00 00 00 ff", expected: { indexed: 8 }, why: "slot 8 is black" },
    { payload: "05 ff 00 00 ff ff ff ff", expected: { argb: "FFFFFFFF" }, why: "RGB white" },
    { payload: "07 01 00 00 00 00 00 ff", expected: { theme: 1 }, why: "theme 1 is dark text" },
    { payload: "03 41 00 00 ff ff ff ff", expected: { indexed: 65 }, why: "slot 65 is white" }
  ])("reads $payload as $why", ({ payload, expected }) => {
    expect(readColor(new BinaryReader(hexBytes(payload)))).toEqual(expected);
  });

  it("writes an RGB colour byte-identically to Excel", () => {
    // Including the 0xff index byte, which is what Excel puts there for an RGB colour.
    expect(toHex(encodeColor({ argb: "FFFFFFFF" }))).toBe("05 ff 00 00 ff ff ff ff");
  });

  it("puts the bytes in R G B A order, not A R G B", () => {
    // Opaque pure red. Getting this backwards yields a plausible-looking wrong colour rather
    // than an error, which is why it is asserted rather than assumed.
    expect(toHex(encodeColor({ argb: "FFFF0000" }))).toBe("05 ff 00 00 ff 00 00 ff");
    expect(readColor(new BinaryReader(hexBytes("05 ff 00 00 ff 00 00 ff")))).toEqual({
      argb: "FFFF0000"
    });
  });

  it("treats six hex digits as an opaque colour", () => {
    expect(readColor(new BinaryReader(encodeColor({ argb: "00FF00" })))).toEqual({
      argb: "FF00FF00"
    });
  });

  it("clears fValidRGB for a colour it does not resolve", () => {
    // A theme slot and a palette index are resolved by the consumer. Excel writes the resolved
    // RGB alongside them; this writer cannot, and writing a plausible wrong one with the bit set
    // would make a consumer honouring the bit render the wrong colour instead of falling back to
    // the index. This is the one bit pattern here the corpus does not contain.
    expect(toHex(encodeColor({ theme: 4 }))).toBe("06 04 00 00 00 00 00 00");
    expect(toHex(encodeColor({ indexed: 8 }))).toBe("02 08 00 00 00 00 00 00");
  });

  it("prefers an explicit RGB over a theme slot over a palette index", () => {
    // A model colour may carry all three; only one fits.
    expect(
      readColor(new BinaryReader(encodeColor({ argb: "FF102030", theme: 4, indexed: 8 })))
    ).toEqual({
      argb: "FF102030"
    });
    expect(readColor(new BinaryReader(encodeColor({ theme: 4, indexed: 8 })))).toEqual({
      theme: 4
    });
  });
});

describe("BrtFill", () => {
  it("reads the two fills Excel writes into every workbook", () => {
    const none = "00 00 00 00 03 40 00 00 00 00 00 ff 03 41 00 00 ff ff ff ff " + "00 ".repeat(48);
    const gray = "11 00 00 00 03 40 00 00 00 00 00 ff 03 41 00 00 ff ff ff ff " + "00 ".repeat(48);
    // `none` is reported as no fill: a cell with it has nothing to apply.
    expect(readFill(hexBytes(none.trim()), "styles")).toBeUndefined();
    // 17 is exactly where `gray125` sits in the eighteen-value pattern ordering, which is what
    // pins that ordering — were it different anywhere below 17, gray125 would not land on 17.
    expect(readFill(hexBytes(gray.trim()), "styles")).toEqual({
      type: "pattern",
      pattern: "gray125",
      fgColor: { indexed: 64 },
      bgColor: { indexed: 65 }
    });
  });

  it("round-trips a solid fill with a real colour", () => {
    const fill = {
      type: "pattern" as const,
      pattern: "solid" as const,
      fgColor: { argb: "FF00FF00" },
      bgColor: { argb: "FFFFFFFF" }
    };
    expect(readFill(encodeFill(fill), "styles")).toEqual(fill);
  });

  it("writes the two mandatory entries byte-identically to Excel", () => {
    // These were composed through `encodeColor` and came out as *automatic* colours (`01 40 …`)
    // where Excel writes **indexed** ones with their resolved RGB (`03 40 …` black, `03 41 …`
    // white). Nothing caught it: the reader takes the index and ignores the RGB companion either
    // way, so a round trip agreed with itself while the bytes disagreed with Excel — which is
    // precisely the failure mode a byte-for-byte check against real output exists to catch.
    const tail = " 00".repeat(48).trim();
    expect(toHex(mandatoryFill(MANDATORY_FILL_PATTERNS[0]))).toBe(
      `00 00 00 00 03 40 00 00 00 00 00 ff 03 41 00 00 ff ff ff ff ${tail}`
    );
    expect(toHex(mandatoryFill(MANDATORY_FILL_PATTERNS[1]))).toBe(
      `11 00 00 00 03 40 00 00 00 00 00 ff 03 41 00 00 ff ff ff ff ${tail}`
    );
  });

  it("is 68 bytes, whatever it holds", () => {
    expect(encodeFill(undefined)).toHaveLength(68);
    expect(
      encodeFill({ type: "pattern", pattern: "solid", fgColor: { argb: "FF0000FF" } })
    ).toHaveLength(68);
  });

  it("degrades a gradient to a solid fill of its first stop", () => {
    // The alternative is inventing the gradient field layout, which the corpus does not
    // establish, or dropping the fill and losing the colour along with the gradient.
    expect(
      readFill(
        encodeFill({
          type: "gradient",
          gradient: "angle",
          degree: 90,
          stops: [
            { position: 0, color: { argb: "FFFF0000" } },
            { position: 1, color: { argb: "FF0000FF" } }
          ]
        }),
        "styles"
      )
    ).toEqual({ type: "pattern", pattern: "solid", fgColor: { argb: "FFFF0000" } });
  });
});

import { buildTtfWithCmap } from "@pdf/__tests__/ttf-test-utils";
import { PdfFontError } from "@pdf/errors";
import {
  compilePdfFontConfig,
  type PdfFontConfig,
  type PdfFontSource
} from "@pdf/font/font-config";
import { parseTtf } from "@pdf/font/ttf-parser";
import { describe, expect, it } from "vitest";

function buildFont(familyName: string): Uint8Array {
  return buildTtfWithCmap([{ start: 0x41, end: 0x41, delta: -0x40 }], 2, { familyName });
}

function buildTtc(fonts: Uint8Array[]): Uint8Array {
  const headerLength = 12 + fonts.length * 4;
  const length = headerLength + fonts.reduce((sum, font) => sum + font.length, 0);
  const result = new Uint8Array(length);
  const view = new DataView(result.buffer);
  view.setUint32(0, 0x74746366, false);
  view.setUint32(4, 0x00010000, false);
  view.setUint32(8, fonts.length, false);
  let offset = headerLength;
  fonts.forEach((font, index) => {
    view.setUint32(12 + index * 4, offset, false);
    const rebased = font.slice();
    const rebasedView = new DataView(rebased.buffer);
    const numTables = rebasedView.getUint16(4, false);
    for (let table = 0; table < numTables; table++) {
      const tableOffsetPosition = 12 + table * 16 + 8;
      rebasedView.setUint32(
        tableOffsetPosition,
        rebasedView.getUint32(tableOffsetPosition, false) + offset,
        false
      );
    }
    result.set(rebased, offset);
    offset += rebased.length;
  });
  return result;
}

describe("compilePdfFontConfig", () => {
  it("compiles all four face slots and TTC sources", () => {
    const regular = buildFont("Regular");
    const bold = buildFont("Bold");
    const italic = buildFont("Italic");
    const collection = buildTtc([buildFont("Unused"), buildFont("Bold Italic")]);

    const compiled = compilePdfFontConfig({
      default: {
        regular,
        bold: { data: bold },
        italic,
        boldItalic: { data: collection, collectionIndex: 1 }
      }
    });

    expect(compiled.default.regular.font.familyName).toBe("Regular");
    expect(compiled.default.bold?.font.familyName).toBe("Bold");
    expect(compiled.default.italic?.font.familyName).toBe("Italic");
    expect(compiled.default.boldItalic?.font.familyName).toBe("Bold Italic");
    expect(compiled.default.boldItalic?.collectionIndex).toBe(1);
  });

  it("normalizes names and resolves fallbacks through aliases", () => {
    const compiled = compilePdfFontConfig({
      default: { regular: buildFont("Default") },
      families: [
        {
          name: "  Noto   Sans  ",
          aliases: [" UI   Sans "],
          faces: { regular: buildFont("Noto Sans") }
        }
      ],
      fallbackFamilies: ["  ui sans "]
    });

    expect(compiled.families[0].name).toBe("Noto Sans");
    expect(compiled.families[0].aliases).toEqual(["UI Sans"]);
    expect(compiled.families[0].normalizedName).toBe("noto sans");
    expect(compiled.fallbackFamilies[0]).toBe(compiled.families[0]);
  });

  it.each([
    {
      label: "family and alias",
      families: [
        { name: "Alpha", aliases: ["Beta"], faces: { regular: buildFont("Alpha") } },
        { name: " beta ", faces: { regular: buildFont("Beta") } }
      ]
    },
    {
      label: "aliases in one family",
      families: [
        {
          name: "Alpha",
          aliases: ["Beta", " BETA "],
          faces: { regular: buildFont("Alpha") }
        }
      ]
    }
  ])("rejects normalized name conflicts between $label", ({ families }) => {
    expect(() =>
      compilePdfFontConfig({ default: { regular: buildFont("Default") }, families })
    ).toThrow(/conflicts/);
  });

  it("rejects unknown fallback references", () => {
    expect(() =>
      compilePdfFontConfig({
        default: { regular: buildFont("Default") },
        fallbackFamilies: ["Missing"]
      })
    ).toThrow("Fallback font family 'Missing' is not configured");
  });

  it("rejects missing regular faces and malformed values", () => {
    expect(() => compilePdfFontConfig({ default: {} } as PdfFontConfig)).toThrow(
      "must define regular"
    );
    expect(() =>
      compilePdfFontConfig({ default: { regular: { data: "bad" } as unknown as PdfFontSource } })
    ).toThrow("must contain Uint8Array data");
    expect(() =>
      compilePdfFontConfig({
        default: { regular: buildFont("Default") },
        families: [{ name: "  ", faces: { regular: buildFont("Blank") } }]
      })
    ).toThrow("must not be empty");
  });

  it("names the offending face and keeps the underlying cause", () => {
    // A config can hold a dozen font files; an error that only says the font is
    // invalid leaves the caller guessing which one to replace.
    let thrown: unknown;
    try {
      compilePdfFontConfig({
        default: { regular: buildFont("Default"), bold: new Uint8Array([1, 2, 3, 4]) }
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(PdfFontError);
    expect((thrown as Error).message).toContain("default.bold");
    expect((thrown as Error).cause).toBeInstanceOf(PdfFontError);
  });

  it("names the offending face inside a named family too", () => {
    expect(() =>
      compilePdfFontConfig({
        default: { regular: buildFont("Default") },
        families: [
          {
            name: "Song",
            faces: { regular: buildFont("Song"), italic: new Uint8Array([1, 2, 3, 4]) }
          }
        ]
      })
    ).toThrow("family 'Song'.italic");
  });

  it("rejects a supplied optional face rather than silently dropping it", () => {
    // `bold?` means the caller may omit it, not that a broken file is accepted:
    // dropping it would draw bold runs in regular with no way to notice.
    expect(() =>
      compilePdfFontConfig({
        default: { regular: buildFont("Default"), bold: new Uint8Array([1, 2, 3, 4]) }
      })
    ).toThrow(PdfFontError);
  });

  it("explains which format was supplied instead of a TrueType font", () => {
    const signature = (bytes: number[]) =>
      new Uint8Array([...bytes, ...(new Array(60).fill(0) as number[])]);
    const cases: Array<[number[], string]> = [
      [[0x4f, 0x54, 0x54, 0x4f], "CFF-flavored OpenType"],
      [[0x77, 0x4f, 0x46, 0x32], "WOFF2"],
      [[0x77, 0x4f, 0x46, 0x46], "WOFF"],
      [[0x50, 0x4b, 0x03, 0x04], "ZIP archive"],
      [[0x89, 0x50, 0x4e, 0x47], '(".PNG")']
    ];
    for (const [bytes, expected] of cases) {
      expect(() => compilePdfFontConfig({ default: { regular: signature(bytes) } })).toThrow(
        expected
      );
    }
  });

  it("says the data is empty or too short instead of blaming the header", () => {
    expect(() => compilePdfFontConfig({ default: { regular: new Uint8Array(0) } })).toThrow(
      "Font data is empty"
    );
    expect(() => compilePdfFontConfig({ default: { regular: new Uint8Array([1, 2]) } })).toThrow(
      "only 2 byte(s)"
    );
  });

  it("clones input bytes and freezes the compiled configuration", () => {
    const bytes = buildFont("Snapshot");
    const compiled = compilePdfFontConfig({
      default: { regular: bytes },
      families: [{ name: "Family", aliases: ["Alias"], faces: { regular: buildFont("Family") } }],
      fallbackFamilies: ["Alias"]
    });
    const firstByte = compiled.default.regular.data[0];
    bytes[0] = 0xff;

    expect(compiled.default.regular.data[0]).toBe(firstByte);
    expect(compiled.default.regular.data).not.toBe(bytes);
    expect(Object.isFrozen(compiled)).toBe(true);
    expect(Object.isFrozen(compiled.default)).toBe(true);
    expect(Object.isFrozen(compiled.default.regular)).toBe(true);
    expect(Object.isFrozen(compiled.families)).toBe(true);
    expect(Object.isFrozen(compiled.families[0].aliases)).toBe(true);
    expect(Object.isFrozen(compiled.fallbackFamilies)).toBe(true);
  });
});

describe("parseTtf collectionIndex", () => {
  const ttc = buildTtc([buildFont("First"), buildFont("Second")]);

  it("selects a font from a TrueType Collection", () => {
    expect(parseTtf(ttc).familyName).toBe("First");
    expect(parseTtf(ttc, 1).familyName).toBe("Second");
  });

  it.each([NaN, Infinity, 0.5, -1])("rejects invalid collection index %s", index => {
    expect(() => parseTtf(ttc, index)).toThrow(PdfFontError);
  });

  it("rejects an out-of-range index", () => {
    expect(() => parseTtf(ttc, 2)).toThrow("out of range");
  });

  it("rejects a non-zero index for a standalone font", () => {
    expect(() => parseTtf(buildFont("Standalone"), 1)).toThrow("non-collection font");
  });

  it("rejects truncated and invalid TTC headers with PdfFontError", () => {
    expect(() => parseTtf(new Uint8Array([0x74, 0x74, 0x63, 0x66]))).toThrow(PdfFontError);

    const truncatedOffsets = new Uint8Array(12);
    const view = new DataView(truncatedOffsets.buffer);
    view.setUint32(0, 0x74746366, false);
    view.setUint32(4, 0x00010000, false);
    view.setUint32(8, 1, false);
    expect(() => parseTtf(truncatedOffsets)).toThrow("offset table is truncated");

    const badOffset = new Uint8Array(16);
    const badOffsetView = new DataView(badOffset.buffer);
    badOffsetView.setUint32(0, 0x74746366, false);
    badOffsetView.setUint32(4, 0x00010000, false);
    badOffsetView.setUint32(8, 1, false);
    badOffsetView.setUint32(12, 16, false);
    expect(() => parseTtf(badOffset)).toThrow("header is out of range");
  });
});

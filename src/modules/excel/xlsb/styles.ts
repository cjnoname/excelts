/**
 * BIFF12 styles: number formats, fonts, fills, and the cell-format table that indexes them.
 *
 * Number formats came first, and the ordering was deliberate rather than incidental. A cell's
 * `iFmt` is what turns `42663` into `2016-10-07` and `0.155` into `15.5%`, so without it a reader
 * produces numerically correct output that is *wrong on screen* — the one kind of fidelity loss a
 * user notices immediately. Fonts and fills change how a workbook looks; a missing number format
 * changes what it appears to say.
 *
 * **Borders are absent, and that is a finding rather than an omission.** All nine Excel-authored reference
 * workbooks contain exactly one `BrtBorder`, byte-identical across every file: the default
 * "no borders" entry. A corpus with one sample of a 51-byte structure establishes that the
 * structure is 51 bytes and nothing else — no edge, no style, no colour is ever exercised — so
 * there is nothing here to read off. See `font.ts` and `fill.ts` for what a corpus that *does*
 * vary makes establishable.
 *
 * ## The layout came from Excel's own output
 *
 * `BrtXF` is sixteen bytes, and the fields below were read off a real `styles.bin` rather than
 * guessed. The workbook that produced it has a date cell, and its third cell format carries
 * `iFmt = 14` — the built-in `mm-dd-yy` — which is what identified the field's offset:
 *
 * ```text
 * 00 00 | 0e 00 | 00 00 | 00 00 | 00 00 | 00 00 | 10 10 | 01 00
 * parent  iFmt    iFont   iFill   iBorder  …flags…
 * ```
 *
 * The built-in format strings are the ones `xlsx/defaultnumformats.ts` already carries. Reusing
 * them matters beyond saving a table: a reader that disagreed with the XLSX path about what
 * format 14 means would make the same file display differently depending on which container it
 * arrived in.
 */

import type { Alignment, Fill, Font, Protection } from "@excel/types";
import {
  ATTRIBUTE_MASK,
  encodeAlignmentAndProtection,
  readAlignment,
  readProtection
} from "@excel/xlsb/alignment";
import {
  encodeBiffRecords,
  encodeWideString,
  iterateBiffRecords,
  readWideString
} from "@excel/xlsb/binary";
import { MANDATORY_FILL_PATTERNS, encodeFill, mandatoryFill, readFill } from "@excel/xlsb/fill";
import { defaultFont, encodeFont, readFont, unmodelledFlagsOf } from "@excel/xlsb/font";
import { requireRecordSpec, recordSpec } from "@excel/xlsb/spec/records";
import type { StyleFacets } from "@excel/xlsb/write/types";
import { defaultNumFormats } from "@excel/xlsx/defaultnumformats";
import { BinaryReader, BinaryWriter, concatUint8Arrays } from "@utils/binary";

/**
 * First format id available for a custom format.
 *
 * Ids below this are reserved for the built-ins, so a writer that started numbering at zero
 * would silently redefine `General`.
 */
const FIRST_CUSTOM_FORMAT_ID = 164;

/**
 * Byte offsets within a `BrtXF` payload.
 *
 * Established from the corpus by correlation: `issue127.xlsb` declares three fonts and its six
 * `BrtXF` records read `iFont` = 0, 1, 1, 2, 2, 0 at offset 4; `issues.xlsb` declares three and
 * reads 0, 0, 0, 0, 1, 2. Every value is in range for the font count of its own file and varies
 * exactly where the fonts do, which a wrong offset would not do twice.
 */
const XF_FORMAT_OFFSET = 2;
const XF_FONT_OFFSET = 4;
const XF_FILL_OFFSET = 6;

/** What a styles part says about the formatting a cell can reference. */
export interface StyleTable {
  /**
   * Format string for each cell-format index, or `undefined` where the format is `General`.
   *
   * Indexed the way a cell's `iStyleRef` indexes it, so a reader can go straight from a cell to
   * a format string without holding the intermediate tables.
   */
  readonly numberFormats: readonly (string | undefined)[];
  /** Font for each cell-format index, or `undefined` where the entry is the default font. */
  readonly fonts: readonly (Partial<Font> | undefined)[];
  /** Fill for each cell-format index, or `undefined` where the entry is the default (no) fill. */
  readonly fills: readonly (Fill | undefined)[];
  /** Alignment for each cell-format index, or `undefined` where the entry is Excel's default. */
  readonly alignments: readonly (Partial<Alignment> | undefined)[];
  /** Protection for each cell-format index, or `undefined` where it is Excel's default (locked). */
  readonly protections: readonly (Partial<Protection> | undefined)[];
  /**
   * Font attributes a `BrtFont` carried that this reader does not model, counted by field.
   *
   * `grbit` has bits whose meaning the reference corpus does not establish, and one workbook in
   * it sets one. Reporting the count is the alternative to silently dropping the bit.
   */
  readonly unmodelledFontFlags: number;
  /**
   * The font at index 0 — the one every cell that names no font inherits.
   *
   * Absent from `fonts`, which is indexed by *cell-format* and reports `undefined` wherever the entry is
   * this default, so there was no way to ask what the default *was*. Without it an XLSB read dropped the
   * workbook's font and the next write fell back to Calibri 11, restyling every unstyled cell in a file
   * whose author had chosen something else.
   */
  readonly defaultFont?: Partial<Font>;
}

/** The built-in format string for an id, or `undefined` when there is none. */
export function builtinNumberFormat(id: number): string | undefined {
  const format = defaultNumFormats[id];
  // The locale-specific entries carry no `f`. Falling back to undefined rather than picking one
  // is deliberate: guessing a locale would produce a format the file never specified.
  return format?.f;
}

/**
 * Read `xl/styles.bin`.
 *
 * Only the number-format chain is followed: custom formats from `BrtFmt`, then each `BrtXF`'s
 * `iFmt`. `BrtXF` appears in two collections — cell formats and named-style formats — and only
 * the ones inside `BrtBeginCellXfs` are what a cell's `iStyleRef` indexes, so the scope is
 * tracked rather than every `BrtXF` being collected.
 */
export function readStyles(bytes: Uint8Array, part: string): StyleTable {
  const customFormats = new Map<number, string>();
  const fontTable: (Partial<Font> | undefined)[] = [];
  const fillTable: (Fill | undefined)[] = [];
  const numberFormats: (string | undefined)[] = [];
  const fonts: (Partial<Font> | undefined)[] = [];
  const fills: (Fill | undefined)[] = [];
  const alignments: (Partial<Alignment> | undefined)[] = [];
  const protections: (Partial<Protection> | undefined)[] = [];
  let unmodelledFontFlags = 0;
  let inCellXfs = false;

  for (const record of iterateBiffRecords(bytes, part)) {
    const name = recordSpec(record.id)?.name;
    switch (name) {
      case "BrtFmt": {
        const reader = new BinaryReader(record.payload, 0, part);
        try {
          const id = reader.readUint16();
          customFormats.set(id, readWideString(reader, part));
        } catch {
          // A truncated format record costs that format, not the whole styles part.
        }
        break;
      }
      case "BrtFont": {
        const font = readFont(record.payload, part);
        unmodelledFontFlags += unmodelledFlagsOf(record.payload);
        fontTable.push(font);
        break;
      }
      case "BrtFill":
        fillTable.push(readFill(record.payload, part));
        break;
      case "BrtBeginCellXfs":
        inCellXfs = true;
        break;
      case "BrtEndCellXfs":
        inCellXfs = false;
        break;
      case "BrtXF": {
        if (!inCellXfs) {
          break;
        }
        if (record.payload.length < XF_FILL_OFFSET + 2) {
          numberFormats.push(undefined);
          fonts.push(undefined);
          fills.push(undefined);
          alignments.push(undefined);
          protections.push(undefined);
          break;
        }
        const id = new BinaryReader(record.payload, XF_FORMAT_OFFSET, part).readUint16();
        const format = customFormats.get(id) ?? builtinNumberFormat(id);
        // `General` is normalised to "no format". Reporting the string instead would be more
        // literal and worse: every caller would have to compare against a magic value to answer
        // the only question they have — is there a format to apply — and the round trip through
        // `CellFormatTable`, whose index 0 *is* "no format", would stop being symmetric.
        numberFormats.push(format === "General" ? undefined : format);
        // Index 0 of each table is the default, which a cell does not need to be told about.
        const iFont = new BinaryReader(record.payload, XF_FONT_OFFSET, part).readUint16();
        const iFill = new BinaryReader(record.payload, XF_FILL_OFFSET, part).readUint16();
        fonts.push(iFont === 0 ? undefined : fontTable[iFont]);
        fills.push(iFill === 0 ? undefined : fillTable[iFill]);
        alignments.push(readAlignment(record.payload));
        protections.push(readProtection(record.payload));
        break;
      }
      default:
        break;
    }
  }

  return {
    numberFormats,
    fonts,
    fills,
    alignments,
    protections,
    unmodelledFontFlags,
    ...(fontTable[0] === undefined ? {} : { defaultFont: fontTable[0] })
  };
}

/**
 * Intern the five facets an owner carries, whichever kind of owner it is.
 *
 * Cells, rows and columns reference their format identically, so they interned it identically — three
 * copies of the same five-field object literal. This is the one place that list lives now.
 */
export function internStyle(table: CellFormatTable, owner: StyleFacets): number {
  return table.intern({
    numberFormat: owner.numberFormat,
    font: owner.font,
    fill: owner.fill,
    alignment: owner.alignment,
    protection: owner.protection
  });
}

/** The formatting a single cell asks for. Any subset may be present. */
export interface InternedFormat {
  readonly numberFormat?: string | undefined;
  readonly font?: Partial<Font> | undefined;
  readonly fill?: Fill | undefined;
  readonly alignment?: Partial<Alignment> | undefined;
  readonly protection?: Partial<Protection> | undefined;
}

/**
 * Cell formats being accumulated while worksheets are written.
 *
 * A cell references formatting by index, so the table has to exist before the worksheets that
 * point into it — but its contents are only known once every cell has been visited. Interning as
 * the cells are written and serialising afterwards is what resolves that, and it is why index 0 is
 * reserved: a cell with no format must be able to say so without an entry.
 *
 * Three tables are interned, not one, because that is how the format stores them: a `BrtXF` holds
 * *indices* into the number-format, font and fill tables, so two cells that share a font but
 * differ in number format share the font entry. Interning the triple as an opaque key instead
 * would duplicate the font, which for a workbook that bolds a column and formats half of it is
 * the difference between two font records and one per cell.
 */
export class CellFormatTable {
  /** One entry per cell-format index. Index 0 is the default everything. */
  private readonly xfs: InternedFormat[] = [{}];
  private readonly indexByKey = new Map<string, number>();

  /** Interned fonts and fills, in the order they will be written. Index 0 is the default. */
  private readonly fonts: (Partial<Font> | undefined)[] = [undefined];
  private readonly fontIndexByKey = new Map<string, number>();
  private readonly fills: (Fill | undefined)[] = [undefined];
  private readonly fillIndexByKey = new Map<string, number>();

  /** Index for a cell format, adding it if new. An empty format maps to 0. */
  intern(format: InternedFormat): number {
    const numberFormat =
      format.numberFormat === "General" ? undefined : (format.numberFormat ?? undefined);
    const font = isEmptyObject(format.font) ? undefined : format.font;
    const fill = format.fill;
    const alignment = isEmptyObject(format.alignment) ? undefined : format.alignment;
    const protection = isEmptyObject(format.protection) ? undefined : format.protection;
    if (
      numberFormat === undefined &&
      font === undefined &&
      fill === undefined &&
      alignment === undefined &&
      protection === undefined
    ) {
      return 0;
    }

    // Keys are structural. `JSON.stringify` is stable enough here because every value comes from
    // the same builder in the same field order, and a key collision would only cost a duplicate
    // entry rather than a wrong one.
    const key = JSON.stringify([
      numberFormat ?? null,
      font ?? null,
      fill ?? null,
      alignment ?? null,
      protection ?? null
    ]);
    const existing = this.indexByKey.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const index = this.xfs.length;
    this.xfs.push({ numberFormat, font, fill, alignment, protection });
    this.indexByKey.set(key, index);

    if (font !== undefined) {
      this.internInto(this.fonts, this.fontIndexByKey, font);
    }
    if (fill !== undefined) {
      this.internInto(this.fills, this.fillIndexByKey, fill);
    }
    return index;
  }

  /** True when nothing but the default format was used, so no styles part is needed. */
  get isEmpty(): boolean {
    return this.xfs.length === 1;
  }

  get entries(): readonly InternedFormat[] {
    return this.xfs;
  }

  /** Font table as it will be written. Index 0 is the default font. */
  get fontEntries(): readonly (Partial<Font> | undefined)[] {
    return this.fonts;
  }

  /** Fill table as it will be written, excluding the two mandatory entries that precede it. */
  get fillEntries(): readonly (Fill | undefined)[] {
    return this.fills;
  }

  /** Index of an interned font within {@link fontEntries}. */
  fontIndex(font: Partial<Font> | undefined): number {
    return font === undefined ? 0 : (this.fontIndexByKey.get(JSON.stringify(font)) ?? 0);
  }

  /**
   * Index of an interned fill, offset past the two mandatory entries.
   *
   * Excel writes `none` and `gray125` first in every workbook, and a cell fill therefore cannot
   * be index 0 or 1. Folding the offset in here rather than at each call site is what keeps the
   * two tables from drifting apart.
   */
  fillIndex(fill: Fill | undefined): number {
    if (fill === undefined) {
      return 0;
    }
    const index = this.fillIndexByKey.get(JSON.stringify(fill));
    return index === undefined || index === 0 ? 0 : index - 1 + MANDATORY_FILL_PATTERNS.length;
  }

  private internInto<T>(table: (T | undefined)[], keys: Map<string, number>, value: T): void {
    const key = JSON.stringify(value);
    if (keys.has(key)) {
      return;
    }
    keys.set(key, table.length);
    table.push(value);
  }
}

/**
 * Serialise `xl/styles.bin`.
 *
 * Every collection is emitted even when empty, because Excel requires the containers to be
 * present and in this order — fonts, fills, borders, then the format tables that index them.
 * The counts on the `Begin` records are what the validator checks against the entries that
 * follow.
 */
export function writeStyles(table: CellFormatTable, bookDefaultFont?: Partial<Font>): Uint8Array {
  const records: { id: number; payload?: Uint8Array }[] = [];
  const record = (name: string, payload?: Uint8Array): void => {
    records.push({ id: requireRecordSpec(name).id, payload });
  };
  const count = (value: number): Uint8Array => new BinaryWriter().writeUint32(value).toUint8Array();

  record("BrtBeginStyleSheet");

  // Custom formats, numbered from the first id the built-ins leave free.
  const custom = [...table.entries.entries()].filter(
    (entry): entry is [number, InternedFormat & { numberFormat: string }] =>
      entry[0] > 0 && entry[1].numberFormat !== undefined
  );
  const formatIdByIndex = new Map<number, number>();
  const idByFormat = new Map<string, number>();
  for (const [index, entry] of custom) {
    // Two cells with the same format string but different fonts are two XFs and one `BrtFmt`.
    let id = idByFormat.get(entry.numberFormat);
    if (id === undefined) {
      id = FIRST_CUSTOM_FORMAT_ID + idByFormat.size;
      idByFormat.set(entry.numberFormat, id);
    }
    formatIdByIndex.set(index, id);
  }
  record("BrtBeginFmts", count(idByFormat.size));
  for (const [format, id] of idByFormat) {
    record(
      "BrtFmt",
      concatUint8Arrays([
        new BinaryWriter().writeUint16(id).toUint8Array(),
        encodeWideString(format)
      ])
    );
  }
  record("BrtEndFmts");

  // Excel expects these collections to exist. A workbook with no explicit font still has one,
  // and a reader that indexes into an absent table has nothing to index into.
  const fonts = table.fontEntries;
  record("BrtBeginFonts", count(fonts.length));
  record("BrtFont", defaultFont(bookDefaultFont));
  for (const font of fonts.slice(1)) {
    record("BrtFont", encodeFont(font ?? {}));
  }
  record("BrtEndFonts");

  const fills = table.fillEntries;
  record("BrtBeginFills", count(MANDATORY_FILL_PATTERNS.length + fills.length - 1));
  for (const pattern of MANDATORY_FILL_PATTERNS) {
    record("BrtFill", mandatoryFill(pattern));
  }
  for (const fill of fills.slice(1)) {
    record("BrtFill", encodeFill(fill));
  }
  record("BrtEndFills");

  record("BrtBeginBorders", count(1));
  record("BrtBorder", new Uint8Array(51));
  record("BrtEndBorders");

  // The style XFs a named style points at. One, for `Normal`.
  record("BrtBeginCellStyleXfs", count(1));
  record("BrtXF", cellFormat({ parent: 0xffff, formatId: 0, fontIndex: 0, fillIndex: 0 }));
  record("BrtEndCellStyleXfs");

  record("BrtBeginCellXfs", count(table.entries.length));
  table.entries.forEach((entry, index) => {
    record(
      "BrtXF",
      cellFormat({
        parent: 0,
        formatId: formatIdByIndex.get(index) ?? 0,
        fontIndex: table.fontIndex(entry.font),
        fillIndex: table.fillIndex(entry.fill),
        alignment: entry.alignment,
        protection: entry.protection
      })
    );
  });
  record("BrtEndCellXfs");

  record("BrtBeginStyles", count(1));
  record("BrtStyle", normalStyle());
  record("BrtEndStyles");

  record("BrtEndStyleSheet");
  return encodeBiffRecords(records);
}

/**
 * A `BrtXF`: sixteen bytes.
 *
 * The fields left at zero are alignment, protection, rotation, indentation and the border index —
 * every one of them a default, which is honest about what is being written rather than filling
 * them with plausible-looking values. `0x1010` in the flag word is what Excel writes there in
 * every cell format across the reference corpus.
 */
function cellFormat(options: {
  parent: number;
  formatId: number;
  fontIndex: number;
  fillIndex: number;
  alignment?: Partial<Alignment> | undefined;
  protection?: Partial<Protection> | undefined;
}): Uint8Array {
  // `xfGrbitAtr` says which attributes this format overrides rather than inheriting from its
  // parent. Excel sets it, and it is not decorative: in `issues.xlsb` bit 0 appears on exactly
  // the formats with a number format and bit 1 on exactly those with a font, which is how the
  // field was identified. Writing zero here while setting the fields it describes would produce a
  // format whose own mask contradicts it.
  let overrides = 0;
  if (options.formatId !== 0) {
    overrides |= ATTRIBUTE_MASK.numberFormat;
  }
  if (options.fontIndex !== 0) {
    overrides |= ATTRIBUTE_MASK.font;
  }
  if (options.fillIndex !== 0) {
    overrides |= ATTRIBUTE_MASK.fill;
  }
  if (options.alignment !== undefined) {
    overrides |= ATTRIBUTE_MASK.alignment;
  }
  if (options.protection !== undefined) {
    overrides |= ATTRIBUTE_MASK.protection;
  }

  return concatUint8Arrays([
    new BinaryWriter()
      .writeUint16(options.parent)
      .writeUint16(options.formatId)
      .writeUint16(options.fontIndex)
      .writeUint16(options.fillIndex)
      .writeUint16(0) // ixBorder — the one table whose layout the corpus does not establish
      .toUint8Array(),
    encodeAlignmentAndProtection(options.alignment, options.protection, overrides)
  ]);
}

function isEmptyObject(value: object | undefined): boolean {
  return value === undefined || Object.keys(value).length === 0;
}

/** The `Normal` named style every workbook has. */
function normalStyle(): Uint8Array {
  return concatUint8Arrays([
    new BinaryWriter()
      .writeUint32(0) // ixf
      .writeUint16(1) // grbitObj
      .writeUint8(0) // iStyBuiltIn
      .writeUint8(0xff) // iLevel
      .toUint8Array(),
    encodeWideString("Normal")
  ]);
}

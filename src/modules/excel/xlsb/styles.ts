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

import type { Alignment, BorderStyle, Borders, Fill, Font, Protection, Style } from "@excel/types";
import {
  ATTRIBUTE_MASK,
  encodeAlignmentAndProtection,
  readAlignment,
  readProtection
} from "@excel/xlsb/alignment";
import {
  encodeBiffRecords,
  encodeWideString,
  iterateInterpretableRecords,
  readWideString
} from "@excel/xlsb/binary";
import { borderStyleName, borderStyleValue, encodeBorder, readBorder } from "@excel/xlsb/border";
import { MANDATORY_FILL_PATTERNS, encodeFill, mandatoryFill, readFill } from "@excel/xlsb/fill";
import {
  defaultFont,
  encodeFont,
  readFont,
  unmodelledFlagsOf,
  underlineValue
} from "@excel/xlsb/font";
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
 * The reserved identifier for a built-in number format code, or `undefined` for a custom one.
 *
 * A built-in format needs no `BrtFmt`: the identifier alone names it. Every format string used to become a
 * custom entry from 164 up, so a plain date cell carried a `BrtFmt` declaring `mm-dd-yy` where Excel writes
 * `iFmt = 14` and nothing else. Both display the same date, and only one of them is what Excel writes.
 *
 * The table is the XLSX module's, because there is one set of reserved identifiers and two readers of it.
 */
const BUILT_IN_FORMAT_IDS: ReadonlyMap<string, number> = new Map(
  Object.entries(defaultNumFormats)
    .filter((entry): entry is [string, { f: string }] => typeof entry[1].f === "string")
    .map(([id, format]) => [format.f, Number(id)])
);

/** The built-in date format Excel gives a date cell that asks for no format of its own. */
export const DEFAULT_DATE_FORMAT = "mm-dd-yy";

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
/** `ixBorder`, immediately after `ixFill`. */
const XF_BORDER_OFFSET = 8;

/** What a styles part says about the formatting a cell can reference. */
export interface StyleTable {
  /**
   * Format string for each cell-format index, or `undefined` where the format is `General`.
   *
   * Indexed the way a cell's `iStyleRef` indexes it, so a reader can go straight from a cell to
   * a format string without holding the intermediate tables.
   */
  readonly numberFormats: readonly (string | undefined)[];
  /**
   * Differential formats by `dxfId`, which is what a conditional-formatting rule refers to.
   *
   * Read because the rule survived a round trip and its *format* did not: `dxfId` indexed a table nothing
   * parsed, so the next write found a rule with no `style` and wrote "no format". The rule then fired and
   * displayed nothing — harder to notice than a missing rule, because Excel still lists it.
   */
  readonly dxfs: readonly (Partial<Style> | undefined)[];
  /** Font for each cell-format index, or `undefined` where the entry is the default font. */
  readonly fonts: readonly (Partial<Font> | undefined)[];
  /** Fill for each cell-format index, or `undefined` where the entry is the default (no) fill. */
  readonly fills: readonly (Fill | undefined)[];
  /** One per cell-format index; `undefined` where the format uses the default, no border. */
  readonly borders: readonly (Partial<Borders> | undefined)[];
  /** Named cell styles, with their formatting resolved through the style-XF collection. */
  readonly namedStyles: readonly NamedStyleLike[];
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
  /**
   * The font collection as `BrtFont` order gives it — what an `ifnt` indexes.
   *
   * Distinct from {@link fonts}, which is indexed by *cell format*. A rich string's `StrRun` names its font
   * by position in this collection, so reading the runs needs this list and not that one; without it the runs
   * could be parsed and then not resolved to anything.
   */
  readonly fontTable: readonly (Partial<Font> | undefined)[];
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
 * the ones inside `BrtBeginCellXFs` are what a cell's `iStyleRef` indexes, so the scope is
 * tracked rather than every `BrtXF` being collected.
 */
export function readStyles(bytes: Uint8Array, part: string): StyleTable {
  const customFormats = new Map<number, string>();
  /** A format identifier as a format string: the part's own `BrtFmt`, else the reserved code. */
  const formatById = (id: number): string | undefined =>
    customFormats.get(id) ?? builtinNumberFormat(id);
  /** Differential formats, indexed the way a conditional-formatting rule's `dxfId` indexes them. */
  const dxfs: (Partial<Style> | undefined)[] = [];
  const fontTable: (Partial<Font> | undefined)[] = [];
  const fillTable: (Fill | undefined)[] = [];
  const borderTable: (Partial<Borders> | undefined)[] = [];
  /** Style XFs, which `BrtStyle.ixf` indexes. A different collection from the cell XFs. */
  const styleXfs: {
    numberFormat?: string;
    font?: Partial<Font>;
    fill?: Fill;
    border?: Partial<Borders>;
    alignment?: Partial<Alignment>;
    protection?: Partial<Protection>;
  }[] = [];
  const namedStyles: { name: string; ixf: number; builtinId?: number; hidden?: boolean }[] = [];
  let inStyleXfs = false;
  const numberFormats: (string | undefined)[] = [];
  const fonts: (Partial<Font> | undefined)[] = [];
  const fills: (Fill | undefined)[] = [];
  const borders: (Partial<Borders> | undefined)[] = [];
  const alignments: (Partial<Alignment> | undefined)[] = [];
  const protections: (Partial<Protection> | undefined)[] = [];
  let unmodelledFontFlags = 0;
  let inCellXfs = false;

  for (const record of iterateInterpretableRecords(bytes, part)) {
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
      case "BrtDXF": {
        // Differential formats, in the order the `BrtBeginDXFs` collection declares them — which is what a
        // conditional-formatting rule's `dxfId` indexes. Pushed even when it reads as `undefined`, because a
        // gap would shift every id after it.
        dxfs.push(readDxf(record.payload, part));
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
      case "BrtBorder":
        borderTable.push(readBorder(record.payload, part));
        break;
      case "BrtBeginCellStyleXFs":
        inStyleXfs = true;
        break;
      case "BrtEndCellStyleXFs":
        inStyleXfs = false;
        break;
      case "BrtStyle": {
        const named = readNamedStyle(record.payload, part);
        if (named !== undefined) {
          namedStyles.push(named);
        }
        break;
      }
      case "BrtBeginCellXFs":
        inCellXfs = true;
        break;
      case "BrtEndCellXFs":
        inCellXfs = false;
        break;
      case "BrtXF": {
        if (inStyleXfs) {
          // A style XF, which a `BrtStyle` points at by index. Collected separately from the cell XFs
          // because the two collections are indexed independently — reading them into one list is what
          // would make a named style resolve to whichever cell format happened to sit at that position.
          styleXfs.push({
            // The built-in fallback, which the cell XFs below have always had and this did not: a named style
            // whose format is one of the reserved codes carries no `BrtFmt`, and read without the fallback it
            // came back with no format at all. Latent while this library's writer emitted a `BrtFmt` for every
            // format including the built-ins — a bug the writer was hiding rather than one it lacked.
            numberFormat: formatById(
              new BinaryReader(record.payload, XF_FORMAT_OFFSET, part).readUint16()
            ),
            font: fontTable[new BinaryReader(record.payload, XF_FONT_OFFSET, part).readUint16()],
            fill: fillTable[new BinaryReader(record.payload, XF_FILL_OFFSET, part).readUint16()],
            border:
              record.payload.length >= XF_BORDER_OFFSET + 2
                ? borderTable[new BinaryReader(record.payload, XF_BORDER_OFFSET, part).readUint16()]
                : undefined,
            alignment: readAlignment(record.payload),
            protection: readProtection(record.payload)
          });
          break;
        }
        if (!inCellXfs) {
          break;
        }
        if (record.payload.length < XF_FILL_OFFSET + 2) {
          numberFormats.push(undefined);
          fonts.push(undefined);
          fills.push(undefined);
          borders.push(undefined);
          alignments.push(undefined);
          protections.push(undefined);
          break;
        }
        const id = new BinaryReader(record.payload, XF_FORMAT_OFFSET, part).readUint16();
        const format = formatById(id);
        // `General` is normalised to "no format". Reporting the string instead would be more
        // literal and worse: every caller would have to compare against a magic value to answer
        // the only question they have — is there a format to apply — and the round trip through
        // `CellFormatTable`, whose index 0 *is* "no format", would stop being symmetric.
        numberFormats.push(format === "General" ? undefined : format);
        // Index 0 of each table is the default, which a cell does not need to be told about.
        const iFont = new BinaryReader(record.payload, XF_FONT_OFFSET, part).readUint16();
        const iFill = new BinaryReader(record.payload, XF_FILL_OFFSET, part).readUint16();
        const iBorder =
          record.payload.length >= XF_BORDER_OFFSET + 2
            ? new BinaryReader(record.payload, XF_BORDER_OFFSET, part).readUint16()
            : 0;
        fonts.push(iFont === 0 ? undefined : fontTable[iFont]);
        fills.push(iFill === 0 ? undefined : fillTable[iFill]);
        borders.push(iBorder === 0 ? undefined : borderTable[iBorder]);
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
    dxfs,
    fonts,
    fills,
    borders,
    // Resolved here rather than in the loop: a `BrtStyle` may precede the `BrtXF` it points at, and the
    // whole style-XF collection is known only once the part has been walked.
    namedStyles: namedStyles.map(entry => {
      const xf = styleXfs[entry.ixf] ?? {};
      return {
        name: entry.name,
        ...(entry.builtinId === undefined || entry.builtinId === 0
          ? {}
          : { builtinId: entry.builtinId }),
        ...(entry.hidden === true ? { hidden: true } : {}),
        ...(xf.numberFormat === undefined || xf.numberFormat === "General"
          ? {}
          : { numFmt: xf.numberFormat }),
        ...(xf.font === undefined ? {} : { font: xf.font }),
        ...(xf.fill === undefined ? {} : { fill: xf.fill }),
        ...(xf.border === undefined ? {} : { border: xf.border }),
        ...(xf.alignment === undefined ? {} : { alignment: xf.alignment }),
        ...(xf.protection === undefined ? {} : { protection: xf.protection })
      };
    }),
    alignments,
    protections,
    unmodelledFontFlags,
    fontTable,
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
    border: owner.border,
    alignment: owner.alignment,
    protection: owner.protection
  });
}

/** The formatting a single cell asks for. Any subset may be present. */
export interface InternedFormat {
  readonly numberFormat?: string | undefined;
  readonly font?: Partial<Font> | undefined;
  readonly fill?: Fill | undefined;
  readonly border?: Partial<Borders> | undefined;
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
  /** Interned borders. Index 0 is the default — no border — which every corpus workbook writes. */
  private readonly borders: (Partial<Borders> | undefined)[] = [undefined];
  private readonly borderIndexByKey = new Map<string, number>();

  /** Index for a cell format, adding it if new. An empty format maps to 0. */
  intern(format: InternedFormat): number {
    const numberFormat =
      format.numberFormat === "General" ? undefined : (format.numberFormat ?? undefined);
    const font = isEmptyObject(format.font) ? undefined : format.font;
    const fill = format.fill;
    const border = isEmptyObject(format.border) ? undefined : format.border;
    const alignment = isEmptyObject(format.alignment) ? undefined : format.alignment;
    const protection = isEmptyObject(format.protection) ? undefined : format.protection;
    if (
      numberFormat === undefined &&
      font === undefined &&
      fill === undefined &&
      border === undefined &&
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
      border ?? null,
      alignment ?? null,
      protection ?? null
    ]);
    const existing = this.indexByKey.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const index = this.xfs.length;
    this.xfs.push({ numberFormat, font, fill, border, alignment, protection });
    this.indexByKey.set(key, index);

    if (font !== undefined) {
      this.internInto(this.fonts, this.fontIndexByKey, font);
    }
    if (fill !== undefined) {
      this.internInto(this.fills, this.fillIndexByKey, fill);
    }
    if (border !== undefined) {
      this.internInto(this.borders, this.borderIndexByKey, border);
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

  /** Border table as it will be written. Index 0 is the default, no border. */
  get borderEntries(): readonly (Partial<Borders> | undefined)[] {
    return this.borders;
  }

  /** Index of an interned border within {@link borderEntries}. */
  borderIndex(border: Partial<Borders> | undefined): number {
    return border === undefined ? 0 : (this.borderIndexByKey.get(JSON.stringify(border)) ?? 0);
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

  private internInto<T>(table: (T | undefined)[], keys: Map<string, number>, value: T): number {
    const key = JSON.stringify(value);
    const existing = keys.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const index = table.length;
    keys.set(key, index);
    table.push(value);
    return index;
  }

  /**
   * Intern a font on its own and return its `ifnt`.
   *
   * Rich text needs this: a `StrRun` names its font by index into the same `BrtFont` collection the cell
   * formats index, so a run's font has to be in *that* table and not a second one. Without it a rich string
   * could only refer to fonts some cell happened to use, which is why rich text was reported as unwritable
   * rather than approximated.
   *
   * An empty or absent font is index 0, the default — which is what a run with no formatting of its own means.
   */
  internFont(font: Partial<Font> | undefined): number {
    return font === undefined || isEmptyObject(font)
      ? 0
      : this.internInto(this.fonts, this.fontIndexByKey, font);
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
export function writeStyles(
  table: CellFormatTable,
  bookDefaultFont?: Partial<Font>,
  namedStyles: readonly NamedStyleLike[] = [],
  dxfs: readonly Partial<Style>[] = []
): Uint8Array {
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
    // A built-in code resolves to its reserved identifier and contributes no `BrtFmt`.
    const builtIn = BUILT_IN_FORMAT_IDS.get(entry.numberFormat);
    if (builtIn !== undefined) {
      formatIdByIndex.set(index, builtIn);
      continue;
    }
    let id = idByFormat.get(entry.numberFormat);
    if (id === undefined) {
      id = FIRST_CUSTOM_FORMAT_ID + idByFormat.size;
      idByFormat.set(entry.numberFormat, id);
    }
    formatIdByIndex.set(index, id);
  }
  // A named style's format has to reach the same table, or its style XF points at an id no `BrtFmt`
  // declares — which is a format Excel resolves to `General`, silently.
  for (const named of namedStyles) {
    if (
      named.numFmt !== undefined &&
      named.numFmt !== "General" &&
      !BUILT_IN_FORMAT_IDS.has(named.numFmt) &&
      !idByFormat.has(named.numFmt)
    ) {
      idByFormat.set(named.numFmt, FIRST_CUSTOM_FORMAT_ID + idByFormat.size);
    }
  }
  // Omitted when there is nothing in it. Excel writes no `BrtBeginFmts` at all for a workbook with only
  // built-in number formats — verified across eight styles parts it produced — while this wrote an empty
  // collection. The same distinction as `BrtBeginColInfos`, which is noted in the record table for the same
  // reason: whether a collection-begin record appears when empty is per record and cannot be generalised.
  const hasFormats = idByFormat.size > 0;
  if (hasFormats) {
    record("BrtBeginFmts", count(idByFormat.size));
  }
  for (const [format, id] of idByFormat) {
    record(
      "BrtFmt",
      concatUint8Arrays([
        new BinaryWriter().writeUint16(id).toUint8Array(),
        encodeWideString(format)
      ])
    );
  }
  if (hasFormats) {
    record("BrtEndFmts");
  }

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

  // The default — 51 zero bytes — then one per interned border. Index 0 has to be the default because a
  // cell format with no border points at it, which is what every corpus workbook does.
  const borders = table.borderEntries;
  record("BrtBeginBorders", count(borders.length));
  for (const border of borders) {
    record("BrtBorder", encodeBorder(border));
  }
  record("BrtEndBorders");

  // The style XFs a named style points at. One, for `Normal`.
  // One style XF per named style, plus `Normal` at index 0. `BrtStyle.ixf` indexes *this* collection —
  // not the cell XFs — so the two have to be written together and in the same order.
  //
  // The facets each style asks for are interned into the same font, fill and border tables the cells
  // use, which is why this runs after them: a named style that bolds its text shares the bold font
  // record with any cell that does, rather than adding a second.
  record("BrtBeginCellStyleXFs", count(1 + namedStyles.length));
  record("BrtXF", cellFormat({ parent: 0xffff, formatId: 0, fontIndex: 0, fillIndex: 0 }));
  for (const named of namedStyles) {
    record(
      "BrtXF",
      cellFormat({
        // **`0xFFFF` — a style XF has no parent.** `ixfParent` is an index into *this* collection, and this wrote
        // 0 on the reasoning that a named style inherits from `Normal`. That reasoning is about the style
        // hierarchy, not about this field: a `BrtXF` in `BrtBeginCellStyleXFs` is a *root* format, and 0xFFFF is
        // how the record says so. Excel writes 0xFFFF for every one of them.
        //
        // The cost was the whole styles part. Forty-eight of forty-nine style XFs claimed style XF 0 as their
        // parent, and Excel answered `Removed Records: Style from /xl/styles.bin part (Styles)` — it discarded
        // every named style in the workbook. Note *which* records it named: the fault was in the XFs and the
        // symptom was in the Styles that index them, which is why reading the message literally led nowhere for
        // several rounds.
        //
        // A cell XF is the opposite case and keeps `parent: 0`: it genuinely inherits from a style XF, and 0 is
        // `Normal`.
        parent: 0xffff,
        // Built-in first, then this part's own `BrtFmt` table — the same resolution the cell formats use.
        // Looking only in `idByFormat` left a named style whose format is a reserved code pointing at
        // identifier 0, which is `General`: the style kept its font and lost its number format.
        formatId:
          named.numFmt === undefined
            ? 0
            : (BUILT_IN_FORMAT_IDS.get(named.numFmt) ?? idByFormat.get(named.numFmt) ?? 0),
        fontIndex: table.fontIndex(named.font),
        fillIndex: table.fillIndex(named.fill),
        borderIndex: table.borderIndex(named.border),
        alignment: named.alignment,
        protection: named.protection
      })
    );
  }
  record("BrtEndCellStyleXFs");

  record("BrtBeginCellXFs", count(table.entries.length));
  table.entries.forEach((entry, index) => {
    record(
      "BrtXF",
      cellFormat({
        parent: 0,
        formatId: formatIdByIndex.get(index) ?? 0,
        fontIndex: table.fontIndex(entry.font),
        fillIndex: table.fillIndex(entry.fill),
        borderIndex: table.borderIndex(entry.border),
        alignment: entry.alignment,
        protection: entry.protection
      })
    );
  });
  record("BrtEndCellXFs");

  record("BrtBeginStyles", count(1 + namedStyles.length));
  record("BrtStyle", normalStyle());
  namedStyles.forEach((named, index) => {
    record("BrtStyle", namedStyle(named, index + 1));
  });
  record("BrtEndStyles");

  // The differential formats a conditional-formatting rule's `dxfId` indexes. **After the styles, and always**
  // — both of which this had wrong. It wrote them before `BrtBeginStyles`, with a comment asserting that is
  // where the grammar puts them, and omitted the collection when empty. Excel puts
  // `Styles → DXFs → TableStyles` and writes `BrtBeginDXFs` with a count of zero when there are none, in every
  // styles part it produced.
  // **Encoded before the count is written**, because a style that yields no properties is not writable and the
  // declared count has to match the records that follow. Excel discards the whole collection when it meets an
  // empty `BrtDXF` — six bytes saying "a differential format that changes nothing" — so one unhandled font
  // property cost a workbook every rule's formatting. See `encodeDxf`.
  const encodedDxfs = dxfs
    .map(style => encodeDxf(style))
    .filter((payload): payload is Uint8Array => payload !== undefined);
  record("BrtBeginDXFs", count(encodedDxfs.length));
  for (const payload of encodedDxfs) {
    record("BrtDXF", payload);
  }
  record("BrtEndDXFs");

  // The default table and PivotTable style names. Excel writes this collection unconditionally; nothing here
  // wrote it at all, and a `BrtTableStyleClient` in a PivotTable view names a style this is where you declare.
  record("BrtBeginTableStyles", tableStyles());
  record("BrtEndTableStyles");

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
  borderIndex?: number;
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
  if ((options.borderIndex ?? 0) !== 0) {
    overrides |= ATTRIBUTE_MASK.border;
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
      // `ixBorder`. This was a hard zero — "the one table whose layout the corpus does not establish" —
      // which is why a border a caller asked for vanished. MS-XLSB 2.4.314 establishes it.
      .writeUint16(options.borderIndex ?? 0)
      .toUint8Array(),
    encodeAlignmentAndProtection(options.alignment, options.protection, overrides)
  ]);
}

function isEmptyObject(value: object | undefined): boolean {
  return value === undefined || Object.keys(value).length === 0;
}

/** The `Normal` named style every workbook has. */
/**
 * A named cell style: `BrtStyle` — MS-XLSB 2.4.809.
 *
 * ```text
 * ixf          u32   index into the BrtBeginCellStyleXFs collection
 * grbitObj1    u16   StyleFlags
 * iStyBuiltIn  u8    nonzero for a built-in style
 * iLevel       u8    only read when iStyBuiltIn is 1 or 2
 * stName       CellStyleName
 * ```
 *
 * **`iLevel` is 0 unless the style is an outline style, and `0xFF` costs the whole collection.** The comment
 * here used to claim `0xFF` was "what Excel writes"; Excel writes `0`, verified against a workbook it repaired:
 * `BrtStyle` came back as `00 00 00 00 01 00 00 00 …` for `Normal` and `01 00 00 00 01 00 08 00 …` for
 * `Hyperlink`, both with a zero in this byte. The field is an outline *level*, so `0xFF` is not "not
 * applicable" — it is level 255, and Excel answered `Removed Records: Style from /xl/styles.bin`, discarding
 * every named style in the workbook.
 *
 * Only `iStyBuiltIn` 1 and 2 — `RowLevel_n` and `ColLevel_n` — read this field at all, so a level is written
 * only for those and every other style gets 0.
 *
 * **The same defect lived in two encoders and was fixed in one.** `cellStyleRecord` further down had its `0xFF`
 * corrected earlier in the same session; this one kept it, and this is the one the built-in styles go through.
 * Two writers for one record is why a fix can look complete and change nothing.
 */
function namedStyle(named: NamedStyleLike, xfIndex: number): Uint8Array {
  const builtin = named.builtinId ?? 0;
  // `fBuiltIn` MUST be 1 whenever `iStyBuiltIn` is nonzero — the specification makes that a MUST, so the
  // two are derived from one value rather than set independently.
  let flags = builtin === 0 ? 0 : STYLE_FLAG_BUILT_IN;
  flags |= named.hidden === true ? STYLE_FLAG_HIDDEN : 0;
  return concatUint8Arrays([
    new BinaryWriter()
      .writeUint32(xfIndex)
      .writeUint16(flags)
      .writeUint8(builtin)
      // The outline level, meaningful only for `RowLevel_n` (1) and `ColLevel_n` (2).
      .writeUint8(builtin === 1 || builtin === 2 ? (named.outlineLevel ?? 0) : 0)
      .toUint8Array(),
    encodeWideString(named.name)
  ]);
}

/** Read a `BrtStyle`. Returns the name and the style-XF index it points at. */
function readNamedStyle(
  payload: Uint8Array,
  part: string
): { name: string; ixf: number; builtinId?: number; hidden?: boolean } | undefined {
  try {
    const reader = new BinaryReader(payload, 0, part);
    const ixf = reader.readUint32();
    const flags = reader.readUint16();
    const builtinId = reader.readUint8();
    reader.readUint8(); // iLevel
    const name = readWideString(reader, part);
    if (name === "" || name === "Normal") {
      // `Normal` is the default every workbook carries and not a style a caller defined.
      return undefined;
    }
    return {
      name,
      ixf,
      ...(builtinId === 0 ? {} : { builtinId }),
      ...((flags & STYLE_FLAG_HIDDEN) !== 0 ? { hidden: true } : {})
    };
  } catch {
    return undefined;
  }
}

/**
 * A `BrtDXF` — MS-XLSB 2.4.359.
 *
 * A *differential* format: a set of overrides rather than a complete one, so its payload is a flag word
 * and then an `XFProps` — a counted array of `XFProp`, each a type, a size and a blob whose shape the type
 * decides. Thirty-eight types are defined; this writes the ones the model's `Style` can express.
 *
 * **`cb` is the size of the whole `XFProp`, header included.** Writing the blob length instead makes every
 * property after the first land four bytes early, which a reader does not detect — it reads a plausible
 * type from the middle of a colour.
 *
 * Two mutual exclusions the specification states and this respects by construction: an `XFProp` of type 0
 * (a fill pattern) cannot coexist with types 3 or 4 (a gradient), and the model has no gradient here; and
 * `fNewBorder` must be 0 unless types 0x0B/0x0C are used, which are the *internal* borders of a range and
 * are not something a cell style carries.
 */
function encodeDxf(style: Partial<Style>): Uint8Array | undefined {
  const props: { type: number; bytes: Uint8Array }[] = [];
  const font = style.font;
  const fill = style.fill as { pattern?: string; fgColor?: unknown; bgColor?: unknown } | undefined;

  // Fill. The pattern comes first because type 0 is the pattern and the two colours refer to it.
  if (fill?.pattern !== undefined) {
    // **A `FillPattern` is one byte** (MS-XLSB 2.5.51 — an enumeration from 0x00 to 0x12), and this wrote four.
    // Excel writes `cb=5` for this property where this wrote `cb=8`.
    props.push(xfProp(0x00, new BinaryWriter().writeUint8(FILL_PATTERN_SOLID).toUint8Array()));
  }
  if (fill?.fgColor !== undefined) {
    props.push(xfProp(0x01, xfPropColor(fill.fgColor)));
  }
  if (fill?.bgColor !== undefined) {
    props.push(xfProp(0x02, xfPropColor(fill.bgColor)));
  }

  // Font. `Bold` is an *enumeration* — 0x0190 normal, 0x02BC bold — not a boolean, so a `1` here is
  // neither value and Excel reads it as a weight of one.
  if (font?.color !== undefined) {
    props.push(xfProp(0x05, xfPropColor(font.color)));
  }
  if (font?.name !== undefined) {
    props.push(xfProp(0x18, lpWideString(font.name)));
  }
  if (font?.bold !== undefined) {
    props.push(
      xfProp(0x19, new BinaryWriter().writeUint16(font.bold ? 0x02bc : 0x0190).toUint8Array())
    );
  }
  if (font?.italic !== undefined) {
    props.push(xfProp(0x1c, new BinaryWriter().writeUint8(font.italic ? 1 : 0).toUint8Array()));
  }
  if (font?.underline !== undefined && font.underline !== false) {
    // **`0x1A`, and it was missing entirely.** `bold`, `italic`, `strike`, `size`, `name` and `color` all had a
    // branch and the underline had none, so a rule formatted with nothing but an underline yielded a `BrtDXF`
    // with a property count of zero — six bytes that say "a differential format that changes nothing". Excel
    // discards the collection, and with it every other rule's formatting.
    //
    // The value is an `Underline` enumeration (0 none, 1 single, 2 double, 0x21/0x22 accounting), not a boolean,
    // and it comes from the same `underlineValue` the ordinary font records use.
    props.push(
      xfProp(0x1a, new BinaryWriter().writeUint16(underlineValue(font.underline)).toUint8Array())
    );
  }
  if (font?.strike !== undefined) {
    props.push(xfProp(0x1d, new BinaryWriter().writeUint8(font.strike ? 1 : 0).toUint8Array()));
  }
  // Borders. Each edge is its own `XFProp` — an `XFPropBorder`, which is the same eight-byte `XFPropColor`
  // as above followed by a two-byte `dgBorder`. Types 0x0B and 0x0C are the *internal* borders of a range
  // and are gated by `fNewBorder`; a cell style has no such thing, so the flag stays 0 and they are never
  // written.
  const border = style.border as Partial<Borders> | undefined;
  for (const [type, edge] of [
    [0x06, border?.top],
    [0x07, border?.bottom],
    [0x08, border?.left],
    [0x09, border?.right],
    [0x0a, border?.diagonal]
  ] as const) {
    if (edge !== undefined) {
      props.push(xfProp(type, xfPropBorder(edge)));
    }
  }
  // The two diagonal directions are separate one-byte flags rather than part of the diagonal edge, because
  // one diagonal border can be drawn in either direction or both.
  const diagonal = border?.diagonal as
    | { readonly up?: boolean; readonly down?: boolean }
    | undefined;
  if (diagonal?.up !== undefined) {
    props.push(xfProp(0x0d, new BinaryWriter().writeUint8(diagonal.up ? 1 : 0).toUint8Array()));
  }
  if (diagonal?.down !== undefined) {
    props.push(xfProp(0x0e, new BinaryWriter().writeUint8(diagonal.down ? 1 : 0).toUint8Array()));
  }

  if (font?.size !== undefined) {
    // Twips, and bounded at 20–8191 by the specification — 20 twips is one point.
    const twips = Math.max(20, Math.min(8191, Math.round(font.size * DXF_TWIPS_PER_POINT)));
    props.push(xfProp(0x24, new BinaryWriter().writeUint32(twips).toUint8Array()));
  }

  // Ascending by type. The specification does not require an order — it constrains which types may
  // *coexist*, not their sequence — but Excel writes an enumerated property array in type order, and
  // matching that costs nothing while a needless deviation is one more thing a reader could be strict
  // about. The one ordering rule that does exist is that a gradient (type 3) is followed by its stops
  // (type 4); nothing here produces a gradient, and a sort by type would preserve that pairing anyway.
  props.sort((left, right) => left.type - right.type);
  if (props.length === 0) {
    // **A differential format that changes nothing is not writable.** Excel discards the whole `DXFs` collection
    // when it meets one — and with it every other rule's formatting, which is how a single unhandled font
    // property (the underline, above) cost an entire workbook its conditional formatting.
    //
    // Returning `undefined` rather than an empty record makes the caller decide: `collectDxfs` drops the style
    // and the rule keeps `dxfId` "none", so the rule still applies and simply carries no format. That is a
    // visible, reportable loss instead of a package Excel repairs. It is also a guard rather than a fix — the
    // fix is for every model property to have a branch — but the next one that is missed will cost one rule's
    // formatting instead of all of them.
    return undefined;
  }
  return concatUint8Arrays([
    // The flag word: fifteen unused bits, then `fNewBorder` at bit 15.
    //
    // **Set.** It is a *capability* — "internal border formatting can be used in `xfprops`", meaning the
    // `XFProp` types `0x0B` and `0x0C` are permitted — not a statement that any is present. Excel sets it on
    // every `BrtDXF` it writes; this wrote zero, which forbids those types. Nothing here emits one today, so
    // the difference is latent rather than visible, and it is the sort of latency that turns into a puzzle the
    // first time an inner border is added.
    new BinaryWriter().writeUint16(DXF_NEW_BORDER).toUint8Array(),
    // `XFProps`: two reserved bytes, then the count.
    new BinaryWriter().writeUint16(0).writeUint16(props.length).toUint8Array(),
    ...props.map(property => property.bytes)
  ]);
}

/** `fNewBorder`, bit 15 of `BrtDXF`'s flag word: the inner-border `XFProp` types are permitted. */
const DXF_NEW_BORDER = 0x8000;

/** `FillPattern` for a solid fill, which is the only pattern a differential format here expresses. */
const FILL_PATTERN_SOLID = 1;

/** Twips per point, for a differential font size. */
const DXF_TWIPS_PER_POINT = 20;

/** One `XFProp`: a type, the size of the *whole* structure, then the blob. */
function xfProp(type: number, blob: Uint8Array): { type: number; bytes: Uint8Array } {
  const bytes = concatUint8Arrays([
    new BinaryWriter()
      .writeUint16(type)
      .writeUint16(blob.length + 4)
      .toUint8Array(),
    blob
  ]);
  return { type, bytes };
}

/**
 * An `XFPropColor` — MS-XLSB 2.5.161. Eight bytes.
 *
 * `xclrType` 2 is an RGBA colour and 3 a theme index; 4 is "not set". `fValidRGBA` says whether `dwRgba`
 * was derived from the other three fields, and it is set for an explicit ARGB because that is exactly
 * what `dwRgba` then holds.
 */
function xfPropColor(color: unknown): Uint8Array {
  const value = color as { argb?: string; theme?: number; tint?: number } | undefined;
  const writer = new BinaryWriter();
  if (value?.theme !== undefined) {
    writer.writeUint8(0x03).writeUint8(value.theme & 0xff);
  } else if (typeof value?.argb === "string") {
    // Bit 0 is `fValidRGBA`, and `xclrType` occupies the seven bits above it.
    writer.writeUint8(0x01 | (0x02 << 1)).writeUint8(0);
  } else {
    writer.writeUint8(0x04 << 1).writeUint8(0);
  }
  // `nTintShade` maps to -1.0…1.0 and MUST NOT be -32768. Written through `writeUint16` with the
  // two's-complement conversion done here, because the writer has no signed 16-bit method — and a negative
  // tint passed to the unsigned one would be written as a very large lightening value.
  const tint = Math.max(-32767, Math.min(32767, Math.round((value?.tint ?? 0) * 32767)));
  writer.writeUint16(tint < 0 ? tint + 0x10000 : tint);
  const argb = typeof value?.argb === "string" ? value.argb : "00000000";
  // `LongRGBA` is a byte order all its own: red, green, blue, alpha — *not* the ARGB the string spells.
  const bytes = argb.padStart(8, "0").slice(-8);
  const at = (index: number): number => Number.parseInt(bytes.slice(index, index + 2), 16) || 0;
  writer.writeUint8(at(2)).writeUint8(at(4)).writeUint8(at(6)).writeUint8(at(0));
  return writer.toUint8Array();
}

/**
 * An `XFPropBorder` — MS-XLSB 2.5.160. Ten bytes: the colour, then the line style.
 *
 * `dgBorder` comes from `borderStyleValue` rather than a second table here: a `BrtBorder` edge writes the
 * same enumeration, and two copies of those fourteen names in two orders is how one of the two ends up
 * writing "medium" where the caller asked for "thin".
 */
function xfPropBorder(edge: unknown): Uint8Array {
  const value = edge as { style?: BorderStyle; color?: unknown } | undefined;
  return concatUint8Arrays([
    xfPropColor(value?.color),
    new BinaryWriter().writeUint16(borderStyleValue(value?.style)).toUint8Array()
  ]);
}

/** An `LPWideString`: a one-byte character count, then UTF-16. */
function lpWideString(value: string): Uint8Array {
  const characters = [...value].slice(0, 32);
  // **`cchCharacters` is two bytes** (MS-XLSB 2.5.92), and this wrote one. Everything after the count therefore
  // landed a byte early, so a differential format naming a font read its name from the wrong offset — Excel
  // discarded the whole `DXFs` collection, and with it every conditional-formatting rule's formatting.
  //
  // Verified against Excel's own bytes for the same font: `0d 00 43 00 6f 00 …` for "Comic Sans MS", where this
  // wrote `0d 43 00 6f 00 …`. The record's `cb` differed by exactly one — 32 against 31 — which is the whole
  // visible symptom of a field being half the width it should be.
  const writer = new BinaryWriter().writeUint16(characters.length);
  for (const character of characters.join("")) {
    writer.writeUint16(character.charCodeAt(0));
  }
  return writer.toUint8Array();
}

/** `StyleFlags.fBuiltIn`. */
const STYLE_FLAG_BUILT_IN = 0x01;
/** `StyleFlags.fHidden` — hidden from Excel's Cell Styles gallery. */
const STYLE_FLAG_HIDDEN = 0x02;

/** A named cell style, as the model holds it. */
export interface NamedStyleLike {
  readonly name: string;
  readonly font?: Partial<Font>;
  readonly fill?: Fill;
  readonly border?: Partial<Borders>;
  readonly alignment?: Partial<Alignment>;
  readonly protection?: Partial<Protection>;
  readonly numFmt?: string;
  readonly builtinId?: number;
  readonly hidden?: boolean;
  /**
   * The outline level a `RowLevel_n`/`ColLevel_n` built-in style applies to.
   *
   * Only those two built-ins read it; every other style writes 0. Modelled because the field exists and a
   * workbook using outline styles has a level to carry — not because anything sets it yet.
   */
  readonly outlineLevel?: number;
}

function normalStyle(): Uint8Array {
  return concatUint8Arrays([
    new BinaryWriter()
      .writeUint32(0) // ixf
      .writeUint16(1) // grbitObj
      .writeUint8(0) // iStyBuiltIn
      // `iLevel` — the outline level a `RowLevel_n`/`ColLevel_n` built-in style applies to. `Normal` has none,
      // and Excel writes 0. This wrote `0xff`, reading the field as "not applicable"; the field is an outline
      // level, and 255 is not one.
      .writeUint8(0) // iLevel
      .toUint8Array(),
    encodeWideString("Normal")
  ]);
}

/**
 * Read a `BrtDXF` back into the partial `Style` a conditional-formatting rule holds.
 *
 * The inverse of {@link encodeDxf}, and it exists because the rule survived a round trip while its *format*
 * did not: `dxfId` came back as an index into a table nothing read, so the second write found a rule with no
 * `style` and wrote `0xFFFFFFFF`. The rule then fired and displayed nothing — harder to notice than the rule
 * disappearing, because the conditional formatting is still listed in Excel's dialog.
 *
 * Walked by `cb` rather than by a fixed field order. The specification constrains which property types may
 * coexist, not their sequence, so a producer other than this writer may order them differently — and `cb`
 * covering the whole `XFProp` is what makes the walk possible at all.
 */
export function readDxf(payload: Uint8Array, part: string): Partial<Style> | undefined {
  if (payload.length < 6) {
    return undefined;
  }
  const view = new DataView(payload.buffer, payload.byteOffset, payload.length);
  const font: Record<string, unknown> = {};
  const fill: Record<string, unknown> = {};
  const border: Record<string, unknown> = {};
  // Two flag bytes, then `XFProps`: two reserved and the property count.
  let offset = 6;
  while (offset + 4 <= payload.length) {
    const type = view.getUint16(offset, true);
    const size = view.getUint16(offset + 2, true);
    if (size < 4 || offset + size > payload.length) {
      break;
    }
    const blob = offset + 4;
    switch (type) {
      case 0x00:
        // The fill pattern. Only solid is written, and a fill with a colour and no pattern is not a fill the
        // model can express.
        fill.type = "pattern";
        fill.pattern = "solid";
        break;
      case 0x01:
        fill.fgColor = readDxfColor(view, blob);
        break;
      case 0x02:
        fill.bgColor = readDxfColor(view, blob);
        break;
      case 0x05:
        font.color = readDxfColor(view, blob);
        break;
      case 0x06:
      case 0x07:
      case 0x08:
      case 0x09:
      case 0x0a:
        border[DXF_BORDER_EDGE[type]!] = readDxfBorder(view, blob);
        break;
      case 0x18:
        font.name = readLpWideString(view, blob);
        break;
      case 0x19:
        // `Bold` is an enumeration: 0x02BC is bold, 0x0190 normal. Anything else is neither, so it is not
        // reported as a boolean either.
        font.bold = view.getUint16(blob, true) === 0x02bc;
        break;
      case 0x1c:
        font.italic = view.getUint8(blob) === 1;
        break;
      case 0x1d:
        font.strike = view.getUint8(blob) === 1;
        break;
      case 0x24:
        // Twips back to points.
        font.size = view.getUint32(blob, true) / 20;
        break;
      default:
        break;
    }
    offset += size;
  }
  const style: Record<string, unknown> = {};
  if (Object.keys(font).length > 0) {
    style.font = font;
  }
  if (Object.keys(fill).length > 0) {
    // A pattern, even when the record did not carry one. This writer always emits type 0x00 alongside the
    // colours, but a `Fill` with a colour and no `type` is not a shape the model can express — and another
    // producer is free to omit it, since the specification only forbids a *gradient* beside a pattern.
    fill.type ??= "pattern";
    fill.pattern ??= "solid";
    style.fill = fill;
  }
  if (Object.keys(border).length > 0) {
    style.border = border;
  }
  return Object.keys(style).length === 0 ? undefined : (style as Partial<Style>);
}

/** `XFProp` type to the border edge it formats — MS-XLSB 2.5.159 types 0x06 through 0x0A. */
const DXF_BORDER_EDGE: Readonly<Record<number, string>> = {
  0x06: "top",
  0x07: "bottom",
  0x08: "left",
  0x09: "right",
  0x0a: "diagonal"
};

/** An `XFPropColor`: `fValidRGBA` and `xclrType` share a byte, then a palette index, a tint and `LongRGBA`. */
function readDxfColor(view: DataView, offset: number): Record<string, unknown> {
  const kind = view.getUint8(offset) >> 1;
  const tint = view.getInt16(offset + 2, true);
  const colour: Record<string, unknown> = {};
  if (kind === 0x03) {
    colour.theme = view.getUint8(offset + 1);
  } else if (kind === 0x02) {
    // `LongRGBA` is red, green, blue, alpha — not the order the model's `argb` string spells, so the bytes are
    // reordered rather than concatenated.
    const hex = (value: number): string => value.toString(16).padStart(2, "0").toUpperCase();
    colour.argb =
      hex(view.getUint8(offset + 7)) +
      hex(view.getUint8(offset + 4)) +
      hex(view.getUint8(offset + 5)) +
      hex(view.getUint8(offset + 6));
  }
  if (tint !== 0) {
    colour.tint = tint / 32767;
  }
  return colour;
}

/** An `XFPropBorder`: an eight-byte colour then a two-byte `dgBorder`. */
function readDxfBorder(view: DataView, offset: number): Record<string, unknown> {
  const style = borderStyleName(view.getUint16(offset + 8, true));
  const colour = readDxfColor(view, offset);
  return {
    ...(style === undefined ? {} : { style }),
    ...(Object.keys(colour).length === 0 ? {} : { color: colour })
  };
}

/** An `LPWideString`: a one-byte character count, then UTF-16. */
function readLpWideString(view: DataView, offset: number): string {
  // **Two bytes of count**, matching `lpWideString`. Both read and wrote one, so a font name round-tripped
  // through this codec perfectly and was rejected by Excel — the fifth time in this module that a reader and a
  // writer sharing a wrong assumption made a defect invisible from the inside.
  const characters = view.getUint16(offset, true);
  let text = "";
  for (let index = 0; index < characters; index += 1) {
    text += String.fromCharCode(view.getUint16(offset + 2 + index * 2, true));
  }
  return text;
}

/**
 * `BrtBeginTableStyles` — the count of custom table styles, then the two default style names.
 *
 * Zero custom styles: nothing here defines one. The names are the defaults Excel writes, and the PivotTable
 * one is what `BrtTableStyleClient` in a pivot view refers to.
 */
function tableStyles(): Uint8Array {
  return concatUint8Arrays([
    new BinaryWriter().writeUint32(0).toUint8Array(),
    encodeWideString(DEFAULT_TABLE_STYLE),
    encodeWideString(DEFAULT_PIVOT_STYLE)
  ]);
}

const DEFAULT_TABLE_STYLE = "TableStyleMedium2";
const DEFAULT_PIVOT_STYLE = "PivotStyleLight16";

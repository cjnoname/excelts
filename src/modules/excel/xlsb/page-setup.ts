/**
 * Page setup: margins, paper, scaling and the default row and column sizes.
 *
 * **`BrtMargins` is the most firmly established record in this module.** Forty-eight bytes, six
 * `float64`s, and `any_sheets.xlsb` carries `0.7, 0.7, 0.75, 0.75, 0.3, 0.3` — Excel's default
 * margins exactly: 0.7 inch left and right, 0.75 top and bottom, 0.3 for the header and footer.
 * The order follows from the pairing: three pairs of equal values in a record whose defaults are
 * three pairs. The metric-locale workbooks agree, carrying `0.7875` (2 cm) in the same positions.
 *
 * **`BrtPageSetup`** was confirmed three independent ways. Its first field reads 9, which is A4 in
 * the paper-size enumeration; its second reads 100, a scale percentage; and its last is a
 * relationship id — `0xFFFFFFFF` in the workbooks with no printer settings, and the string
 * `"rId2"` in `issues.xlsb`, which is the one workbook in the corpus that ships
 * `xl/printerSettings/printerSettings1.bin`.
 *
 * **`BrtWsFmtInfo`** carries the sheet's default row height in twips: 300 in the Calibri 11
 * workbooks, which is 15 points — Excel's default. The metric and LibreOffice files read 264, 288
 * and 280, all plausible defaults for their own fonts.
 *
 * **`BrtPrintOptions` is deliberately absent.** Two bytes, and the corpus disagrees with itself:
 * `0x0010` in most files but `0x5950` and `0x5a30` in `picture.xlsb`. A two-byte field holding
 * about six flags should not reach 0x5a30, so either the reading is wrong or those records are
 * something else — and a print option guessed wrong flips a boolean silently. One inconsistent
 * sample is not an establishment.
 */
import type { Margins, PageSetup } from "@excel/types";
import { COLUMN_WIDTH_UNITS, TWIPS_PER_POINT } from "@excel/xlsb/binary";
import { BinaryReader, BinaryWriter } from "@utils/binary";

/** Bytes in a `BrtMargins`. Six `float64`s. */
const MARGINS_SIZE = 48;

/** Excel's default margins, in inches — the values that identified the field order. */
export const DEFAULT_MARGINS: Margins = {
  left: 0.7,
  right: 0.7,
  top: 0.75,
  bottom: 0.75,
  header: 0.3,
  footer: 0.3
};

/** Read a `BrtMargins`. */
export function readMargins(payload: Uint8Array, part: string): Margins | undefined {
  if (payload.length < MARGINS_SIZE) {
    return undefined;
  }
  const reader = new BinaryReader(payload, 0, part);
  return {
    left: reader.readFloat64(),
    right: reader.readFloat64(),
    top: reader.readFloat64(),
    bottom: reader.readFloat64(),
    header: reader.readFloat64(),
    footer: reader.readFloat64()
  };
}

/** Serialise a `BrtMargins`, filling anything the caller left out with Excel's default. */
export function encodeMargins(margins: Partial<Margins> | undefined): Uint8Array {
  const resolved = { ...DEFAULT_MARGINS, ...margins };
  return new BinaryWriter()
    .writeFloat64(resolved.left)
    .writeFloat64(resolved.right)
    .writeFloat64(resolved.top)
    .writeFloat64(resolved.bottom)
    .writeFloat64(resolved.header)
    .writeFloat64(resolved.footer)
    .toUint8Array();
}

/** `BrtPageSetup` flag bits. Only `fLandscape` and `fNoOrient` are exercised by the corpus. */
/**
 * `BrtPageSetup`'s flag word, MS-XLSB 2.4.722: `fLeftToRight`(0), `fLandscape`(1), reserved(2), `fNoColor`(3),
 * `fDraft`(4), `fNotes`(5), `fNoOrient`(6), `fUsePage`(7), `fEndNotes`(8), `iErrors`(9–10).
 *
 * **`noOrient` was `0x0080` here**, under the name `orientationSet` and with the opposite polarity. Bit 7 is
 * `fUsePage` — "number the first printed page from `iPageStart`" — so every sheet with a stated orientation
 * also claimed a custom first page number. Excel writes `0x0000` for such a sheet.
 *
 * The bit that means "the orientation was not chosen" is `fNoOrient` at bit 6, and it is set when the
 * orientation is *absent*, not present.
 */
const PAGE_SETUP_FLAGS = {
  landscape: 0x0002,
  noOrient: 0x0040,
  usePage: 0x0080
} as const;

/** What a `BrtPageSetup` says, in the model's terms. */
export type ReadPageSetup = Partial<
  Pick<
    PageSetup,
    | "paperSize"
    | "scale"
    | "horizontalDpi"
    | "verticalDpi"
    | "fitToWidth"
    | "fitToHeight"
    | "orientation"
    | "firstPageNumber"
  >
>;

/** Read a `BrtPageSetup`. */
export function readPageSetup(payload: Uint8Array, part: string): ReadPageSetup | undefined {
  if (payload.length < 34) {
    return undefined;
  }
  const reader = new BinaryReader(payload, 0, part);
  const paperSize = reader.readUint32();
  const scale = reader.readUint32();
  const horizontalDpi = reader.readUint32();
  const verticalDpi = reader.readUint32();
  reader.readUint32(); // copies — the model has no field for it
  const firstPageNumber = reader.readUint32();
  const fitToWidth = reader.readUint32();
  const fitToHeight = reader.readUint32();
  const flags = reader.readUint16();

  const setup: ReadPageSetup = {};
  if (paperSize !== 0) {
    setup.paperSize = paperSize;
  }
  if (scale !== 0 && scale !== 100) {
    setup.scale = scale;
  }
  if (horizontalDpi !== 0) {
    setup.horizontalDpi = horizontalDpi;
  }
  if (verticalDpi !== 0) {
    setup.verticalDpi = verticalDpi;
  }
  if (fitToWidth !== 1) {
    setup.fitToWidth = fitToWidth;
  }
  if (fitToHeight !== 1) {
    setup.fitToHeight = fitToHeight;
  }
  // Kept when `fUsePage` says the number is meant, even if it is 1: the bit and the number are one statement,
  // and dropping the number turns a deliberate "start at 1" into silence that re-encodes without the bit.
  if (firstPageNumber > 1 || (flags & PAGE_SETUP_FLAGS.usePage) !== 0) {
    setup.firstPageNumber = firstPageNumber;
  }
  // Reported only when the file says the orientation was chosen; otherwise it is the printer's.
  if ((flags & PAGE_SETUP_FLAGS.noOrient) === 0) {
    setup.orientation = (flags & PAGE_SETUP_FLAGS.landscape) !== 0 ? "landscape" : "portrait";
  }
  return Object.keys(setup).length === 0 ? undefined : setup;
}

/**
 * Serialise a `BrtPageSetup`.
 *
 * The trailing relationship id is written absent (`0xFFFFFFFF`): it names a `printerSettings`
 * part, and this library does not produce one, so pointing at a part that is not in the package
 * would be the same class of dangling reference as a `PtgName` with no `BrtName`.
 */
export function encodePageSetup(setup: ReadPageSetup | undefined): Uint8Array {
  let flags = 0;
  if (setup?.orientation === "landscape" || setup?.orientation === "portrait") {
    if (setup.orientation === "landscape") {
      flags |= PAGE_SETUP_FLAGS.landscape;
    }
  } else {
    // Nothing chose an orientation, so the printer decides.
    flags |= PAGE_SETUP_FLAGS.noOrient;
  }
  if (setup?.firstPageNumber !== undefined) {
    // `fUsePage` — number the first printed page from `iPageStart`. Derived from the presence of a first page
    // number, which is what this library's XLSX writer does with `useFirstPageNumber`.
    flags |= PAGE_SETUP_FLAGS.usePage;
  }
  return (
    new BinaryWriter()
      // **The defaults are the XLSX schema's, not zero.** A field omitted from `<pageSetup>` has a stated
      // default; this record has no way to omit one, so a zero here is a positive claim rather than silence.
      // `iPaperSize` of 0 means "a custom size described by a DEVMODE" — and there is no DEVMODE — where the
      // schema's absent `paperSize` means US Letter. Likewise `horizontalDpi`/`verticalDpi` default to 600.
      .writeUint32(setup?.paperSize ?? DEFAULT_PAPER_SIZE)
      .writeUint32(setup?.scale ?? 100)
      .writeUint32(setup?.horizontalDpi ?? DEFAULT_PRINT_DPI)
      .writeUint32(setup?.verticalDpi ?? DEFAULT_PRINT_DPI)
      .writeUint32(1) // copies
      .writeUint32(setup?.firstPageNumber ?? 1)
      .writeUint32(setup?.fitToWidth ?? 1)
      .writeUint32(setup?.fitToHeight ?? 1)
      .writeUint16(flags)
      .writeUint32(0xffffffff) // printer-settings relationship: absent
      .toUint8Array()
  );
}

/** The sheet's default row height and column width. */
export interface SheetFormatInfo {
  /** Default row height in points. 15 in the Calibri 11 workbooks. */
  readonly defaultRowHeight?: number;
  /** Default column width in characters. */
  readonly defaultColWidth?: number;
  /**
   * Deepest row grouping level, 0–7.
   *
   * The last two bytes of this record are `iOutLevelRw` and `iOutLevelCol` — one byte each, per
   * MS-XLSB 2.4.873. They were written as a single zeroed `u16` and read not at all, which is why
   * outline level was on the loss list: the sheet's grouped rows survived while the depth Excel uses to
   * draw the outline gutter did not, so a grouped sheet opened with no controls to collapse it.
   */
  readonly outlineLevelRow?: number;
  /** Deepest column grouping level, 0–7. */
  readonly outlineLevelCol?: number;
}

/** `paperSize` when nothing chose one: US Letter, which is what an absent XLSX `paperSize` means. */
const DEFAULT_PAPER_SIZE = 1;

/** `horizontalDpi`/`verticalDpi` when nothing chose them, per the XLSX schema. */
const DEFAULT_PRINT_DPI = 600;

/** A column width this record spells as "unset". */
const UNSET_WIDTH = 0xffffffff;

/** Read a `BrtWsFmtInfo`. */
export function readSheetFormatInfo(
  payload: Uint8Array,
  part: string
): SheetFormatInfo | undefined {
  if (payload.length < 8) {
    return undefined;
  }
  const reader = new BinaryReader(payload, 0, part);
  const dxGCol = reader.readUint32();
  const cchDefColWidth = reader.readUint16();
  const rowHeightTwips = reader.readUint16();

  // `dxGCol` is the precise width in the same 1/256-character units `BrtColInfo` uses, and it wins
  // when present: `date.xlsb` carries 2958 there — 11.55 characters — alongside a `cchDefColWidth`
  // of 8, so reading only the rounded field would report a width the file does not have.
  // The flag word, then one byte per axis. Read defensively: this record is twelve bytes in every
  // corpus workbook, but the length check above only requires eight.
  let outlineLevelRow = 0;
  let outlineLevelCol = 0;
  if (payload.length >= 12) {
    reader.readUint16(); // flags
    outlineLevelRow = reader.readUint8();
    outlineLevelCol = reader.readUint8();
  }

  const info: SheetFormatInfo = {
    ...(rowHeightTwips === 0 ? {} : { defaultRowHeight: rowHeightTwips / TWIPS_PER_POINT }),
    ...(outlineLevelRow === 0 ? {} : { outlineLevelRow }),
    ...(outlineLevelCol === 0 ? {} : { outlineLevelCol }),
    ...(dxGCol !== UNSET_WIDTH && dxGCol !== 0
      ? { defaultColWidth: dxGCol / COLUMN_WIDTH_UNITS }
      : cchDefColWidth === 0
        ? {}
        : { defaultColWidth: cchDefColWidth })
  };
  return Object.keys(info).length === 0 ? undefined : info;
}

/** Serialise a `BrtWsFmtInfo`. Twelve bytes, as Excel writes it. */
export function encodeSheetFormatInfo(info: SheetFormatInfo | undefined): Uint8Array {
  const width = info?.defaultColWidth;
  // A width that is a whole number of characters is what `cchDefColWidth` alone expresses, and
  // Excel leaves `dxGCol` unset in that case — which is why the two are written as a pair rather
  // than one always overriding the other.
  const fractional = width !== undefined && !Number.isInteger(width);
  return (
    new BinaryWriter()
      .writeUint32(fractional ? Math.round(width * COLUMN_WIDTH_UNITS) : UNSET_WIDTH)
      .writeUint16(fractional ? 8 : Math.round(width ?? 8))
      .writeUint16(Math.round((info?.defaultRowHeight ?? 15) * TWIPS_PER_POINT))
      .writeUint16(0) // flags
      // `iOutLevelRw` and `iOutLevelCol`, one byte each, bounded at 7 by the specification. These were a
      // single zeroed `u16` before, which is what made a grouped sheet come back without its outline
      // gutter — the grouping survived on the rows and the depth that draws the controls did not.
      .writeUint8(clampOutline(info?.outlineLevelRow))
      .writeUint8(clampOutline(info?.outlineLevelCol))
      .toUint8Array()
  );
}

/** An outline level the record can hold: 0 through 7. */
function clampOutline(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(7, Math.trunc(value)));
}

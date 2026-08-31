/**
 * The records Excel writes into every workbook, whether or not their contents vary.
 *
 * **Why this file exists.** A package can satisfy every rule this library's validator knows and
 * still be rejected by Excel, because "structurally coherent" and "acceptable to Excel" are not the
 * same claim — and only the second one matters to a user. Comparing a workbook written here against
 * one Excel wrote, record by record, showed the difference was not a wrong field anywhere: it was
 * absence. Excel's workbook part opens with a `BrtFileVersion` and carries a `BrtBookView`; its
 * worksheet declares a view before it declares any cells. This library wrote none of them.
 *
 * So the rule for this file is narrow: **emit what Excel emits, in the order Excel emits it, with
 * the values Excel uses.** Each layout below was read off the reference corpus and each is
 * self-checking or carries a value that could not be a coincidence — noted per record. Nothing here
 * is a field this library interprets; it is the floor a reader is entitled to assume is present.
 */
import { encodeWideString } from "@excel/xlsb/binary";
import { BinaryWriter, concatUint8Arrays } from "@utils/binary";

/**
 * `BrtFileVersion` — the first record in every workbook part.
 *
 * Self-checking: a 16-byte GUID then four `XLWideString`s, which for Excel's values comes to
 * `16 + 6 + 5 + 5 + 8 + 4×4 = 50` bytes — exactly the length in every corpus workbook. The strings
 * are the application (`xl`), the version that last edited the file, the lowest version that can,
 * and the build number.
 *
 * The GUID is `rgAbsPath`, a hash of the path the file was last saved to. Zero in `date.xlsb` and
 * non-zero in `any_sheets.xlsb`, so both are acceptable — zero is written here because this library
 * has no path to hash and inventing one would leak nothing useful.
 */
export function fileVersion(): Uint8Array {
  return concatUint8Arrays([
    new Uint8Array(16), // rgAbsPath: no last-saved path
    encodeWideString("xl"),
    encodeWideString("6"),
    encodeWideString("6"),
    encodeWideString("14420")
  ]);
}

/**
 * `BrtWbProp` — workbook properties.
 *
 * Excel writes this into every workbook, so it is no longer conditional on the 1904 flag: a
 * workbook that omitted it was missing a record a consumer expects rather than one it merely did
 * not need. `date1904` is bit 0 of the flags, established by comparing two otherwise-identical
 * reference workbooks whose first bytes are `20` and `21`.
 */
export function workbookProperties(date1904: boolean): Uint8Array {
  return concatUint8Arrays([
    new BinaryWriter()
      .writeUint32(WORKBOOK_FLAGS_DEFAULT | (date1904 ? WORKBOOK_FLAG_1904 : 0))
      // `date.xlsb` carries 0x000280AB here — a theme version, which this library has no theme to
      // version, so Excel's own value is written rather than a zero that claims something else.
      .writeUint32(THEME_VERSION)
      .toUint8Array(),
    // The workbook's code name. Twelve bytes total, and this string is what makes it twelve: an
    // eight-byte record was four short, which is the kind of shortfall nothing here would notice
    // and Excel rejects outright.
    encodeWideString("")
  ]);
}

/** `dwThemeVersion`, verbatim from Excel's output. */
const THEME_VERSION = 0x000280ab;

/** `f1904`. */
export const WORKBOOK_FLAG_1904 = 0x0001;

/**
 * The remaining `BrtWbProp` flags, verbatim from Excel.
 *
 * `date.xlsb` carries `20 00 01 00`; the low word is 0x0020 with the epoch bit clear. Written as
 * Excel writes it rather than decomposed, because this library interprets none of the other bits and
 * naming them would imply otherwise.
 */
const WORKBOOK_FLAGS_DEFAULT = 0x00010020;

/**
 * `BrtBookView` — the window Excel restores the workbook into.
 *
 * Twenty-nine bytes: seven `u32`s then a flag byte. `iTabRatio` reads 500 in `date.xlsb`, which is
 * the documented default (50.0%), and 600 in `any_sheets.xlsb` — a value that tracks a real
 * setting rather than sitting at a fixed offset by chance.
 */
export function bookView(): Uint8Array {
  return new BinaryWriter()
    .writeUint32(0) // xWn
    .writeUint32(0) // yWn
    .writeUint32(23040) // dxWn — Excel's default window width
    .writeUint32(8880) // dyWn
    .writeUint32(500) // iTabRatio, in tenths of a percent
    .writeUint32(0) // itabFirst
    .writeUint32(0) // itabCur
    .writeUint8(0x78) // flags, verbatim
    .toUint8Array();
}

/**
 * `BrtCalcProp` — how the workbook recalculates.
 *
 * Twenty-six bytes. The `float64` at offset 12 reads `0.001`, which is the documented default
 * iterative-calculation delta, and the `u32` at 8 reads 100 — the default iteration count. Two
 * documented defaults at the offsets a `u32`/`u32`/`f64` reading puts them is the confirmation, and all
 * nine corpus workbooks agree on both.
 *
 * **Two of the fields are the model's to set and one is not.** `cIterations` and `numDelta` are at
 * established offsets, so a workbook that asked for 250 iterations gets them. Whether iterative
 * calculation is *on* lives in the flags word, and every corpus workbook has it off — the byte pair reads
 * `6a 00` in all nine — so the bit is unobserved. Writing a guessed bit would turn iteration on or off in
 * a file whose author chose the opposite, so `iterate` is reported as a loss instead. The distinction is
 * the usual one here: an offset read off Excel's bytes and a bit inferred from a name are different
 * kinds of claim.
 */
export function calculationProperties(
  properties: { readonly iterateCount?: number; readonly iterateDelta?: number } = {}
): Uint8Array {
  return new BinaryWriter()
    .writeUint32(0) // recalc id
    .writeUint32(1) // fFullCalcOnLoad and friends, verbatim
    .writeUint32(properties.iterateCount ?? 100) // cIterations
    .writeFloat64(properties.iterateDelta ?? 0.001) // numDelta
    .writeUint32(1) // cIterationsMax
    .writeUint16(0x6a) // flags, verbatim — the iterative-calculation bit among them is unobserved
    .toUint8Array();
}

/**
 * `BrtBeginWsView` — a worksheet needs at least one view, and this library wrote none.
 *
 * Thirty bytes: a `u16` of flags then seven `u32`s. `icvHdr` reads 64 — the automatic colour index
 * established from the font table — and `wScale` reads 100, a zoom percentage. Two independently
 * meaningful values at the offsets this reading assigns them.
 */
export function worksheetView(): Uint8Array {
  // 2 + 4 + 4 + 4 + 4 + 4 + 4 + 4 = 30, which is the length of every corpus record. The arithmetic
  // is worth stating because an extra `reserved` field here produced a 32-byte record that this
  // library's own validator accepted.
  return new BinaryWriter()
    .writeUint16(0x039c) // flags, verbatim: gridlines and headings shown
    .writeUint32(0) // xlView
    .writeUint32(0) // rwTop
    .writeUint32(0) // colLeft
    .writeUint32(64) // icvHdr — the automatic colour index
    .writeUint32(100) // wScale, as a percentage
    .writeUint32(0) // wScaleNormal
    .writeUint32(0) // wScaleSLV
    .toUint8Array();
}

/**
 * `BrtSel` — the selection inside a view.
 *
 * Self-checking: five `u32`s then `cref` groups of four, so `cref = 1` gives exactly the 36 bytes
 * every corpus record has. The active cell and the single selected range agree with each other in
 * both samples, which is what fixes the field order.
 */
export function selection(): Uint8Array {
  return new BinaryWriter()
    .writeUint32(3) // pnn: the whole sheet, unsplit
    .writeUint32(0) // rwAct
    .writeUint32(0) // colAct
    .writeUint32(0) // irefAct
    .writeUint32(1) // cref
    .writeUint32(0) // rwFirst
    .writeUint32(0) // rwLast
    .writeUint32(0) // colFirst
    .writeUint32(0) // colLast
    .toUint8Array();
}

/**
 * `BrtSheetProtection` — sixty-six bytes, byte-identical in every corpus sheet.
 *
 * One sample of a structure establishes its size and nothing else, so nothing here is interpreted.
 * It is emitted because Excel emits it, and the bytes are the ones Excel emits for a sheet with no
 * protection: a workbook missing a record every real file has is a workbook this library has no
 * evidence is acceptable.
 */
export function sheetProtection(): Uint8Array {
  // Written as the byte sequence it is, rather than assembled from fields this module does not
  // interpret. Assembling it produced 64 bytes where Excel writes 66 — and a two-byte shortfall in a
  // record nobody reads is exactly the kind of thing that passes every check here and fails in Excel.
  const bytes = new Uint8Array(SHEET_PROTECTION_SIZE);
  // The `01` bytes are the individual "allowed" toggles, at the offsets Excel puts them.
  for (const offset of [6, 10, 46, 62]) {
    bytes[offset] = 1;
  }
  return bytes;
}

const SHEET_PROTECTION_SIZE = 66;

/**
 * `BrtPrintOptions` — two bytes this module deliberately does not interpret.
 *
 * The corpus disagrees with itself: `0x0010` in most workbooks but `0x5950` and `0x5a30` in
 * `picture.xlsb`. A field of about six flags should not reach 0x5a30, so either the reading is
 * wrong or those records are something else — and a print option guessed wrong flips a boolean
 * nobody notices. Excel's common value is written verbatim, with no claim about what its bits mean.
 */
export function printOptions(): Uint8Array {
  return new BinaryWriter().writeUint16(0x0010).toUint8Array();
}

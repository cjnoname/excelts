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
import { BinaryReader, BinaryWriter, concatUint8Arrays } from "@utils/binary";
import { base64ToUint8Array, uint8ArrayToBase64 } from "@utils/utils.base";

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

/**
 * `f1904` — bit 0 of `BrtWbProp`'s flag word, MS-XLSB 2.4.860.
 *
 * Excel for Mac used 1904 as its epoch, and workbooks created that way are still in circulation. A reader
 * that ignores the flag reads every date in one exactly 1462 days early — four years, which is wrong in a way
 * that looks like a plausible date rather than an error.
 *
 * Defined once. There were two copies, in this file and in `binary.ts`, and the second had no callers — so
 * the two were free to disagree about which bit this is, with nothing to notice. The reader imports this one.
 */
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
 * `BrtBookView` — MS-XLSB 2.4.313.
 *
 * ```text
 * xWn        i32   window left, in twips
 * yWn        i32   window top
 * dxWn       u32   width
 * dyWn       u32   height
 * iTabRatio  u32   tab-bar share, 0–1000
 * itabFirst  u32   first visible sheet
 * itabCur    u32   active sheet
 * flags      u8    seven bits then one unused
 * ```
 *
 * The flags, bit 0 upwards: `fHidden`, `fVeryHidden`, `fIconic`, `fDspHScroll`, `fDspVScroll`,
 * `fBotAdornment`, `fAFDateGroup`. Excel's default is `0x78` — both scroll bars, the sheet tabs and
 * date grouping — and assembling that rather than writing the literal is what lets `visibility` be
 * expressed.
 */
export function bookView(view?: WorkbookViewLike): Uint8Array {
  let flags = (1 << 3) | (1 << 4) | (1 << 5) | (1 << 6);
  // `visible` is the default and clears both bits; the other two are Excel's own vocabulary for a
  // window the user cannot bring back without knowing it is there.
  flags |= view?.visibility === "hidden" ? 1 << 0 : 0;
  flags |= view?.visibility === "veryHidden" ? (1 << 0) | (1 << 1) : 0;
  return (
    new BinaryWriter()
      .writeInt32(view?.x ?? 0)
      .writeInt32(view?.y ?? 0)
      // Excel's defaults when the model says nothing. A zero-sized window is a window Excel opens with no
      // usable area, so the fallback is a size rather than 0.
      .writeUint32(clampWindow(view?.width, 23040))
      .writeUint32(clampWindow(view?.height, 8880))
      // In tenths of a percent, bounded at 1000 by the specification.
      .writeUint32(Math.max(0, Math.min(1000, Math.trunc(view?.tabRatio ?? 500))))
      .writeUint32(Math.max(0, Math.trunc(view?.firstSheet ?? 0)))
      .writeUint32(Math.max(0, Math.trunc(view?.activeTab ?? 0)))
      .writeUint8(flags)
      .toUint8Array()
  );
}

/** Read a `BrtBookView`, or `undefined` when it is short. */
export function readBookView(payload: Uint8Array, part: string): WorkbookViewLike | undefined {
  try {
    const reader = new BinaryReader(payload, 0, part);
    const x = reader.readInt32();
    const y = reader.readInt32();
    const width = reader.readUint32();
    const height = reader.readUint32();
    const tabRatio = reader.readUint32();
    const firstSheet = reader.readUint32();
    const activeTab = reader.readUint32();
    const flags = reader.readUint8();
    const visibility =
      (flags & (1 << 1)) !== 0 ? "veryHidden" : (flags & (1 << 0)) !== 0 ? "hidden" : "visible";
    return { x, y, width, height, tabRatio, firstSheet, activeTab, visibility };
  } catch {
    return undefined;
  }
}

/** A workbook view, as the model names it. */
export interface WorkbookViewLike {
  readonly x?: number;
  readonly y?: number;
  readonly width?: number;
  readonly height?: number;
  readonly tabRatio?: number;
  readonly firstSheet?: number;
  readonly activeTab?: number;
  readonly visibility?: string;
}

/**
 * `BrtBookProtection` — MS-XLSB 2.4.311. Six bytes: two password verifiers and a flag word.
 *
 * The flags are `fLockStructure`, `fLockWindow`, `fLockRevision` at bits 0, 1 and 2.
 *
 * **Neither verifier is written**, and in both cases 0 is the correct value. Without a password there is
 * nothing to verify; *with* one, MS-XLSB requires both to be 0 because the real hash travels in the
 * preceding `BrtBookProtectionIso` — see `bookProtectionIso`.
 */
export function bookProtection(protection: BookProtectionLike): Uint8Array {
  return new BinaryWriter()
    .writeUint16(0)
    .writeUint16(0)
    .writeUint16(bookProtectionFlags(protection))
    .toUint8Array();
}

/**
 * `wFlags` — `fLockStructure`, `fLockWindow`, `fLockRevision` at bits 0, 1 and 2.
 *
 * Shared because the Iso record and the legacy record MUST carry the same value, which the specification
 * states outright.
 */
function bookProtectionFlags(protection: BookProtectionLike): number {
  return (
    (protection.lockStructure === true ? 1 << 0 : 0) |
    (protection.lockWindows === true ? 1 << 1 : 0) |
    (protection.lockRevision === true ? 1 << 2 : 0)
  );
}

/** Read a `BrtBookProtection`, or `undefined` when nothing is locked. */
export function readBookProtection(
  payload: Uint8Array,
  part: string
): BookProtectionLike | undefined {
  try {
    const reader = new BinaryReader(payload, 0, part);
    reader.readUint16(); // protpwdBook
    reader.readUint16(); // protpwdRev
    const flags = reader.readUint16();
    const protection = {
      ...((flags & (1 << 0)) !== 0 ? { lockStructure: true } : {}),
      ...((flags & (1 << 1)) !== 0 ? { lockWindows: true } : {}),
      ...((flags & (1 << 2)) !== 0 ? { lockRevision: true } : {})
    };
    // Excel writes this record for a workbook that locks nothing. Returning an object for it would
    // report every workbook as deliberately configured.
    return Object.keys(protection).length === 0 ? undefined : protection;
  } catch {
    return undefined;
  }
}

/** The workbook-protection fields this record carries. */
export interface BookProtectionLike {
  readonly lockStructure?: boolean;
  readonly lockWindows?: boolean;
  readonly lockRevision?: boolean;
  /** The ISO password hash, base64 as the model and OOXML both store it. */
  readonly hashValue?: string;
  readonly saltValue?: string;
  readonly algorithmName?: string;
  readonly spinCount?: number;
}

/** A window dimension the record can hold, in twips. */
function clampWindow(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.min(Math.trunc(value), 2_147_483_646);
}

/**
 * `BrtCalcProp` — MS-XLSB 2.4.318.
 *
 * ```text
 * recalcID          u32
 * fAutoRecalc       u32   0 manual, 1 automatic, 2 automatic except tables
 * cCalcCount        u32   iteration limit, used when fIter is 1
 * xnumDelta         f64   minimum change, used when fIter is 1
 * cUserThreadCount  i32
 * flags             u16   nine bits, then seven reserved
 * ```
 *
 * The flags, bit 0 upwards: `fFullCalcOnLoad`, `fRefA1`, **`fIter`**, `fFullPrec`, `fSomeUncalced`,
 * `fSaveRecalc`, `fMTREnabled`, `fUserSetThreadCount`, `fNoDeps`.
 *
 * **`fIter` is bit 2, and finding it removed the last reported loss in this record.** The count and the
 * delta were written because their offsets were established from Excel's output; the switch that makes
 * either of them do anything sat in a flags word every corpus workbook leaves off, so it was reported
 * rather than guessed. The specification names it directly, so there is nothing left to guess.
 *
 * Two field labels here were also wrong, in a way that only mattered to a reader: offset 4 is
 * `fAutoRecalc` and was commented "fFullCalcOnLoad and friends", and the trailing `u32` is
 * `cUserThreadCount` and was commented `cIterationsMax`. The *values* were right — 1 is automatic
 * calculation and one calculation thread — so nothing was wrong in the file.
 */
/**
 * The XLSX counterpart is `<calcPr fullCalcOnLoad="1">`, and the two exist for the same reason.
 *
 * Neither writer produces a `calcChain`, so neither can claim its cached results were computed by Excel. This
 * container says so through `recalcID = 0` (see below); the XML one had no equivalent at all — it emitted a
 * real engine id, `calcId="171027"`, which is a claim that Excel 2016 computed those values. So an XLSB from
 * here recalculated on open and an XLSX from the same model did not, and a formula this library declined to
 * evaluate displayed its placeholder zero until something was edited.
 */
export function calculationProperties(properties: CalcPropertiesLike = {}): Uint8Array {
  // Excel's default: `fRefA1`, `fFullPrec`, `fSaveRecalc`, `fMTREnabled` — 0x6a. Assembling rather than
  // writing that literal is what lets `fIter` and `fFullCalcOnLoad` be set from the model.
  let flags = (1 << 1) | (1 << 3) | (1 << 5) | (1 << 6);
  flags |= properties.fullCalcOnLoad === true ? 1 << 0 : 0;
  flags |= properties.iterate === true ? 1 << 2 : 0;
  return (
    new BinaryWriter()
      // **`recalcID` is deliberately 0, and it is load-bearing — do not copy Excel's value here.** The
      // specification says an application recalculates every formula in the workbook when this is *less than*
      // its own recalculation-engine id, so 0 forces a full recalculation on open. That is what makes it safe
      // for this writer to emit a formula cell whose cached result it does not know: `BrtFmlaNum` has no
      // "no value" encoding — the result is always eight bytes — so a formula with no computed value goes out
      // as 0, and Excel replaces it before anyone sees it. Excel writes its real engine id (0x0002EA35 in the
      // file this was checked against) because its cached results are genuine. Matching that number to close
      // the byte diff would make every uncalculated formula display 0.
      .writeUint32(0) // recalcID
      .writeUint32(1) // fAutoRecalc: automatic
      .writeUint32(properties.iterateCount ?? 100) // cCalcCount
      .writeFloat64(properties.iterateDelta ?? 0.001) // xnumDelta
      .writeInt32(1) // cUserThreadCount
      .writeUint16(flags)
      .toUint8Array()
  );
}

/** Read a `BrtCalcProp`, or `undefined` when it is short. */
export function readCalculationProperties(
  payload: Uint8Array,
  part: string
): CalcPropertiesLike | undefined {
  try {
    const reader = new BinaryReader(payload, 0, part);
    reader.readUint32(); // recalcID
    reader.readUint32(); // fAutoRecalc
    const iterateCount = reader.readUint32();
    const iterateDelta = reader.readFloat64();
    reader.readInt32(); // cUserThreadCount
    const flags = reader.readUint16();
    const iterate = (flags & (1 << 2)) !== 0;
    return {
      ...((flags & 1) !== 0 ? { fullCalcOnLoad: true } : {}),
      // The count and the delta only mean anything when iteration is on — the specification says so of
      // both — so reporting them for a workbook that does not iterate would present Excel's own defaults
      // as settings a caller made.
      ...(iterate ? { iterate, iterateCount, iterateDelta } : {})
    };
  } catch {
    return undefined;
  }
}

/** The calculation fields the model carries. */
export interface CalcPropertiesLike {
  readonly fullCalcOnLoad?: boolean;
  readonly iterate?: boolean;
  readonly iterateCount?: number;
  readonly iterateDelta?: number;
}

/**
 * `BrtBeginWsView` — MS-XLSB 2.4.307.
 *
 * ```text
 * flags         u16   eleven bits, then five reserved
 * xlView        u32   XLView: 0 normal, 1 page-break preview, 2 page layout
 * rwTop         u32
 * colLeft       u32
 * icvHdr        u8    gridline colour index; 64 is "automatic"
 * reserved2     u8
 * reserved3     u16
 * wScale        u16   zoom percentage, 10–400
 * wScaleNormal  u16   0 means 100
 * wScaleSLV     u16
 * wScalePLV     u16
 * iWbkView      u32
 * ```
 *
 * `2 + 4 + 4 + 4 + 1 + 1 + 2 + 2 + 2 + 2 + 2 + 4 = 30`, the length of every corpus record.
 *
 * **The previous version reached 30 by a different route and was right only by accident.** It wrote a
 * `u16` followed by seven `u32`s — also 30 — with `icvHdr` as a `u32` of 64 and `wScale` as a `u32` of
 * 100. Because 64 and 100 both fit in their real fields and the bytes beside them are reserved or zero,
 * the output was byte-identical to Excel's. Any *other* value would have landed in the wrong field: a
 * zoom of 150 written as a `u32` puts 150 in `wScale` and 0 in `wScaleNormal`, which happens to work,
 * but a gridline colour of 300 would overflow into a reserved byte. The layout is now the
 * specification's, so the coincidence is no longer load-bearing.
 */
export function worksheetView(view?: WorksheetViewLike, workbookViewIndex = 0): Uint8Array {
  // Bit 0 is `fWnProt`; the eleven flags run up from there. Excel's default for a plain sheet is
  // `0x039c` — gridlines, headings, zeros, ruler, outline symbols and the default gridline colour — and
  // asserting that this assembles to exactly that value is how the bit order is pinned.
  let flags = 0;
  flags |= view?.showGridLines === false ? 0 : 1 << 2; // fDspGrid
  flags |= view?.showRowColHeaders === false ? 0 : 1 << 3; // fDspRwCol
  flags |= 1 << 4; // fDspZeros: the model has no field for it, and Excel's default is to show zeros
  flags |= view?.rightToLeft === true ? 1 << 5 : 0; // fRightToLeft
  // `fSelected` — this sheet is the selected one in its workbook view. Excel sets it on the active sheet of
  // every workbook it writes; nothing set it here, so a workbook opened with no sheet tab highlighted.
  flags |= view?.tabSelected === true ? 1 << 6 : 0;
  flags |= view?.showRuler === false ? 0 : 1 << 7; // fDspRuler
  flags |= 1 << 8; // fDspGuts: outline symbols, shown by default
  flags |= 1 << 9; // fDefaultHdr: use the automatic gridline colour
  const zoom = clampZoom(view?.zoomScale);
  return (
    new BinaryWriter()
      .writeUint16(flags)
      .writeUint32(xlView(view?.style))
      .writeUint32(0) // rwTop
      .writeUint32(0) // colLeft
      .writeUint8(64) // icvHdr — the automatic colour index
      .writeUint8(0) // reserved2
      .writeUint16(0) // reserved3
      .writeUint16(zoom)
      // `wScaleNormal` is the zoom to use *in normal view*, and 0 means 100. Writing the sheet's zoom here
      // as well would pin a page-layout zoom onto normal view; leaving it 0 lets Excel keep its own.
      .writeUint16(clampZoom(view?.zoomScaleNormal, 0))
      .writeUint16(0) // wScaleSLV
      .writeUint16(0) // wScalePLV
      // `iWbkView`: which `BrtBookView` this sheet view belongs to. Zero for the only view, and the
      // *position* for a second — a sheet may carry one view per workbook view, and giving them all
      // index 0 is what made the second and later ones unwritable rather than merely unwritten.
      .writeUint32(Math.max(0, Math.trunc(workbookViewIndex)))
      .toUint8Array()
  );
}

/** Read a `BrtBeginWsView` back to the model's view fields. */
export function readWorksheetView(
  payload: Uint8Array,
  part: string
): WorksheetViewLike | undefined {
  try {
    const reader = new BinaryReader(payload, 0, part);
    const flags = reader.readUint16();
    const style = viewStyle(reader.readUint32());
    reader.readUint32(); // rwTop
    reader.readUint32(); // colLeft
    reader.readUint8(); // icvHdr
    reader.readUint8();
    reader.readUint16();
    const zoom = reader.readUint16();
    const zoomNormal = reader.readUint16();
    return {
      // Only the departures from the default are reported, so a plain sheet does not come back with six
      // explicit settings a caller never made.
      ...((flags & (1 << 2)) === 0 ? { showGridLines: false } : {}),
      ...((flags & (1 << 3)) === 0 ? { showRowColHeaders: false } : {}),
      ...((flags & (1 << 5)) !== 0 ? { rightToLeft: true } : {}),
      ...((flags & (1 << 7)) === 0 ? { showRuler: false } : {}),
      ...(zoom === 100 || zoom === 0 ? {} : { zoomScale: zoom }),
      ...(zoomNormal === 0 ? {} : { zoomScaleNormal: zoomNormal }),
      ...(style === undefined ? {} : { style })
    };
  } catch {
    return undefined;
  }
}

/** The view fields this record carries, as the model names them. */
export interface WorksheetViewLike {
  readonly showGridLines?: boolean;
  readonly showRowColHeaders?: boolean;
  readonly showRuler?: boolean;
  readonly rightToLeft?: boolean;
  readonly zoomScale?: number;
  readonly zoomScaleNormal?: number;
  readonly style?: "pageBreakPreview" | "pageLayout";
  /** `fSelected`: this sheet is the selected one in its workbook view. */
  readonly tabSelected?: boolean;
}

/** `XLView`, MS-XLSB 2.5.168. */
function xlView(style: WorksheetViewLike["style"]): number {
  return style === "pageBreakPreview" ? 1 : style === "pageLayout" ? 2 : 0;
}

function viewStyle(value: number): WorksheetViewLike["style"] {
  return value === 1 ? "pageBreakPreview" : value === 2 ? "pageLayout" : undefined;
}

/**
 * A zoom the record can hold.
 *
 * The specification bounds it at 10–400, and `wScale` is a `u16`: an out-of-range value is not merely
 * odd but a record Excel is entitled to reject, so it is clamped rather than passed through.
 */
function clampZoom(value: number | undefined, fallback = 100): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(10, Math.min(400, Math.trunc(value)));
}

/**
 * `BrtSel` — one selection, belonging to one pane.
 *
 * Five `u32`s then `cref` groups of four, so `cref = 1` gives 36 bytes. `[MS-XLSB]` 2.4.790 requires the
 * active cell to lie inside the range named by `sqrfx`, which a single cell satisfies trivially.
 *
 * A view is given one of these per pane — see `paneSelections`, which records how far that is and is not
 * verified. On an unsplit sheet a single `PNNTOPLEFT` selection at `A1` is right, and that case is confirmed
 * by files Excel opens; the split cases are not.
 *
 * @param pane - `Pnn` of the pane this selection is in.
 * @param row - Zero-based active cell row, also the single selected range.
 * @param column - Zero-based active cell column.
 */
export function selection(pane = PNN_TOP_LEFT, row = 0, column = 0): Uint8Array {
  return new BinaryWriter()
    .writeUint32(pane)
    .writeUint32(row) // rwAct
    .writeUint32(column) // colAct
    .writeUint32(0) // dwRfxAct: the only range in `sqrfx`
    .writeUint32(1) // sqrfx.crfx
    .writeUint32(row) // rwFirst
    .writeUint32(row) // rwLast
    .writeUint32(column) // colFirst
    .writeUint32(column) // colLast
    .toUint8Array();
}

/** `PNNTOPLEFT` — MS-XLSB 2.5.108. The pane an unsplit sheet's only selection sits in. */
const PNN_TOP_LEFT = 3;

/**
 * `BrtSheetProtection` — MS-XLSB 2.4.792.
 *
 * ```text
 * protpwd            u16   password verifier, 0 for none
 * fLocked            u32   is the sheet protected at all
 * fObjects           u32   …then fifteen more, each a whole 4-byte Boolean
 * fScenarios, fFormatCells, fFormatColumns, fFormatRows,
 * fInsertColumns, fInsertRows, fInsertHyperlinks,
 * fDeleteColumns, fDeleteRows, fSelLockedCells,
 * fSort, fAutoFilter, fPivotTables, fSelUnlockedCells
 * ```
 *
 * `2 + 16 × 4 = 66`, which is exactly the length observed in Excel's own output. **That arithmetic is
 * why this used to be an opaque blob.** The note here read "assembling it produced 64 bytes where Excel
 * writes 66", and the missing two are `protpwd` — the field list starts with a `u16`, not a `u32`, and
 * assembling sixteen Booleans without it lands two short. So the record was written as a byte pattern
 * with `01` at four offsets, and every configured protection setting was reported as a loss.
 *
 * The four offsets were right: 6, 10, 46 and 62 are `fObjects`, `fScenarios`, `fSelLockedCells` and
 * `fSelUnlockedCells`, which is Excel's default for an *unprotected* sheet. The observation was sound;
 * only the interpretation was missing.
 *
 * **Every field means "allowed", and so does the model's.** That is worth stating because XLSX inverts
 * most of them on the way out — `formatCells="0"` in the XML is `formatCells: true` in the model — so a
 * writer that copied the XML attribute values into this record would disable everything a caller
 * enabled. The mapping here is straight from the model.
 */
export function sheetProtection(protection?: SheetProtectionLike): Uint8Array {
  const writer = new BinaryWriter();
  // The password *verifier*, and it is 0 here in both cases. Without a password there is nothing to
  // verify; *with* one, MS-XLSB requires this field to be 0 because the real hash travels in the
  // preceding `BrtSheetProtectionIso` — see `sheetProtectionIso`.
  writer.writeUint16(0);
  for (const value of sheetProtectionPermissions(protection)) {
    writer.writeUint32(value);
  }
  return writer.toUint8Array();
}

/**
 * The sixteen permission Booleans, in the order both protection records list them.
 *
 * Shared because `BrtSheetProtectionIso` and `BrtSheetProtection` MUST carry *identical* values for all
 * sixteen — the specification says so explicitly — and two copies of a sixteen-entry list with defaults
 * attached is the most reliable way to end up with two that disagree.
 *
 * **Every field means "allowed", and so does the model's.** That is worth stating because XLSX inverts
 * most of them on the way out — `formatCells="0"` in the XML is `formatCells: true` in the model — so a
 * writer that copied the XML attribute values here would disable everything a caller enabled.
 */
function sheetProtectionPermissions(protection?: SheetProtectionLike): number[] {
  const flag = (value: boolean | undefined, fallback: boolean): number =>
    (value ?? fallback) ? 1 : 0;
  // Excel's defaults for a protected sheet: objects and scenarios editable, both selections allowed,
  // everything else disallowed. An absent field takes the default rather than `false`, because a caller
  // who protected a sheet without listing sixteen permissions did not mean to forbid selection.
  return [
    protection?.sheet === true ? 1 : 0,
    ...(
      [
        [protection?.objects, true],
        [protection?.scenarios, true],
        [protection?.formatCells, false],
        [protection?.formatColumns, false],
        [protection?.formatRows, false],
        [protection?.insertColumns, false],
        [protection?.insertRows, false],
        [protection?.insertHyperlinks, false],
        [protection?.deleteColumns, false],
        [protection?.deleteRows, false],
        [protection?.selectLockedCells, true],
        [protection?.sort, false],
        [protection?.autoFilter, false],
        [protection?.pivotTables, false],
        [protection?.selectUnlockedCells, true]
      ] as readonly [boolean | undefined, boolean][]
    ).map(([value, fallback]) => flag(value, fallback))
  ];
}

/**
 * `BrtSheetProtectionIso` — MS-XLSB 2.4.793. The **password**, which the legacy record cannot carry.
 *
 * This existing was the correction to a wrong claim, not a new capability of the format: the loss report
 * used to say a sheet password was *physically impossible* because `protpwd` is a 16-bit verifier and the
 * model holds a SHA-512 hash, which cannot be reversed. All true, and beside the point — `BrtSheetProtectionIso`
 * exists precisely for the ISO/IEC 29500 form and carries the salt, the algorithm name, the hash bytes and
 * the spin count **verbatim**. Nothing has to be reversed, because nothing has to be computed: the hash is
 * copied across. The record-name table needed for this was already in the repository, and one search for
 * "Iso" would have found it.
 *
 * ```
 * dwSpinCount        u32   iterations used to produce the hash
 * fLocked …          u32   the same sixteen Booleans as the legacy record, in the same order
 * ipdPasswordData          IsoPasswordData: hash, salt, algorithm name
 * ```
 *
 * **It MUST be immediately followed by a `BrtSheetProtection` whose `protpwd` is 0** and whose sixteen
 * Booleans match. That is stated in the specification rather than inferred, which matters here because the
 * corpus has no sample: the pairing is the authority, not a guess about record order.
 *
 * @returns The payload, or `undefined` when the model holds no hash — in which case only the legacy record
 *   is written and the sheet is protected but not password-protected.
 */
export function sheetProtectionIso(protection?: SheetProtectionLike): Uint8Array | undefined {
  const hash = decodeBase64(protection?.hashValue);
  if (hash === undefined || hash.length === 0) {
    return undefined;
  }
  const writer = new BinaryWriter();
  // Bounded at ten million by the specification. The model's own default matches Excel's.
  writer.writeUint32(Math.max(0, Math.min(10_000_000, protection?.spinCount ?? 100_000)));
  for (const value of sheetProtectionPermissions(protection)) {
    writer.writeUint32(value);
  }
  return concatUint8Arrays([
    writer.toUint8Array(),
    isoPasswordData(hash, decodeBase64(protection?.saltValue), protection?.algorithmName)
  ]);
}

/**
 * `BrtBookProtectionIso` — MS-XLSB 2.4.312. The workbook's two passwords.
 *
 * ```
 * dwBookSpinCount    u32
 * dwRevSpinCount     u32
 * wFlags             u16   the same flags as the legacy record
 * ipdBookPasswordData      structure and window protection
 * ipdRevPasswordData       change-tracking protection
 * ```
 *
 * Both password fields are always present even when only one is set, because the second is positional
 * rather than optional — an empty `IsoPasswordData` is three zero-length prefixes, not an absence.
 *
 * Like the sheet form, it MUST be immediately followed by the legacy `BrtBookProtection` with both
 * verifiers set to 0 and the same `wFlags`.
 */
export function bookProtectionIso(protection: BookProtectionLike): Uint8Array | undefined {
  const hash = decodeBase64(protection.hashValue);
  if (hash === undefined || hash.length === 0) {
    return undefined;
  }
  const spinCount = Math.max(0, Math.min(10_000_000, protection.spinCount ?? 100_000));
  const writer = new BinaryWriter()
    .writeUint32(spinCount)
    // The *revision* spin count. The model carries a single set of hash fields — there is no separate
    // revision hash to describe — so this is 0 and `ipdRevPasswordData` is empty. The record still has to
    // contain both, because the second is positional rather than optional.
    .writeUint32(0)
    .writeUint16(bookProtectionFlags(protection));
  return concatUint8Arrays([
    writer.toUint8Array(),
    isoPasswordData(hash, decodeBase64(protection.saltValue), protection.algorithmName),
    isoPasswordData(undefined, undefined, undefined)
  ]);
}

/**
 * An `IsoPasswordData` — MS-XLSB 2.5.80: two `LPByteBuf` then an `XLNullableWideString`.
 *
 * The specification ties the three together: a non-empty salt requires a non-empty hash *and* a non-empty
 * algorithm name, and a non-empty algorithm name requires a non-empty hash. Writing a salt for a hash that
 * did not survive would be a record Excel is entitled to reject, so an absent hash empties all three.
 */
function isoPasswordData(
  hash: Uint8Array | undefined,
  salt: Uint8Array | undefined,
  algorithmName: string | undefined
): Uint8Array {
  if (hash === undefined || hash.length === 0) {
    // Three empty prefixes: a zero-length hash, a zero-length salt and a NULL algorithm name.
    return new BinaryWriter().writeUint32(0).writeUint32(0).writeUint32(0xffffffff).toUint8Array();
  }
  const name = algorithmName ?? "SHA-512";
  const parts: Uint8Array[] = [
    new BinaryWriter().writeUint32(hash.length).toUint8Array(),
    hash,
    new BinaryWriter().writeUint32(salt?.length ?? 0).toUint8Array()
  ];
  if (salt !== undefined && salt.length > 0) {
    parts.push(salt);
  }
  // An `XLNullableWideString`: a character count then UTF-16, with 0xFFFFFFFF reserved for NULL.
  const characters = [...name];
  const nameWriter = new BinaryWriter().writeUint32(characters.length);
  for (const character of characters.join("")) {
    nameWriter.writeUint16(character.charCodeAt(0));
  }
  parts.push(nameWriter.toUint8Array());
  return concatUint8Arrays(parts);
}

/**
 * Base64 to bytes, or `undefined` when the input is absent or not base64.
 *
 * The model stores a hash and a salt the way OOXML does — base64 text — while the record wants the bytes.
 * Writing the base64 *characters* would produce a hash of the right shape and the wrong value, which no
 * reader can detect: the password would simply never match.
 */
function decodeBase64(value: string | undefined): Uint8Array | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }
  try {
    return base64ToUint8Array(value);
  } catch {
    return undefined;
  }
}

/**
 * Read the password half of a `BrtSheetProtectionIso` or a `BrtBookProtectionIso`.
 *
 * Only the `IsoPasswordData` and the spin count are taken. The sixteen permission Booleans are read from
 * the legacy record that MUST follow, which carries identical values — reading them twice would be two
 * places for the same fact to come from, and the legacy path already existed.
 *
 * @param offset - Where the `IsoPasswordData` begins: 68 for a sheet (spin count plus sixteen Booleans),
 *   10 for a workbook (two spin counts plus the flag word).
 */
export function readIsoPasswordData(
  payload: Uint8Array,
  offset: number,
  spinCountAt: number
): IsoPasswordFields | undefined {
  if (payload.length < offset + 12) {
    return undefined;
  }
  const reader = new BinaryReader(payload);
  reader.position = spinCountAt;
  const spinCount = reader.readUint32();
  reader.position = offset;
  const hashLength = reader.readUint32();
  if (hashLength === 0 || payload.length < offset + 4 + hashLength) {
    return undefined;
  }
  const hash = payload.subarray(reader.position, reader.position + hashLength);
  reader.position += hashLength;
  const saltLength = reader.readUint32();
  const salt = payload.subarray(reader.position, reader.position + saltLength);
  reader.position += saltLength;
  const nameLength = reader.readUint32();
  // 0xFFFFFFFF is the `XLNullableWideString` NULL, which is not a length — treating it as one would try to
  // read four gigabytes of name.
  let algorithmName: string | undefined;
  if (nameLength !== 0xffffffff && nameLength > 0) {
    let name = "";
    for (let index = 0; index < nameLength; index += 1) {
      name += String.fromCharCode(reader.readUint16());
    }
    algorithmName = name;
  }
  return {
    spinCount,
    hashValue: uint8ArrayToBase64(hash),
    ...(saltLength > 0 ? { saltValue: uint8ArrayToBase64(salt) } : {}),
    ...(algorithmName === undefined ? {} : { algorithmName })
  };
}

/** The password fields an Iso protection record carries. */
export interface IsoPasswordFields {
  readonly spinCount: number;
  readonly hashValue: string;
  readonly saltValue?: string;
  readonly algorithmName?: string;
}

/** Read a `BrtSheetProtection`, or `undefined` when the sheet is not protected. */
export function readSheetProtection(
  payload: Uint8Array,
  part: string
): SheetProtectionLike | undefined {
  try {
    const reader = new BinaryReader(payload, 0, part);
    reader.readUint16(); // protpwd — a verifier this reader does not attempt to reverse.
    if (reader.readUint32() === 0) {
      // `fLocked` is 0, so every field after it is undefined by the specification and MUST be ignored.
      // Returning a protection object here would report an unprotected sheet as configured.
      return undefined;
    }
    const next = (): boolean => reader.readUint32() !== 0;
    return {
      sheet: true,
      objects: next(),
      scenarios: next(),
      formatCells: next(),
      formatColumns: next(),
      formatRows: next(),
      insertColumns: next(),
      insertRows: next(),
      insertHyperlinks: next(),
      deleteColumns: next(),
      deleteRows: next(),
      selectLockedCells: next(),
      sort: next(),
      autoFilter: next(),
      pivotTables: next(),
      selectUnlockedCells: next()
    };
  } catch {
    return undefined;
  }
}

/** The protection fields this codec reads and writes. All of them mean "allowed". */
export interface SheetProtectionLike {
  readonly sheet?: boolean;
  readonly objects?: boolean;
  readonly scenarios?: boolean;
  readonly formatCells?: boolean;
  readonly formatColumns?: boolean;
  readonly formatRows?: boolean;
  readonly insertColumns?: boolean;
  readonly insertRows?: boolean;
  readonly insertHyperlinks?: boolean;
  readonly deleteColumns?: boolean;
  readonly deleteRows?: boolean;
  readonly selectLockedCells?: boolean;
  readonly sort?: boolean;
  readonly autoFilter?: boolean;
  readonly pivotTables?: boolean;
  readonly selectUnlockedCells?: boolean;
  /** The ISO password hash, base64 as the model and OOXML both store it. */
  readonly hashValue?: string;
  readonly saltValue?: string;
  readonly algorithmName?: string;
  readonly spinCount?: number;
}

/**
 * `BrtPrintOptions` — MS-XLSB 2.4.470. Four meaningful bits in two bytes.
 *
 * ```text
 * bit 0  fHCenter       centre horizontally on the page
 * bit 1  fVCenter       centre vertically
 * bit 2  fPrintHeaders  print row and column headers
 * bit 3  fPrintGrid     print gridlines
 * bit 4  unused         "undefined and MUST be ignored" — Excel sets it in every file
 * ```
 *
 * **This used to write `0x0010` verbatim and interpret nothing**, on the reasoning that the corpus disagreed
 * with itself: most workbooks say `0x0010` but `picture.xlsb` says `0x5950` and `0x5a30`, and a field of six
 * flags should not reach 0x5a30. That was the right caution and the wrong conclusion — the consequence was that
 * four print options were silently dropped from every binary workbook, `horizontalCentered` among them.
 *
 * The reading is now anchored on Excel's own output. Across fifteen workbooks Excel wrote `0x0010` for fourteen
 * and `0x0011` for the one whose XML carries `<printOptions horizontalCentered="1"/>` — so bit 0 is `fHCenter`,
 * confirmed from the outside rather than inferred from a field list, and the specification names the three
 * beside it. `picture.xlsb`'s values set bits the specification says MUST be 0, so that file is either odd or
 * those records are not what they appear; either way it is not evidence about these four.
 *
 * Bit 4 is kept set because Excel sets it universally. The specification calls it unused and requires readers to
 * ignore it, so writing it costs nothing and matches every reference file byte for byte.
 */
export function printOptions(options: PrintOptionsLike = {}): Uint8Array {
  let flags = PRINT_OPTIONS_UNUSED_BIT;
  flags |= options.horizontalCentered === true ? 1 << 0 : 0;
  flags |= options.verticalCentered === true ? 1 << 1 : 0;
  flags |= options.showRowColHeaders === true ? 1 << 2 : 0;
  flags |= options.showGridLines === true ? 1 << 3 : 0;
  return new BinaryWriter().writeUint16(flags).toUint8Array();
}

/** Read `BrtPrintOptions` back, or `undefined` when the record is truncated. */
export function readPrintOptions(payload: Uint8Array): PrintOptionsLike | undefined {
  if (payload.length < 2) {
    return undefined;
  }
  const flags = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint16(
    0,
    true
  );
  return {
    horizontalCentered: (flags & (1 << 0)) !== 0,
    verticalCentered: (flags & (1 << 1)) !== 0,
    showRowColHeaders: (flags & (1 << 2)) !== 0,
    showGridLines: (flags & (1 << 3)) !== 0
  };
}

/** The bit the specification calls unused and Excel sets anyway. See `printOptions`. */
const PRINT_OPTIONS_UNUSED_BIT = 1 << 4;

/** The four print options this record carries. */
export interface PrintOptionsLike {
  readonly horizontalCentered?: boolean;
  readonly verticalCentered?: boolean;
  readonly showRowColHeaders?: boolean;
  readonly showGridLines?: boolean;
}

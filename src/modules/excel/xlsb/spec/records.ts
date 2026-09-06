/**
 * BIFF12 record specification, as data.
 *
 * This is the single source of truth for what a record *is*: its identifier, its
 * name, whether it opens or closes a scope, and as much of its payload layout as
 * has been established. Everything that needs to understand a record stream —
 * the disassembler, the fixture builder, the validator, and eventually the reader
 * and writer — derives from this table rather than carrying its own copy.
 *
 * That is a deliberate reaction to how binary format support usually goes wrong.
 * When each part parser inlines its own field offsets, the layout knowledge is
 * unverifiable and the reader and writer drift apart: they agree with each other
 * and disagree with the format, and no round-trip test can see it because both
 * sides share the mistake. A table can be checked on its own
 * (`scripts/verify-xlsb-spec.ts`) and read against `[MS-XLSB]` by a human without
 * chasing it through nine files.
 *
 * ## Partial layouts are expressed, not guessed
 *
 * A record may declare a *prefix* of its fields, or none at all. Trailing bytes
 * are always reported as a remainder rather than silently ignored, so the
 * disassembler never claims to have decoded more than it has and the table can
 * grow one field at a time without ever lying. `fields` being absent means "the
 * layout has not been established", which is a fact worth recording — not a
 * licence to invent offsets.
 *
 * ## Scope pairs are written once
 *
 * A `Begin`/`End` pair is one row in {@link SCOPE_PAIRS}, and both records are
 * generated from it. Declaring the two halves separately and hoping they stay
 * consistent is exactly the kind of duplication this table exists to remove:
 * Begin/End balance is the most basic structural invariant in BIFF12, and a
 * mismatched pair in the table would make the check that enforces it wrong.
 *
 * Record identifiers below were read from `[MS-XLSB]`. The numbering of the
 * `Begin`/`End` pairs is contiguous, which is a useful cross-check but not a
 * guarantee — `IgnoredErrors` is the exception, with `BrtCellIgnoreEC` sitting
 * between its own delimiters.
 */

/** A primitive the spec table can name in a payload layout. */
export type BiffFieldType =
  | "u8"
  | "u16"
  | "u32"
  | "i16"
  | "i32"
  | "f64"
  /** 4 bytes: a 30-bit value plus `fX100` and `fInt` flags. */
  | "rk"
  /** `u32` character count followed by that many UTF-16LE code units. */
  | "wideString"
  /** As `wideString`, but `0xFFFFFFFF` means absent. */
  | "nullableWideString"
  /** `Cell`: column `u32`, then `iStyleRef` in the low 24 bits of a `u32`. */
  | "cell"
  /** `UncheckedRfX`: first/last row as `u32`, first/last column as `u32`. */
  | "rfx";

/** Byte width of a fixed-size field, or `undefined` when it is variable. */
export const FIXED_FIELD_WIDTHS: Readonly<Partial<Record<BiffFieldType, number>>> = {
  u8: 1,
  u16: 2,
  u32: 4,
  i16: 2,
  i32: 4,
  f64: 8,
  rk: 4,
  cell: 8,
  rfx: 16
};

export interface BiffFieldSpec {
  readonly name: string;
  readonly type: BiffFieldType;
}

/**
 * What a record is, for the checks that care about a class of record rather than a
 * specific one.
 *
 * This lives in the table because three separate places used to carry their own
 * hand-written list of cell-record names — the ordering check, the index check and
 * the coordinate check — which is exactly the duplication the table exists to
 * remove. A record's category is a fact about the format, so the format description
 * owns it.
 */
export type BiffRecordCategory =
  /** Payload begins with a `Cell`: a column and a style reference. */
  | "cell"
  /** Opens a row; carries the row number and a row-level style reference. */
  | "row";

export interface BiffRecordSpec {
  readonly id: number;
  /** `[MS-XLSB]` record name, e.g. `BrtRowHdr`. */
  readonly name: string;
  /** Class of record, where it belongs to one. */
  readonly category?: BiffRecordCategory;
  /** Present when the record delimits a scope. */
  readonly scope?: "begin" | "end";
  /** Name of the matching delimiter, for a scoped record. */
  readonly pairsWith?: string;
  /**
   * Leading payload fields, where established. Absent means the layout is not
   * yet known; a shorter list than the real payload is fine and the remainder is
   * reported rather than dropped.
   */
  readonly fields?: readonly BiffFieldSpec[];
}

/**
 * `Begin`/`End` delimiter pairs: `[beginId, endId, beginName, endName]`.
 *
 * **Both names are written out.** This table used to carry one *suffix* and derive
 * `BrtBegin${suffix}`/`BrtEnd${suffix}` from it, which was shorter and produced sixteen names that do
 * not exist: `BrtBeginRwBrk` for `BrtBeginRwBrk`, `BrtBeginCellXFs` for `BrtBeginCellXFs`,
 * `BrtBeginDVals` for `BrtBeginDVals`, and so on. Four of the pairs cannot be expressed by
 * that convention at all — `BrtFRTBegin` and `BrtACBegin` put the word `Begin` at the *end* — so the
 * abbreviation was not merely error-prone but insufficient.
 *
 * These names are not decoration. They are what `record("BrtBeginRwBrk", …)` looks up when writing, and
 * what a diagnostic hands the caller when it reports an unread record, so a name invented here sends
 * someone to search `[MS-XLSB]` for a record that is not in it. Every name in this file is pinned
 * against the specification's own record list by `spec/record-names.ts`.
 */
const SCOPE_PAIRS: readonly (readonly [number, number, string, string])[] = [
  // Future/alternate-content wrappers. These may appear anywhere, which the scope
  // checker has to know about — they nest inside records that are not otherwise
  // containers.
  [0x0023, 0x0024, "BrtFRTBegin", "BrtFRTEnd"],
  [0x0025, 0x0026, "BrtACBegin", "BrtACEnd"],

  // Workbook part.
  [0x0083, 0x0084, "BrtBeginBook", "BrtEndBook"],
  [0x008f, 0x0090, "BrtBeginBundleShs", "BrtEndBundleShs"],
  [0x0087, 0x0088, "BrtBeginBookViews", "BrtEndBookViews"],
  [0x0161, 0x0162, "BrtBeginExternals", "BrtEndExternals"],

  // Worksheet part.
  [0x0081, 0x0082, "BrtBeginSheet", "BrtEndSheet"],
  [0x0091, 0x0092, "BrtBeginSheetData", "BrtEndSheetData"],
  [0x0085, 0x0086, "BrtBeginWsViews", "BrtEndWsViews"],
  [0x0089, 0x008a, "BrtBeginWsView", "BrtEndWsView"],
  [0x0186, 0x0187, "BrtBeginColInfos", "BrtEndColInfos"],
  [0x00b1, 0x00b2, "BrtBeginMergeCells", "BrtEndMergeCells"],
  [0x00a1, 0x00a2, "BrtBeginAFilter", "BrtEndAFilter"],
  [0x00a3, 0x00a4, "BrtBeginFilterColumn", "BrtEndFilterColumn"],
  [0x00a5, 0x00a6, "BrtBeginFilters", "BrtEndFilters"],
  [0x00ac, 0x00ad, "BrtBeginCustomFilters", "BrtEndCustomFilters"],
  [0x023d, 0x023e, "BrtBeginDVals", "BrtEndDVals"],
  [0x01df, 0x01e0, "BrtBeginHeaderFooter", "BrtEndHeaderFooter"],
  [0x0188, 0x0189, "BrtBeginRwBrk", "BrtEndRwBrk"],
  [0x018a, 0x018b, "BrtBeginColBrk", "BrtEndColBrk"],
  [0x008b, 0x008c, "BrtBeginCsViews", "BrtEndCsViews"],
  [0x008d, 0x008e, "BrtBeginCsView", "BrtEndCsView"],
  // Sparklines. All future records, so each begins with an `FRTHeader`; see `xlsb/sparkline.ts`.
  [0x0411, 0x0412, "BrtBeginSparklineGroup", "BrtEndSparklineGroup"],
  [0x0420, 0x0421, "BrtBeginSparklines", "BrtEndSparklines"],
  [0x0422, 0x0423, "BrtBeginSparklineGroups", "BrtEndSparklineGroups"],
  // Conditional formatting. `BrtBeginCFRule`'s shape is decided by an `iType`/`iTemplate` *pair*; see
  // `xlsb/conditional-format.ts`.
  [0x01cd, 0x01ce, "BrtBeginConditionalFormatting", "BrtEndConditionalFormatting"],
  [0x01cf, 0x01d0, "BrtBeginCFRule", "BrtEndCFRule"],
  [0x01f9, 0x01fa, "BrtBeginDXFs", "BrtEndDXFs"],
  // The three graphical conditional-formatting rules. Each `BrtBeginCFRule` of a graphical type MUST be
  // followed by one of these collections; a rule without it is a stream Excel rejects.
  [0x01d1, 0x01d2, "BrtBeginIconSet", "BrtEndIconSet"],
  [0x01d3, 0x01d4, "BrtBeginDatabar", "BrtEndDatabar"],
  [0x01d5, 0x01d6, "BrtBeginColorScale", "BrtEndColorScale"],
  // Excel writes this collection in every styles part it produces, carrying the default table and PivotTable
  // style names. Verified across eight workbooks it converted; this library omitted it entirely.
  [0x01fc, 0x01fd, "BrtBeginTableStyles", "BrtEndTableStyles"],

  // Shared strings part.
  [0x009f, 0x00a0, "BrtBeginSst", "BrtEndSst"],

  // Styles part.
  [0x0116, 0x0117, "BrtBeginStyleSheet", "BrtEndStyleSheet"],
  [0x0263, 0x0264, "BrtBeginFonts", "BrtEndFonts"],
  [0x025b, 0x025c, "BrtBeginFills", "BrtEndFills"],
  [0x0265, 0x0266, "BrtBeginBorders", "BrtEndBorders"],
  [0x0267, 0x0268, "BrtBeginFmts", "BrtEndFmts"],
  [0x0269, 0x026a, "BrtBeginCellXFs", "BrtEndCellXFs"],
  [0x0272, 0x0273, "BrtBeginCellStyleXFs", "BrtEndCellStyleXFs"],
  [0x026b, 0x026c, "BrtBeginStyles", "BrtEndStyles"],

  // Table part.
  [0x0157, 0x0158, "BrtBeginList", "BrtEndList"],
  [0x0159, 0x015a, "BrtBeginListCols", "BrtEndListCols"],
  [0x015b, 0x015c, "BrtBeginListCol", "BrtEndListCol"],
  [0x0294, 0x0296, "BrtBeginListParts", "BrtEndListParts"],

  // Comments part.
  [0x0274, 0x0275, "BrtBeginComments", "BrtEndComments"],
  [0x0276, 0x0277, "BrtBeginCommentAuthors", "BrtEndCommentAuthors"],
  [0x0279, 0x027a, "BrtBeginCommentList", "BrtEndCommentList"],
  [0x027b, 0x027c, "BrtBeginComment", "BrtEndComment"],

  // PivotCache Definition part, and the workbook records that bind a cache to it.
  [0x0180, 0x0181, "BrtBeginPivotCacheIDs", "BrtEndPivotCacheIDs"],
  [0x0182, 0x0183, "BrtBeginPivotCacheID", "BrtEndPivotCacheID"],
  [0x00b3, 0x00b4, "BrtBeginPivotCacheDef", "BrtEndPivotCacheDef"],
  [0x00b9, 0x00ba, "BrtBeginPCDSource", "BrtEndPCDSource"],
  [0x00bb, 0x00bc, "BrtBeginPCDSRange", "BrtEndPCDSRange"],
  [0x00b5, 0x00b6, "BrtBeginPCDFields", "BrtEndPCDFields"],
  [0x00b7, 0x00b8, "BrtBeginPCDField", "BrtEndPCDField"],
  [0x00bd, 0x00be, "BrtBeginPCDFAtbl", "BrtEndPCDFAtbl"],

  // PivotCache Records part.
  [0x00c1, 0x00c2, "BrtBeginPivotCacheRecords", "BrtEndPivotCacheRecords"],

  // PivotTable view part. `BrtBeginSXVI` and `BrtBeginSXLocation` are *not* here — their `End` identifiers
  // are lower than their `Begin`, so they live in NON_CONTIGUOUS_SCOPE_PAIRS.
  [0x0118, 0x013b, "BrtBeginSXView", "BrtEndSXView"],
  [0x011f, 0x0120, "BrtBeginSXVDs", "BrtEndSXVDs"],
  [0x011d, 0x011e, "BrtBeginSXVD", "BrtEndSXVD"],
  [0x011b, 0x011c, "BrtBeginSXVIs", "BrtEndSXVIs"],
  [0x0135, 0x0136, "BrtBeginISXVDRws", "BrtEndISXVDRws"],
  [0x0137, 0x0138, "BrtBeginISXVDCols", "BrtEndISXVDCols"],
  [0x0129, 0x012a, "BrtBeginSXLI", "BrtEndSXLI"],
  [0x012b, 0x012c, "BrtBeginSXLIRws", "BrtEndSXLIRws"],
  [0x012d, 0x012e, "BrtBeginSXLICols", "BrtEndSXLICols"],
  [0x0184, 0x0185, "BrtBeginISXVIs", "BrtEndISXVIs"],
  [0x0123, 0x0124, "BrtBeginSXPIs", "BrtEndSXPIs"],
  [0x0121, 0x0122, "BrtBeginSXPI", "BrtEndSXPI"],
  [0x0127, 0x0128, "BrtBeginSXDIs", "BrtEndSXDIs"],
  [0x0125, 0x0126, "BrtBeginSXDI", "BrtEndSXDI"]
];

/**
 * A scope whose delimiters are not contiguous.
 *
 * `BrtCellIgnoreECs` wraps `BrtCellIgnoreEC` entries, so its `End` is two above
 * its `Begin` rather than one. Kept apart from {@link SCOPE_PAIRS} only because
 * the contiguity of that table is a useful thing to be able to check.
 */
const NON_CONTIGUOUS_SCOPE_PAIRS: readonly (readonly [number, number, string, string])[] = [
  [0x0288, 0x028a, "BrtBeginCellIgnoreECs", "BrtEndCellIgnoreECs"],

  // Two pivot pairs whose `End` identifier is **lower** than its `Begin` — not merely
  // non-contiguous but *decreasing*. `BrtEndSXVI` is 281 against a `Begin` of 282, and
  // `BrtEndSXLocation` is 313 against 314. Any convention that derives one from the other,
  // in either direction, is wrong for these two.
  [0x011a, 0x0119, "BrtBeginSXVI", "BrtEndSXVI"],
  [0x013a, 0x0139, "BrtBeginSXLocation", "BrtEndSXLocation"]
];

/** `Cell`, shared by every cell record: column plus style reference. */
const CELL: readonly BiffFieldSpec[] = [{ name: "cell", type: "cell" }];

/** The `u32` item count carried by a counted collection's `Begin` record. */
const COUNT: readonly BiffFieldSpec[] = [{ name: "count", type: "u32" }];

const UNSCOPED_RECORDS: readonly BiffRecordSpec[] = [
  // --- Cells and rows -------------------------------------------------------
  {
    id: 0x0000,
    name: "BrtRowHdr",
    category: "row",
    fields: [
      { name: "rw", type: "u32" },
      { name: "ixfe", type: "u32" },
      { name: "miyRw", type: "u16" },
      // Three separate flag bytes, per MS-XLSB 2.4.770. Declared as one `u16` here first, which merged
      // offsets 10 and 11 — and since the writer set its one flag in the low byte, it landed in `fExtraDsc`
      // rather than `fUnsynced`. Splitting them is what makes `iOutLevel`, `fCollapsed` and `fDyZero`
      // addressable at all.
      { name: "ascDsc", type: "u8" },
      { name: "flags", type: "u8" },
      { name: "phShow", type: "u8" }
    ]
  },
  { id: 0x0001, name: "BrtCellBlank", category: "cell", fields: CELL },
  {
    id: 0x0002,
    name: "BrtCellRk",
    category: "cell",
    fields: [...CELL, { name: "value", type: "rk" }]
  },
  {
    id: 0x0003,
    name: "BrtCellError",
    category: "cell",
    fields: [...CELL, { name: "error", type: "u8" }]
  },
  {
    id: 0x0004,
    name: "BrtCellBool",
    category: "cell",
    fields: [...CELL, { name: "value", type: "u8" }]
  },
  {
    id: 0x0005,
    name: "BrtCellReal",
    category: "cell",
    fields: [...CELL, { name: "value", type: "f64" }]
  },
  {
    id: 0x0006,
    name: "BrtCellSt",
    category: "cell",
    fields: [...CELL, { name: "value", type: "wideString" }]
  },
  {
    id: 0x0007,
    name: "BrtCellIsst",
    category: "cell",
    fields: [...CELL, { name: "isst", type: "u32" }]
  },

  // Formula cells carry their cached result, then flags, then the token stream.
  // The token stream itself is not described here — it is a grammar, not a field
  // layout, and belongs with the formula codec.
  {
    id: 0x0008,
    name: "BrtFmlaString",
    category: "cell",
    fields: [...CELL, { name: "value", type: "wideString" }]
  },
  {
    id: 0x0009,
    name: "BrtFmlaNum",
    category: "cell",
    fields: [...CELL, { name: "value", type: "f64" }]
  },
  {
    id: 0x000a,
    name: "BrtFmlaBool",
    category: "cell",
    fields: [...CELL, { name: "value", type: "u8" }]
  },
  {
    id: 0x000b,
    name: "BrtFmlaError",
    category: "cell",
    fields: [...CELL, { name: "error", type: "u8" }]
  },

  // The `Short` variants are the same records with a shorter encoding. Their
  // layout is deliberately left undeclared: it has not been established here, and
  // guessing an offset is how a reader and a writer come to agree with each other
  // and disagree with Excel.
  // PivotCache items. Ids 20–26 are the value records of a `BrtBeginPCDFAtbl` collection; only the four a
  // worksheet-range cache can produce are declared, because a name in this table is a claim that the writer
  // or the reader understands the record.
  { id: 0x0014, name: "BrtPCDIMissing" },
  { id: 0x0015, name: "BrtPCDINumber" },
  { id: 0x0016, name: "BrtPCDIBoolean" },
  { id: 0x0018, name: "BrtPCDIString" },
  { id: 0x0021, name: "BrtPCRRecord" },
  { id: 0x000c, name: "BrtShortBlank", category: "cell" },
  { id: 0x000d, name: "BrtShortRk", category: "cell" },
  { id: 0x000e, name: "BrtShortError", category: "cell" },
  { id: 0x000f, name: "BrtShortBool", category: "cell" },
  { id: 0x0010, name: "BrtShortReal", category: "cell" },
  { id: 0x0011, name: "BrtShortSt", category: "cell" },
  { id: 0x0012, name: "BrtShortIsst", category: "cell" },

  // --- Shared strings -------------------------------------------------------
  {
    id: 0x0013,
    name: "BrtSSTItem",
    // `RichStr`: a flag byte, then the text. When `fRichStr` or `fExtStr` is set the
    // record continues with formatting runs or phonetic data, which the prefix
    // deliberately does not describe — those bytes are reported as a remainder rather
    // than decoded, so a rich string round-trips as its text with the extra reported.
    fields: [
      { name: "flags", type: "u8" },
      { name: "text", type: "wideString" }
    ]
  },

  // --- Workbook -------------------------------------------------------------
  {
    id: 0x0027,
    name: "BrtName",
    // Established from Excel's output: `00000000 00 ffffffff 0d000000 "MyBrokenRange"` is
    // flags, a keyboard shortcut byte, a sheet index (0xFFFFFFFF for workbook scope) and
    // the name. The definition's token stream follows, and the whole record self-checks:
    // `13 + 2×cch + 4 + cce + 4 + cb + 4` equals the payload for six of the seven names in
    // the corpus. The seventh is `_xlfn.CONCAT`, longer by exactly 16 bytes — four more
    // nullable strings, present because its flags carry `fProc` (0x08). A conditional tail
    // confirmed by an exact byte count is a conditional, not a guess.
    //
    // Reading the token stream needs the sheet list and the `BrtExternSheet` table. Both are
    // already parsed by the time a `BrtName` appears: the order is `BrtBundleSh…` →
    // `BrtBeginExternals` → `BrtSupSelf` → `BrtExternSheet` → `BrtEndExternals` → `BrtName…`
    // in every corpus workbook, so one pass suffices.
    fields: [
      { name: "flags", type: "u32" },
      { name: "shortcutKey", type: "u8" },
      { name: "sheetIndex", type: "u32" },
      { name: "name", type: "wideString" }
    ]
  },
  { id: 0x0080, name: "BrtFileVersion" },
  {
    id: 0x0099,
    name: "BrtWbProp",
    // Bit 0 of the flags is `f1904`, the 1904 date system. Established by comparing two
    // otherwise-identical reference workbooks: the 1900 one carries `20 00 01 00 …` and the
    // 1904 one `21 00 01 00 …`. Getting this wrong is not a cosmetic error — every date in a
    // 1904 workbook reads exactly 1462 days early, which is four years and looks plausible.
    fields: [{ name: "flags", type: "u32" }]
  },
  {
    id: 0x009c,
    name: "BrtBundleSh",
    // Two variable-length fields, which is why the table must allow them anywhere:
    // the relationship id is nullable (a sheet with no part, as in a chartsheet
    // placeholder), the name is not.
    fields: [
      { name: "state", type: "u32" },
      { name: "tabId", type: "u32" },
      { name: "relId", type: "nullableWideString" },
      { name: "name", type: "wideString" }
    ]
  },
  { id: 0x009d, name: "BrtCalcProp" },
  // A conditional-formatting value object: one threshold of a colour scale, data bar or icon set.
  { id: 0x01d7, name: "BrtCFVO" },
  // A pivot cache item holding a date. Absent from this table, so a `Date` in a cache field was written as
  // `BrtPCDIString` of `Date.prototype.toString()` — a localised, timezone-bearing sentence.
  { id: 0x0019, name: "BrtPCDIDatetime" },
  // A standalone colour, used by a colour scale and a data bar. Same eight-byte `BrtColor` structure the
  // fonts, fills and borders carry.
  { id: 0x0234, name: "BrtColor" },
  // One byte of AutoRecover state, all bits clear for a file saved normally. Excel writes it in every workbook
  // part it produces, immediately after `BrtCalcProp`; this library wrote none.
  { id: 0x009b, name: "BrtFileRecover" },
  { id: 0x009e, name: "BrtBookView" },
  { id: 0x0216, name: "BrtBookProtection" },
  { id: 0x02a5, name: "BrtBookProtectionIso" },
  { id: 0x0165, name: "BrtSupSelf" },
  {
    id: 0x016a,
    name: "BrtExternSheet",
    // A count then that many 12-byte entries of three u32s. Confirmed by two values that cannot
    // be coincidences: `issues.xlsb` holds `[{0,0,0},{0,2,2}]` and its `OneRange` name carries
    // `ixti = 1`, which therefore means the *third* sheet — and that name is used on the third
    // sheet. `issue_182.xlsb`, whose name is `MyBrokenRange`, holds `{0,-1,-1}`: a reference to
    // a deleted sheet, which is what that workbook exists to exhibit.
    fields: [{ name: "count", type: "u32" }]
  },

  // --- Worksheet ------------------------------------------------------------
  {
    id: 0x0093,
    name: "BrtWsProp"
    // Self-checking: the record ends in an XLWideString, so `23 + 2 × cch` must equal the payload,
    // and it does at all three lengths the corpus contains (23, 33, 35). Inside the header, the
    // eight bytes at offset 3 are a `BrtColor` reading `00 40 …` — the automatic colour with
    // `fValidRGB` clear — and the eight after it two 0xFFFFFFFF sync positions. The code name is
    // observed and varies (`Лист1`, `Sheet1`); a tab colour is never set in the corpus, so its
    // position is established while its use is not. See `xlsb/sheet-properties.ts`.
  },
  { id: 0x0094, name: "BrtWsDim", fields: [{ name: "ref", type: "rfx" }] },
  {
    // MS-XLSB 2.4.723. Twenty-nine bytes; see `xlsb/pane.ts` for why the two `Xnum`s cross axes.
    id: 0x0097,
    name: "BrtPane",
    fields: [
      { name: "rowsFrozen", type: "f64" },
      { name: "columnsFrozen", type: "f64" },
      { name: "topRow", type: "u32" },
      { name: "leftColumn", type: "u32" },
      { name: "activePane", type: "u32" },
      { name: "flags", type: "u8" }
    ]
  },
  { id: 0x0098, name: "BrtSel" },
  {
    id: 0x003c,
    name: "BrtColInfo",
    // Established from Excel's output: an 18-byte record whose third field held 2742, which is
    // 10.71 characters in the 1/256ths this format uses — the default Calibri 11 column width.
    // That value is what identified the field.
    fields: [
      { name: "colFirst", type: "u32" },
      { name: "colLast", type: "u32" },
      { name: "width", type: "u32" },
      { name: "ixfe", type: "u32" },
      { name: "flags", type: "u16" }
    ]
  },
  {
    // MS-XLSB 2.4.356. Only the flag word has a fixed position; everything after it is variable-length,
    // so the field list stops there and `xlsb/data-validation.ts` owns the rest. Declaring `sqrfx` as a
    // field would claim a fixed offset for something whose offset depends on the count before it.
    id: 0x0040,
    name: "BrtDVal",
    fields: [{ name: "flags", type: "u32" }]
  },
  { id: 0x00b0, name: "BrtMergeCell", fields: [{ name: "ref", type: "rfx" }] },
  {
    // MS-XLSB 2.4.315. The indices are untyped `Rw_Col`; which axis they name comes from the enclosing
    // `BrtBeginRwBrk` or `BrtBeginColBrk` scope, which is why `xlsb/page-breaks.ts` takes one.
    id: 0x018c,
    name: "BrtBrk",
    fields: [
      { name: "index", type: "u32" },
      { name: "start", type: "u32" },
      { name: "end", type: "u32" },
      { name: "manual", type: "u32" },
      { name: "pivot", type: "u32" }
    ]
  },
  {
    id: 0x01dc,
    name: "BrtMargins"
    // Six float64s. `any_sheets.xlsb` carries 0.7, 0.7, 0.75, 0.75, 0.3, 0.3 — Excel's default
    // margins exactly — and three pairs of equal values in a record whose defaults are three
    // pairs fixes the order. The metric workbooks agree, carrying 0.7875 (2 cm) in the same
    // positions. No field is declared here because they are all doubles and `decode.ts` has no
    // float field type; the codec lives in `xlsb/page-setup.ts`.
  },
  { id: 0x01dd, name: "BrtPrintOptions" },
  {
    id: 0x01de,
    name: "BrtPageSetup",
    // Confirmed three ways: the first field reads 9, which is A4 in the paper-size enumeration;
    // the second reads 100, a scale percentage; and the last is a relationship id, absent
    // (0xFFFFFFFF) in the workbooks with no printer settings and `"rId2"` in `issues.xlsb` — the
    // one workbook that ships `xl/printerSettings/printerSettings1.bin`.
    fields: [
      { name: "paperSize", type: "u32" },
      { name: "scale", type: "u32" },
      { name: "horizontalDpi", type: "u32" },
      { name: "verticalDpi", type: "u32" },
      { name: "copies", type: "u32" },
      { name: "firstPageNumber", type: "u32" },
      { name: "fitToWidth", type: "u32" },
      { name: "fitToHeight", type: "u32" },
      { name: "flags", type: "u16" }
    ]
  },
  {
    id: 0x01e5,
    name: "BrtWsFmtInfo",
    // Twelve bytes. The default row height reads 300 twips — 15 points — in the Calibri 11
    // workbooks, which is Excel's default, and 264/280/288 in the others, each plausible for its
    // own font. `dxGCol` is the precise column width in the same 1/256-character units
    // `BrtColInfo` uses, and 0xFFFFFFFF when unset.
    fields: [
      { name: "dxGCol", type: "u32" },
      { name: "cchDefColWidth", type: "u16" },
      { name: "miyDefRowHeight", type: "u16" },
      { name: "flags", type: "u16" },
      // The sheet's outline depth, one byte per axis, bounded at 7 — MS-XLSB 2.4.837. `encodeSheetFormatInfo`
      // and `readSheetFormatInfo` have always written and read these with their own arithmetic, so the
      // record was correct on disk while the table describing it stopped two bytes early. Only the tooling
      // built on this table saw the short version, which is the tooling every other check here runs on.
      { name: "iOutLevelRw", type: "u8" },
      { name: "iOutLevelCol", type: "u8" }
    ]
  },
  {
    // Layout from MS-XLSB 2.4.693, and confirmed against two corpus files: `poi-hyperlink.xlsb` carries
    // `00×16 | cch=4 "rId2" | 0 | 0 | 0` for a link on A1, and `poi-testVarious.xlsb` the same shape with
    // `rfx` reading row 11, column 1. Both are 40 bytes, and both name a `TargetMode="External"`
    // relationship in the sheet's own `.rels` — which is where the destination URL lives. The record
    // carries only the reference to it.
    id: 0x01ee,
    name: "BrtHLink",
    fields: [
      { name: "ref", type: "rfx" },
      { name: "relId", type: "nullableWideString" },
      // The fragment within the destination, for a link into this workbook.
      { name: "location", type: "wideString" },
      { name: "tooltip", type: "wideString" },
      { name: "display", type: "wideString" }
    ]
  },
  { id: 0x0217, name: "BrtSheetProtection" },
  { id: 0x02a6, name: "BrtSheetProtectionIso" },
  {
    id: 0x0226,
    name: "BrtDrawing",
    // The relationship id of the sheet's drawing part, and nothing else. `picture.xlsb` carries
    // `04 00 00 00 72 00 49 00 64 00 32 00` in both of its sheets — an `XLWideString` reading
    // `"rId2"` — and `xl/worksheets/_rels/sheet1.bin.rels` declares exactly that id pointing at
    // `../drawings/drawing1.xml`. The length confirms the reading: 4 + 2 × 4 = 12.
    //
    // Its position is equally settled: after `BrtMargins`, before the sheet's closing scope. The
    // drawing itself is XML shared with the XLSX path — only this reference is binary.
    fields: [{ name: "relId", type: "wideString" }]
  },
  { id: 0x0227, name: "BrtLegacyDrawing" },
  // Chartsheet records, all read out of `cal-any_sheets.xlsb` — the one corpus workbook with a
  // chartsheet. `BrtCsProp` is a flag word, a `BrtColor` and a code name; `BrtBeginCsView` is
  // `2 + 4 + 4 = 10`, and that workbook's is `02 00 | 58 00 00 00 | 00 00 00 00`.
  {
    id: 0x028b,
    name: "BrtCsProp",
    fields: [{ name: "flags", type: "u16" }]
  },
  {
    id: 0x029d,
    name: "BrtCsProtection",
    fields: [{ name: "flags", type: "u16" }]
  },
  // Both are an `XLWideString` relationship id, the same shape as `BrtDrawing` and `BrtLegacyDrawing`.
  // `BrtLegacyDrawingHF` points at the VML that holds header, footer and watermark pictures;
  // `BrtBkHim` at a sheet background image.
  { id: 0x0228, name: "BrtLegacyDrawingHF" },
  { id: 0x0232, name: "BrtBkHim" },
  // A future record whose entire payload is an `FRTHeader` carrying one cell reference and one formula.
  { id: 0x0413, name: "BrtSparkline" },
  // A differential format, which a `BrtBeginCFRule.dxfId` indexes.
  { id: 0x01fb, name: "BrtDXF" },
  { id: 0x0289, name: "BrtCellIgnoreEC" },
  { id: 0x01aa, name: "BrtArrFmla" },
  { id: 0x01ab, name: "BrtShrFmla" },

  // --- AutoFilter -----------------------------------------------------------
  { id: 0x00a7, name: "BrtFilter" },
  { id: 0x00a8, name: "BrtColorFilter" },
  { id: 0x00a9, name: "BrtIconFilter" },
  { id: 0x00aa, name: "BrtTop10Filter" },
  { id: 0x00ab, name: "BrtDynamicFilter" },
  { id: 0x00ae, name: "BrtCustomFilter" },
  { id: 0x00af, name: "BrtAFilterDateGroupItem" },

  // --- Styles ---------------------------------------------------------------
  {
    id: 0x002b,
    name: "BrtFont",
    // Established from fifteen fonts across nine Excel-authored workbooks, and the reading is
    // self-checking: the name is an XLWideString at offset 21, so `25 + 2 × cch` must equal the
    // payload length. It does for all fifteen at four different name lengths. The field division
    // within the header is pinned by values that cannot be coincidences — `bCharSet` reads 204
    // (Cyrillic) in the Russian-locale workbook and 134 (GB2312) in the Chinese one, and
    // `bFontScheme` reads 2 (minor) on exactly the 11pt Calibri fonts. See `xlsb/font.ts`.
    fields: [
      { name: "dyHeight", type: "u16" },
      { name: "grbit", type: "u16" },
      { name: "bls", type: "u16" },
      { name: "sss", type: "u16" },
      { name: "uls", type: "u8" },
      { name: "bFamily", type: "u8" },
      { name: "bCharSet", type: "u8" },
      { name: "unused", type: "u8" }
    ]
  },
  { id: 0x002c, name: "BrtFmt" },
  {
    id: 0x002d,
    name: "BrtFill",
    // 68 bytes. Every reference workbook contains exactly two, differing in one byte: `fls` = 0
    // and `fls` = 17. Those are the `none` and `gray125` fills Excel writes into every workbook,
    // and 17 is exactly where `gray125` sits in the eighteen-value pattern ordering — an
    // enumeration confirmed at its first and eighteenth position. See `xlsb/fill.ts`.
    fields: [{ name: "fls", type: "u32" }]
  },
  // 51 bytes, and the corpus contains exactly one — byte-identical in all nine Excel-authored workbooks: the
  // default "no borders" entry. One sample of a structure establishes its size and nothing else,
  // so no field is declared. A workbook with a single bordered cell would change that.
  { id: 0x002e, name: "BrtBorder" },
  {
    id: 0x002f,
    name: "BrtXF",
    // Sixteen bytes. `iFmt` was identified by a date cell carrying the built-in id 14. `iFont`
    // and `iFill` were identified by correlation: `issue127.xlsb` declares three fonts and reads
    // 0, 1, 1, 2, 2, 0 at offset 4, `issues.xlsb` declares three and reads 0, 0, 0, 0, 1, 2 —
    // every value in range for its own file's font count, varying exactly where the fonts do.
    fields: [
      { name: "ixfeParent", type: "u16" },
      { name: "iFmt", type: "u16" },
      { name: "iFont", type: "u16" },
      { name: "iFill", type: "u16" },
      { name: "ixBorder", type: "u16" },
      { name: "trot", type: "u8" },
      { name: "indent", type: "u8" }
    ]
  },
  { id: 0x0030, name: "BrtStyle" },
  { id: 0x0201, name: "BrtTableStyleClient" },

  // --- Tables ---------------------------------------------------------------
  { id: 0x015f, name: "BrtListCCFmla" },
  { id: 0x0160, name: "BrtListTrFmla" },
  { id: 0x0295, name: "BrtListPart" },

  // --- Comments -------------------------------------------------------------
  { id: 0x0278, name: "BrtCommentAuthor" },
  { id: 0x027d, name: "BrtCommentText" }
];

/**
 * Begin records of counted collections carry the item count as a leading `u32`.
 *
 * Named separately from the pair table because it is the count that makes the
 * index checks possible — an `isst` is only out of range relative to
 * `BrtBeginSst`'s unique-string count, and an `ixfe` relative to
 * `BrtBeginCellXFs`'s.
 */
const COUNTED_COLLECTION_BEGINS: Readonly<Record<string, readonly BiffFieldSpec[]>> = {
  BrtBeginSst: [
    { name: "cstTotal", type: "u32" },
    { name: "cstUnique", type: "u32" }
  ],
  BrtBeginFonts: COUNT,
  BrtBeginFills: COUNT,
  BrtBeginBorders: COUNT,
  BrtBeginFmts: COUNT,
  BrtBeginCellXFs: COUNT,
  BrtBeginCellStyleXFs: COUNT,
  BrtBeginStyles: COUNT,
  // `BrtBeginColInfos` is deliberately absent: Excel writes it with an **empty** payload, unlike the styles
  // collections above. It carried `COUNT` here while the comment on `OBSERVED_PAYLOAD_SIZES` and the writer
  // both recorded the opposite — three places describing one record, one of them wrong, and nothing
  // comparing them until the layout check in `check-records.ts`.
  BrtBeginMergeCells: [{ name: "cmcs", type: "u32" }]
};

function buildScopeRecords(): BiffRecordSpec[] {
  const records: BiffRecordSpec[] = [];
  for (const [beginId, endId, beginName, endName] of [
    ...SCOPE_PAIRS,
    ...NON_CONTIGUOUS_SCOPE_PAIRS
  ]) {
    records.push({
      id: beginId,
      name: beginName,
      scope: "begin",
      pairsWith: endName,
      fields: COUNTED_COLLECTION_BEGINS[beginName]
    });
    records.push({ id: endId, name: endName, scope: "end", pairsWith: beginName });
  }
  return records;
}

/** Every record this table describes, in identifier order. */
/**
 * Values this library writes into an established layout that no reference workbook exercises.
 *
 * The distinction this register exists to preserve: an offset read off Excel's own bytes and a
 * value taken from a documented convention are different kinds of claim, and the second must not
 * inherit the first's confidence merely by sitting next to it in the same function. Every font in
 * the nine Excel-authored workbooks is regular weight with no toggles set, so `BrtFont`'s bold and italic
 * *fields* are established while their "on" state is not.
 *
 * It lives in the spec table because this file is the single source of truth for what has been
 * established, and because `spec.test.ts` pins it against the table on every run — the same treatment the
 * undeclared `BrtShort*` layouts get. A single workbook containing one bold and one italic cell
 * would settle every entry.
 */
/**
 * Payload lengths observed in Excel's own output, for the records whose length never varies.
 *
 * **This table exists because of a whole class of defect the rest of this module could not see.**
 * Every check here — framing, scoping, ordering, coordinates, indexes — asks whether a stream is
 * *internally* consistent, and a record that is the wrong length is perfectly consistent with
 * itself. Three such records shipped: `BrtRowHdr` was written as twelve bytes where Excel writes
 * twenty-five, `BrtBeginColInfos` carried a four-byte count where Excel's payload is empty, and
 * `BrtWbProp` was four bytes short of its trailing code name. Each one produced a package this
 * library validated and Excel refused to open.
 *
 * Only records with a **single** observed length across the nine Excel-authored workbooks are listed, and
 * only where that constancy is *structural*. A record whose length legitimately varies — a string, a
 * counted array of ranges — is absent rather than approximated, which is why this table is a fraction of
 * the record count.
 *
 * **That second condition was added after a violation of it rejected a valid file.** An entry here is
 * consumed by `check-framing.ts` as an **error**, so it asserts that no producer will ever write the record
 * at another length. `BrtDrawing` was listed at 12 bytes — the length of `"rId2"` — and a sheet with ten
 * relationships writes `"rId10"` at 14, so the validator refused a package this library had just produced.
 * `BrtACBegin` and `BrtSel` were the same shape: a count followed by that many structures, constant only
 * because the corpus never carries two. `check-records.ts` now refuses any record with a declared
 * variable-width field; the three above had no field list to check, so they were read against
 * `[MS-XLSB]` by hand.
 */
export const OBSERVED_PAYLOAD_SIZES: ReadonlyMap<string, number> = new Map([
  // `BrtACBegin` is deliberately absent. Its payload is `cver` — a count — followed by that many
  // `ACProductVersion` structures, so the length follows the count. Every corpus workbook carries one
  // version and therefore six bytes, which is what put it here; a file naming two applications is six bytes
  // longer and equally valid.
  ["BrtBeginBook", 0],
  ["BrtBeginBookViews", 0],
  ["BrtBeginBorders", 4],
  ["BrtBeginBundleShs", 0],
  // Empty, not a count — section 2.4.170 gives this record no fields and section 3.8.1 declares `0000`. It is
  // listed here because this is the second time the distinction has cost a broken file: `BrtBeginColInfos` is
  // the first, noted above. Excel refused to open a workbook whose `workbook.bin` carried a four-byte count
  // here, and every structural check in this repository passed on that file.
  ["BrtBeginPivotCacheIDs", 0],
  ["BrtBeginCellStyleXFs", 4],
  ["BrtBeginCellXFs", 4],
  ["BrtBeginColInfos", 0],
  ["BrtBeginExternals", 0],
  ["BrtBeginFills", 4],
  ["BrtBeginFmts", 4],
  ["BrtBeginFonts", 4],
  ["BrtFRTBegin", 4],
  ["BrtBeginSheet", 0],
  ["BrtBeginSheetData", 0],
  ["BrtBeginSst", 8],
  ["BrtBeginStyleSheet", 0],
  ["BrtBeginStyles", 4],
  ["BrtBeginWsView", 30],
  ["BrtBeginWsViews", 0],
  ["BrtBookView", 29],
  ["BrtBorder", 51],
  ["BrtCalcProp", 26],
  // A `DVals`: two flag bytes, the prompt window's position, an unused word, then the count. Written as four
  // bytes — the count alone — so Excel read `idvMac` from past the end of the record.
  ["BrtBeginDVals", 18],
  // An `FRTHeader` with nothing set, a `u16` of flags, eight `BrtColor`, three `Xnum` and `isltype`. Written
  // with the flags as a `u32`, which made it 100 and made Excel discard the whole worksheet part.
  ["BrtBeginSparklineGroup", 98],
  ["BrtFileRecover", 1],
  // `BrtCellBlank` is **not** pinned, and the reason is worth keeping: this table used to say 8, read
  // off twelve Calamine fixtures that all agreed. `poi-62815.xlsb` — Excel 16.0, conformant in every
  // other respect — writes it at 9, with one trailing zero byte. A `Cell` is 8 bytes and the ninth is
  // slack the format permits, so "every Excel-authored one is 8" was a claim about one collection
  // rather than about Excel. Two independent upstreams disagreeing is exactly what the second one is
  // for.
  ["BrtCellIsst", 12],
  ["BrtCellReal", 16],
  ["BrtCellRk", 12],
  ["BrtColInfo", 18],
  // `BrtDrawing` is deliberately absent. It was here at 12 bytes, which is what `"rId2"` encodes to — and
  // its payload is an `XLWideString`, so the length follows the relationship id. A sheet with ten or more
  // relationships gets `rId10`, the record becomes 14 bytes, and this table made the validator **reject a
  // file this library had just written**. That is the failure mode a length table has: an entry is an
  // assertion about every producer, not a note about the corpus.
  ["BrtACEnd", 0],
  ["BrtEndBook", 0],
  ["BrtEndBookViews", 0],
  ["BrtEndBorders", 0],
  ["BrtEndBundleShs", 0],
  ["BrtEndCellStyleXFs", 0],
  ["BrtEndCellXFs", 0],
  ["BrtEndColInfos", 0],
  ["BrtEndExternals", 0],
  ["BrtEndFills", 0],
  ["BrtEndFmts", 0],
  ["BrtEndFonts", 0],
  ["BrtFRTEnd", 0],
  ["BrtEndHeaderFooter", 0],
  ["BrtEndSheet", 0],
  ["BrtEndSheetData", 0],
  ["BrtEndSst", 0],
  ["BrtEndStyleSheet", 0],
  ["BrtEndStyles", 0],
  ["BrtEndWsView", 0],
  ["BrtEndWsViews", 0],
  ["BrtFill", 68],
  ["BrtMargins", 48],
  ["BrtPrintOptions", 2],
  ["BrtRowHdr", 25],
  // `BrtSel` is deliberately absent. Its trailing `sqrfx` is an `UncheckedSqRfX` — a count and that many
  // sixteen-byte ranges — so 36 bytes is the length of a *single-range* selection, which is all the corpus
  // contains. Ctrl-clicking a second range makes the record 52 bytes, and `sqrfx.crfx` may be up to 32,767.
  ["BrtSheetProtection", 66],
  ["BrtSupSelf", 0],
  ["BrtWsDim", 16],
  ["BrtWsFmtInfo", 12],
  ["BrtXF", 16]
]);

export const INFERRED_VALUES = {
  /**
   * A `BrtExternSheet` entry whose `itabFirst` and `itabLast` differ, which is how a reference across a
   * span of sheets (`Sheet1:Sheet3!A1`) names them.
   *
   * The entry layout is established — `issues.xlsb` carries `{0,0}` and `{2,2}` — so this is a claim
   * about a *value*, not an offset: no corpus workbook spans more than one sheet, so the reading comes
   * from the field names and from the decoder, which has always treated a difference as a span. The
   * alternative was to keep writing the first sheet's entry, which turned `SUM(Sheet1:Sheet3!A1)` into
   * `SUM(Sheet1!A1)`.
   */
  externSheetSpan: true,
  /**
   * `BrtFont.bls` for bold — **kept here for the record, and no longer an inference.**
   *
   * 400 for regular is established from fifteen reference fonts. 700 for bold is now established too: five bold fonts
   * across `poi-comments.xlsb`, `poi-sample.xlsb` and `poi-testVarious.xlsb` all carry it. Left in this table so the
   * entry's history is visible rather than silently disappearing, and because `check-records.ts` reports the table as
   * the writer's list of values that came from reasoning rather than from bytes — with a note that this one graduated.
   */
  fontWeightBold: 700,
  /**
   * `BrtColor.nTintAndShade` scale — **observed, to fifteen decimal places.**
   *
   * This was the last of the five with no evidence behind it, on the reading that every colour in the corpus carries a
   * zero tint — which was true of every *standalone* `BrtColor` record and missed the ones **embedded** in `BrtFont`,
   * where the field sits at offset 14. Two of the 62 fonts across the corpus carry a tint, both theme colours in
   * `poi-sample.xlsb`:
   *
   * | raw     | ÷ 32767              | the XLSX literal it reproduces |
   * | ------- | -------------------- | ------------------------------ |
   * | -16383  | -0.499984740745262   | `tint="-0.499984740745262"`    |
   * | 13106   | 0.399975585192419    | `tint="0.39997558519241921"`   |
   *
   * Those are the two values Excel's own UI produces for "darker 50%" and "lighter 40%", and they agree to every digit
   * the XLSX form prints. Dividing by 32768 gives -0.499969482421875 instead, which matches nothing.
   *
   * Kept in this table so the entry's history stays visible; `check-records.ts` reports it as a value that came from
   * reasoning, with the note that the reasoning has since been confirmed.
   */
  colorTintScale: 32767,
  /**
   * `BrtRowHdr.ixfe` — the row's own cell format.
   *
   * Zero on all 493 rows across the reference workbooks and the corpus, so a row-level style is still unexercised. The
   * *offset* was already pinned by arithmetic — `rw` at 0 and `miyRw` at 8 leave this `u32` at 4 with nowhere else to be
   * — and the column form is now pinned by observation as well: `BrtColInfo.ixfe` at the same relative position carries
   * a **non-zero** value (1, twice) in the corpus against 19 zeros, so the field is being read where it is written.
   *
   * What remains inferred is only that a *row* uses the same layout as a column, which the record's own arithmetic
   * already required.
   */
  rowAndColumnStyleIndex: 4,
  /**
   * Offset of the tab colour inside `BrtWsProp`.
   *
   * Every sheet in the corpus has an automatic tab colour, so a real one is unobserved. The offset
   * is pinned by the record's self-check: the code name is an XLWideString whose count sits at 19,
   * and the eight bytes at 3 read as a valid `BrtColor` with the remaining eight as sync positions.
   */
  sheetTabColorOffset: 3
} as const;

export const BIFF_RECORDS: readonly BiffRecordSpec[] = [
  ...UNSCOPED_RECORDS,
  ...buildScopeRecords()
].sort((left, right) => left.id - right.id);

export const RECORD_BY_ID: ReadonlyMap<number, BiffRecordSpec> = new Map(
  BIFF_RECORDS.map(record => [record.id, record])
);

export const RECORD_BY_NAME: ReadonlyMap<string, BiffRecordSpec> = new Map(
  BIFF_RECORDS.map(record => [record.name, record])
);

/**
 * Largest valid record identifier, exclusive.
 *
 * The identifier is a variable-length integer of at most two bytes with seven
 * value bits each, so `0x4000` and above cannot be encoded and a stream claiming
 * one is misframed rather than merely unrecognised.
 */
export const MAX_RECORD_ID = 0x4000;

/**
 * Records in a category, by name.
 *
 * Derived rather than written out: a category is declared once on the record, and
 * every consumer asks this. The alternative — a `Set` of names beside each checker —
 * is how the ordering check and the index check came to disagree about whether
 * `BrtFmlaString` is a cell.
 */
export const RECORD_NAMES_BY_CATEGORY: ReadonlyMap<
  BiffRecordCategory,
  ReadonlySet<string>
> = new Map(
  (["cell", "row"] as const).map(category => [
    category,
    new Set(BIFF_RECORDS.filter(record => record.category === category).map(r => r.name))
  ])
);

/** Names in a category. Empty rather than undefined for an unused category. */
export function recordNamesInCategory(category: BiffRecordCategory): ReadonlySet<string> {
  return RECORD_NAMES_BY_CATEGORY.get(category) ?? new Set();
}

/** Look up a record, or `undefined` when the identifier is not described here. */
export function recordSpec(id: number): BiffRecordSpec | undefined {
  return RECORD_BY_ID.get(id);
}

/** Look up a record by `[MS-XLSB]` name. Throws, because a typo is a bug. */
export function requireRecordSpec(name: string): BiffRecordSpec {
  const spec = RECORD_BY_NAME.get(name);
  if (!spec) {
    throw new Error(`unknown BIFF12 record name: ${name}`);
  }
  return spec;
}

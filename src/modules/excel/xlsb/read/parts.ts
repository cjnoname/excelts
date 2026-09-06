/**
 * Read BIFF12 parts into a workbook model.
 *
 * Every field comes from `spec/decode.ts`, so this cannot disagree with the writer, the
 * disassembler or the validator about where a value lives — they all read the one table.
 *
 * ## What it refuses to do
 *
 * A record whose layout the table does not describe is skipped and counted, not guessed
 * at. The seven `BrtShort*` cell variants are in that position, and a skipped record is
 * reported (`unreadRecords`) rather than hidden — a reader that silently drops cells is
 * worse than one that says it cannot read them.
 *
 * How large that gap is, measured rather than assumed: those seven ids appear **zero**
 * times across the twenty-three pinned corpus workbooks, eighteen of them Excel-authored,
 * and `[MS-XLSB]` 2.4 does not list ids 12–18 at all. This comment previously called them
 * "common in Excel-authored files", which the corpus contradicts and which also
 * contradicted the README two directories away. Their names come from community reverse
 * engineering, which `spec/record-names.ts` records explicitly.
 */

import { StyledBlankRuns, type StyledBlankRange } from "@excel/core/styled-blanks";
import type { Font, HeaderFooter, IgnoredError, Margins } from "@excel/types";
import { encodeCol } from "@excel/utils/address";
import {
  COLUMN_WIDTH_UNITS,
  TWIPS_PER_POINT,
  NAME_FLAG_FUNCTION,
  NAME_FLAG_HIDDEN,
  iterateInterpretableRecords,
  type BiffRange,
  readCell,
  readWideString,
  sheetStateName,
  type BiffRecord
} from "@excel/xlsb/binary";
import { readColor } from "@excel/xlsb/color";
import {
  readCfRule,
  readCfvo,
  readDatabar,
  readIconSet,
  readConditionalFormattingBlock,
  type ReadConditionalFormatting
} from "@excel/xlsb/conditional-format";
import { readValidation, type SheetValidation } from "@excel/xlsb/data-validation";
import {
  WORKBOOK_FLAG_1904,
  readBookProtection,
  readIsoPasswordData,
  readBookView,
  readCalculationProperties,
  readSheetProtection,
  readWorksheetView,
  type BookProtectionLike,
  type CalcPropertiesLike,
  type IsoPasswordFields,
  type WorkbookViewLike,
  type SheetProtectionLike,
  type WorksheetViewLike,
  readPrintOptions,
  type PrintOptionsLike
} from "@excel/xlsb/defaults";
import { readDrawing } from "@excel/xlsb/drawing";
import { errorTextOf } from "@excel/xlsb/error-values";
import { readAutoFilter, readIgnoredErrors } from "@excel/xlsb/filter";
import {
  FILTER_CRITERIA_RECORDS,
  readFilterCriteria,
  type FilterCriteriaRecord
} from "@excel/xlsb/filter-criteria";
import { decodePtg, type PtgContext } from "@excel/xlsb/formula/ptg";
import { readHeaderFooter } from "@excel/xlsb/header-footer";
import { readBreak, type SheetBreak } from "@excel/xlsb/page-breaks";
import {
  readMargins,
  readPageSetup,
  readSheetFormatInfo,
  type ReadPageSetup,
  type SheetFormatInfo
} from "@excel/xlsb/page-setup";
import { readPane, type SheetPane } from "@excel/xlsb/pane";
import { readSheetProperties, type SheetProperties } from "@excel/xlsb/sheet-properties";
import { readSparkline, readSparklineGroup, type SheetSparklineGroup } from "@excel/xlsb/sparkline";
import {
  cellField,
  decodeRecord,
  numberField,
  rangeField,
  type DecodedRecord
} from "@excel/xlsb/spec/decode";
import { recordSpec } from "@excel/xlsb/spec/records";

/** A group being assembled: the model's shape with a mutable member list, since members arrive as records. */
type SheetSparklineGroupRead = Omit<SheetSparklineGroup, "sparklines"> & {
  readonly sparklines: SheetSparklineGroup["sparklines"][number][];
};
import type { StyleTable } from "@excel/xlsb/styles";
import { ROW_FLAG_UNSYNCED } from "@excel/xlsb/write/rows";
import { NodeType } from "@formula/syntax/ast";
import { printAst } from "@formula/syntax/print";
import { BinaryReader } from "@utils/binary";

/** A cell as read from a worksheet part. */
/** One `BrtBeginPivotCacheID`: a cache identifier and the workbook relationship naming its definition. */
export interface PivotCacheBinding {
  readonly cacheId: number;
  readonly relationshipId: string;
  /**
   * The part the relationship resolves to, when the workbook's `.rels` could be read.
   *
   * **The pairing key, and it used to be array position.** On a rewrite the writer has to reconnect each preserved cache
   * definition to the `cacheId` that announces it, and it matched the reader's binding list against the preserved-part
   * list *by index* — the reader collected bindings in `workbook.bin` order and the parts arrive in ZIP order, and
   * nothing in OPC makes those the same. Two caches delivered in the opposite order would bind each `cacheId` to the
   * other's definition: every part present, structurally valid, and the pivots reading the wrong data.
   *
   * Filled in by the package reader, which is where the relationship table is; absent when the `.rels` is missing or
   * malformed, in which case the writer falls back to position and says so.
   */
  readonly definitionPath?: string;
}

export interface ReadCell {
  readonly row: number;
  readonly column: number;
  readonly value: string | number | boolean | null;
  /**
   * Index into the styles part's cell formats.
   *
   * The style itself is *not* copied here. It used to be — five fields resolved and attached to every
   * cell — which meant a sheet of fifty thousand cells sharing one format carried fifty thousand
   * copies of the same five references, for a table the caller already holds. The index is the
   * information; resolving it is the applying step's job.
   */
  readonly styleIndex: number;
  /**
   * Number format for this cell, resolved through the styles part.
   *
   * The one style field that stays, because it is not only a style: it is the difference between a
   * date and the number `42663`, and this reader needs it to decide which of the two a value *is*
   * before anything is applied.
   */
  readonly numberFormat?: string;
  /** Formula text, when the cell carries one. `value` is then the cached result. */
  readonly formula?: string;
  /** Cell whose formula this one shares, for a `PtgExp` deferral. */
  readonly sharedFormulaOrigin?: { readonly row: number; readonly column: number };
  /**
   * `"shared"` or `"array"` on the master of a filled range.
   *
   * Set from the `BrtShrFmla` or `BrtArrFmla` that follows the master's own record — the master's `Rgce` is a
   * `PtgExp` naming itself, so the expression is only in the following record and the *kind* is only in which
   * record it is.
   */
  readonly shareType?: "shared" | "array";
  /** The range that shared or array formula covers, from the following record's `RfX`. */
  readonly ref?: string;
  /** Whether `value` is an error text rather than a string, so the model's `{ error }` shape can be rebuilt. */
  readonly isError?: boolean;
  /**
   * Formatting runs, when the cell's shared string carried them.
   *
   * `value` is still the whole text, so a caller that ignores this reads the cell correctly and unstyled —
   * which is what every caller did before the runs were read at all.
   */
  readonly richText?: readonly { readonly text: string; readonly font?: Partial<Font> }[];
}

/** A column width, in the units the public API uses. */
export interface ReadColumn {
  /** One-based, inclusive, matching the `min`/`max` a column model carries. */
  readonly min: number;
  readonly max: number;
  readonly widthCharacters: number;
  /** `fUserSet` — the width is the author's rather than the default Excel writes into every column. */
  readonly customWidth?: boolean;
  /** `fHidden`. */
  readonly hidden?: boolean;
  /** `fBestFit`. */
  readonly bestFit?: boolean;
  /** `iOutLevel`. */
  readonly outlineLevel?: number;
  /** `fCollapsed`. */
  readonly collapsed?: boolean;
  /** Cell-format index the column declares for itself, when it declares one. */
  readonly styleIndex?: number;
}

export interface ReadWorksheet {
  /**
   * Sparkline groups, with their members.
   *
   * Present because an XLSB round trip used to lose every sparkline: the records were written correctly and
   * came back as nothing, so the second write emitted none and reported no loss.
   */
  readonly sparklineGroups: readonly SheetSparklineGroup[];
  readonly cells: readonly ReadCell[];
  /**
   * Styled blank cells, as rectangles, when the read collapsed them.
   *
   * Empty unless `blankCells: "collapse"` was asked for. A writer expands them back into the records they came
   * from, which is what makes the collapse lossless rather than a discard — see `StyledBlankRuns`.
   */
  readonly styledBlanks: readonly StyledBlankRange[];
  /** Merged ranges, as `"A1:B2"` — the shape the public merge API takes. */
  readonly merges: readonly string[];
  /** Column widths, for the columns that declared one. */
  readonly columns: readonly ReadColumn[];
  /** Row heights in points, keyed by one-based row number. */
  readonly rowHeights: ReadonlyMap<number, number>;
  /** Hidden, grouped and collapsed state per one-based row. */
  readonly rowSettings: ReadonlyMap<
    number,
    { outlineLevel?: number; collapsed?: boolean; hidden?: boolean }
  >;
  /** Records skipped because their layout is not described. Keyed by record name. */
  /**
   * Cell-format index each row declares for itself, by one-based row number.
   *
   * Only non-zero entries: `BrtRowHdr` carries a zero for a row with no format of its own, and
   * recording those would give every row a style it does not have.
   */
  readonly rowStyles: ReadonlyMap<number, number>;
  /** What the sheet prints at the top and bottom of each page, when it declares any. */
  readonly headerFooter?: Partial<HeaderFooter>;
  /** Tab colour and VBA code name, when the sheet declares either. */
  readonly sheetProperties?: SheetProperties;
  /** Page margins, when the sheet declares them. */
  readonly margins?: Margins;
  /** Paper, scaling and orientation, when the sheet declares any of them. */
  readonly pageSetup?: ReadPageSetup;
  /** Default row height and column width, when the sheet declares them. */
  readonly formatInfo?: SheetFormatInfo;
  readonly unreadRecords: ReadonlyMap<string, number>;
  /**
   * Record ids with no name in the spec table, counted by id.
   *
   * Distinct from `unreadRecords`, which counts records this library *recognises* and cannot
   * decode. These it does not recognise at all, so there is no name to report — only the id, in
   * hex, which is what a future spec-table entry would be keyed by.
   */
  readonly unknownRecords: ReadonlyMap<number, number>;
  /**
   * Formulas that could not be decoded, by address.
   *
   * Separate from `unreadRecords` because the cell itself *was* read — its cached result is
   * present and usable — and only the expression was lost. Reporting them together would
   * make a workbook that reads fine look like one with missing cells.
   */
  readonly undecodedFormulas: readonly string[];
  /** Cells whose expression was not decoded because the caller asked for cached values only. */
  readonly cachedOnlyFormulas: readonly string[];
  /**
   * Cells whose value was an error code, by address.
   *
   * The cell is kept as a blank — its position and format are real information — but the error is
   * lost, and this is the only way a caller learns that. It used to be reported nowhere at all:
   * `BrtCellError` decoded to `null`, which is indistinguishable from `BrtCellBlank`, so a workbook
   * full of `#N/A` read back as a workbook full of empty cells and said nothing. That workbook now reads
   * back as its errors; see below for what remains.
   *
   * Not `unreadRecords`, because the record *was* read and understood.
   *
   * **Now only for a code outside the table.** The reason this list used to cover *every* error cell was that
   * "no workbook in the reference corpus contains a single `BrtCellError` or `BrtFmlaError` — so the byte's
   * meaning is unobserved, and inventing it is how a reader comes to agree with this library's own writer and
   * disagree with Excel". Five corpus workbooks now carry one, and all five agree with MS-XLSB 2.5.98.2, so
   * the eight documented codes are read as values. A byte outside them still lands here.
   */
  readonly errorCells: readonly string[];
  /**
   * Relationship id from the sheet's `BrtDrawing`, when it has one.
   *
   * This reader does not model drawings — the XML and the media survive as opaque parts — but the
   * *reference* is binary, so it is the one piece a rewrite has to reproduce itself. Dropping it left a
   * package whose drawing part and `.rels` were both intact and whose sheet no longer pointed at
   * either: every picture in a read-modify-written workbook silently disappeared from Excel while every
   * structural check still passed.
   */
  readonly drawingRelationshipId?: string;
  /**
   * Hyperlinks the sheet declares, each naming a relationship rather than a URL.
   *
   * `BrtHLink` carries a range and a `relId`; the destination lives in the sheet's own `.rels`, because a
   * hyperlink target is an OPC relationship with `TargetMode="External"`. Resolving the two is the
   * caller's job — this reader does not have the relationships.
   */
  readonly hyperlinks: readonly ReadHyperlink[];
  /** Relationship id of a background image, when the sheet declares one. */
  readonly backgroundRelationshipId?: string;
  /** Relationship id of the header/footer VML, when the sheet declares one. */
  readonly headerFooterRelationshipId?: string;
  /** The range an auto filter covers, when the sheet has one. */
  readonly autoFilter?: string;
  /** Error warnings the sheet suppresses, one entry per range. */
  readonly ignoredErrors: readonly IgnoredError[];
  /** One entry per sheet view, in declaration order. */
  readonly viewSettings: readonly WorksheetViewLike[];
  /** Configured sheet protection, when the sheet declares any. */
  readonly sheetProtectionSettings?: SheetProtectionLike;
  /**
   * Conditional formatting blocks, one per `BrtBeginConditionalFormatting`.
   *
   * The rules come back without their `formulae`: decoding an `Rgce` token stream to formula text needs the
   * reverse of `encodeParsedFormula`, which this module does not have. So a `cellIs` rule returns with its
   * operator and no operand — a narrowing that is named here because the alternative, inventing a plausible
   * operand, produces a rule that looks complete and evaluates differently.
   */
  readonly conditionalFormattings?: readonly ReadConditionalFormatting[];
  /** The `<filterColumn>` fragment rebuilt from the records inside `BrtBeginAFilter`. */
  readonly autoFilterCriteriaXml?: string;
  /** Data validations, one entry per `BrtDVal` with the ranges it covers. */
  readonly validations: readonly SheetValidation[];
  /** The sheet's frozen or split panes, when it declares any. */
  readonly pane?: SheetPane;
  /** Manual page breaks, one-based. */
  readonly rowBreaks: readonly SheetBreak[];
  readonly columnBreaks: readonly SheetBreak[];
}

/** One `BrtHLink`: where it applies, and the relationship naming where it goes. */
export interface ReadHyperlink {
  /** Zero-based inclusive bounds. Excel writes a single cell as a one-cell range. */
  readonly ref: BiffRange;
  /** Empty when the destination is inside this workbook, in which case `location` says where. */
  readonly relId: string;
  readonly location: string;
  readonly tooltip: string;
}

/**
 * Read `xl/sharedStrings.bin` into the string table a worksheet indexes into.
 *
 * @returns The texts, the formatting runs of any that carried them, and how many entries had bytes past
 *          their text that could not be read as runs. The runs used to be dropped with only a count to say
 *          so — a workbook of styled text read back as plain text. The count remains for what is genuinely
 *          unread: phonetic data, and any record longer than the shape it declares.
 */
export function readSharedStrings(
  bytes: Uint8Array,
  part: string
): {
  readonly texts: string[];
  readonly runs: ReadonlyMap<number, readonly { readonly at: number; readonly font: number }[]>;
  readonly richCount: number;
} {
  const texts: string[] = [];
  const runs = new Map<number, readonly { at: number; font: number }[]>();
  let richCount = 0;
  for (const record of iterateInterpretableRecords(bytes, part)) {
    if (recordSpec(record.id)?.name !== "BrtSSTItem") {
      continue;
    }
    const decoded = decodeRecord(record, part);
    const text = decoded?.fields.get("text");
    const index = texts.length;
    texts.push(typeof text === "string" ? text : "");
    if (decoded === undefined || decoded.trailingBytes === 0) {
      continue;
    }
    // **The runs are read now, not counted** — but only when the record says it has them.
    //
    // `RichStr` (MS-XLSB 2.5.122) puts `fRichStr` in bit 0 of the first byte, and only then does a
    // four-byte count and that many `StrRun`s follow — each an `ich` character offset and an `ifnt` index
    // into the styles part's font collection. Verified against `poi-sample.xlsb`, whose entries end
    // `01 00 00 00 07 00 03 00`: one run, from character 7, in font 3.
    //
    // Dispatching on the flag rather than on the presence of trailing bytes matters. Bit 1 is `fExtStr`,
    // phonetic data, which nothing here models; and a record with *neither* flag and bytes past its text is
    // simply longer than the shape it declares. Both are counted as unread. Trying to read runs from either
    // would invent formatting out of whatever those bytes happen to be.
    if ((record.payload[0]! & 0x01) === 0) {
      richCount++;
      continue;
    }
    const parsed = readStringRuns(record.payload, record.payload.length - decoded.trailingBytes);
    if (parsed === undefined) {
      richCount++;
      continue;
    }
    runs.set(index, parsed);
  }
  return { texts, runs, richCount };
}

export interface ReadSheet {
  readonly name: string;
  readonly state: "visible" | "hidden" | "veryHidden";
  /** Relationship id naming the part that holds this sheet's records, when the file gives one. */
  readonly relId?: string;
}

export interface ReadWorkbook {
  /** Sheets, in workbook declaration order. */
  readonly sheets: readonly ReadSheet[];
  /** Workbook views, in declaration order. */
  readonly bookViews?: readonly WorkbookViewLike[];
  /** Structure, window and revision locks, when any is set. */
  readonly bookProtection?: BookProtectionLike;
  /**
   * The cache bindings, kept so a read-modify-write can re-emit them.
   *
   * This reader does not model pivot tables — the three binary parts are carried through as opaque bytes —
   * but `BrtBeginPivotCacheID` lives in `workbook.bin`, which *is* rebuilt from the model. So the parts
   * survived a round trip while their binding did not: the specification requires one cache definition part
   * per binding record, and the result was the definition present and unannounced, with the view pointing at
   * a cache the workbook no longer declared. Two fields are enough to put it back.
   */
  readonly pivotCaches?: readonly PivotCacheBinding[];
  /** Iteration and full-calculation-on-load, when the workbook sets either. */
  readonly calcProperties?: CalcPropertiesLike;
  /**
   * Whether the workbook uses the 1904 date system.
   *
   * Every date serial in the workbook is relative to this epoch, so it has to be read from the
   * workbook part before any worksheet is interpreted.
   */
  readonly date1904: boolean;
  /** Sheet names alone, which is what a formula context needs. */
  readonly sheetNames: readonly string[];
  /**
   * Defined names, in declaration order.
   *
   * `PtgName` is a one-based index into this list, so the order is load-bearing: reading
   * the names into a map keyed by name would make every `PtgName` unresolvable.
   */
  readonly definedNames: readonly string[];
  /**
   * The `BrtExternSheet` table a 3D reference's `ixti` indexes.
   *
   * Needed before any worksheet is read, because every `PtgRef3d` in every formula resolves
   * through it. See `PtgContext.externSheets` for why treating `ixti` as a sheet index is wrong.
   */
  readonly externSheets: readonly { readonly first: number; readonly last: number }[];
  /**
   * Names a caller would recognise, with the range each points at.
   *
   * Separate from `definedNames`, which is the raw table in declaration order because `PtgName`
   * is a one-based index into it and must include the hidden entries. This list drops those: a
   * workbook carrying `_xlfn.CONCAT` — a stub Excel writes so an older consumer degrades
   * gracefully — has a defined name no user ever created, and reporting it as one would be
   * wrong. The two lists therefore differ in both length and purpose.
   */
  readonly namedRanges: readonly {
    readonly name: string;
    readonly ranges: readonly string[];
    /** Sheet index for a locally scoped name; absent means workbook scope. */
    readonly localSheetId?: number;
  }[];
  /**
   * One-based positions of sheet records this reader could not decode.
   *
   * The sheet keeps its position — every 3D reference indexes sheets by it — but its name, visibility
   * and the relationship naming its part are all lost, so the caller is told rather than handed a
   * workbook whose sheets are quietly named `Sheet1`, `Sheet2`, `Sheet3`.
   */
  readonly malformedSheets: readonly number[];
  /**
   * Names whose definition is an expression rather than a reference, as `name: expression`.
   *
   * Kept apart from `namedRanges` because they cannot go through `definedNamesAdd`, which takes an A1
   * reference. Reported rather than dropped: a workbook whose `Sales` is `OFFSET(…)` comes back without
   * it, and a formula built on that name then resolves to nothing.
   */
  readonly namedExpressions: readonly { readonly name: string; readonly expression: string }[];
  /**
   * Names whose record carried no definition at all.
   *
   * Separate from `namedExpressions`, which have one this library cannot express as a reference. These have none to
   * express: the token stream is empty. They were dropped in silence — see `undefinedName` in `parseDefinedName`.
   */
  readonly undefinedNames: readonly string[];
}

/** Read `xl/workbook.bin`. */
export function readWorkbookPart(bytes: Uint8Array, part: string): ReadWorkbook {
  const sheets: ReadSheet[] = [];
  const definedNames: string[] = [];
  const namedRanges: { name: string; ranges: string[]; localSheetId?: number }[] = [];
  const namedExpressions: { name: string; expression: string }[] = [];
  const undefinedNames: string[] = [];
  const externSheets: { first: number; last: number }[] = [];
  /** One-based positions of `BrtBundleSh` records that did not decode. */
  const malformedSheets: number[] = [];
  let date1904 = false;
  let calcProperties: CalcPropertiesLike | undefined;
  const bookViews: (WorkbookViewLike | undefined)[] = [];
  let bookProtectionPassword: IsoPasswordFields | undefined;
  let bookProtection: BookProtectionLike | undefined;
  const pivotCaches: { cacheId: number; relationshipId: string }[] = [];

  for (const record of iterateInterpretableRecords(bytes, part)) {
    const recordName = recordSpec(record.id)?.name;
    switch (recordName) {
      case "BrtWbProp": {
        const flags = numberField(decodeRecord(record, part), "flags") ?? 0;
        date1904 = (flags & WORKBOOK_FLAG_1904) !== 0;
        continue;
      }
      case "BrtBookView": {
        // The first only. `BrtBeginBookViews` may hold several and the model's list does too, but this
        // writer emits one — so reading more than the first would report views a write cannot reproduce.
        bookViews.push(readBookView(record.payload, part));
        continue;
      }
      case "BrtBeginPivotCacheID": {
        // `idSx` then a `RelID`. The relationship it names is itself an opaque-part edge that the writer
        // replays with its original id, so the pair still matches after a round trip.
        const reader = new BinaryReader(record.payload, 0, part);
        const cacheId = reader.readUint32();
        const relationshipId = readWideString(reader, "BrtBeginPivotCacheID");
        if (relationshipId.length > 0) {
          pivotCaches.push({ cacheId, relationshipId });
        }
        continue;
      }
      case "BrtBookProtectionIso": {
        // The password half only. The locks come from the legacy record that MUST follow, which carries the
        // same `wFlags` — so this is held aside and merged when that one arrives, rather than duplicating
        // the flag decoding.
        bookProtectionPassword = readIsoPasswordData(record.payload, 10, 0);
        continue;
      }
      case "BrtBookProtection": {
        const locks = readBookProtection(record.payload, part);
        bookProtection =
          locks === undefined ? undefined : { ...locks, ...(bookProtectionPassword ?? {}) };
        continue;
      }
      case "BrtCalcProp": {
        calcProperties = readCalculationProperties(record.payload, part);
        continue;
      }
      case "BrtExternSheet": {
        externSheets.push(...readExternSheets(record.payload, part));
        continue;
      }
      case "BrtBundleSh": {
        const decoded = decodeRecord(record, part);
        const name = decoded?.fields.get("name");
        if (typeof name !== "string") {
          // A `BrtBundleSh` this reader cannot decode used to be *skipped*, which meant a workbook whose
          // three sheet records were malformed read back as a workbook with no sheets — silently, and
          // with every other part intact. `poi-Simple.xlsb` in the pinned corpus is exactly that file:
          // its `iTabID` is 0 where the spec says the value MUST be between 1 and 0xFFFF, and it carries
          // four integers before the strings where the record has room for two.
          //
          // The layout is not in doubt — the spec states it and twenty-two of twenty-three corpus files
          // agree — so nothing is guessed here. What changed is the outcome: a placeholder keeps the
          // sheet's *position*, because `PtgRef3d` and `BrtExternSheet` index sheets by it and dropping
          // one silently retargets every reference after it, and the failure is reported.
          malformedSheets.push(sheets.length + 1);
          sheets.push({ name: `Sheet${sheets.length + 1}`, state: "visible" });
          continue;
        }
        const relId = decoded?.fields.get("relId");
        sheets.push({
          name,
          state: sheetStateName(numberField(decoded, "state") ?? 0),
          // Carried so the caller can resolve the part through the relationships rather than
          // guessing it from the sheet's position, which a chartsheet makes wrong.
          ...(typeof relId === "string" ? { relId } : {})
        });
        continue;
      }
      case "BrtName": {
        // Every name enters `definedNames`, hidden ones included, because `PtgName` is a
        // one-based index into the record order and skipping an entry shifts every later index.
        const parsed = readName(record.payload, part, {
          sheetNames: sheets.map(sheet => sheet.name),
          externSheets
        });
        if (parsed === undefined) {
          continue;
        }
        definedNames.push(parsed.name);
        if (!parsed.hidden && (parsed.range !== undefined || parsed.ranges !== undefined)) {
          namedRanges.push({
            name: parsed.name,
            ranges: parsed.ranges ?? [parsed.range!],
            ...(parsed.localSheetId === undefined ? {} : { localSheetId: parsed.localSheetId })
          });
        }
        if (!parsed.hidden && parsed.expression !== undefined) {
          namedExpressions.push({ name: parsed.name, expression: parsed.expression });
        }
        // Reported whether hidden or not: a hidden one is machinery a formula may still name, and a visible one is a
        // name the caller would expect to find. Both leave the model, so both are said out loud.
        if (parsed.undefinedName) {
          undefinedNames.push(parsed.name);
        }
        continue;
      }
      default:
        continue;
    }
  }

  return {
    sheets,
    sheetNames: sheets.map(sheet => sheet.name),
    definedNames,
    namedRanges,
    namedExpressions,
    undefinedNames,
    externSheets,
    malformedSheets,
    date1904,
    ...(calcProperties === undefined ? {} : { calcProperties }),
    ...(pivotCaches.length === 0 ? {} : { pivotCaches }),
    ...(bookViews.length === 0
      ? {}
      : { bookViews: bookViews.filter((view): view is WorkbookViewLike => view !== undefined) }),
    ...(bookProtection === undefined ? {} : { bookProtection })
  };
}

/** `BrtExternSheet`: a count, then that many `{ iSupBook, itabFirst, itabLast }` triples. */
function readExternSheets(payload: Uint8Array, part: string): { first: number; last: number }[] {
  const reader = new BinaryReader(payload, 0, part);
  const entries: { first: number; last: number }[] = [];
  try {
    const count = reader.readUint32();
    for (let index = 0; index < count; index++) {
      reader.readUint32(); // iSupBook — only the self-reference (0) is meaningful here
      entries.push({ first: reader.readUint32(), last: reader.readUint32() });
    }
  } catch {
    // A truncated table costs the 3D references, not the workbook.
  }
  return entries;
}

/**
 * `BrtName`, including the token stream that says what the name points at.
 *
 * `fProc` selects a longer tail — four extra nullable strings — but nothing after the token
 * stream is read, so the tail only matters for the record's length and is not walked.
 */
function readName(
  payload: Uint8Array,
  part: string,
  context: PtgContext
):
  | {
      name: string;
      /** The definition, when it is a reference `DefinedNames` can take. */
      range: string | undefined;
      /** The definition split into areas, when it is a union of several. */
      ranges: string[] | undefined;
      /** The definition, when it is an expression rather than a reference. */
      expression: string | undefined;
      hidden: boolean;
      /** `true` when the record carried no token stream — see the return statement. */
      undefinedName: boolean;
      /**
       * The sheet a locally scoped name belongs to, or `undefined` for workbook scope.
       *
       * Read but discarded until print areas needed it: `_xlnm.Print_Area` is a *sheet-local* name and
       * carries no other indication of which sheet it belongs to, so dropping this made every print area
       * unattributable.
       */
      localSheetId: number | undefined;
    }
  | undefined {
  const reader = new BinaryReader(payload, 0, part);
  try {
    const flags = reader.readUint32();
    reader.skip(1); // keyboard shortcut
    const sheetIndex = reader.readUint32(); // 0xFFFFFFFF for a workbook-scoped name
    const name = readWideString(reader, part);
    const tokens = reader.readBytes(reader.readUint32());
    // A hidden or function-stub name is machinery, not something a user named.
    const hidden = (flags & (NAME_FLAG_HIDDEN | NAME_FLAG_FUNCTION)) !== 0;
    let range: string | undefined;
    /** Several ranges, when the definition is a union. */
    let ranges: string[] | undefined;
    let expression: string | undefined;
    if (!hidden && tokens.length > 0) {
      try {
        const ast = decodePtg(tokens, context, `${part} name ${name}`);
        // A shared-formula reference cannot appear in a name, but the decoder's return type
        // admits one, so it is discriminated the same way the cell path does it.
        if (!("sharedRow" in ast)) {
          const printed = printAst(ast);
          // **Asked of the AST, not of the string.** A name's definition is an expression, and only some
          // expressions are references: `=TRUE` and `=OFFSET(#REF!,0,0,COUNTA(#REF!),1)` are ordinary
          // defined names. `definedNamesAdd` takes an A1 reference and *throws* on anything else, so the
          // caller needs to know which it has before offering it — and the node type says so for free.
          //
          // Printing it and then re-parsing to find out would be a second grammar to keep in step with
          // `colCache`, and catching the throw instead costs an exception per name: the
          // `many-defined-names` fixture holds 35,422 of them, most of them `OFFSET(…)`, and 35,422
          // stack captures is the difference between a read and a hang.
          if (ast.type === NodeType.UnionRef) {
            // A union is *several* ranges, and the model holds them as several. Printing it whole gave
            // `(S1!$A$1,S1!$C$1)` as a single range string, which `definedNamesAdd` then parsed with
            // `(S1` as the sheet name — so a multi-range name came back as one range on a sheet that does
            // not exist. Each area is printed on its own instead.
            // Filtered, because a union's area is not guaranteed to print as an address: the
            // `many-defined-names` fixture holds unions containing `#REF!` areas, and handing one to
            // `definedNamesAdd` threw `InvalidAddressError: Invalid address:` and failed the whole read.
            // A name that loses one area of a union is a gap; a read that fails is worse.
            const areas = ast.areas
              .map(area => printAst(area as never))
              .filter(text => text !== "" && !text.includes("#REF!"));
            if (areas.length > 0) {
              ranges = areas;
            } else {
              expression = printed;
            }
          } else if (isReferenceNode(ast)) {
            range = printed;
          } else {
            expression = printed;
          }
        }
      } catch {
        // A definition this library cannot express is reported as a name with no range rather
        // than as no name: the name still exists, and `PtgName` still has to index it.
        range = undefined;
      }
    }
    return {
      name,
      range,
      ranges,
      expression,
      hidden,
      // **Whether the record carried a definition at all.**
      //
      // A `BrtName` with an empty token stream defines nothing, and such a name reached neither `namedRanges` nor
      // `namedExpressions` — so it left the model without a word. `poi-testVarious` carries a hidden `NA` like this and
      // `poi-bug66682` a *visible* `unknownFunction`; the second is a name a caller would see in Excel, vanishing in
      // silence. Excel does not write these (it gives a name a `#NAME?` body at least), but real files hold them, and
      // reporting one is the difference between a gap and a secret.
      undefinedName: tokens.length === 0,
      // `0xFFFFFFFF` is workbook scope, which the model expresses as an absent `localSheetId`.
      localSheetId: sheetIndex === 0xffffffff ? undefined : sheetIndex
    };
  } catch {
    return undefined;
  }
}

/**
 * Whether a decoded definition is a *reference* rather than some other expression.
 *
 * The reference node types, and nothing else. A union of areas counts — `definedNamesAdd` takes each of
 * its members — while a whole-row or whole-column reference does not, because `colCache` wants a bounded
 * one. Everything else is an expression: a literal, an operator, a function call.
 */
function isReferenceNode(node: { readonly type: NodeType }): boolean {
  return (
    node.type === NodeType.CellRef ||
    node.type === NodeType.RangeRef ||
    node.type === NodeType.UnionRef ||
    // Whole-row and whole-column references are references, and omitting them sent every one of them
    // down the "defined by an expression" path — which is where `_xlnm.Print_Titles` went, so a print
    // title round-tripped as a reported loss rather than as a print title.
    node.type === NodeType.RowRangeRef ||
    node.type === NodeType.ColRangeRef
  );
}

/** A decoded string field, or `""` when absent. Empty and missing mean the same thing for these. */
function stringField(decoded: DecodedRecord | undefined, name: string): string {
  const value = decoded?.fields.get(name);
  return typeof value === "string" ? value : "";
}

/** Read one `xl/worksheets/sheetN.bin`. */
export function readWorksheetPart(
  bytes: Uint8Array,
  part: string,
  sharedStrings: readonly string[],
  formulaContext: PtgContext = {},
  styles?: StyleTable,
  /**
   * Formatting runs by shared-string index, from `readSharedStrings`.
   *
   * Passed separately from `sharedStrings` because a run is not part of the *text*: a cell reads the same
   * string whether or not it is styled, and only the cell that points at a styled entry gains a `richText`.
   */
  stringRuns?: ReadonlyMap<number, readonly { readonly at: number; readonly font: number }[]>,
  /** Collapse styled blank cells into rectangles instead of returning one `ReadCell` each. */
  collapseBlanks = false,
  /** What to do with a formula's expression — see `XlsbReadOptions.formulas`. */
  formulaPolicy: "preserve" | "cached" = "preserve"
): ReadWorksheet {
  const cells: ReadCell[] = [];
  const blankRuns = new StyledBlankRuns();
  const merges: string[] = [];
  const columns: ReadColumn[] = [];
  const rowHeights = new Map<number, number>();
  const unreadRecords = new Map<string, number>();
  const unknownRecords = new Map<number, number>();
  const rowStyles = new Map<number, number>();
  /** `iOutLevel`, `fCollapsed` and `fDyZero` per one-based row, only where something is set. */
  const rowSettings = new Map<
    number,
    { outlineLevel?: number; collapsed?: boolean; hidden?: boolean }
  >();
  let headerFooter: Partial<HeaderFooter> | undefined;
  let sheetProperties: SheetProperties | undefined;
  let margins: Margins | undefined;
  let pageSetup: ReadPageSetup | undefined;
  let printOptions: PrintOptionsLike | undefined;
  let formatInfo: SheetFormatInfo | undefined;
  const undecodedFormulas: string[] = [];
  /** Cells whose expression was deliberately not decoded, under `formulas: "cached"`. */
  const cachedOnlyFormulas: string[] = [];
  const errorCells: string[] = [];
  let drawingRelationshipId: string | undefined;
  const hyperlinks: ReadHyperlink[] = [];
  let pane: SheetPane | undefined;
  const validations: SheetValidation[] = [];
  let filterCriteriaRecordsSeen: FilterCriteriaRecord[] | undefined;
  let autoFilterCriteriaXml: string | undefined;
  let conditionalFormatting: ReadConditionalFormatting | undefined;
  // The rule a graphical collection belongs to, while one is open.
  let graphicalRule: Record<string, unknown> | undefined;
  const conditionalFormattings: ReadConditionalFormatting[] = [];
  let sheetProtectionPassword: IsoPasswordFields | undefined;
  let sheetProtectionSettings: SheetProtectionLike | undefined;
  const viewSettings: WorksheetViewLike[] = [];
  const sparklineGroups: SheetSparklineGroupRead[] = [];
  let sparklineGroup: SheetSparklineGroupRead | undefined;
  let autoFilter: string | undefined;
  let backgroundRelationshipId: string | undefined;
  let headerFooterRelationshipId: string | undefined;
  const ignoredErrors: IgnoredError[] = [];
  const rowBreaks: SheetBreak[] = [];
  const columnBreaks: SheetBreak[] = [];
  // Which break collection is open. `BrtBrk`'s three indices are untyped, so the scope is the only thing
  // that says whether the first one is a row or a column.
  let breakAxis: "row" | "column" | undefined;
  let currentRow: number | undefined;

  for (const record of iterateInterpretableRecords(bytes, part)) {
    const spec = recordSpec(record.id);
    if (!spec) {
      // A record id this library has no name for. Counted rather than skipped in silence: the
      // reference corpus contains 26 such ids across 187 occurrences, and "this file holds
      // something I do not understand" is exactly the fact a caller cannot otherwise learn.
      // Framing is unaffected — the record's length prefix is honoured either way.
      unknownRecords.set(record.id, (unknownRecords.get(record.id) ?? 0) + 1);
      continue;
    }

    if (spec.name === "BrtMergeCell") {
      const range = rangeField(decodeRecord(record, part), "ref");
      if (range) {
        merges.push(
          `${encodeCol(range.firstColumn)}${range.firstRow + 1}:` +
            `${encodeCol(range.lastColumn)}${range.lastRow + 1}`
        );
      }
      continue;
    }
    if (spec.name === "BrtWsProp") {
      sheetProperties = readSheetProperties(record.payload, part);
      continue;
    }

    if (spec.name === "BrtBeginHeaderFooter") {
      headerFooter = readHeaderFooter(record.payload, part);
      continue;
    }

    if (spec.name === "BrtMargins") {
      margins = readMargins(record.payload, part);
      continue;
    }

    if (spec.name === "BrtBkHim") {
      backgroundRelationshipId = readDrawing(record.payload, part);
      continue;
    }
    if (spec.name === "BrtLegacyDrawingHF") {
      headerFooterRelationshipId = readDrawing(record.payload, part);
      continue;
    }

    if (spec.name === "BrtBeginAFilter") {
      autoFilter = readAutoFilter(record.payload, part);
      // The criteria nest *inside* this record, so collection starts here and stops at `BrtEndAFilter`.
      filterCriteriaRecordsSeen = [];
      continue;
    }
    if (spec.name === "BrtEndAFilter") {
      autoFilterCriteriaXml = readFilterCriteria(filterCriteriaRecordsSeen ?? []);
      filterCriteriaRecordsSeen = undefined;
      continue;
    }
    if (filterCriteriaRecordsSeen !== undefined && FILTER_CRITERIA_RECORDS.has(spec.name)) {
      filterCriteriaRecordsSeen.push({ name: spec.name, payload: record.payload });
      continue;
    }
    if (spec.name === "BrtCellIgnoreEC") {
      ignoredErrors.push(...readIgnoredErrors(record.payload, part));
      continue;
    }

    if (spec.name === "BrtBeginWsView") {
      // One per view. Overwriting a single slot kept only the last, which for a sheet with two views is
      // the *wrong* one to keep — the first is the one a caller sees when the workbook opens.
      const view = readWorksheetView(record.payload, part);
      if (view !== undefined) {
        viewSettings.push(view);
      }
      continue;
    }

    if (spec.name === "BrtBeginConditionalFormatting") {
      // Opened here and closed by `BrtEndConditionalFormatting`; the rules in between accumulate onto it. The
      // header's own rule count is not used to bound that — a count disagreeing with its collection is a file
      // to survive rather than one to follow off the end of.
      conditionalFormatting = readConditionalFormattingBlock(record.payload, part);
      continue;
    }

    if (spec.name === "BrtBeginCFRule") {
      const rule = readCfRule(record.payload, part);
      if (rule !== undefined && conditionalFormatting !== undefined) {
        conditionalFormatting.rules.push(rule);
        // Held so the graphical collection that may follow can fill in its thresholds and colours.
        graphicalRule = rule as Record<string, unknown>;
      }
      continue;
    }

    if (spec.name === "BrtEndCFRule") {
      graphicalRule = undefined;
      continue;
    }

    // The three graphical collections. Each sits between a `BrtBeginCFRule` and its end, and carries the part
    // of the rule the rule record itself has no room for: the writer emits these, so a reader that skipped them
    // turned a colour scale into a rule with no scale.
    if (spec.name === "BrtBeginDatabar" && graphicalRule !== undefined) {
      Object.assign(graphicalRule, readDatabar(record.payload) ?? {});
      continue;
    }
    if (spec.name === "BrtBeginIconSet" && graphicalRule !== undefined) {
      Object.assign(graphicalRule, readIconSet(record.payload) ?? {});
      continue;
    }
    if (spec.name === "BrtCFVO" && graphicalRule !== undefined) {
      const threshold = readCfvo(record.payload);
      if (threshold !== undefined) {
        (graphicalRule.cfvo as unknown[]).push(threshold);
      }
      continue;
    }
    if (spec.name === "BrtColor" && graphicalRule !== undefined) {
      const colour = readColor(new BinaryReader(record.payload, 0, part));
      if (colour !== undefined) {
        const existing = graphicalRule.color;
        graphicalRule.color = Array.isArray(existing) ? [...existing, colour] : [colour];
      }
      continue;
    }

    if (spec.name === "BrtEndConditionalFormatting") {
      // Dropped when it holds no rules: a block with an empty `rules` array would make `Worksheet.setModel`
      // treat the range as configured, and the writer would emit a header promising nothing.
      if (conditionalFormatting !== undefined && conditionalFormatting.rules.length > 0) {
        conditionalFormattings.push(conditionalFormatting);
      }
      conditionalFormatting = undefined;
      continue;
    }

    if (spec.name === "BrtSheetProtectionIso") {
      // The `IsoPasswordData` starts after the spin count and the sixteen Booleans: 4 + 64.
      sheetProtectionPassword = readIsoPasswordData(record.payload, 68, 0);
      continue;
    }

    if (spec.name === "BrtSheetProtection") {
      // `undefined` when `fLocked` is 0, which is the record every sheet carries whether protected or
      // not — so an unprotected sheet does not come back claiming a configuration nobody set.
      const permissions = readSheetProtection(record.payload, part);
      sheetProtectionSettings =
        permissions === undefined
          ? undefined
          : { ...permissions, ...(sheetProtectionPassword ?? {}) };
      continue;
    }

    if (spec.name === "BrtDVal") {
      const validation = readValidation(record.payload, part, formulaContext);
      if (validation !== undefined) {
        validations.push(validation);
      }
      continue;
    }

    if (spec.name === "BrtPane") {
      pane = readPane(record.payload, part);
      continue;
    }

    if (spec.name === "BrtBeginRwBrk" || spec.name === "BrtBeginColBrk") {
      breakAxis = spec.name === "BrtBeginRwBrk" ? "row" : "column";
      continue;
    }
    if (spec.name === "BrtEndRwBrk" || spec.name === "BrtEndColBrk") {
      breakAxis = undefined;
      continue;
    }
    if (spec.name === "BrtBrk") {
      const entry = breakAxis === undefined ? undefined : readBreak(record.payload, part);
      if (entry !== undefined) {
        (breakAxis === "row" ? rowBreaks : columnBreaks).push(entry);
      }
      continue;
    }

    if (spec.name === "BrtHLink") {
      const decoded = decodeRecord(record, part);
      const ref = rangeField(decoded, "ref");
      if (ref !== undefined) {
        hyperlinks.push({
          ref,
          relId: stringField(decoded, "relId"),
          location: stringField(decoded, "location"),
          tooltip: stringField(decoded, "tooltip")
        });
      }
      continue;
    }

    if (spec.name === "BrtBeginSparklineGroup") {
      // Opened here; the `BrtSparkline` records between this and `BrtEndSparklineGroup` accumulate onto it.
      // Every sparkline used to be lost on read — the group was written correctly and came back as nothing, so
      // a read-modify-write deleted it and reported no loss, because the model handed to the second write
      // genuinely had none.
      const group = readSparklineGroup(record.payload, part);
      sparklineGroup =
        group === undefined ? undefined : { ...group, sparklines: [...group.sparklines] };
      continue;
    }

    if (spec.name === "BrtSparkline" && sparklineGroup !== undefined) {
      const sparkline = readSparkline(record.payload, part, formulaContext);
      if (sparkline !== undefined) {
        sparklineGroup.sparklines.push(sparkline);
      }
      continue;
    }

    if (spec.name === "BrtEndSparklineGroup") {
      // A group with no members draws nothing and is what the writer refuses to emit, so it is dropped here
      // too rather than carried as an empty shell.
      if (sparklineGroup !== undefined && sparklineGroup.sparklines.length > 0) {
        sparklineGroups.push(sparklineGroup);
      }
      sparklineGroup = undefined;
      continue;
    }

    if (spec.name === "BrtDrawing") {
      drawingRelationshipId = readDrawing(record.payload, part);
      continue;
    }

    if (spec.name === "BrtPageSetup") {
      pageSetup = readPageSetup(record.payload, part);
      continue;
    }

    if (spec.name === "BrtPrintOptions") {
      // Merged onto the page setup, which is where the model keeps these four — they arrive in a separate record
      // and belong to the same object. Held aside when `BrtPageSetup` has not been seen yet, because the two
      // records' order is not fixed and overwriting would drop whichever came first.
      printOptions = readPrintOptions(record.payload);
      continue;
    }

    if (spec.name === "BrtWsFmtInfo") {
      formatInfo = readSheetFormatInfo(record.payload, part);
      continue;
    }

    if (spec.name === "BrtColInfo") {
      const decoded = decodeRecord(record, part);
      const first = numberField(decoded, "colFirst");
      const last = numberField(decoded, "colLast");
      const width = numberField(decoded, "width");
      if (first !== undefined && last !== undefined && width !== undefined) {
        const ixfe = numberField(decoded, "ixfe") ?? 0;
        const flags = numberField(decoded, "flags") ?? 0;
        // MS-XLSB 2.4.45: `fHidden` at 0, `fUserSet` at 1, `fBestFit` at 2, `iOutLevel` at 8–10 and
        // `fCollapsed` at 12. Only `fUserSet` was read, so a hidden or grouped column came back as an
        // ordinary one — and the *next* write then had nothing to write.
        const outlineLevel = (flags >> 8) & 0x07;
        columns.push({
          min: first + 1,
          max: last + 1,
          widthCharacters: width / COLUMN_WIDTH_UNITS,
          // `fUserSet` distinguishes a width the author chose from the default Excel writes into every
          // column, which is the same distinction `isCustomWidth` carries in the model.
          customWidth: (flags & (1 << 1)) !== 0,
          ...((flags & (1 << 0)) !== 0 ? { hidden: true } : {}),
          ...((flags & (1 << 2)) !== 0 ? { bestFit: true } : {}),
          ...(outlineLevel > 0 ? { outlineLevel } : {}),
          ...((flags & (1 << 12)) !== 0 ? { collapsed: true } : {}),
          ...(ixfe === 0 ? {} : { styleIndex: ixfe })
        });
      }
      continue;
    }
    if (spec.category === "row") {
      const decoded = decodeRecord(record, part);
      currentRow = numberField(decoded, "rw");
      const height = numberField(decoded, "miyRw");
      const flags = numberField(decoded, "flags") ?? 0;
      // Only a height the author set is recorded. Excel writes the default into every row
      // header, so keeping them all would turn an unstyled sheet into one with a height on
      // every row — the `fUnsynced` flag is what distinguishes the two.
      if (currentRow !== undefined && height !== undefined && (flags & ROW_FLAG_UNSYNCED) !== 0) {
        rowHeights.set(currentRow + 1, height / TWIPS_PER_POINT);
      }
      const rowStyle = numberField(decoded, "ixfe") ?? 0;
      if (currentRow !== undefined && rowStyle !== 0) {
        rowStyles.set(currentRow + 1, rowStyle);
      }
      // The three flags that share the byte with `fUnsynced`: `iOutLevel` in the low three bits,
      // `fCollapsed` at 3, `fDyZero` at 4. Only non-default values are recorded, so a sheet where Excel
      // wrote a header for every row does not come back with a flag on each one.
      if (currentRow !== undefined) {
        const outlineLevel = flags & 0x07;
        const settings: { outlineLevel?: number; collapsed?: boolean; hidden?: boolean } = {
          ...(outlineLevel > 0 ? { outlineLevel } : {}),
          ...((flags & (1 << 3)) !== 0 ? { collapsed: true } : {}),
          ...((flags & (1 << 4)) !== 0 ? { hidden: true } : {})
        };
        if (Object.keys(settings).length > 0) {
          rowSettings.set(currentRow + 1, settings);
        }
      }
      continue;
    }
    // `BrtShrFmla` / `BrtArrFmla` — the expression a shared or array formula's *master* defers to.
    //
    // The master's own record carries a `PtgExp` naming itself, so without this branch it read back as a
    // follower pointing at its own address: a cell with a `sharedFormulaOrigin` and no formula anywhere,
    // which the model then dropped. The record that actually holds the tokens sits immediately after it, and
    // has no `category` in the spec table — so it was skipped before this.
    if ((spec.name === "BrtShrFmla" || spec.name === "BrtArrFmla") && formulaPolicy === "cached") {
      // **A shared or array formula's expression lives in its own record, so `"cached"` has to skip it here too.**
      //
      // Skipping only the `BrtFmla*` branch left the master of a shared formula holding a decoded expression while
      // every other formula cell in the sheet had been reduced to a value — `"cached"` was honoured for four cells out
      // of six on the one corpus file that has both. Dropping the record leaves the master's own cached value in
      // place, which is exactly what the policy promises, and the followers resolve to nothing and keep theirs.
      const master = cells[cells.length - 1];
      if (master !== undefined) {
        cachedOnlyFormulas.push(`${encodeCol(master.column)}${master.row + 1}`);
        // The master's own record named itself through a `PtgExp`; with no expression coming, that self-reference
        // would otherwise survive as a follower pointing at its own address and lose the value with it.
        cells[cells.length - 1] = (({ sharedFormulaOrigin: _dropped, ...rest }) => rest)(master);
      }
      continue;
    }
    if (spec.name === "BrtShrFmla" || spec.name === "BrtArrFmla") {
      const master = cells[cells.length - 1];
      if (master !== undefined) {
        const shared = readSharedFormula(record, part, spec.name, master, formulaContext);
        if (shared === undefined) {
          undecodedFormulas.push(`${encodeCol(master.column)}${master.row + 1}`);
        } else {
          cells[cells.length - 1] = shared;
        }
      }
      continue;
    }
    if (spec.category !== "cell") {
      continue;
    }
    // One path for every reason a cell cannot be read: no declared layout, a value shape
    // not yet mapped, or an index that does not resolve. An earlier version special-cased
    // the first with its own branch, which was redundant — a record with no layout decodes
    // to nothing and falls through here anyway — and redundant branches are how two paths
    // come to disagree.
    // Decoded **once**. This used to call `decodeRecord` here and again inside `readCellValue`, so
    // every cell in the sheet was parsed against its layout twice — on the hottest path in the reader,
    // for a result that cannot differ between the two calls.
    const decodedCell = decodeRecord(record, part);
    const value = readCellValue(decodedCell, spec.name, sharedStrings);
    if (value === undefined) {
      unreadRecords.set(spec.name, (unreadRecords.get(spec.name) ?? 0) + 1);
      continue;
    }
    const cell = cellField(decodedCell, "cell");
    if (cell === undefined || currentRow === undefined) {
      continue;
    }
    // An error cell reads as a blank, which is the honest outcome and not a silent one: the address
    // is recorded so the caller can be told the difference between "empty" and "was an error".
    // Counted only when the code could not be resolved — the value is then `null`, indistinguishable from a
    // blank, which is the situation this list exists to report. A recognised error is a value like any other.
    if (
      (spec.name === "BrtCellError" || spec.name === "BrtFmlaError") &&
      typeof value !== "string"
    ) {
      errorCells.push(`${encodeCol(cell.column)}${currentRow + 1}`);
    }

    // Rich text: the cell points at a shared-string entry that carried formatting runs, so the runs are
    // sliced back into the `{ text, font }` list the model uses. Resolved here rather than in
    // `readCellValue`, which returns a value and has no business knowing about fonts.
    const richText =
      spec.name === "BrtCellIsst" && typeof value === "string"
        ? richTextOf(numberField(decodedCell, "isst"), value, stringRuns, styles)
        : undefined;

    // A formula cell's expression sits after its cached value. The value is already read,
    // so a formula that cannot be decoded costs the expression and nothing else.
    let formula: string | undefined;
    let sharedFormulaOrigin: { row: number; column: number } | undefined;
    if (spec.name.startsWith("BrtFmla") && formulaPolicy === "cached") {
      // **Asked for the value and nothing else.** A caller reading a large workbook to extract numbers pays for token
      // decoding on every formula cell and throws the result away; and a caller who does not trust this codec's
      // formula output would rather have the number Excel computed than an expression that might be wrong. Counted as
      // deferred rather than lost, because nothing failed — the expression was not asked for.
      cachedOnlyFormulas.push(`${encodeCol(cell.column)}${currentRow + 1}`);
    } else if (spec.name.startsWith("BrtFmla")) {
      const decoded = readFormula(record, part, spec.name, currentRow, cell.column, formulaContext);
      if (decoded === undefined) {
        undecodedFormulas.push(`${encodeCol(cell.column)}${currentRow + 1}`);
      } else if (typeof decoded === "string") {
        formula = decoded;
      } else {
        sharedFormulaOrigin = decoded;
      }
    }

    // **A styled blank need not become a cell.**
    //
    // Excel writes a `BrtCellBlank` for every cell that carries formatting past the data — applying a fill to a
    // whole column leaves one per row to the sheet's end — and materialising each is what makes a small workbook
    // expensive. Measured on a sheet with 253 rows of data and 322,520 such records: 169.7 MB of retained heap
    // for cells holding nothing.
    //
    // With `blankCells: "collapse"` they are accumulated into rectangles instead, which the writer expands again.
    // That is the difference from simply dropping them: the run is a *representation* of the same records rather
    // than a loss, so an XLSB read and written back is unchanged and no fidelity report is owed.
    if (collapseBlanks && value === null && formula === undefined && richText === undefined) {
      blankRuns.add(currentRow, cell.column, cell.styleIndex);
      continue;
    }
    const numberFormat = styles?.numberFormats[cell.styleIndex];
    cells.push({
      row: currentRow,
      column: cell.column,
      value,
      styleIndex: cell.styleIndex,
      ...(numberFormat === undefined ? {} : { numberFormat }),
      ...(formula === undefined ? {} : { formula }),
      ...(sharedFormulaOrigin === undefined ? {} : { sharedFormulaOrigin }),
      ...(richText === undefined ? {} : { richText }),
      // Flagged so the applying step can rebuild the model's `{ error }` shape. Without it the text would go
      // back as an ordinary string, and `#N/A` would become the four characters "#N/A" — which displays the
      // same and is not the same value.
      ...(spec.name === "BrtCellError" || spec.name === "BrtFmlaError"
        ? { isError: typeof value === "string" }
        : {})
    });
  }

  return {
    cells,
    styledBlanks: blankRuns.ranges(),
    merges,
    columns,
    rowHeights,
    rowSettings,
    rowStyles,
    sheetProperties,
    headerFooter,
    margins,
    // The two records are one object in the model.
    pageSetup:
      pageSetup === undefined && printOptions === undefined
        ? undefined
        : { ...(pageSetup ?? {}), ...(printOptions ?? {}) },
    formatInfo,
    unreadRecords,
    unknownRecords,
    undecodedFormulas,
    cachedOnlyFormulas,
    errorCells,
    hyperlinks,
    validations,
    conditionalFormattings,
    ...(autoFilterCriteriaXml === undefined ? {} : { autoFilterCriteriaXml }),
    ...(sheetProtectionSettings === undefined ? {} : { sheetProtectionSettings }),
    viewSettings,
    ...(autoFilter === undefined ? {} : { autoFilter }),
    ...(backgroundRelationshipId === undefined ? {} : { backgroundRelationshipId }),
    ...(headerFooterRelationshipId === undefined ? {} : { headerFooterRelationshipId }),
    ignoredErrors,
    rowBreaks,
    columnBreaks,
    ...(pane === undefined ? {} : { pane }),
    ...(drawingRelationshipId === undefined ? {} : { drawingRelationshipId }),
    sparklineGroups
  };
}

/**
 * Read the token stream out of a formula cell.
 *
 * The record is `Cell`, the cached value, a flags word, then `CellParsedFormula`. Skipping
 * to the tokens therefore needs the cached value's width, which differs per record — so the
 * record name selects it rather than a fixed offset.
 *
 * @returns Formula text, a shared-formula origin, or `undefined` when it could not be
 *          decoded. The distinction matters: the first two are successes.
 */
function readFormula(
  record: BiffRecord,
  part: string,
  name: string,
  row: number,
  column: number,
  context: PtgContext
): string | { row: number; column: number } | undefined {
  const where = `${part} ${encodeCol(column)}${row + 1}`;
  try {
    const reader = new BinaryReader(record.payload, 0, part);
    readCell(reader);
    switch (name) {
      case "BrtFmlaNum":
        reader.readFloat64();
        break;
      case "BrtFmlaBool":
      case "BrtFmlaError":
        reader.readUint8();
        break;
      case "BrtFmlaString": {
        const length = reader.readUint32();
        reader.skip(length * 2);
        break;
      }
      default:
        return undefined;
    }
    reader.readUint16(); // grbit: recalculation flags, not expression structure.
    const tokens = reader.readBytes(reader.readUint32());
    // `RgbExtra`, which follows the `Rgce` and its own length. Read because a `PtgExp` — the token a cell
    // deferring to a shared or array formula carries — keeps only its row in the `Rgce`; the column is a
    // `PtgExtraCol` here. Skipping it made every such formula undecodable, silently, since the `catch` below
    // reports the same outcome for a genuine parse failure.
    const extra = reader.readBytes(reader.readUint32());
    const decoded = decodePtg(tokens, { ...context, origin: { row, column } }, where, extra);
    return "sharedRow" in decoded
      ? { row: decoded.sharedRow, column: decoded.sharedColumn }
      : printAst(decoded);
  } catch {
    // Every failure mode is the same outcome for the caller: the cached value stands and
    // the expression is reported. Distinguishing them here would put codec detail in the
    // reader's contract.
    return undefined;
  }
}

function readCellValue(
  decoded: DecodedRecord | undefined,
  name: string,
  sharedStrings: readonly string[]
): string | number | boolean | null | undefined {
  switch (name) {
    case "BrtCellBlank":
      return null;
    case "BrtCellError":
    case "BrtFmlaError": {
      // **Decoded, not dropped.** These used to return `null` and be counted in `errorCells`, so a workbook
      // of `#N/A` read back as a workbook of blanks. `BErr` is an eight-value table (2.5.98.2) whose codes
      // Excel's own files confirm — see `error-values.ts`.
      // The field is named `error`, not `value` — see the record table. Reading the wrong name yielded
      // `undefined` and every error cell fell back to a blank, which is the outcome this branch replaced.
      const code = numberField(decoded, "error");
      const text = code === undefined ? undefined : errorTextOf(code);
      // An unrecognised byte still reads as a blank and is still counted, because inventing an error is worse
      // than reporting that one could not be read.
      return text ?? null;
    }
    case "BrtCellRk":
    case "BrtCellReal":
      return numberField(decoded, "value");
    case "BrtCellBool": {
      const raw = numberField(decoded, "value");
      return raw === undefined ? undefined : raw !== 0;
    }
    case "BrtCellSt": {
      const text = decoded?.fields.get("value");
      return typeof text === "string" ? text : undefined;
    }
    case "BrtCellIsst": {
      const index = numberField(decoded, "isst");
      // An out-of-range index is a broken file, which the validator reports. Here it
      // becomes undefined rather than an empty string, so the cell is counted as unread
      // instead of silently becoming blank.
      return index === undefined ? undefined : sharedStrings[index];
    }
    // A formula cell's cached result. The declared layout stops after it — the flags word
    // and token stream that follow are read separately by `readFormula`, and appear here as
    // the record's trailing bytes.
    case "BrtFmlaNum":
    case "BrtFmlaBool":
      return name === "BrtFmlaBool"
        ? numberField(decoded, "value") !== 0
        : numberField(decoded, "value");
    case "BrtFmlaString": {
      const text = decoded?.fields.get("value");
      return typeof text === "string" ? text : undefined;
    }
    // `BrtCellError` and `BrtFmlaError` are handled at the top of this switch, which is where the `BErr`
    // table resolves them. They had a second branch down here that mapped the code to `null` on the grounds
    // that "the model's error representation is a separate concern from reading the record" — unreachable
    // once the first branch existed, and the reason it gave is no longer true: `error-values.ts` is that
    // representation and it is shared with the writer.
    default:
      return undefined;
  }
}

/**
 * Resolve a master cell against the `BrtShrFmla` or `BrtArrFmla` that follows it.
 *
 * The record is an `RfX` — the range the formula covers — then, for `BrtArrFmla` only, a flag byte, then a
 * parsed formula. The master keeps its cached value and its style; what it gains is the expression and the
 * range, and what it loses is the `sharedFormulaOrigin` that pointed at itself.
 *
 * `undefined` when the tokens cannot be decoded, so the caller reports the address rather than silently
 * leaving a self-referential cell behind.
 */
function readSharedFormula(
  record: BiffRecord,
  part: string,
  name: string,
  master: ReadCell,
  context: PtgContext
): ReadCell | undefined {
  try {
    const reader = new BinaryReader(record.payload, 0, part);
    const firstRow = reader.readUint32();
    const lastRow = reader.readUint32();
    const firstColumn = reader.readUint32();
    const lastColumn = reader.readUint32();
    if (name === "BrtArrFmla") {
      reader.readUint8(); // `fAlwaysCalc`, a recalculation hint rather than expression structure.
    }
    const tokens = reader.readBytes(reader.readUint32());
    const extra = reader.readBytes(reader.readUint32());
    const decoded = decodePtg(
      tokens,
      { ...context, origin: { row: master.row, column: master.column } },
      `${part} ${encodeCol(master.column)}${master.row + 1}`,
      extra
    );
    if ("sharedRow" in decoded) {
      return undefined;
    }
    const { sharedFormulaOrigin: _dropped, ...rest } = master;
    return {
      ...rest,
      formula: printAst(decoded),
      shareType: name === "BrtArrFmla" ? ("array" as const) : ("shared" as const),
      ref: `${encodeCol(firstColumn)}${firstRow + 1}` + `:${encodeCol(lastColumn)}${lastRow + 1}`
    };
  } catch {
    return undefined;
  }
}

/**
 * The `StrRun` array at `at`, or `undefined` when the bytes do not form one.
 *
 * Refuses rather than guesses: a short or ragged remainder means the trailing bytes are something other
 * than runs, and inventing formatting from them would be worse than reporting the string unread.
 */
function readStringRuns(
  payload: Uint8Array,
  at: number
): readonly { readonly at: number; readonly font: number }[] | undefined {
  if (at + 4 > payload.length) {
    return undefined;
  }
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const count = view.getUint32(at, true);
  // Four bytes per run, and the count must account for every remaining byte: a mismatch means this is not
  // a run array.
  if (count === 0 || at + 4 + count * 4 !== payload.length) {
    return undefined;
  }
  const runs: { at: number; font: number }[] = [];
  for (let index = 0; index < count; index += 1) {
    const offset = at + 4 + index * 4;
    runs.push({ at: view.getUint16(offset, true), font: view.getUint16(offset + 2, true) });
  }
  return runs;
}

/**
 * The `{ text, font }` runs of a rich string, sliced from its `StrRun` offsets.
 *
 * `RichStr` stores one string and the character offset each run *begins* at; the model stores each run's own
 * text. So the offsets are turned into slices, with the span of the last run running to the end.
 *
 * A run whose `ifnt` is 0 gets no `font`: index 0 is the default font, which is what "no formatting of its
 * own" means, and attaching the default explicitly would make an unstyled run look styled on the way back
 * out.
 */
function richTextOf(
  index: number | undefined,
  text: string,
  stringRuns:
    | ReadonlyMap<number, readonly { readonly at: number; readonly font: number }[]>
    | undefined,
  styles: StyleTable | undefined
): readonly { readonly text: string; readonly font?: Partial<Font> }[] | undefined {
  const runs = index === undefined ? undefined : stringRuns?.get(index);
  if (runs === undefined || runs.length === 0) {
    return undefined;
  }
  const fonts = styles?.fontTable ?? [];
  return runs.map((run, position) => {
    const end = runs[position + 1]?.at ?? text.length;
    const font = run.font === 0 ? undefined : fonts[run.font];
    return {
      text: text.slice(run.at, end),
      ...(font === undefined ? {} : { font })
    };
  });
}

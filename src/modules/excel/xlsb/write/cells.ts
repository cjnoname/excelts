/**
 * Encoding one cell.
 *
 * A `BrtCell*` record is chosen by the *shape of the value*, not by the model's `type` discriminant —
 * and that is a decision rather than an oversight. A rich-text cell built through `Cell.setValue`
 * arrives with `type` set to `String` and its runs nested inside `value`, so the discriminant does not
 * discriminate; the shapes below were read off the model instead.
 *
 * The other decision worth naming is what happens when a cell cannot be encoded. It becomes a blank
 * **with its formatting intact**, and its address is reported. Writing the cached result of a formula
 * this module cannot express would produce a cell that shows the right number and never recalculates,
 * which is worse than one that admits it is empty.
 */
import { ValueType } from "@excel/core/enums";
import type { CellValue } from "@excel/types";
import { encodeCol } from "@excel/utils/address";
import {
  encodeCell,
  encodeRange,
  encodeRk,
  encodeWideString,
  tryDecodeRange,
  type BiffRange
} from "@excel/xlsb/binary";
import { errorCodeOf } from "@excel/xlsb/error-values";
import {
  encodeParsedFormula,
  encodePtg,
  encodeSharedFormulaReference,
  type PtgContext
} from "@excel/xlsb/formula/ptg";
import type { CellFormatTable } from "@excel/xlsb/styles";
import { record, type Emitted } from "@excel/xlsb/write/emit";
import type { RichTextRun, SharedStringTable } from "@excel/xlsb/write/shared-strings";
import { type CellLike, type SheetCell, type SheetRow } from "@excel/xlsb/write/types";
import { parse } from "@formula/syntax/parser";
import { tokenize } from "@formula/syntax/tokenizer";
import { BinaryWriter, concatUint8Arrays } from "@utils/binary";
import { dateToExcel } from "@utils/utils";

/**
 * Choose the record for a cell value.
 *
 * The `BrtShort*` variants are never emitted. Their encoding has not been established,
 * and the non-short records express every value this writer can produce — a larger file
 * than Excel would write, and one whose every byte is accounted for.
 */
export function encodeCellRecord(
  cell: SheetCell,
  strings: SharedStringTable,
  formulaContext: PtgContext,
  // Needed only for rich text, whose runs name fonts by index into the styles part's font collection. Passed
  // rather than reached for, because the table is per-workbook state the worksheet writer already holds.
  formats: CellFormatTable
): readonly Emitted[] | RefusedCell | undefined {
  const head = encodeCell({ column: cell.column, styleIndex: cell.styleIndex ?? 0 });
  const value = cell.value;

  if (cell.formula !== undefined) {
    return encodeFormulaCell(cell, head, formulaContext);
  }
  // A cell that *follows* a shared or array formula. It has no `formula` of its own — the model gives it the
  // master's address in `sharedFormula` — and its record carries a `PtgExp` naming that master instead of an
  // expression. Before this it was reported as an unsupported "shared formula" and written as a blank, which
  // cost the cell both its formula and its cached value.
  if (cell.sharedFormula !== undefined) {
    return followerCell(cell, head);
  }

  if (value === null || value === undefined) {
    return [record("BrtCellBlank", head)];
  }
  if (typeof value === "number") {
    return [numericCell(head, value)];
  }
  if (typeof value === "boolean") {
    return [record("BrtCellBool", concatUint8Arrays([head, Uint8Array.of(value ? 1 : 0)]))];
  }
  if (typeof value === "string") {
    return [
      record(
        "BrtCellIsst",
        concatUint8Arrays([
          head,
          new BinaryWriter().writeUint32(strings.intern(value)).toUint8Array()
        ])
      )
    ];
  }
  // An error value: `BrtCellError` with the `BErr` byte. The cell keeps its style, and the error is the value.
  if (isErrorValue(value)) {
    const code = errorCodeOf(value.error);
    if (code !== undefined) {
      return [record("BrtCellError", concatUint8Arrays([head, Uint8Array.of(code)]))];
    }
  }
  // Rich text: still a `BrtCellIsst`, because a rich string is an entry in the same table. What differs is the
  // entry, not the cell.
  if (isRichText(value)) {
    return [
      record(
        "BrtCellIsst",
        concatUint8Arrays([
          head,
          new BinaryWriter().writeUint32(strings.internRich(value.richText, formats)).toUint8Array()
        ])
      )
    ];
  }
  if (value instanceof Date) {
    // Dates are serial numbers plus a number format; the serial is the value. **Through the same compression
    // as any other number** — a whole-day serial is a small integer, which `RkNumber` holds in four bytes
    // where this wrote eight. It used to go straight to `BrtCellReal`, so every date cost four bytes more than
    // Excel spends on it, and Excel writes `BrtCellRk` for exactly these values.
    return [numericCell(head, dateToExcel(value, cell.date1904 ?? false))];
  }
  // Unreachable for a model-derived cell: `writableValue` has already reduced anything this
  // cannot express to null. Reached only when a caller builds a `SheetCell` by hand with a
  // value outside the supported set, and the caller reports it.
  return undefined;
}

/**
 * A formula cell: the cached result, a flags word, then the token stream.
 *
 * The record is chosen by the *result*'s type, not the formula's: Excel stores
 * `BrtFmlaNum` for a numeric result and `BrtFmlaString` for a text one, and a reader skips
 * to the tokens using that width.
 *
 * A cached result this writer cannot express falls back to `BrtFmlaNum` with zero — which is what
 * Excel itself writes for a formula it has not evaluated — rather than costing the cell its formula.
 * The comment here used to claim the opposite, that such a cell "is not written as a formula at all",
 * and the code never did that; the claim was also the wrong policy. Excel recalculates on open, so
 * the formula displays correctly either way, and dropping it would lose the expression permanently to
 * protect a value that is about to be replaced. The loss is reported instead, by
 * `formulaCachedResultLoss`.
 */
/** A cell the encoder declined, and why. Distinguished from `undefined` so the reason can be reported. */
export interface RefusedCell {
  readonly reason: string;
}

/** Whether a returned value is a refusal rather than records. */
export function isRefused(
  value: readonly Emitted[] | RefusedCell | undefined
): value is RefusedCell {
  return value !== undefined && !Array.isArray(value);
}

/**
 * The construct a codec error names, trimmed to the part a caller can act on.
 *
 * `ExcelNotSupportedError` messages read "XLSB: A1 uses an array constant, which this writer cannot
 * express" — the address and the framing are already in the report, so only the middle is kept.
 */
function formulaReason(message: string): string {
  const match = /uses (.+?), which/.exec(message) ?? /: (.+)$/.exec(message);
  return `formula (${(match?.[1] ?? message).trim()})`;
}

/**
 * A shared formula's body, encoded as offsets from the master cell.
 *
 * Re-encoded rather than rewritten: the tokens are produced by the same `encodePtg` the ordinary path uses, with
 * `origin` and `relativeToOrigin` set. A second traversal that turned absolute tokens into relative ones would
 * be a second encoder for the same grammar, and this module's most repeated defect is two encoders agreeing with
 * each other and not with Excel.
 */
function sharedTemplateTokens(cell: SheetCell, context: PtgContext): Uint8Array {
  return encodePtg(
    parse(tokenize(cell.formula!)),
    { ...context, origin: { row: cell.row, column: cell.column }, relativeToOrigin: true },
    `${encodeCol(cell.column)}${cell.row + 1}`
  );
}

function encodeFormulaCell(
  cell: SheetCell,
  head: Uint8Array,
  context: PtgContext
): readonly Emitted[] | RefusedCell | undefined {
  const where = `${encodeCol(cell.column)}${cell.row + 1}`;
  let tokens: Uint8Array;
  try {
    tokens = encodePtg(parse(tokenize(cell.formula!)), context, where);
  } catch (cause) {
    // **The reason travels with the refusal.** This used to swallow the error and the caller reported a
    // bare `A1: formula`, which tells a caller that something about the formula could not be written and
    // not *what* — so `SUM(Missing[Qty])` and `{1,2;3,4}` produced the same message. The encoder already
    // names the construct; throwing it away here was the only reason it did not reach the report.
    return {
      reason:
        cause instanceof Error && cause.message !== "" ? formulaReason(cause.message) : "formula"
    };
  }
  // A master cell of a shared or array formula stores a `PtgExp` where its expression would go, and the
  // expression itself follows in a `BrtShrFmla` or `BrtArrFmla`. Which of the two, and over what range, is
  // decided by `sharedRange` below; `undefined` means an ordinary single-cell formula.
  const shared = sharedRange(cell);
  const reference =
    shared === undefined ? undefined : encodeSharedFormulaReference(cell.row, cell.column);
  const formula =
    reference === undefined
      ? encodeParsedFormula(tokens)
      : encodeParsedFormula(reference.rgce, reference.rgbExtra);
  const follower =
    shared === undefined
      ? []
      : [
          record(
            shared.kind === "array" ? "BrtArrFmla" : "BrtShrFmla",
            concatUint8Arrays([
              encodeRange(shared.range),
              // `BrtArrFmla` has a flag byte between the range and the formula and `BrtShrFmla` does not.
              //
              // **Zero, not `fAlwaysCalc`.** This carried `0x01` on the reasoning that "Excel's own array
              // formulas carry it" — true of the corpus's single sample, which is a future-function array
              // returning `#NAME?`. Excel's re-save of this library's own `formulas.xlsb` writes `00` for both
              // of its array formulas, so the flag describes that one file's circumstances rather than the
              // record. Asserting always-calc is also not this writer's call to make on a caller's behalf.
              ...(shared.kind === "array" ? [Uint8Array.of(0x00)] : []),
              // **A shared formula's body is a template; an array formula's is not.** The distinction decides
              // whether the references are offsets, and it is the whole of this fix.
              //
              // A `BrtShrFmla` is re-evaluated at every cell of its range, so `H1` written in `H2` has to say
              // "one row above me" — `PtgRefN` with an offset — not "H1". This writer emitted the same absolute
              // tokens it uses for an ordinary formula, so Excel dropped the construct outright: "Removed
              // Feature: Shared formula from /xl/worksheets/sheet1.bin", and then repaired the master cell whose
              // `PtgExp` pointed at it.
              //
              // A `BrtArrFmla` is one formula evaluated once over its range, producing an array. Its references
              // are positions, and relativising them would break it. The two records are adjacent in this
              // switch and differ in exactly this, which is why the comment sits here rather than in the codec.
              //
              // The same mistake, in the same operand, was fixed for conditional formatting earlier — and
              // nothing went back to ask which *other* callers write a template. This is that caller.
              shared.kind === "array"
                ? encodeParsedFormula(tokens)
                : encodeParsedFormula(sharedTemplateTokens(cell, context))
            ])
          )
        ];
  // Zero for a shared master and for an array master alike.
  //
  // **This was briefly `0x0002` for an array master, and that was wrong.** The value came from
  // `poi-bug66682.xlsb`, the corpus's only array formula — whose master is a `BrtFmlaError` holding `#NAME?`
  // from a future function, so the bit belonged to that circumstance rather than to being an array. Excel's own
  // re-save of *this library's* `formulas.xlsb` writes `00 00` on both array masters, which is the reference
  // that settles it: same content, same writer's input, Excel's bytes out.
  //
  // The lesson is the one this module keeps relearning: one sample establishes that a value *occurs*, not what
  // it means. A single differing file is a hypothesis, and this one survived a whole round of being believed.
  const flags = new BinaryWriter().writeUint16(0).toUint8Array();
  // A date-valued cached result is its serial, the same number a literal date cell carries. The
  // epoch has to come from the cell rather than be assumed, for the same reason it does there.
  const result =
    cell.value instanceof Date ? dateToExcel(cell.value, cell.date1904 ?? false) : cell.value;

  // **A cached error is a `BrtFmlaError`, and writing `BrtFmlaNum` 0 instead was a silent corruption.**
  //
  // The record is a cell followed by one `BErr` byte — the layout `spec/records.ts` declares and the corpus confirms:
  // five `BrtFmlaError` records across `poi-bug66682` and `poi-testVarious`, decoding to `#DIV/0!`, `#REF!`, `#NAME?`
  // and `#N/A` through the same `errorCodeOf` table used everywhere else. The comment on `formulaCachedResultLoss`
  // claimed the corpus held none of these; that was true of the nine-file corpus it was written against.
  //
  // What it cost: `poi-bug66682`'s `#DIV/0!` was rebuilt as a cached `0`, so a consumer that does not recalculate —
  // this library's own reader included — read zero where an error belonged, with nothing reported.
  if (isErrorValue(result)) {
    const code = errorCodeOf(result.error);
    if (code !== undefined) {
      return [
        record("BrtFmlaError", concatUint8Arrays([head, Uint8Array.of(code), flags, formula])),
        ...follower
      ];
    }
    // No `BErr` for it — the dynamic-array family. Falls through to the zero below and is reported by
    // `formulaCachedResultLoss`, which is the right outcome: substituting a different error would be worse.
  }
  if (typeof result === "number") {
    return [
      record(
        "BrtFmlaNum",
        concatUint8Arrays([
          head,
          new BinaryWriter().writeFloat64(result).toUint8Array(),
          flags,
          formula
        ])
      ),
      ...follower
    ];
  }
  if (typeof result === "boolean") {
    return [
      record(
        "BrtFmlaBool",
        concatUint8Arrays([head, Uint8Array.of(result ? 1 : 0), flags, formula])
      ),
      ...follower
    ];
  }
  if (typeof result === "string") {
    return [
      record("BrtFmlaString", concatUint8Arrays([head, encodeWideString(result), flags, formula])),
      ...follower
    ];
  }
  // No cached result, or one this writer cannot express. `BrtFmlaNum` with zero is what
  // Excel writes for a formula it has not evaluated.
  return [
    record(
      "BrtFmlaNum",
      concatUint8Arrays([head, new BinaryWriter().writeFloat64(0).toUint8Array(), flags, formula])
    ),
    ...follower
  ];
}

/**
 * The range a shared or array formula covers, and which record declares it.
 *
 * `undefined` for an ordinary formula, which is most of them. A `shareType` without a `ref` is treated as
 * ordinary rather than guessed at: the range is what the record exists to state, and a single-cell guess
 * would silently narrow an author's spill.
 */
function sharedRange(
  cell: SheetCell
): { readonly kind: "shared" | "array"; readonly range: BiffRange } | undefined {
  if (cell.shareType === undefined || cell.ref === undefined) {
    return undefined;
  }
  const range = tryDecodeRange(cell.ref);
  return range === undefined
    ? undefined
    : { kind: cell.shareType === "array" ? "array" : "shared", range };
}

/**
 * A cell that follows a shared or array formula: a `PtgExp` naming the master, and the cached value.
 *
 * The record type still comes from the *value*, exactly as for a formula cell, because a reader skips to the
 * tokens using that width. What differs is that the tokens are the five bytes of a `PtgExp` and the column
 * that completes it sits in the `RgbExtra`.
 */
function followerCell(cell: SheetCell, head: Uint8Array): readonly Emitted[] | RefusedCell {
  // **Through `tryDecodeRange`, because `decodeCell` throws and this branch read as though it returned `undefined`.**
  //
  // The guard below was unreachable: `decodeCell("")` raises `InvalidAddressError`, so a follower whose
  // `sharedFormula` was malformed took the *whole XLSB write* down instead of degrading to the reported loss the code
  // claimed. Measured: a cell with `sharedFormula: ""` threw `InvalidAddressError: Invalid address:` out of
  // `Workbook.toBuffer`. The same shape sat in a local `decodeRange` used by `sharedRange`, whose `ref: ""` case threw
  // identically — while four other range callers in this module remembered the `try`/`catch`.
  const masterRange = tryDecodeRange(cell.sharedFormula!);
  if (masterRange === undefined) {
    return { reason: "shared formula (unreadable master address)" };
  }
  const master = { r: masterRange.firstRow, c: masterRange.firstColumn };
  const reference = encodeSharedFormulaReference(master.r, master.c);
  const formula = encodeParsedFormula(reference.rgce, reference.rgbExtra);
  const flags = new BinaryWriter().writeUint16(0).toUint8Array();
  const value =
    cell.value instanceof Date ? dateToExcel(cell.value, cell.date1904 ?? false) : cell.value;

  if (typeof value === "boolean") {
    return [
      record("BrtFmlaBool", concatUint8Arrays([head, Uint8Array.of(value ? 1 : 0), flags, formula]))
    ];
  }
  if (typeof value === "string") {
    return [
      record("BrtFmlaString", concatUint8Arrays([head, encodeWideString(value), flags, formula]))
    ];
  }
  return [
    record(
      "BrtFmlaNum",
      concatUint8Arrays([
        head,
        new BinaryWriter().writeFloat64(typeof value === "number" ? value : 0).toUint8Array(),
        flags,
        formula
      ])
    )
  ];
}

/** Whether a cell value is an error, which the model nests inside `value`. */
function isErrorValue(value: unknown): value is { readonly error: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { error?: unknown }).error === "string"
  );
}

/**
 * Whether a cell value is a rich-text list.
 *
 * Checked structurally rather than by `CellModel.type`: a rich-text cell built through `Cell.setValue` arrives
 * with `type` set to `String` and the runs nested inside `value`, which is the same reason the rest of this
 * module reads shapes instead of the discriminant.
 */
function isRichText(value: unknown): value is { readonly richText: readonly RichTextRun[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { richText?: unknown }).richText) &&
    (value as { richText: unknown[] }).richText.length > 0
  );
}

/**
 * What this writer can express from a cell.
 *
 * Deliberately narrow. A cell whose content needs a record this writer does not emit
 * becomes a blank rather than an approximation: writing a formula's cached result as a
 * plain number would produce a file that opens, looks right, and silently stops
 * recalculating. The cell still exists, so its position survives, and `unsupportedKind`
 * reports what was lost.
 */
export function writableValue(cell: CellLike): CellValue {
  if (unsupportedKind(cell) !== undefined) {
    return null;
  }
  // A formula cell's model value is undefined and its cached result lives in `result`. **A cell that follows
  // a shared formula is one of these too**: it has no `formula` of its own, only `sharedFormula`, so the test
  // below missed it and every follower was written with a cached value of zero — the formula came back right
  // and the numbers came back as nought.
  if (cell.formula !== undefined || cell.sharedFormula !== undefined) {
    const result = cell.result;
    // `Date` belongs here. Dropping it to null made the cell write a cached zero, which reads back
    // as 1899-12-30 — a formula whose answer is a date came back as the epoch, silently. The date
    // is the same serial a literal date cell writes, so nothing new is needed to express it.
    if (
      result === null ||
      result === undefined ||
      typeof result === "number" ||
      typeof result === "boolean" ||
      typeof result === "string" ||
      result instanceof Date
    ) {
      return (result ?? null) as CellValue;
    }
    // **A cached error passes through, in the same `{ error }` shape a literal error cell uses.**
    //
    // It was flattened to `null` here, so `encodeFormulaCell` saw nothing and wrote `BrtFmlaNum` 0 — the silent
    // corruption `verify:xlsb-corpus` found on `poi-bug66682`. Only errors with a `BErr` code are let through; the
    // dynamic-array family still becomes `null` and is reported by `formulaCachedResultLoss`, because there is no
    // byte to write for it.
    if (isErrorValue(result) && errorCodeOf(result.error) !== undefined) {
      return result as CellValue;
    }
    return null;
  }
  // A hyperlink cell carries `text` and `hyperlink` as *siblings* and leaves `value` empty. The text is
  // the cell's content; the destination is a separate `BrtHLink` and an external relationship. Reading
  // `value` alone therefore wrote the cell blank — which is what the first version of this did, and the
  // link beside it was correct, so the cell came back labelled with its own URL.
  if (cell.hyperlink !== undefined) {
    // `text` may legitimately be `""` — `hyperlink-without-text.xlsx` in the fixtures is exactly that,
    // a `mailto:` link on a cell with no label. Requiring a non-empty string turned such a cell into a
    // blank whose loss nothing reported, which the differential caught on the first run after this
    // feature landed.
    return typeof cell.text === "string" ? cell.text : null;
  }
  const value = cell.value;
  return value === undefined ? null : (value as CellValue);
}

/**
 * What a hyperlink cell loses even though the link itself is written.
 *
 * A link with no label. The record and the relationship both survive, so the destination is intact — but
 * the cell model only classifies a value as a hyperlink when it carries non-empty text, so reading it back
 * has to put *something* there and the only honest choice is the destination. The link works and what it
 * displays changed, which is a loss worth naming: `hyperlink-without-text.xlsx` in the fixtures is a
 * `mailto:` on an unlabelled cell, and it is how this was found.
 */
export function hyperlinkLabelLoss(cell: CellLike): string | undefined {
  return cell.hyperlink !== undefined && cell.text === "" ? "hyperlink display text" : undefined;
}

/**
 * What a formula cell loses even though the formula itself is written.
 *
 * Distinct from `unsupportedKind`, and the distinction decides whether the cell survives. A cached
 * result this writer cannot express is **not** a reason to drop the formula: Excel recalculates on
 * open, so a formula with a stale cached zero displays correctly, while a blank cell has lost the
 * expression for good. The loss is real all the same — a consumer that reads the file without
 * recalculating, which includes this library's own reader, sees `0` where an error belongs — so it is
 * reported rather than left silent.
 *
 * **Narrowed, because `BrtFmlaError` is written now.** This used to report every cached error, on the reasoning that
 * "no workbook in the reference corpus contains a single `BrtCellError` or `BrtFmlaError`, so the mapping from
 * `#DIV/0!` to a code is unobserved". That was true of the nine-file corpus; the current twenty-three hold five
 * `BrtFmlaError` records between `poi-bug66682` and `poi-testVarious`, carrying `#DIV/0!`, `#REF!`, `#NAME?` and
 * `#N/A` — four distinct codes, all in the half of the `BErr` table Excel's own bytes confirm.
 *
 * What is still a loss is an error with no `BErr` value: the dynamic-array family (`#SPILL!`, `#CALC!`) postdates the
 * enumeration, and substituting `#VALUE!` for one would be a different error rather than a reported loss.
 */
export function formulaCachedResultLoss(cell: CellLike): string | undefined {
  if (cell.formula === undefined) {
    return undefined;
  }
  const result = cell.result;
  if (
    result === null ||
    result === undefined ||
    typeof result === "number" ||
    typeof result === "boolean" ||
    typeof result === "string" ||
    result instanceof Date
  ) {
    return undefined;
  }
  const error = (result as Record<string, unknown>).error;
  if (error !== undefined) {
    // Written now, when it is one of the eight `BErr` values — see `encodeFormulaCell`. What remains a loss is an
    // error with no code at all (`#SPILL!`, `#CALC!`), which postdates the enumeration.
    return typeof error === "string" && errorCodeOf(error) !== undefined
      ? undefined
      : "formula cached error";
  }
  return "formula cached value";
}

/**
 * Name of the feature a cell needs and this writer lacks, or `undefined`.
 *
 * Classified by the shape of what the model actually holds, not by `CellModel.type`.
 * That is not laziness: a rich-text cell built through `Cell.setValue` arrives with
 * `type` set to `String` and the runs nested inside `value`, so the discriminant does not
 * discriminate. The shapes below were read off the model rather than assumed — a formula
 * sits in a sibling field with no `value` at all, while an error and rich text are both
 * objects *inside* `value`.
 */
export function unsupportedKind(cell: CellLike): string | undefined {
  // A shared formula is no longer a loss. The claim here was that `PtgExp` "needs the master's address —
  // information the flat cell model does not carry", and the model carries exactly that: `sharedFormula` *is*
  // the master's address. `followerCell` encodes it, and the master's own record is followed by a
  // `BrtShrFmla` holding the expression.

  // A hyperlink is no longer a loss: `BrtHLink` carries the range and a relationship id, and the sheet's
  // `.rels` carries the destination. It is written separately from the cell — the cell keeps its text —
  // so nothing about the *value* is unsupported here.
  // An array formula is no longer a loss either. The claim was that `BrtArrFmla` "does not appear in any
  // reference workbook, so its layout is not established" — true of the nine-workbook corpus that sentence
  // was written against, and not of the current one: `poi-bug66682.xlsb` carries a `BrtArrFmla` and
  // `poi-62815.xlsb` four `BrtShrFmla`, and both close to the byte against the specification's field lists.
  // See `sharedRange` for what is written.
  //
  // A `shareType` with no `ref` still cannot be written, because the range is the one thing the record exists
  // to state and narrowing it to a single cell would silently shrink an author's spill.
  if (cell.shareType !== undefined && cell.ref === undefined) {
    return "array formula without a range";
  }
  if (cell.isDynamicArray === true) {
    return "dynamic array formula";
  }
  // The value of a shared-string cell is an index into the string table, not a number. Passing it
  // through the numeric path writes the index as the cell's content — a plausible-looking small
  // integer where text belongs.
  if (cell.type === ValueType.SharedString && typeof cell.value === "number") {
    return "shared string index";
  }
  const value = cell.value;
  if (
    value === null ||
    value === undefined ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    value instanceof Date
  ) {
    return undefined;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    // An error value is written now: `BErr` (MS-XLSB 2.5.98.2) is an eight-value table and Excel's own bytes
    // confirm four of them — see `error-values.ts`. What is still refused is an error text with no `BErr` at
    // all, which is the dynamic-array family (`#SPILL!`, `#CALC!`): those postdate the enumeration, and
    // substituting `#VALUE!` for one would be a different error rather than a reported loss.
    if (record.error !== undefined) {
      return typeof record.error === "string" && errorCodeOf(record.error) !== undefined
        ? undefined
        : `error value ${typeof record.error === "string" ? record.error : ""}`.trim();
    }
    // Rich text is no longer a loss: a `RichStr` in the shared-string table carries the runs, and each run's
    // font is interned into the same collection a cell format's font goes to — see `SharedStringTable.internRich`.
    // The one case left is a list with no runs at all, which has neither text nor formatting to write.
    if (record.richText !== undefined) {
      return Array.isArray(record.richText) && record.richText.length > 0
        ? undefined
        : "rich text with no runs";
    }
    if (record.formula !== undefined) {
      return "formula";
    }
    if (record.hyperlink !== undefined) {
      return "hyperlink";
    }
  }
  return "cell value";
}

/**
 * A cell's number format as a format string.
 *
 * `Style.numFmt` is either the format code or the `{ id, formatCode }` pair `styles.xml`
 * carries, and only the code is meaningful here: an XLSX numbering id does not survive into
 * BIFF12, where the writer allocates its own.
 */
export function numberFormatOf(cell: CellLike): string | undefined {
  const numFmt = cell.style?.numFmt;
  if (typeof numFmt === "string") {
    return numFmt;
  }
  return typeof numFmt?.formatCode === "string" ? numFmt.formatCode : undefined;
}

/**
 * The sheet's used range, as `BrtWsDim` states it.
 *
 * `extra` widens the result with regions that occupy the grid without contributing cell records — a pivot table's
 * output being the case that matters. Excel writes a real extent for such a sheet (21 of 21 `BrtWsDim` records across
 * the reference workbooks, none of them `0..0`), while deriving the range from rows alone reported an empty sheet for
 * the three pivot sheets in `05-pivots`: nothing had written a cell there, because the body is Excel's to render.
 *
 * Note what this does *not* claim to reproduce. Excel's extent for those sheets is the range after a refresh, which is
 * larger than the pivot table's declared `location` and is not derivable from the file — so the anchor is what gets
 * used, and the result is honest about the sheet being occupied without pretending to know how far.
 */
export function usedRange(rows: readonly SheetRow[], extra: readonly BiffRange[] = []): BiffRange {
  let firstRow = Number.POSITIVE_INFINITY;
  let lastRow = 0;
  let firstColumn = Number.POSITIVE_INFINITY;
  let lastColumn = 0;
  for (const region of extra) {
    firstRow = Math.min(firstRow, region.firstRow);
    lastRow = Math.max(lastRow, region.lastRow);
    firstColumn = Math.min(firstColumn, region.firstColumn);
    lastColumn = Math.max(lastColumn, region.lastColumn);
  }
  for (const row of rows) {
    firstRow = Math.min(firstRow, row.row);
    lastRow = Math.max(lastRow, row.row);
    for (const cell of row.cells) {
      firstColumn = Math.min(firstColumn, cell.column);
      lastColumn = Math.max(lastColumn, cell.column);
    }
  }
  return Number.isFinite(firstRow)
    ? {
        firstRow,
        lastRow,
        firstColumn: Number.isFinite(firstColumn) ? firstColumn : 0,
        lastColumn: Number.isFinite(firstColumn) ? lastColumn : 0
      }
    : { firstRow: 0, lastRow: 0, firstColumn: 0, lastColumn: 0 };
}

/**
 * A number as the smallest record that holds it exactly: `BrtCellRk` when `RkNumber` can, `BrtCellReal`
 * otherwise.
 *
 * `encodeRk` returns undefined rather than rounding, so this cannot silently change a value to save four
 * bytes. Shared with the date branch, because a date is a serial number and there is no reason for it to be
 * spelled less compactly than the same number typed by hand.
 */
function numericCell(head: Uint8Array, value: number): Emitted {
  const compressed = encodeRk(value);
  return compressed === undefined
    ? record(
        "BrtCellReal",
        concatUint8Arrays([head, new BinaryWriter().writeFloat64(value).toUint8Array()])
      )
    : record(
        "BrtCellRk",
        concatUint8Arrays([head, new BinaryWriter().writeUint32(compressed).toUint8Array()])
      );
}

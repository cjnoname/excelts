/**
 * Data validation: `BrtDVal` inside a `BrtBeginDVals` scope.
 *
 * The record is four parts, three of them variable-length, and the specification (MS-XLSB 2.4.356) is
 * complete about all of them:
 *
 * ```text
 * flags        4 bytes, ten packed fields
 * sqrfx        UncheckedSqRfX  — crfx (signed!) then crfx × 16-byte range
 * DValStrings  four XLNullableWideString: errorTitle, error, promptTitle, prompt
 * formula1     DVParsedFormula — cce, tokens, cb, rgcb
 * formula2     DVParsedFormula
 * ```
 *
 * Two details in there are easy to get backwards, and both are silent:
 *
 * - **`DValStrings` puts the *error* pair first.** `strErrorTitle`, `strError`, `strPromptTitle`,
 *   `strPrompt` — not the prompt-then-error order the XLSX attribute list suggests, and not the order
 *   the model's own field declarations happen to sit in. Getting it wrong swaps a validation's tooltip
 *   with its error message, which no round trip through this library would notice.
 * - **`crfx` is signed.** `-1` means the range array is null and `0` means it is empty, which is why
 *   this reads it as an `i32` and treats a negative count as "no ranges" rather than as 4,294,967,295
 *   of them. `BrtDVal` additionally requires at least one range and fewer than 8,192.
 *
 * No corpus workbook contains a `BrtDVal`, so none of this is read off Excel's own bytes. The flag
 * layout, the string order and the two enumerations are the specification's; what is *not* verified is
 * that Excel accepts what this produces, and a round trip cannot tell — the reader and the writer would
 * agree with each other while both disagreed with Excel. The tests therefore assert the byte layout
 * field by field against the specification rather than only reading back what was written.
 */
import type { DataValidationOperator, DataValidationRule } from "@excel/types";
import { encodeRange as encodeReference } from "@excel/utils/address";
import {
  encodeNullableWideString,
  encodeRange,
  readNullableWideString,
  readRange,
  tryDecodeRange,
  type BiffRange
} from "@excel/xlsb/binary";
import {
  decodePtg,
  encodeParsedFormula,
  encodePtg,
  type PtgContext
} from "@excel/xlsb/formula/ptg";
import { parse } from "@formula/syntax/parser";
import { printAst } from "@formula/syntax/print";
import { tokenize } from "@formula/syntax/tokenizer";
import { BinaryReader, BinaryWriter, concatUint8Arrays } from "@utils/binary";

/** `valType`, MS-XLSB 2.4.356. The model's names for the same eight kinds. */
const VALIDATION_TYPE = [
  "any",
  "whole",
  "decimal",
  "list",
  "date",
  "time",
  "textLength",
  "custom"
] as const;

/** `typOperator`. The order is the record's, not alphabetical. */
const OPERATOR: readonly DataValidationOperator[] = [
  "between",
  "notBetween",
  "equal",
  "notEqual",
  "greaterThan",
  "lessThan",
  "greaterThanOrEqual",
  "lessThanOrEqual"
];

/** `errStyle`. */
const ERROR_STYLE = ["stop", "warning", "information"] as const;

/** A validation and the ranges it covers. */
export interface SheetValidation {
  /** Ranges the rule applies to, as `A1`-style references. At least one, or the record is invalid. */
  readonly ranges: readonly string[];
  readonly rule: DataValidationRule;
}

/**
 * Serialise a `BrtDVal`, or return `undefined` when the rule cannot be expressed.
 *
 * A formula this library cannot tokenise is the one real failure mode, and it returns rather than
 * throws so the caller can report the validation as lost and still write the sheet. Losing one
 * validation is better than losing the workbook.
 */
export function encodeValidation(
  validation: SheetValidation,
  context: PtgContext,
  where: string
): Uint8Array | undefined {
  const rule = validation.rule;
  const type = VALIDATION_TYPE.indexOf(rule.type as (typeof VALIDATION_TYPE)[number]);
  if (type < 0) {
    return undefined;
  }
  const ranges = validation.ranges
    .map(reference => tryDecodeRange(reference))
    .filter((range): range is BiffRange => range !== undefined);
  if (ranges.length === 0) {
    // `BrtDVal` requires `crfx >= 1`. A rule covering nothing is not a rule.
    return undefined;
  }

  const withFormulae = rule.type === "any" ? undefined : rule;
  const formulae = withFormulae?.formulae ?? [];
  // `typOperator` is undefined for `any`, `list` and `custom` — the specification says so and says it
  // MUST be ignored — so writing an operator there would be writing into a field nothing reads.
  const usesOperator = rule.type !== "any" && rule.type !== "list" && rule.type !== "custom";
  const operator = usesOperator
    ? Math.max(0, OPERATOR.indexOf(withFormulae?.operator ?? "between"))
    : 0;

  let flags = type & 0x0f;
  flags |= (Math.max(0, ERROR_STYLE.indexOf(errorStyleName(rule.errorStyle))) & 0x07) << 4;
  // Bit 7 is `unused` and MUST be ignored, so it stays 0 rather than being folded into anything.
  flags |= rule.allowBlank ? 1 << 8 : 0;
  // `fSuppressCombo` only means anything for a list. The model expresses the same idea as
  // `showDropDown`, and — this is the trap — it is inverted: XLSX's `showDropDown="1"` *suppresses* the
  // dropdown, which is why the attribute is famously misread. The model follows XLSX, so the bit is a
  // straight copy rather than a negation.
  flags |= suppressCombo(rule) ? 1 << 9 : 0;
  // `mdImeMode` occupies bits 10–17. The model carries no IME mode, so it is "no control".
  flags |= rule.showInputMessage ? 1 << 18 : 0;
  flags |= rule.showErrorMessage ? 1 << 19 : 0;
  flags |= (operator & 0x0f) << 20;
  // Bits 24–31 are `reserved` and MUST be 0.

  const head = new BinaryWriter().writeUint32(flags >>> 0);
  // `crfx` is signed, and the count comes before the ranges.
  head.writeInt32(ranges.length);
  const strings = [rule.errorTitle, rule.error, rule.promptTitle, rule.prompt].map(value =>
    encodeNullableWideString(value === "" ? undefined : value)
  );

  const first = encodeFormulaField(formulae[0], rule.type, context, `${where} formula1`);
  // `formula2` is only read when the operator takes two bounds. The specification requires `cce` to be
  // 0 otherwise, so an unused second formula is an empty one rather than a copy of the first.
  const second =
    usesOperator && (operator === 0 || operator === 1)
      ? encodeFormulaField(formulae[1], rule.type, context, `${where} formula2`)
      : encodeParsedFormula(new Uint8Array(0));
  if (first === undefined || second === undefined) {
    return undefined;
  }

  return concatUint8Arrays([
    head.toUint8Array(),
    ...ranges.map(range => encodeRange(range)),
    ...strings,
    first,
    second
  ]);
}

/**
 * Read a `BrtDVal`, or `undefined` when the payload does not decode.
 *
 * The formulae are decoded back to text through the same `decodePtg`/`printAst` pair the cell reader
 * uses. An earlier version of this returned `formulae: []` and reported the bounds as unreadable, on the
 * grounds that reversing a token stream was out of reach — it was not: the decoder already existed for
 * cell formulas, and the reason to reach for it here is that a validation with no bounds is *worse* than
 * a missing one. `{ type: "whole", operator: "between", formulae: [] }` is a rule Excel accepts every
 * entry against, so a reader that produces it has quietly turned a constraint off.
 */
export function readValidation(
  payload: Uint8Array,
  part: string,
  context: PtgContext = {}
): SheetValidation | undefined {
  try {
    const reader = new BinaryReader(payload, 0, part);
    const flags = reader.readUint32();
    const type = VALIDATION_TYPE[flags & 0x0f];
    if (type === undefined) {
      return undefined;
    }
    const count = reader.readInt32();
    if (count < 1 || count >= 8192) {
      // `-1` is the specification's "null array" and `0` its "empty"; `BrtDVal` permits neither.
      return undefined;
    }
    const ranges: string[] = [];
    for (let index = 0; index < count; index++) {
      ranges.push(rangeReference(readRange(reader)));
    }
    const operatorIndex = (flags >>> 20) & 0x0f;
    const errorTitle = readNullableWideString(reader, part);
    const error = readNullableWideString(reader, part);
    const promptTitle = readNullableWideString(reader, part);
    const prompt = readNullableWideString(reader, part);

    const base = {
      ...(errorTitle === undefined ? {} : { errorTitle }),
      ...(error === undefined ? {} : { error }),
      ...(promptTitle === undefined ? {} : { promptTitle }),
      ...(prompt === undefined ? {} : { prompt }),
      ...((flags >>> 8) & 1 ? { allowBlank: true } : {}),
      ...((flags >>> 18) & 1 ? { showInputMessage: true } : {}),
      ...((flags >>> 19) & 1 ? { showErrorMessage: true } : {}),
      errorStyle: ERROR_STYLE[(flags >>> 4) & 0x07] ?? "stop"
    };

    if (type === "any") {
      // `formula1.cce` MUST be 0 for `any`, so there is nothing after the strings to read.
      return { ranges, rule: { type: "any", ...base } };
    }

    const first = readFormulaField(reader, part, context);
    const second = readFormulaField(reader, part, context);
    const formulae = [first, second].filter((value): value is string => value !== undefined);
    // `typOperator` is undefined for a list and a custom rule — the specification says to ignore it —
    // so reading one there would invent a constraint the record does not express.
    const usesOperator = type !== "list" && type !== "custom";

    return {
      ranges,
      rule: {
        // `time` has no model counterpart; a time bound is a fraction of a day, which is what a date
        // bound already is, so it maps to `date` rather than being dropped.
        type: type === "time" ? "date" : type,
        formulae,
        ...(usesOperator ? { operator: OPERATOR[operatorIndex] ?? "between" } : {}),
        ...base
      } as DataValidationRule
    };
  } catch {
    return undefined;
  }
}

/**
 * One `DVParsedFormula` back to text, or `undefined` when it is empty or does not decode.
 *
 * An empty `cce` is the specification's way of saying a formula is absent — the second bound of a
 * one-sided comparison, or either bound of an `any` rule — so it is a normal outcome and not a failure.
 */
function readFormulaField(
  reader: BinaryReader,
  part: string,
  context: PtgContext
): string | undefined {
  const length = reader.readUint32();
  const tokens = reader.readBytes(length);
  // `rgcb`, the ancillary block. Consumed so that the second formula starts at the right offset —
  // skipping it made `formula2` read `formula1`'s trailer as its own token count.
  reader.readBytes(reader.readUint32());
  if (length === 0) {
    return undefined;
  }
  const decoded = decodePtg(tokens, context, `${part} data validation formula`);
  if ("sharedRow" in decoded) {
    // `DVParsedFormula` may not contain `PtgExp`, so this is a malformed record rather than a shared
    // formula. Reported as an unreadable bound instead of being turned into a reference.
    return undefined;
  }
  return printAst(decoded);
}

/**
 * One `DVParsedFormula`.
 *
 * A model formula is `string | number | Date`, and the three take different routes: a number and a date
 * are literals, a string starting `=` is an expression, and a bare string is a literal too — except for
 * a list, where `"a,b"` is the list itself and has to reach the record as a string token rather than as
 * a reference to a range called `a,b`.
 */
function encodeFormulaField(
  formula: string | number | Date | undefined,
  type: DataValidationRule["type"],
  context: PtgContext,
  where: string
): Uint8Array | undefined {
  if (formula === undefined) {
    return encodeParsedFormula(new Uint8Array(0));
  }
  const text = formulaText(formula, type);
  if (text === undefined) {
    return undefined;
  }
  try {
    return encodeParsedFormula(encodePtg(parse(tokenize(text)), context, where));
  } catch {
    // A formula this library cannot tokenise. Reported by the caller as a lost validation.
    return undefined;
  }
}

/** The expression text for a model formula value. */
function formulaText(
  formula: string | number | Date,
  type: DataValidationRule["type"]
): string | undefined {
  if (typeof formula === "number") {
    return String(formula);
  }
  if (formula instanceof Date) {
    // A date bound is a serial number in the record, the same as a date cell's value.
    return String(excelSerial(formula));
  }
  const trimmed = formula.startsWith("=") ? formula.slice(1) : formula;
  if (trimmed === "") {
    return undefined;
  }
  // An explicitly quoted list — `'"a,b"'` — is already a string literal and tokenises as one.
  return trimmed;
}

/** Days since the 1900 epoch, matching how a date cell's value is stored. */
function excelSerial(date: Date): number {
  return date.getTime() / 86_400_000 + 25_569;
}

function errorStyleName(value: string | undefined): (typeof ERROR_STYLE)[number] {
  return value === "warning" || value === "information" ? value : "stop";
}

/** `fSuppressCombo`, which only a list uses. */
function suppressCombo(rule: DataValidationRule): boolean {
  return rule.type === "list" && (rule as { showDropDown?: boolean }).showDropDown === true;
}

/**
 * A `BiffRange` back to an `A1:B2` reference.
 *
 * Through `@excel/utils/address` rather than a local column-letter loop: that module already collapses a
 * single-cell range to one address and already handles the base-26 carry that makes `AA` follow `Z`, and
 * a second implementation of it here would be a second place for the carry to be wrong.
 */
function rangeReference(range: BiffRange): string {
  return encodeReference(
    { r: range.firstRow, c: range.firstColumn },
    { r: range.lastRow, c: range.lastColumn }
  );
}

/**
 * `BrtBeginDVals` — a `DVals`, MS-XLSB 2.5.36. Eighteen bytes.
 *
 * ```text
 * fWnClosed … reserved  u16   input prompts disabled for the sheet
 * xLeft                 u32   where the prompt window sits, in pixels
 * yTop                  u32
 * unused3               u32
 * idvMac                u32   how many `BrtDVal` records follow
 * ```
 *
 * The position is zeroed rather than invented: it is where the *application* last put the prompt window, which
 * a file being written has no opinion about, and Excel writes zeros for it too.
 */
export function dataValidationHeader(count: number): Uint8Array {
  return new BinaryWriter()
    .writeUint16(0) // fWnClosed and its reserved bits: prompts are enabled
    .writeUint32(0) // xLeft
    .writeUint32(0) // yTop
    .writeUint32(0) // unused3
    .writeUint32(Math.max(0, Math.trunc(count)))
    .toUint8Array();
}

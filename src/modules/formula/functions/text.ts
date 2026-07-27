/**
 * Text Functions — Native RuntimeValue implementations.
 */

import { argToNumber, checkError, excelWildcardToRegex } from "@formula/functions/_shared";
import type { FunctionRuntimeContext } from "@formula/runtime/function-context";
import { DEFAULT_FUNCTION_CONTEXT } from "@formula/runtime/function-context";
import type { RuntimeValue, ScalarValue, ErrorValue } from "@formula/runtime/values";
import {
  RVKind,
  ERRORS,
  isError,
  isArray,
  toNumberRV,
  toStringRV,
  toBooleanRV,
  topLeft,
  rvNumber,
  rvString,
  rvBoolean,
  rvArray
} from "@formula/runtime/values";
import { excelToDate } from "@utils/utils.base";

// ============================================================================
// Local utility
// ============================================================================

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Type alias for a native text function. */
type NativeFn = (args: RuntimeValue[]) => RuntimeValue;

// ============================================================================
// CONCATENATE / CONCAT
// ============================================================================

export function fnCONCATENATE(args: RuntimeValue[]): RuntimeValue {
  const parts: string[] = [];
  for (const a of args) {
    if (isArray(a)) {
      for (const row of a.rows) {
        for (const cell of row) {
          const err = checkError(cell);
          if (err) {
            return err;
          }
          parts.push(toStringRV(cell));
        }
      }
    } else {
      const err = checkError(a);
      if (err) {
        return err;
      }
      parts.push(toStringRV(a));
    }
  }
  return rvString(parts.join(""));
}

// CONCAT has the same semantics as CONCATENATE
export const fnCONCAT: NativeFn = fnCONCATENATE;

// ============================================================================
// TEXTJOIN
// ============================================================================

export function fnTEXTJOIN(args: RuntimeValue[]): RuntimeValue {
  if (args.length < 3) {
    return ERRORS.VALUE;
  }
  const e0 = checkError(args[0]);
  if (e0) {
    return e0;
  }
  const delimiter = toStringRV(topLeft(args[0]));
  const ignoreEmptyRV = toBooleanRV(topLeft(args[1]));
  if (isError(ignoreEmptyRV)) {
    return ignoreEmptyRV;
  }
  const ignoreEmpty = ignoreEmptyRV.value;
  const parts: string[] = [];
  for (let i = 2; i < args.length; i++) {
    const a = args[i];
    if (isArray(a)) {
      for (const row of a.rows) {
        for (const cell of row) {
          const err = checkError(cell);
          if (err) {
            return err;
          }
          const s = toStringRV(cell);
          if (ignoreEmpty && s === "") {
            continue;
          }
          parts.push(s);
        }
      }
    } else {
      const err = checkError(a);
      if (err) {
        return err;
      }
      const s = toStringRV(a);
      if (ignoreEmpty && s === "") {
        continue;
      }
      parts.push(s);
    }
  }
  return rvString(parts.join(delimiter));
}

// ============================================================================
// LEFT / RIGHT / MID / LEN
// ============================================================================

export function fnLEFT(args: RuntimeValue[]): RuntimeValue {
  const err = checkError(args[0]);
  if (err) {
    return err;
  }
  // Implicit intersection on the text arg (see MID for rationale).
  const text = toStringRV(topLeft(args[0]));
  let n: number;
  if (args.length > 1) {
    // Use `argToNumber` so array arguments get implicit-intersection to
    // their top-left cell before numeric coercion — otherwise
    // `LEFT("abc", A1:A2)` would land in `toNumberRV`'s array path and
    // incorrectly surface #VALUE! instead of using A1.
    const nRV = argToNumber(args[1]);
    if (isError(nRV)) {
      return nRV;
    }
    n = nRV.value;
  } else {
    n = 1;
  }
  // Excel rejects negative lengths outright. Without this guard,
  // `text.slice(0, -1)` would silently trim the last character.
  if (n < 0) {
    return ERRORS.VALUE;
  }
  return rvString(text.slice(0, Math.trunc(n)));
}

export function fnRIGHT(args: RuntimeValue[]): RuntimeValue {
  const err = checkError(args[0]);
  if (err) {
    return err;
  }
  const text = toStringRV(topLeft(args[0]));
  let n: number;
  if (args.length > 1) {
    // Implicit intersection via `argToNumber` — see LEFT for rationale.
    const nRV = argToNumber(args[1]);
    if (isError(nRV)) {
      return nRV;
    }
    n = nRV.value;
  } else {
    n = 1;
  }
  if (n < 0) {
    return ERRORS.VALUE;
  }
  const k = Math.trunc(n);
  if (k === 0) {
    return rvString("");
  }
  return rvString(text.slice(-k));
}

export function fnMID(args: RuntimeValue[]): RuntimeValue {
  const err = checkError(args[0]);
  if (err) {
    return err;
  }
  // Implicit intersection on the text arg — without topLeft, passing
  // an array would route through `toStringRV`'s default branch and
  // silently return the empty string, making `MID(A1:A2, 1, 3)` look
  // like an empty cell instead of a 3-char prefix of the first cell.
  const text = toStringRV(topLeft(args[0]));
  const startNumRV = argToNumber(args[1]);
  if (isError(startNumRV)) {
    return startNumRV;
  }
  const startNum = Math.trunc(startNumRV.value);
  const numCharsRV = argToNumber(args[2]);
  if (isError(numCharsRV)) {
    return numCharsRV;
  }
  const numChars = Math.trunc(numCharsRV.value);
  // MID: start_num must be >= 1, num_chars must be >= 0.
  if (startNum < 1 || numChars < 0) {
    return ERRORS.VALUE;
  }
  return rvString(text.slice(startNum - 1, startNum - 1 + numChars));
}

export function fnLEN(args: RuntimeValue[]): RuntimeValue {
  const err = checkError(args[0]);
  if (err) {
    return err;
  }
  // `toStringRV` doesn't dereference arrays — passing `A1:A2` would hit
  // its `default: ""` branch and silently return 0. Do an implicit
  // intersection via `topLeft` so `LEN(A1:A2)` behaves like Excel's
  // legacy implicit-intersection semantics (pick the first cell).
  return rvNumber(toStringRV(topLeft(args[0])).length);
}

// ============================================================================
// TRIM / LOWER / UPPER / PROPER
// ============================================================================

export function fnTRIM(args: RuntimeValue[]): RuntimeValue {
  const err = checkError(args[0]);
  if (err) {
    return err;
  }
  // Implicit intersection: turn an array argument into its top-left
  // cell before stringifying, to match Excel's legacy behaviour.
  // Excel's TRIM only collapses plain ASCII space (U+0020), NOT tabs,
  // newlines, or non-breaking space (U+00A0).
  return rvString(
    toStringRV(topLeft(args[0]))
      .replace(/^ +| +$/g, "")
      .replace(/ +/g, " ")
  );
}

export function fnLOWER(args: RuntimeValue[]): RuntimeValue {
  const err = checkError(args[0]);
  if (err) {
    return err;
  }
  return rvString(toStringRV(topLeft(args[0])).toLowerCase());
}

export function fnUPPER(args: RuntimeValue[]): RuntimeValue {
  const err = checkError(args[0]);
  if (err) {
    return err;
  }
  return rvString(toStringRV(topLeft(args[0])).toUpperCase());
}

export function fnPROPER(args: RuntimeValue[]): RuntimeValue {
  const err = checkError(args[0]);
  if (err) {
    return err;
  }
  return rvString(
    toStringRV(topLeft(args[0])).replace(
      /\p{L}+/gu,
      word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
    )
  );
}

// ============================================================================
// SUBSTITUTE / REPLACE
// ============================================================================

export function fnSUBSTITUTE(args: RuntimeValue[]): RuntimeValue {
  const err0 = checkError(args[0]);
  if (err0) {
    return err0;
  }
  const err1 = checkError(args[1]);
  if (err1) {
    return err1;
  }
  const err2 = checkError(args[2]);
  if (err2) {
    return err2;
  }
  const text = toStringRV(topLeft(args[0]));
  const oldText = toStringRV(topLeft(args[1]));
  const newText = toStringRV(topLeft(args[2]));
  // An empty old_text is a no-op in Excel. Without this guard we would
  // `"abc".split("").join(newText)` and insert newText between every
  // character, and the regex path would match empty strings infinitely.
  if (oldText === "") {
    return rvString(text);
  }
  if (args.length > 3) {
    const instanceNumRV = toNumberRV(topLeft(args[3]));
    if (isError(instanceNumRV)) {
      return instanceNumRV;
    }
    // Excel requires a positive integer; zero, negative, or non-numeric
    // values are #VALUE!. Previously we let the replace pass silently
    // no-op (since `count === 0` never matched), masking caller bugs.
    if (!Number.isFinite(instanceNumRV.value) || instanceNumRV.value < 1) {
      return ERRORS.VALUE;
    }
    const instanceNum = Math.trunc(instanceNumRV.value);
    let count = 0;
    return rvString(
      text.replace(new RegExp(escapeRegex(oldText), "g"), match => {
        count++;
        return count === instanceNum ? newText : match;
      })
    );
  }
  return rvString(text.split(oldText).join(newText));
}

export function fnREPLACE(args: RuntimeValue[]): RuntimeValue {
  const err = checkError(args[0]);
  if (err) {
    return err;
  }
  const text = toStringRV(topLeft(args[0]));
  // Implicit intersection on the numeric arguments — see LEFT.
  const startNumRV = argToNumber(args[1]);
  if (isError(startNumRV)) {
    return startNumRV;
  }
  const startNum = Math.trunc(startNumRV.value);
  const numCharsRV = argToNumber(args[2]);
  if (isError(numCharsRV)) {
    return numCharsRV;
  }
  const numChars = Math.trunc(numCharsRV.value);
  // REPLACE: start_num >= 1, num_chars >= 0. Without this check, negative
  // start_num becomes a slice with negative index and silently trims from
  // the right, which does not match Excel's #VALUE! result.
  if (startNum < 1 || numChars < 0) {
    return ERRORS.VALUE;
  }
  const e3 = checkError(args[3]);
  if (e3) {
    return e3;
  }
  const newText = toStringRV(topLeft(args[3]));
  return rvString(text.slice(0, startNum - 1) + newText + text.slice(startNum - 1 + numChars));
}

// ============================================================================
// FIND / SEARCH
// ============================================================================

export function fnFIND(args: RuntimeValue[]): RuntimeValue {
  const err0 = checkError(args[0]);
  if (err0) {
    return err0;
  }
  const err1 = checkError(args[1]);
  if (err1) {
    return err1;
  }
  // Implicit intersection on text args so arrays collapse to top-left.
  const findText = toStringRV(topLeft(args[0]));
  const withinText = toStringRV(topLeft(args[1]));
  let startNum: number;
  if (args.length > 2) {
    // Implicit intersection so an array supplied as start_num collapses
    // to its top-left cell — matches Excel and the other text family.
    const startNumRV = argToNumber(args[2]);
    if (isError(startNumRV)) {
      return startNumRV;
    }
    startNum = Math.trunc(startNumRV.value);
  } else {
    startNum = 1;
  }
  // Excel's FIND rejects start_num outside [1, length(withinText)].
  if (startNum < 1 || startNum > withinText.length + 1) {
    return ERRORS.VALUE;
  }
  const idx = withinText.indexOf(findText, startNum - 1);
  return idx === -1 ? ERRORS.VALUE : rvNumber(idx + 1);
}

export function fnSEARCH(args: RuntimeValue[]): RuntimeValue {
  const err0 = checkError(args[0]);
  if (err0) {
    return err0;
  }
  const err1 = checkError(args[1]);
  if (err1) {
    return err1;
  }
  // Implicit intersection on text args (see FIND for rationale).
  let findText = toStringRV(topLeft(args[0]));
  const withinText = toStringRV(topLeft(args[1]));
  let startNum: number;
  if (args.length > 2) {
    const startNumRV = argToNumber(args[2]);
    if (isError(startNumRV)) {
      return startNumRV;
    }
    startNum = Math.trunc(startNumRV.value);
  } else {
    startNum = 1;
  }
  if (startNum < 1 || startNum > withinText.length + 1) {
    return ERRORS.VALUE;
  }
  // Use the shared Excel-wildcard → regex converter so SEARCH, MATCH,
  // XLOOKUP, and SUMIF/COUNTIF agree on escape semantics (`~*`, `~?`, `~~`).
  const pattern = excelWildcardToRegex(findText);
  try {
    const re = new RegExp(pattern, "i");
    const sub = withinText.slice(startNum - 1);
    const match = re.exec(sub);
    return match ? rvNumber(match.index + startNum) : ERRORS.VALUE;
  } catch {
    // If regex is invalid, fall back to simple case-insensitive indexOf.
    findText = findText.toLowerCase();
    const idx = withinText.toLowerCase().indexOf(findText, startNum - 1);
    return idx === -1 ? ERRORS.VALUE : rvNumber(idx + 1);
  }
}

// ============================================================================
// REPT
// ============================================================================

export function fnREPT(args: RuntimeValue[]): RuntimeValue {
  const err = checkError(args[0]);
  if (err) {
    return err;
  }
  const text = toStringRV(topLeft(args[0]));
  const timesRV = toNumberRV(topLeft(args[1]));
  if (isError(timesRV)) {
    return timesRV;
  }
  const times = Math.floor(timesRV.value);
  if (times < 0) {
    return ERRORS.VALUE;
  }
  // Excel caps the result at 32767 characters; we additionally bail out
  // early on huge products so the engine can't be DoS'd into allocating
  // a multi-gigabyte string. (R6-P1-4)
  const total = text.length * times;
  if (total > 32767) {
    return ERRORS.VALUE;
  }
  return rvString(text.repeat(times));
}

// ============================================================================
// TEXT (complex number/date formatting)
// ============================================================================

export function fnTEXT(
  args: RuntimeValue[],
  context: FunctionRuntimeContext = DEFAULT_FUNCTION_CONTEXT
): RuntimeValue {
  const rawVal = topLeft(args[0]);
  if (isError(rawVal)) {
    return rawVal;
  }
  const e1 = checkError(args[1]);
  if (e1) {
    return e1;
  }
  const fmt = toStringRV(topLeft(args[1]));

  // "@" format = return text as-is
  if (fmt === "@") {
    return rvString(toStringRV(rawVal));
  }

  // Conditional sections: positive;negative;zero;text (up to 4 parts).
  // Text input — when the value is a String/Boolean that doesn't parse
  // as a number — is routed to the 4th section if present. Without this
  // early dispatch, the later `toNumberRV(rawVal)` would #VALUE! and
  // `TEXT("hi", "0;-0;0;@")` could never reach the 4th section.
  const sections = splitFormatSections(fmt);
  const isTextInput = rawVal.kind === RVKind.String;
  if (isTextInput && sections.length >= 4) {
    // The 4th section formats the text value — `@` is a placeholder
    // that re-emits the source string (like Excel's `@` metacharacter).
    return rvString(sections[3].replace(/@/g, toStringRV(rawVal)));
  }

  const valRV = toNumberRV(rawVal);
  if (isError(valRV)) {
    return valRV;
  }
  const val = valRV.value;
  let activeFmt: string;
  if (sections.length >= 3) {
    activeFmt = val > 0 ? sections[0] : val < 0 ? sections[1] : sections[2];
  } else if (sections.length === 2) {
    activeFmt = val >= 0 ? sections[0] : sections[1];
  } else {
    activeFmt = sections[0];
  }
  // For negative section, use absolute value (sign is in the format)
  const useVal = sections.length >= 2 && val < 0 ? Math.abs(val) : val;

  return rvString(formatWithCode(useVal, activeFmt, rawVal, context.date1904));
}

/**
 * Split format string on `;` separators, respecting quoted strings.
 */
function splitFormatSections(fmt: string): string[] {
  const sections: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < fmt.length; i++) {
    if (fmt[i] === '"') {
      inQuotes = !inQuotes;
      current += fmt[i];
    } else if (fmt[i] === ";" && !inQuotes) {
      sections.push(current);
      current = "";
    } else {
      current += fmt[i];
    }
  }
  sections.push(current);
  return sections;
}

/**
 * Format a number using a single format code section.
 */
function formatWithCode(val: number, fmt: string, rawVal: ScalarValue, date1904: boolean): string {
  const upper = fmt.toUpperCase();

  // Date/time formats — detect by presence of date/time tokens
  if (
    upper.includes("YYYY") ||
    upper.includes("YY") ||
    upper.includes("MMMM") ||
    upper.includes("MMM") ||
    upper.includes("DDDD") ||
    upper.includes("DDD") ||
    upper.includes("DD") ||
    /(?:^|[^H])MM(?!M)/.test(upper) ||
    /(?:^|[^M])M(?!M)/.test(upper.replace(/MMMM|MMM/g, "")) ||
    upper.includes("HH") ||
    /(?:^|[^H])H(?!H)/.test(upper) ||
    upper.includes("SS") ||
    upper.includes("AM/PM") ||
    upper.includes("A/P")
  ) {
    return formatDate(val, fmt, date1904);
  }

  // Percentage format
  if (fmt.includes("%")) {
    const stripped = fmt.replace(/[^0#.%,]/g, "");
    const dotIdx = stripped.indexOf(".");
    const afterDot =
      dotIdx >= 0
        ? stripped
            .slice(dotIdx + 1)
            .replace(/%/g, "")
            .replace(/,/g, "")
        : "";
    const decimals = afterDot.length;
    const pctVal = val * 100;
    let result = pctVal.toFixed(decimals);
    if (fmt.includes(",")) {
      const parts = result.split(".");
      parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
      result = parts.join(".");
    }
    return result + "%";
  }

  // Scientific notation: 0.00E+00
  if (/[0#]\.?[0#]*E[+-][0#]+/i.test(fmt)) {
    return formatScientific(val, fmt);
  }

  // Fraction format: # ?/? or # ??/??
  if (/[?]+\/[?]+/.test(fmt)) {
    return formatFraction(val, fmt);
  }

  // Number format with 0 and #
  if (fmt.includes("0") || fmt.includes("#")) {
    return formatNumber(val, fmt);
  }

  // Literal-only section (no numeric placeholders). Excel emits the
  // format string verbatim, substituting any `@` with the stringified
  // value. This matters for 3- and 4-section formats like
  // `"pos;neg;zero"` — the selected section has no `#`/`0` but should
  // still appear in the output.
  return fmt.replace(/@/g, String(val));
}

/**
 * Format number using #, 0, comma patterns.
 */
/**
 * Format number using #, 0, comma patterns.
 *
 * The implementation tokenises the pattern left-to-right so that *any*
 * literal character (parentheses, `+`/`-`, currency symbols, letters in
 * quoted `"..."` segments, backslash-escaped characters, leading/trailing
 * punctuation) is preserved in its original position. The previous
 * implementation stripped everything that wasn't `0 # . ,` before analysis
 * and tried to re-inject a handful of literals afterwards, which caused
 * formats like `0;(0)` (→ "(5)" for -5) and `#,##0.00;-#,##0.00` to drop
 * their negative-section literal characters entirely.
 */
function formatNumber(val: number, fmt: string): string {
  // Strip `[color]` and `[condition]` tags up front (Excel-style
  // decorations that don't affect the numeric layout in our engine).
  const cleanFmt = fmt.replace(/\[[^\]]*\]/g, "");

  // Tokenise: emit one token per atomic pattern element. Literals preserve
  // their source position; only numeric placeholders participate in the
  // numeric layout calculations below.
  type Token =
    | { kind: "digit"; char: "0" | "#" }
    | { kind: "dot" }
    | { kind: "comma" }
    | { kind: "literal"; text: string };
  const tokens: Token[] = [];
  for (let i = 0; i < cleanFmt.length; i++) {
    const ch = cleanFmt[i];
    if (ch === '"') {
      // Quoted literal run: consume until the closing quote.
      let j = i + 1;
      let buf = "";
      while (j < cleanFmt.length && cleanFmt[j] !== '"') {
        buf += cleanFmt[j];
        j++;
      }
      tokens.push({ kind: "literal", text: buf });
      i = j; // skip closing quote
      continue;
    }
    if (ch === "\\" && i + 1 < cleanFmt.length) {
      // Backslash escape: next character is a literal.
      tokens.push({ kind: "literal", text: cleanFmt[i + 1] });
      i++;
      continue;
    }
    if (ch === "0" || ch === "#") {
      tokens.push({ kind: "digit", char: ch });
      continue;
    }
    if (ch === ".") {
      tokens.push({ kind: "dot" });
      continue;
    }
    if (ch === ",") {
      tokens.push({ kind: "comma" });
      continue;
    }
    // Any other character is a literal (space, parentheses, currency
    // symbol, sign, hyphen, etc.).
    tokens.push({ kind: "literal", text: ch });
  }

  // Count integer/fraction digit slots and decide whether to group.
  // Trailing commas after the last integer digit token — before the
  // decimal point or end of pattern — act as a "scale by 1/1000^k"
  // multiplier (Excel's "thousands scaling"), not thousand separators.
  // Example: `#,##0,` → 1,234,567 → "1,235" (divide by 1000).
  // Example: `#,##0,,` → 1,234,567,890 → "1,234" (divide by 1,000,000).
  let sawDot = false;
  const intDigitSlots: ("0" | "#")[] = [];
  const fracDigitSlots: ("0" | "#")[] = [];
  let hasGrouping = false;
  // Scan for trailing commas that sit strictly after the last integer
  // digit slot but before any dot or fractional slot. Each such comma
  // divides the value by 1000. Scan from end-of-pattern backward to
  // locate them.
  let scalingFactor = 1;
  {
    // Find the last integer digit-slot index.
    let lastIntDigitIdx = -1;
    let dotIdx = -1;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.kind === "dot") {
        dotIdx = i;
        break;
      }
      if (t.kind === "digit") {
        lastIntDigitIdx = i;
      }
    }
    // Trailing commas live after `lastIntDigitIdx` and strictly before
    // `dotIdx` (if present). They must be adjacent — only run-of-commas
    // directly abutting the last integer digit count as scaling.
    if (lastIntDigitIdx !== -1) {
      const stopBefore = dotIdx === -1 ? tokens.length : dotIdx;
      let k = lastIntDigitIdx + 1;
      while (k < stopBefore && tokens[k].kind === "comma") {
        scalingFactor *= 1000;
        // Remove this comma so later logic doesn't treat it as a
        // thousand-separator or literal artefact. We mutate the token
        // to a no-op literal with empty text.
        tokens[k] = { kind: "literal", text: "" };
        k++;
      }
    }
  }
  // Apply the scaling before any other formatting work.
  const scaledVal = val / scalingFactor;
  for (const t of tokens) {
    if (t.kind === "dot") {
      sawDot = true;
      continue;
    }
    if (t.kind === "digit") {
      if (sawDot) {
        fracDigitSlots.push(t.char);
      } else {
        intDigitSlots.push(t.char);
      }
      continue;
    }
    if (t.kind === "comma" && !sawDot) {
      // A comma between digit slots means "thousands grouping".
      hasGrouping = true;
    }
  }
  if (intDigitSlots.length === 0 && fracDigitSlots.length === 0) {
    return fmt; // Nothing to format; return the (raw) pattern.
  }

  // Round to the requested fractional precision.
  const rounded = roundHalfAwayFromZeroFmt(scaledVal, fracDigitSlots.length);
  const sign = rounded < 0 ? "-" : "";
  const absStr = Math.abs(rounded).toFixed(fracDigitSlots.length);
  const [intPartRaw, fracPart = ""] = absStr.split(".");
  let intPart = intPartRaw;

  // Pad the integer part to satisfy mandatory `0` slots.
  const mandatoryInt = intDigitSlots.filter(s => s === "0").length;
  if (intPart.length < mandatoryInt) {
    intPart = intPart.padStart(mandatoryInt, "0");
  }
  // Apply thousand grouping if the pattern requested it.
  let groupedInt = intPart;
  if (hasGrouping) {
    groupedInt = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }

  // Walk the tokens again and materialise output, interleaving the
  // integer run, decimal point, and fractional run with literals.
  let out = "";
  let intCursor = 0; // index into groupedInt (right-to-left on integer digits)
  // We emit integer digits in source order using a trick: scan tokens
  // left-to-right; the first integer digit slot consumes `groupedInt[0]`
  // if integer has more digits than slots all extras come out before the
  // first digit slot (Excel overflow rule).
  const totalIntSlots = intDigitSlots.length;
  // Determine how much "overflow" we need to prepend. Overflow digits
  // appear right before the first digit token we encounter.
  const overflowDigits = Math.max(0, groupedInt.length - totalIntSlots);
  let fracCursor = 0;
  let emittedOverflow = false;
  let firstDigitTokenIdx = -1;
  for (let k = 0; k < tokens.length; k++) {
    if (tokens[k].kind === "digit") {
      // We only care about the first *integer* digit token — one that
      // comes before the dot. If the pattern has no integer slots, we
      // still need to emit any overflow somewhere; pick the first digit
      // token regardless.
      firstDigitTokenIdx = k;
      break;
    }
    if (tokens[k].kind === "dot") {
      break;
    }
  }

  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.kind === "literal") {
      out += t.text;
      continue;
    }
    if (t.kind === "dot") {
      if (fracDigitSlots.length > 0 || fracPart.length > 0) {
        out += ".";
      }
      continue;
    }
    if (t.kind === "comma") {
      // Grouping commas are consumed by the integer-build step above,
      // so trailing commas here are literal (unusual but valid).
      continue;
    }
    // digit token
    if (sawDotAt(tokens, k)) {
      // fractional slot
      if (fracCursor < fracPart.length) {
        out += fracPart[fracCursor];
      } else if (t.char === "0") {
        out += "0";
      }
      fracCursor++;
      continue;
    }
    // integer slot
    if (k === firstDigitTokenIdx && !emittedOverflow) {
      if (overflowDigits > 0) {
        out += groupedInt.slice(0, overflowDigits);
      }
      emittedOverflow = true;
    }
    const slotIdx = intCursor;
    // Right-align the integer into the digit slots: leading `#` slots
    // emit nothing when the value is shorter than the pattern, and
    // leading `0` slots pad with a zero. Previously the logic treated
    // every slot as if the integer started at slot 0 (left-align),
    // which made `TEXT(0, "#,##0")` produce "00" instead of "0".
    //
    // The number of "padding" slots that must appear before the first
    // real digit equals `totalIntSlots − groupedInt.length` when that
    // value is positive (overflow path zeroes it out since we already
    // prepended the overflow digits before the first slot).
    const paddingSlots = overflowDigits > 0 ? 0 : Math.max(0, totalIntSlots - groupedInt.length);
    const srcIdx = overflowDigits + slotIdx - paddingSlots;
    if (srcIdx >= 0 && srcIdx < groupedInt.length) {
      out += groupedInt[srcIdx];
    } else if (t.char === "0") {
      out += "0";
    }
    intCursor++;
  }

  return sign + out;
}

/**
 * Did a dot token appear at any index < k in `tokens`? Used to classify
 * each digit slot as integer vs fractional during the emit pass.
 */
function sawDotAt(tokens: readonly { kind: string }[], k: number): boolean {
  for (let i = 0; i < k; i++) {
    if (tokens[i].kind === "dot") {
      return true;
    }
  }
  return false;
}

/**
 * Round `val` to `decimals` fractional digits using Excel's half-away-
 * from-zero convention (the same rule `formatNumber`'s caller relies on
 * to keep `-0.5` displaying as `"-1"` instead of `"0"`).
 */
function roundHalfAwayFromZeroFmt(val: number, decimals: number): number {
  if (!isFinite(val) || decimals < 0) {
    return val;
  }
  const factor = Math.pow(10, decimals);
  return ((val < 0 ? -1 : 1) * Math.round(Math.abs(val) * factor)) / factor;
}

/**
 * Format a number in scientific notation: 0.00E+00
 */
function formatScientific(val: number, fmt: string): string {
  const upper = fmt.toUpperCase();
  const eIdx = upper.indexOf("E");
  const beforeE = fmt.slice(0, eIdx);
  const afterE = fmt.slice(eIdx + 1);

  // Count decimal places in mantissa
  const dotIdx = beforeE.indexOf(".");
  const mantissaDecimals = dotIdx >= 0 ? beforeE.slice(dotIdx + 1).replace(/[^0#]/g, "").length : 0;

  // Count exponent digits
  const expSign = afterE[0] === "+" || afterE[0] === "-" ? afterE[0] : "+";
  const expDigits = afterE.replace(/[^0#]/g, "").length;

  const exp = val === 0 ? 0 : Math.floor(Math.log10(Math.abs(val)));
  const mantissa = val / Math.pow(10, exp);
  const expStr =
    (exp >= 0 && expSign === "+" ? "+" : exp < 0 ? "-" : "") +
    String(Math.abs(exp)).padStart(expDigits, "0");

  return mantissa.toFixed(mantissaDecimals) + "E" + expStr;
}

/**
 * Format a number as a fraction: "# ?/?" or "# ??/??"
 */
function formatFraction(val: number, fmt: string): string {
  const whole = Math.floor(Math.abs(val));
  const frac = Math.abs(val) - whole;
  const sign = val < 0 ? "-" : "";

  if (frac === 0) {
    if (fmt.includes("#") || fmt.includes("0")) {
      return sign + whole + "      ";
    }
    return sign + whole + " 0/1";
  }

  // Determine max denominator from ? count
  const slashIdx = fmt.indexOf("/");
  const denomPattern = fmt.slice(slashIdx + 1).replace(/[^?0#]/g, "");
  const maxDenom = Math.pow(10, denomPattern.length) - 1;

  // Find best fraction approximation
  let bestNum = 0;
  let bestDen = 1;
  let bestError = Math.abs(frac);
  for (let d = 1; d <= maxDenom; d++) {
    const n = Math.round(frac * d);
    const error = Math.abs(frac - n / d);
    if (error < bestError) {
      bestError = error;
      bestNum = n;
      bestDen = d;
      if (error === 0) {
        break;
      }
    }
  }

  const hasWholePart = fmt.indexOf("?") > 0 && fmt[0] !== "?" && fmt[0] !== "/";
  if (hasWholePart) {
    const numStr = String(bestNum).padStart(denomPattern.length, " ");
    const denStr = String(bestDen).padStart(denomPattern.length, " ");
    return sign + (whole > 0 ? whole + " " : "") + numStr + "/" + denStr;
  }
  return sign + (whole * bestDen + bestNum) + "/" + bestDen;
}

/**
 * Day name arrays for date formatting.
 */
const DAY_NAMES_FULL = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday"
];
const DAY_NAMES_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES_FULL = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December"
];
const MONTH_NAMES_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec"
];

/**
 * Format a numeric Excel serial date with a date/time format code.
 *
 * In the native value system, dates are always numbers (serial values).
 * We always use excelToDate() to convert and then read UTC fields so the
 * output does not drift by a day in timezones west of UTC.
 */
/**
 * Format a serial-date value using an Excel-style pattern.
 *
 * Unlike a naive multi-pass regex approach, this implementation tokenises
 * the pattern in a single left-to-right sweep and disambiguates the
 * overloaded `m` / `mm` token by looking at its neighbours:
 *
 *   - `mm` after `h:` or before `:ss` is rendered as **minutes**
 *   - otherwise `mm` is rendered as **month**
 *
 * Without this, a mixed format like `"yyyy-mm-dd hh:mm:ss"` would render
 * the time's minutes as months (both tokens fire the same regex), giving
 * garbage like `"2023-06-15 14:06:45"` for a timestamp at 14:30:45.
 */
function formatDate(val: number, fmt: string, date1904: boolean): string {
  const d = excelToDate(val, date1904);

  const year = d.getUTCFullYear();
  const month0 = d.getUTCMonth();
  const dayN = d.getUTCDate();
  const dow = d.getUTCDay();
  const fracDay = val % 1;
  const totalSeconds = Math.round(Math.abs(fracDay) * 86400);
  const hours = Math.floor(totalSeconds / 3600) % 24;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const seconds = totalSeconds % 60;

  const hasAmPmToken = /AM\/PM/i.test(fmt) || /A\/P/i.test(fmt);
  const h12 = hours % 12 === 0 ? 12 : hours % 12;
  const ampm = hours < 12 ? "AM" : "PM";
  const ap = hours < 12 ? "A" : "P";

  // Phase 1: scan the pattern into an ordered list of runs. Each run is
  // either a "letter run" (one or more identical case-insensitive letters
  // from the pattern alphabet) or a literal run (any other characters,
  // preserved verbatim). This way we know the full context of every `m`
  // before deciding whether it means month or minute.
  type Run = { kind: "letters"; lower: string; count: number } | { kind: "literal"; text: string };
  const runs: Run[] = [];
  let i = 0;
  while (i < fmt.length) {
    const ch = fmt[i];
    const lo = ch.toLowerCase();
    // Handle two-char literals that must not tokenise as letters
    if (fmt.slice(i, i + 5).toUpperCase() === "AM/PM") {
      runs.push({ kind: "literal", text: ampm });
      i += 5;
      continue;
    }
    if (fmt.slice(i, i + 3).toUpperCase() === "A/P") {
      runs.push({ kind: "literal", text: ap });
      i += 3;
      continue;
    }
    if (lo === "y" || lo === "m" || lo === "d" || lo === "h" || lo === "s") {
      let j = i + 1;
      while (j < fmt.length && fmt[j].toLowerCase() === lo) {
        j++;
      }
      runs.push({ kind: "letters", lower: lo, count: j - i });
      i = j;
      continue;
    }
    // Literal: consume until the next token-letter (to keep literal runs
    // contiguous and reduce array churn).
    let j = i + 1;
    while (j < fmt.length) {
      const nx = fmt[j].toLowerCase();
      if (nx === "y" || nx === "m" || nx === "d" || nx === "h" || nx === "s") {
        break;
      }
      if (fmt.slice(j, j + 5).toUpperCase() === "AM/PM") {
        break;
      }
      if (fmt.slice(j, j + 3).toUpperCase() === "A/P") {
        break;
      }
      j++;
    }
    runs.push({ kind: "literal", text: fmt.slice(i, j) });
    i = j;
  }

  // Phase 2: render each run, using neighbour context to decide whether
  // an `m` / `mm` run means minute (when adjacent to an `h` or `s` run)
  // or month (otherwise).
  let out = "";
  for (let r = 0; r < runs.length; r++) {
    const run = runs[r];
    if (run.kind === "literal") {
      out += run.text;
      continue;
    }
    switch (run.lower) {
      case "y":
        out += run.count >= 4 ? String(year).padStart(4, "0") : String(year).slice(-2);
        break;
      case "d":
        if (run.count >= 4) {
          out += DAY_NAMES_FULL[dow];
        } else if (run.count === 3) {
          out += DAY_NAMES_SHORT[dow];
        } else if (run.count === 2) {
          out += String(dayN).padStart(2, "0");
        } else {
          out += String(dayN);
        }
        break;
      case "h":
        out +=
          run.count >= 2
            ? String(hasAmPmToken ? h12 : hours).padStart(2, "0")
            : String(hasAmPmToken ? h12 : hours);
        break;
      case "s":
        out += run.count >= 2 ? String(seconds).padStart(2, "0") : String(seconds);
        break;
      case "m": {
        // Month-names render independent of context.
        if (run.count === 4) {
          out += MONTH_NAMES_FULL[month0];
          break;
        }
        if (run.count === 3) {
          out += MONTH_NAMES_SHORT[month0];
          break;
        }
        // Otherwise `m` / `mm` is month-or-minute. Follow Excel's rule:
        // treat as minute iff an adjacent letter-run is `h` or `s`.
        const isMinute = isAdjacentTimeContext(runs, r);
        const value = isMinute ? minutes : month0 + 1;
        out += run.count >= 2 ? String(value).padStart(2, "0") : String(value);
        break;
      }
    }
  }
  return out;
}

/**
 * Determine whether the `m` / `mm` run at `runs[idx]` should render as
 * minutes (true) or months (false). Excel's rule, simplified: minutes
 * when the immediately preceding or following *letter* run is `h` or
 * `s`, ignoring intervening literal separators like `:`.
 */
function isAdjacentTimeContext(
  runs: readonly (
    | { kind: "letters"; lower: string; count: number }
    | { kind: "literal"; text: string }
  )[],
  idx: number
): boolean {
  for (let j = idx - 1; j >= 0; j--) {
    const p = runs[j];
    if (p.kind === "letters") {
      if (p.lower === "h" || p.lower === "s") {
        return true;
      }
      break;
    }
  }
  for (let j = idx + 1; j < runs.length; j++) {
    const p = runs[j];
    if (p.kind === "letters") {
      if (p.lower === "h" || p.lower === "s") {
        return true;
      }
      break;
    }
  }
  return false;
}

// ============================================================================
// VALUE / EXACT
// ============================================================================

export function fnVALUE(args: RuntimeValue[]): RuntimeValue {
  const err = checkError(args[0]);
  if (err) {
    return err;
  }
  // Delegate to the central numeric-string parser. It rejects empty /
  // whitespace-only / Infinity / NaN / hex forms the way Excel does, which
  // a naive `Number(s)` would accept silently.
  return toNumberRV(topLeft(args[0]));
}

export function fnEXACT(args: RuntimeValue[]): RuntimeValue {
  const err0 = checkError(args[0]);
  if (err0) {
    return err0;
  }
  const err1 = checkError(args[1]);
  if (err1) {
    return err1;
  }
  return rvBoolean(toStringRV(topLeft(args[0])) === toStringRV(topLeft(args[1])));
}

// ============================================================================
// Additional Text Functions
// ============================================================================

export function fnCODE(args: RuntimeValue[]): RuntimeValue {
  const err = checkError(args[0]);
  if (err) {
    return err;
  }
  const text = toStringRV(topLeft(args[0]));
  return text.length > 0 ? rvNumber(text.charCodeAt(0)) : ERRORS.VALUE;
}

export function fnCHAR(args: RuntimeValue[]): RuntimeValue {
  const err = checkError(args[0]);
  if (err) {
    return err;
  }
  const nRV = toNumberRV(topLeft(args[0]));
  if (isError(nRV)) {
    return nRV;
  }
  // Excel's CHAR accepts integers in [1, 255] only; outside the ANSI range
  // it returns #VALUE!. We also truncate fractional inputs toward zero to
  // match Excel's coercion semantics.
  const code = Math.trunc(nRV.value);
  if (code < 1 || code > 255) {
    return ERRORS.VALUE;
  }
  return rvString(String.fromCharCode(code));
}

export function fnCLEAN(args: RuntimeValue[]): RuntimeValue {
  const err = checkError(args[0]);
  if (err) {
    return err;
  }
  const text = toStringRV(topLeft(args[0]));
  // Remove non-printable ASCII control characters (0x00-0x1F)
  let result = "";
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) >= 32) {
      result += text[i];
    }
  }
  return rvString(result);
}

export function fnT(args: RuntimeValue[]): RuntimeValue {
  const v = topLeft(args[0]);
  if (isError(v)) {
    return v;
  }
  return v.kind === RVKind.String ? v : rvString("");
}

// ============================================================================
// More Text Functions
// ============================================================================

export function fnUNICHAR(args: RuntimeValue[]): RuntimeValue {
  const err = checkError(args[0]);
  if (err) {
    return err;
  }
  const nRV = toNumberRV(topLeft(args[0]));
  if (isError(nRV)) {
    return nRV;
  }
  const code = Math.floor(nRV.value);
  if (code < 1) {
    return ERRORS.VALUE;
  }
  try {
    return rvString(String.fromCodePoint(code));
  } catch {
    return ERRORS.VALUE;
  }
}

export function fnUNICODE(args: RuntimeValue[]): RuntimeValue {
  const err = checkError(args[0]);
  if (err) {
    return err;
  }
  const text = toStringRV(topLeft(args[0]));
  if (text.length === 0) {
    return ERRORS.VALUE;
  }
  const cp = text.codePointAt(0);
  return cp !== undefined ? rvNumber(cp) : ERRORS.VALUE;
}

export function fnBAHTTEXT(args: RuntimeValue[]): RuntimeValue {
  const err = checkError(args[0]);
  if (err) {
    return err;
  }
  return rvString(toStringRV(topLeft(args[0])));
}

export function fnDOLLAR(args: RuntimeValue[]): RuntimeValue {
  const numRV = toNumberRV(topLeft(args[0]));
  if (isError(numRV)) {
    return numRV;
  }
  const num = numRV.value;
  let decimals: number;
  if (args.length > 1) {
    const decRV = toNumberRV(topLeft(args[1]));
    if (isError(decRV)) {
      return decRV;
    }
    decimals = decRV.value;
  } else {
    decimals = 2;
  }
  const d = Math.floor(decimals);
  let rounded: number;
  if (d < 0) {
    const factor = Math.pow(10, -d);
    rounded = Math.round(Math.abs(num) / factor) * factor;
  } else {
    rounded = Math.abs(num);
  }
  const formatted = rounded.toFixed(Math.max(0, d));
  const parts = formatted.split(".");
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const result = parts.join(".");
  return rvString(num < 0 ? `($${result})` : `$${result}`);
}

export function fnFIXED(args: RuntimeValue[]): RuntimeValue {
  const numRV = toNumberRV(topLeft(args[0]));
  if (isError(numRV)) {
    return numRV;
  }
  const num = numRV.value;
  let decimals: number;
  if (args.length > 1) {
    const decRV = toNumberRV(topLeft(args[1]));
    if (isError(decRV)) {
      return decRV;
    }
    decimals = decRV.value;
  } else {
    decimals = 2;
  }
  let noCommas: boolean;
  if (args.length > 2) {
    const ncRV = toBooleanRV(topLeft(args[2]));
    if (isError(ncRV)) {
      return ncRV;
    }
    noCommas = ncRV.value;
  } else {
    noCommas = false;
  }
  const d = Math.floor(decimals);
  let rounded: number;
  if (d < 0) {
    const factor = Math.pow(10, -d);
    rounded = Math.round(num / factor) * factor;
  } else {
    rounded = num;
  }
  let result = rounded.toFixed(Math.max(0, d));
  if (!noCommas) {
    const parts = result.split(".");
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    result = parts.join(".");
  }
  return rvString(result);
}

export function fnASC(args: RuntimeValue[]): RuntimeValue {
  const err = checkError(args[0]);
  if (err) {
    return err;
  }
  const text = toStringRV(topLeft(args[0]));
  return rvString(
    text.replace(/[\uFF01-\uFF5E]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
  );
}

export function fnDBCS(args: RuntimeValue[]): RuntimeValue {
  const err = checkError(args[0]);
  if (err) {
    return err;
  }
  const text = toStringRV(topLeft(args[0]));
  return rvString(text.replace(/[!-~]/g, ch => String.fromCharCode(ch.charCodeAt(0) + 0xfee0)));
}

export function fnJIS(args: RuntimeValue[]): RuntimeValue {
  return fnDBCS(args);
}

export function fnPHONETIC(args: RuntimeValue[]): RuntimeValue {
  const err = checkError(args[0]);
  if (err) {
    return err;
  }
  // Implicit intersection: array → top-left cell, matching the rest of
  // the text-function family.
  return rvString(toStringRV(topLeft(args[0])));
}

export function fnNUMBERVALUE(args: RuntimeValue[]): RuntimeValue {
  const e0 = checkError(args[0]);
  if (e0) {
    return e0;
  }
  // Implicit intersection on every text arg.
  let text = toStringRV(topLeft(args[0]));
  let decSep = ".";
  if (args.length > 1) {
    const e1 = checkError(args[1]);
    if (e1) {
      return e1;
    }
    decSep = toStringRV(topLeft(args[1]));
  }
  let grpSep = ",";
  if (args.length > 2) {
    const e2 = checkError(args[2]);
    if (e2) {
      return e2;
    }
    grpSep = toStringRV(topLeft(args[2]));
  }
  text = text.split(grpSep).join("");
  if (decSep !== ".") {
    text = text.replace(decSep, ".");
  }
  // Handle percentage. Excel divides by 100 for EACH trailing `%`, so
  // `NUMBERVALUE("50%%")` = 50 / 10000 = 0.005. Previously we only
  // recognised the first `%` and treated `50%%` as the literal string
  // "50%" → NaN → #VALUE!.
  let pctCount = 0;
  while (text.endsWith("%")) {
    pctCount++;
    text = text.slice(0, -1);
  }
  // `Number("")` is 0, not NaN — reject empty / whitespace-only inputs
  // so `NUMBERVALUE("")` does not silently produce 0 (R6-P1-6).
  if (text.trim() === "") {
    return ERRORS.VALUE;
  }
  const n = Number(text);
  if (isNaN(n)) {
    return ERRORS.VALUE;
  }
  return rvNumber(pctCount > 0 ? n / Math.pow(100, pctCount) : n);
}

// ============================================================================
// Excel 365 Text Functions: TEXTBEFORE, TEXTAFTER, TEXTSPLIT
// ============================================================================

/**
 * Parse the common [instance_num, match_mode, match_end, if_not_found]
 * tail used by TEXTBEFORE / TEXTAFTER. Returns the numeric values (with
 * defaults filled in) or an error if any argument is malformed.
 *
 * - match_mode: 0 = case-sensitive (default), 1 = case-insensitive.
 * - match_end:  0 = don't treat string edge as delimiter (default),
 *               1 = treat string edge as a virtual delimiter so that
 *                   TEXTAFTER with a missing delimiter returns "".
 */
function parseTextBeforeAfterTail(
  args: RuntimeValue[]
):
  | { inst: number; matchMode: 0 | 1; matchEnd: 0 | 1; ifNotFound: RuntimeValue | null }
  | ErrorValue {
  let inst = 1;
  if (args.length > 2) {
    const instRV = toNumberRV(topLeft(args[2]));
    if (isError(instRV)) {
      return instRV;
    }
    inst = Math.trunc(instRV.value);
  }
  let matchMode: 0 | 1 = 0;
  if (args.length > 3) {
    const mmRV = toNumberRV(topLeft(args[3]));
    if (isError(mmRV)) {
      return mmRV;
    }
    const mm = Math.trunc(mmRV.value);
    if (mm !== 0 && mm !== 1) {
      return ERRORS.VALUE;
    }
    matchMode = mm;
  }
  let matchEnd: 0 | 1 = 0;
  if (args.length > 4) {
    const meRV = toNumberRV(topLeft(args[4]));
    if (isError(meRV)) {
      return meRV;
    }
    const me = Math.trunc(meRV.value);
    if (me !== 0 && me !== 1) {
      return ERRORS.VALUE;
    }
    matchEnd = me;
  }
  const ifNotFound = args.length > 5 ? args[5] : null;
  return { inst, matchMode, matchEnd, ifNotFound };
}

export function fnTEXTBEFORE(args: RuntimeValue[]): RuntimeValue {
  const e0 = checkError(args[0]);
  if (e0) {
    return e0;
  }
  const e1 = checkError(args[1]);
  if (e1) {
    return e1;
  }
  const text = toStringRV(topLeft(args[0]));
  const delimiter = toStringRV(topLeft(args[1]));
  const tail = parseTextBeforeAfterTail(args);
  if ("kind" in tail && tail.kind === RVKind.Error) {
    return tail;
  }
  const { inst, matchMode, matchEnd, ifNotFound } = tail as Exclude<typeof tail, ErrorValue>;
  if (inst === 0) {
    return ERRORS.VALUE;
  }
  if (delimiter === "") {
    return rvString(inst > 0 ? "" : text);
  }
  // For case-insensitive matching we search within the lower-cased
  // haystack but slice against the original so the returned prefix/
  // suffix preserves the source text's case.
  const haystack = matchMode === 1 ? text.toLowerCase() : text;
  const needle = matchMode === 1 ? delimiter.toLowerCase() : delimiter;
  const notFound = (): RuntimeValue => {
    if (matchEnd === 1 && inst === 1) {
      // Treat the string end as a virtual delimiter: everything is "before".
      return rvString(text);
    }
    return ifNotFound !== null ? ifNotFound : ERRORS.NA;
  };
  if (inst > 0) {
    let pos = -1;
    for (let i = 0; i < inst; i++) {
      pos = haystack.indexOf(needle, pos + 1);
      if (pos === -1) {
        return notFound();
      }
    }
    return rvString(text.slice(0, pos));
  }
  // Negative: search from end
  let pos = haystack.length;
  for (let i = 0; i < -inst; i++) {
    pos = haystack.lastIndexOf(needle, pos - 1);
    if (pos === -1) {
      return notFound();
    }
  }
  return rvString(text.slice(0, pos));
}

export function fnTEXTAFTER(args: RuntimeValue[]): RuntimeValue {
  const e0 = checkError(args[0]);
  if (e0) {
    return e0;
  }
  const e1 = checkError(args[1]);
  if (e1) {
    return e1;
  }
  const text = toStringRV(topLeft(args[0]));
  const delimiter = toStringRV(topLeft(args[1]));
  const tail = parseTextBeforeAfterTail(args);
  if ("kind" in tail && tail.kind === RVKind.Error) {
    return tail;
  }
  const { inst, matchMode, matchEnd, ifNotFound } = tail as Exclude<typeof tail, ErrorValue>;
  if (inst === 0) {
    return ERRORS.VALUE;
  }
  if (delimiter === "") {
    return rvString(inst > 0 ? text : "");
  }
  const haystack = matchMode === 1 ? text.toLowerCase() : text;
  const needle = matchMode === 1 ? delimiter.toLowerCase() : delimiter;
  const notFound = (): RuntimeValue => {
    if (matchEnd === 1 && inst === 1) {
      // String end is a virtual delimiter → everything after it is "".
      return rvString("");
    }
    return ifNotFound !== null ? ifNotFound : ERRORS.NA;
  };
  if (inst > 0) {
    let pos = -1;
    for (let i = 0; i < inst; i++) {
      pos = haystack.indexOf(needle, pos + 1);
      if (pos === -1) {
        return notFound();
      }
    }
    return rvString(text.slice(pos + delimiter.length));
  }
  let pos = haystack.length;
  for (let i = 0; i < -inst; i++) {
    pos = haystack.lastIndexOf(needle, pos - 1);
    if (pos === -1) {
      return notFound();
    }
  }
  return rvString(text.slice(pos + delimiter.length));
}

export function fnTEXTSPLIT(args: RuntimeValue[]): RuntimeValue {
  const e0 = checkError(args[0]);
  if (e0) {
    return e0;
  }
  const text = toStringRV(topLeft(args[0]));
  let colDelimiter = "";
  if (args.length > 1) {
    const e1 = checkError(args[1]);
    if (e1) {
      return e1;
    }
    colDelimiter = toStringRV(topLeft(args[1]));
  }
  const rowDelimiter =
    args.length > 2 && args[2].kind !== RVKind.Blank ? toStringRV(topLeft(args[2])) : "";

  // `ignore_empty` (4th arg, default FALSE) — when TRUE, suppress empty
  // fragments produced by consecutive delimiters.
  let ignoreEmpty = false;
  if (args.length > 3 && args[3].kind !== RVKind.Blank) {
    const ieRV = toBooleanRV(topLeft(args[3]));
    if (isError(ieRV)) {
      return ieRV;
    }
    ignoreEmpty = ieRV.value;
  }

  // `match_mode` (5th arg, default 0 = case-sensitive). When 1 the
  // delimiter match is case-insensitive; we implement that by lowercasing
  // both the haystack and the delimiter(s) before splitting, which is
  // consistent with Excel's specification for TEXTSPLIT.
  let matchMode = 0;
  if (args.length > 4 && args[4].kind !== RVKind.Blank) {
    const mmRV = toNumberRV(topLeft(args[4]));
    if (isError(mmRV)) {
      return mmRV;
    }
    matchMode = Math.trunc(mmRV.value);
    if (matchMode !== 0 && matchMode !== 1) {
      return ERRORS.VALUE;
    }
  }

  // `pad_with` (6th arg, default #N/A) — value used to fill shorter rows
  // when the split produces a ragged 2D shape. Explicit error arguments
  // (e.g. `TEXTSPLIT(…, #VALUE!)`) propagate into the pad cells verbatim,
  // matching Excel.
  const pad: ScalarValue = args.length > 5 ? topLeft(args[5]) : ERRORS.NA;

  const splitString = (s: string, delim: string): string[] => {
    if (!delim) {
      return [s];
    }
    if (matchMode === 1) {
      // Case-insensitive split — find positions by scanning the lowercased
      // haystack but slice the original so case is preserved in output.
      const haystack = s.toLowerCase();
      const needle = delim.toLowerCase();
      const parts: string[] = [];
      let last = 0;
      let i = 0;
      while (i <= haystack.length - needle.length) {
        if (haystack.slice(i, i + needle.length) === needle) {
          parts.push(s.slice(last, i));
          i += needle.length;
          last = i;
        } else {
          i++;
        }
      }
      parts.push(s.slice(last));
      return parts;
    }
    return s.split(delim);
  };

  let rows: string[];
  if (rowDelimiter) {
    rows = splitString(text, rowDelimiter);
  } else {
    rows = [text];
  }

  // Split each row into columns, applying ignore_empty per row after the
  // split. When ignore_empty is TRUE at the row level we also drop rows
  // that were themselves empty (i.e. empty string from consecutive row
  // delimiters).
  const matrix: ScalarValue[][] = [];
  let maxWidth = 0;
  for (const row of rows) {
    if (ignoreEmpty && row === "") {
      continue;
    }
    let parts: string[];
    if (colDelimiter) {
      parts = splitString(row, colDelimiter);
      if (ignoreEmpty) {
        parts = parts.filter(p => p !== "");
      }
    } else {
      parts = [row];
    }
    if (parts.length === 0) {
      // All fragments were empty and ignore_empty discarded them; keep a
      // pad row so the result is still a well-formed rectangle.
      parts = [""];
    }
    matrix.push(parts.map(p => rvString(p)));
    if (parts.length > maxWidth) {
      maxWidth = parts.length;
    }
  }

  if (matrix.length === 0) {
    // ignore_empty consumed everything → return a single pad cell so the
    // array is still a valid 1×1 spill (matches Excel).
    return rvArray([[pad]]);
  }

  // Pad ragged rows out to the maximum width with `pad_with`.
  const result: ScalarValue[][] = [];
  for (const row of matrix) {
    if (row.length < maxWidth) {
      const padded: ScalarValue[] = row.slice();
      while (padded.length < maxWidth) {
        padded.push(pad);
      }
      result.push(padded);
    } else {
      result.push(row);
    }
  }
  return rvArray(result);
}

// ============================================================================
// REGEX family (Excel 365, 2024)
// ============================================================================

/**
 * Convert an Excel REGEX pattern to a JavaScript RegExp. Excel's regex
 * dialect is close to PCRE; JavaScript's RegExp is close enough for the
 * vast majority of practical patterns, but a few constructs (named
 * captures, look-behind, some Unicode classes) behave slightly
 * differently. We pass patterns through as-is and let JavaScript's
 * parser surface #VALUE! on the rare incompatibility.
 */
function compileExcelRegex(
  pattern: string,
  caseSensitive: boolean,
  global: boolean
): RegExp | null {
  try {
    let flags = "u";
    if (!caseSensitive) {
      flags += "i";
    }
    if (global) {
      flags += "g";
    }
    return new RegExp(pattern, flags);
  } catch {
    return null;
  }
}

/**
 * Resolve the optional `case_sensitivity` argument used by every REGEX
 * function. `0`/FALSE/omitted → case-insensitive (Excel default),
 * any other value → case-sensitive. Errors propagate.
 */
function resolveCaseSensitivity(
  arg: RuntimeValue | undefined
): { caseSensitive: boolean } | ErrorValue {
  if (arg === undefined) {
    return { caseSensitive: false };
  }
  // Accept boolean or number; anything else coerced via toBooleanRV.
  const b = toBooleanRV(arg);
  if (isError(b)) {
    return b;
  }
  return { caseSensitive: b.value };
}

/**
 * REGEXTEST(text, pattern, [case_sensitivity]) — returns TRUE iff the
 * regex matches any substring of `text`.
 */
export function fnREGEXTEST(args: RuntimeValue[]): RuntimeValue {
  const textV = toStringRV(topLeft(args[0]));
  const patternV = toStringRV(topLeft(args[1]));
  const cs = resolveCaseSensitivity(args[2]);
  if ("kind" in cs) {
    return cs; // error
  }
  const errCheck = checkError(args[0]) ?? checkError(args[1]);
  if (errCheck) {
    return errCheck;
  }
  const re = compileExcelRegex(patternV, cs.caseSensitive, false);
  if (!re) {
    return ERRORS.VALUE;
  }
  return rvBoolean(re.test(textV));
}

/**
 * REGEXEXTRACT(text, pattern, [return_mode], [case_sensitivity]) —
 *   return_mode = 0 (default) → first match as a string
 *   return_mode = 1 → all matches as a 1-column array
 *   return_mode = 2 → capture groups of the first match as a 1-row array
 */
export function fnREGEXEXTRACT(args: RuntimeValue[]): RuntimeValue {
  const textV = toStringRV(topLeft(args[0]));
  const patternV = toStringRV(topLeft(args[1]));
  const errCheck = checkError(args[0]) ?? checkError(args[1]);
  if (errCheck) {
    return errCheck;
  }
  const modeV = args.length > 2 ? toNumberRV(topLeft(args[2])) : rvNumber(0);
  if (isError(modeV)) {
    return modeV;
  }
  const mode = Math.trunc(modeV.value);
  if (mode !== 0 && mode !== 1 && mode !== 2) {
    return ERRORS.VALUE;
  }
  const cs = resolveCaseSensitivity(args[3]);
  if ("kind" in cs) {
    return cs;
  }
  const needGlobal = mode === 1;
  const re = compileExcelRegex(patternV, cs.caseSensitive, needGlobal);
  if (!re) {
    return ERRORS.VALUE;
  }
  if (mode === 0) {
    const m = re.exec(textV);
    if (!m) {
      return ERRORS.NA;
    }
    return rvString(m[0]);
  }
  if (mode === 1) {
    const matches: string[] = [];
    let m: RegExpExecArray | null;
    // eslint-disable-next-line no-cond-assign
    while ((m = re.exec(textV)) !== null) {
      matches.push(m[0]);
      // Guard against zero-length matches causing an infinite loop.
      if (m.index === re.lastIndex) {
        re.lastIndex++;
      }
    }
    if (matches.length === 0) {
      return ERRORS.NA;
    }
    return rvArray(matches.map(s => [rvString(s)]));
  }
  // mode === 2 — capture groups of first match as a row array.
  const m = re.exec(textV);
  if (!m) {
    return ERRORS.NA;
  }
  // Exclude the full-match element (index 0) — only capture groups.
  if (m.length <= 1) {
    // No capture groups defined in the pattern — return the full match.
    return rvArray([[rvString(m[0])]]);
  }
  const row: ScalarValue[] = [];
  for (let i = 1; i < m.length; i++) {
    row.push(rvString(m[i] ?? ""));
  }
  return rvArray([row]);
}

/**
 * REGEXREPLACE(text, pattern, replacement, [occurrence], [case_sensitivity]) —
 *   occurrence = 0 (default) → replace all
 *   occurrence = n (positive) → replace only the n-th match
 *   occurrence = n (negative) → replace only the n-th-last match
 */
export function fnREGEXREPLACE(args: RuntimeValue[]): RuntimeValue {
  const textV = toStringRV(topLeft(args[0]));
  const patternV = toStringRV(topLeft(args[1]));
  const replacementV = toStringRV(topLeft(args[2]));
  const errCheck = checkError(args[0]) ?? checkError(args[1]) ?? checkError(args[2]);
  if (errCheck) {
    return errCheck;
  }
  const occurrenceV = args.length > 3 ? toNumberRV(topLeft(args[3])) : rvNumber(0);
  if (isError(occurrenceV)) {
    return occurrenceV;
  }
  const occurrence = Math.trunc(occurrenceV.value);
  const cs = resolveCaseSensitivity(args[4]);
  if ("kind" in cs) {
    return cs;
  }
  // Always compile with the global flag — we need to enumerate matches
  // to apply the occurrence filter; `String.replace` without `/g` would
  // only see the first match and we wouldn't be able to address later
  // hits for `occurrence > 1`.
  const re = compileExcelRegex(patternV, cs.caseSensitive, true);
  if (!re) {
    return ERRORS.VALUE;
  }

  if (occurrence === 0) {
    // Replace all.
    return rvString(textV.replace(re, replacementV));
  }

  // Collect every match's range so we can address them by index.
  const ranges: Array<{ start: number; end: number }> = [];
  let m: RegExpExecArray | null;
  // eslint-disable-next-line no-cond-assign
  while ((m = re.exec(textV)) !== null) {
    ranges.push({ start: m.index, end: m.index + m[0].length });
    if (m.index === re.lastIndex) {
      re.lastIndex++;
    }
  }
  if (ranges.length === 0) {
    return rvString(textV); // no match → unchanged (Excel behavior)
  }
  // Negative index counts from the end; -1 is the last match.
  const idx = occurrence > 0 ? occurrence - 1 : ranges.length + occurrence;
  if (idx < 0 || idx >= ranges.length) {
    // Out-of-range occurrence → unchanged (Excel behavior).
    return rvString(textV);
  }
  const { start, end } = ranges[idx];
  return rvString(textV.slice(0, start) + replacementV + textV.slice(end));
}

// ============================================================================
// VALUETOTEXT / ARRAYTOTEXT (Excel 365)
// ============================================================================

/**
 * Format a single scalar for VALUETOTEXT / ARRAYTOTEXT.
 *
 * Format 0 (concise, default):
 *   - Number → plain number string
 *   - String → the string itself (no quotes)
 *   - Boolean → "TRUE" / "FALSE"
 *   - Error → error text (e.g. "#N/A")
 *   - Blank → ""
 *
 * Format 1 (strict):
 *   - String → wrapped in double quotes with `""` escapes
 *   - Everything else → same as format 0
 */
function scalarToText(v: ScalarValue, strict: boolean): string {
  switch (v.kind) {
    case RVKind.Number:
      return String(v.value);
    case RVKind.String:
      if (strict) {
        return `"${v.value.replace(/"/g, '""')}"`;
      }
      return v.value;
    case RVKind.Boolean:
      return v.value ? "TRUE" : "FALSE";
    case RVKind.Error:
      return v.code;
    case RVKind.Blank:
      return "";
  }
}

/**
 * VALUETOTEXT(value, [format]) — format a scalar or 1×1 array as text.
 * For multi-cell arrays, this applies implicit intersection at the
 * evaluator layer — so by the time we see args[0] it is already scalar.
 */
export function fnVALUETOTEXT(args: RuntimeValue[]): RuntimeValue {
  const formatV = args.length > 1 ? toNumberRV(topLeft(args[1])) : rvNumber(0);
  if (isError(formatV)) {
    return formatV;
  }
  const fmt = Math.trunc(formatV.value);
  if (fmt !== 0 && fmt !== 1) {
    return ERRORS.VALUE;
  }
  const strict = fmt === 1;
  return rvString(scalarToText(topLeft(args[0]), strict));
}

/**
 * ARRAYTOTEXT(array, [format]) — flatten an array to a delimited text
 * representation.
 *
 * Format 0 (concise, default): row-major join with ", ".
 * Format 1 (strict): wraps output in `{…}`, rows separated by `;`,
 *   cells by `,`; strings inside quoted.
 */
export function fnARRAYTOTEXT(args: RuntimeValue[]): RuntimeValue {
  const formatV = args.length > 1 ? toNumberRV(topLeft(args[1])) : rvNumber(0);
  if (isError(formatV)) {
    return formatV;
  }
  const fmt = Math.trunc(formatV.value);
  if (fmt !== 0 && fmt !== 1) {
    return ERRORS.VALUE;
  }
  const strict = fmt === 1;
  const arg = args[0];
  if (arg.kind !== RVKind.Array) {
    return rvString(scalarToText(topLeft(arg), strict));
  }
  if (!strict) {
    // Concise: flatten row-major, join with ", ".
    const parts: string[] = [];
    for (const row of arg.rows) {
      for (const cell of row) {
        parts.push(scalarToText(cell, false));
      }
    }
    return rvString(parts.join(", "));
  }
  // Strict: `{row1;row2;...}` with rows as `a,b,c` and strings quoted.
  const rowStrs: string[] = [];
  for (const row of arg.rows) {
    const cellStrs: string[] = [];
    for (const cell of row) {
      cellStrs.push(scalarToText(cell, true));
    }
    rowStrs.push(cellStrs.join(","));
  }
  return rvString(`{${rowStrs.join(";")}}`);
}

// ============================================================================
// ENCODEURL
// ============================================================================

/**
 * ENCODEURL(text) — percent-encode a string for URL use.
 *
 * Excel follows RFC 3986's "unreserved" character rule: A-Z, a-z, 0-9,
 * and `- _ . ~` are kept verbatim; everything else is encoded as
 * `%HH` using the UTF-8 byte sequence. This is exactly what JavaScript's
 * `encodeURIComponent` does, so we delegate to it.
 */
export function fnENCODEURL(args: RuntimeValue[]): RuntimeValue {
  const err = checkError(args[0]);
  if (err) {
    return err;
  }
  const s = toStringRV(topLeft(args[0]));
  return rvString(encodeURIComponent(s));
}

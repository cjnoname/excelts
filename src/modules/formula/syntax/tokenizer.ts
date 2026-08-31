/**
 * Formula Tokenizer
 *
 * Converts an Excel formula string into a stream of tokens.
 * Supports cell references (A1, $A$1), ranges (A1:B10),
 * cross-sheet references (Sheet1!A1), operators, function calls,
 * numbers, strings, booleans, and error literals.
 */

import { FormulaParseError } from "@formula/errors";
import type { Token } from "@formula/syntax/token-types";
import { TokenType } from "@formula/syntax/token-types";

// ============================================================================
// Character Helpers
// ============================================================================

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

// Matches a single Unicode letter (any script). Used by `isAlpha` for the
// non-ASCII path so that defined names in Chinese, Japanese, Korean, Cyrillic,
// Greek, etc. tokenise correctly (e.g. `=销售额+10`).
//
// Note: JavaScript strings are UTF-16, so `formula[i]` yields a single code
// unit. This regex correctly identifies any BMP letter. Astral-plane letters
// (U+10000+) require surrogate-pair handling which would be more invasive;
// BMP coverage is sufficient for virtually all real-world named ranges.
const UNICODE_LETTER = /\p{L}/u;

function isAlpha(ch: string): boolean {
  // ASCII fast path — the overwhelming majority of Excel formulas.
  if ((ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z")) {
    return true;
  }
  // Any other ASCII character (digits, punctuation, control) is not a letter.
  if (ch.charCodeAt(0) < 128) {
    return false;
  }
  // Non-ASCII: defer to Unicode letter classification.
  return UNICODE_LETTER.test(ch);
}

function isAlphaNumOrUnderscore(ch: string): boolean {
  return isAlpha(ch) || isDigit(ch) || ch === "_" || ch === ".";
}

/**
 * ASCII-only alpha check. Cell column letters are A–Z only — a Unicode
 * identifier like `销售额` must never be misread as a column. Use this inside
 * `parseCellRef` and other strictly-A1-notation parsers; use `isAlpha` for
 * general identifier lexing where Unicode letters are valid.
 */
function isAsciiAlpha(ch: string): boolean {
  return (ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z");
}

/**
 * Cheap lookahead: does position `i` in `s` start a plausible cell or
 * range reference? We only need to distinguish "this is a ref" from
 * "this is anything else" — good enough to disambiguate 3D sheet
 * references (`Q1:Q4!A1`) from name references.
 *
 * Accepts: `$?[A-Z]+$?\d+`-shaped prefixes, whole-column `$?[A-Z]+`,
 * and whole-row `$?\d+`. Anything else (identifiers, punctuation,
 * quotes) returns false.
 */
function looksLikeCellRefStart(s: string, i: number): boolean {
  const len = s.length;
  let j = i;
  if (j < len && s[j] === "$") {
    j++;
  }
  // Either letters first (cell / col) or digits first (whole row)
  if (j < len && isAsciiAlpha(s[j])) {
    // Consume up to 3 letters (Excel column max "XFD"). More than 3
    // consecutive letters means it's not a column ref.
    let letters = 0;
    while (j < len && isAsciiAlpha(s[j]) && letters < 4) {
      j++;
      letters++;
    }
    if (letters === 0 || letters > 3) {
      return false;
    }
    // Optional $digits for an A1-style cell ref; pure letters are a
    // whole-column ref, also valid.
    if (j < len && s[j] === "$") {
      j++;
    }
    // At minimum the following char should be a digit or a delimiter
    // that closes a whole-column ref (`:` / `,` / `)` / operators).
    if (j < len && s[j] >= "0" && s[j] <= "9") {
      return true;
    }
    return true; // whole-column ref, e.g. `A:A` or bare `A`
  }
  if (j < len && s[j] >= "0" && s[j] <= "9") {
    // Whole-row ref (e.g. `1:5`)
    return true;
  }
  return false;
}

/**
 * Advance past a run of spaces and tabs. Used inside bracketed structured
 * reference parsing where only horizontal whitespace is significant (newlines
 * and carriage returns are not expected inside `[...]` tokens).
 */
function skipHorizontalWhitespace(s: string, i: number, len: number): number {
  while (i < len && (s[i] === " " || s[i] === "\t")) {
    i++;
  }
  return i;
}

// ============================================================================
// Error Literal Detection
// ============================================================================

/**
 * Known Excel error literals. The constant below is sorted longest-first at
 * module load so greedy longest-match in `matchErrorLiteral` is always
 * correct — future entries can be added in any order.
 */
const ERROR_LITERALS = [
  "#GETTING_DATA",
  "#BLOCKED!",
  "#CONNECT!",
  "#UNKNOWN!",
  "#SPILL!",
  "#VALUE!",
  "#FIELD!",
  "#DIV/0!",
  "#NAME?",
  "#NULL!",
  "#CALC!",
  "#BUSY!",
  "#REF!",
  "#NUM!",
  "#N/A"
].sort((a, b) => b.length - a.length);

/**
 * Try to match a known Excel error literal at `pos` (which must point at `#`).
 * Matches case-insensitively and greedily (longest list entry wins).
 * Returns the canonical (upper-cased) value and end index, or null on no match.
 */
function matchErrorLiteral(formula: string, pos: number): { value: string; end: number } | null {
  for (const lit of ERROR_LITERALS) {
    const end = pos + lit.length;
    if (end > formula.length) {
      continue;
    }
    const slice = formula.slice(pos, end);
    if (slice.toUpperCase() === lit) {
      return { value: lit, end };
    }
  }
  return null;
}

// ============================================================================
// Cell Reference Detection
// ============================================================================

/**
 * Check if a string is a valid cell reference (like A1, $B$2, XFD1048576).
 * Returns null if not a cell ref, otherwise returns parsed info.
 */
function parseCellRef(
  s: string
): { col: string; row: string; colAbsolute: boolean; rowAbsolute: boolean } | null {
  let i = 0;
  let colAbsolute = false;
  let rowAbsolute = false;

  if (i < s.length && s[i] === "$") {
    colAbsolute = true;
    i++;
  }

  const colStart = i;
  while (i < s.length && isAsciiAlpha(s[i])) {
    i++;
  }
  const colPart = s.slice(colStart, i).toUpperCase();
  if (colPart.length === 0 || colPart.length > 3) {
    return null;
  }
  // Validate column is <= XFD
  if (colPart.length === 3 && colPart > "XFD") {
    return null;
  }

  if (i < s.length && s[i] === "$") {
    rowAbsolute = true;
    i++;
  }

  const rowStart = i;
  while (i < s.length && isDigit(s[i])) {
    i++;
  }
  const rowPart = s.slice(rowStart, i);
  if (rowPart.length === 0 || i !== s.length) {
    return null;
  }
  const rowNum = parseInt(rowPart, 10);
  if (rowNum < 1 || rowNum > 1048576) {
    return null;
  }

  return { col: colPart, row: rowPart, colAbsolute, rowAbsolute };
}

// ============================================================================
// Structured Reference Bracket Parser
// ============================================================================

/** Valid special items in structured references */
const STRUCTURED_REF_SPECIALS = new Set(["#All", "#Data", "#Headers", "#Totals", "#This Row"]);

/**
 * Parse the bracketed portion of a structured reference starting at position `pos`.
 * `pos` must point to the opening `[`.
 *
 * Handles:
 *   [Column]                    → simple column
 *   [#Headers]                  → special item
 *   [[#Headers],[Column]]       → nested: special + column
 *   [[#This Row],[Column]]      → nested: special + column
 *   [[Col1]:[Col2]]             → column range
 *   [@Column]                   → shorthand for [#This Row],[Column]
 *   [@[Column]]                 → alternative shorthand
 *
 * Returns parsed specials, columns, and the position after the closing `]`.
 */
function parseStructuredRefBrackets(
  formula: string,
  pos: number
): { specials: string[]; columns: string[]; end: number } {
  const len = formula.length;
  if (pos >= len || formula[pos] !== "[") {
    throw new FormulaParseError("Expected '['", pos);
  }

  const specials: string[] = [];
  const columns: string[] = [];
  let i = pos + 1; // skip opening [

  // Skip whitespace inside brackets
  i = skipHorizontalWhitespace(formula, i, len);

  // Check for @ shorthand: [@Column] or [@[Column]]
  if (i < len && formula[i] === "@") {
    specials.push("#This Row");
    i++; // skip @
    // Skip whitespace
    i = skipHorizontalWhitespace(formula, i, len);
    if (i < len && formula[i] === "[") {
      // [@[Column]] form — inner bracketed column name
      i++; // skip [
      const colName = readBracketedItem(formula, i);
      columns.push(colName.value);
      i = colName.end; // after inner ]
    } else if (i < len && formula[i] !== "]") {
      // [@Column] form — unbracketed column name until ]
      const start = i;
      while (i < len && formula[i] !== "]") {
        i++;
      }
      const name = formula.slice(start, i).trim();
      if (name.length > 0) {
        columns.push(name);
      }
    }
    // Skip whitespace before closing ]
    i = skipHorizontalWhitespace(formula, i, len);
    if (i < len && formula[i] === "]") {
      i++; // skip closing ]
    }
    return { specials, columns, end: i };
  }

  // Check for nested brackets: [[...],[...]] or [[Col1]:[Col2]]
  if (i < len && formula[i] === "[") {
    // Parse comma-separated inner bracket items
    while (i < len && formula[i] === "[") {
      const item = readBracketedItem(formula, i + 1);
      const value = item.value;
      i = item.end; // after the inner ]

      if (STRUCTURED_REF_SPECIALS.has(value)) {
        specials.push(value);
      } else {
        columns.push(value);
      }

      // Skip whitespace
      i = skipHorizontalWhitespace(formula, i, len);

      // Check for : (column range) or , (next item)
      if (i < len && formula[i] === ":") {
        i++; // skip :
        // Skip whitespace
        i = skipHorizontalWhitespace(formula, i, len);
        // Next must be a [Column]
        if (i < len && formula[i] === "[") {
          const item2 = readBracketedItem(formula, i + 1);
          columns.push(item2.value);
          i = item2.end;
        }
        // Skip whitespace
        i = skipHorizontalWhitespace(formula, i, len);
      } else if (i < len && formula[i] === ",") {
        i++; // skip ,
        // Skip whitespace
        i = skipHorizontalWhitespace(formula, i, len);
      }
    }

    // Skip whitespace before closing ]
    i = skipHorizontalWhitespace(formula, i, len);
    if (i < len && formula[i] === "]") {
      i++; // skip outer closing ]
    }
    return { specials, columns, end: i };
  }

  // Check for special item: [#Headers], [#Data], etc.
  if (i < len && formula[i] === "#") {
    const start = i;
    while (i < len && formula[i] !== "]") {
      i++;
    }
    const value = formula.slice(start, i).trim();
    if (STRUCTURED_REF_SPECIALS.has(value)) {
      specials.push(value);
    } else {
      // Unknown `[#Something]` is an error, not a silent no-op. Stash
      // the invalid string so the binder can route it to #NAME?; doing
      // this the other way (returning an empty specials+columns) would
      // alias to the default data range and silently mis-evaluate. We
      // use a sentinel prefix that can never match a real special so
      // downstream code distinguishes it unambiguously.
      specials.push(`#__INVALID__:${value}`);
    }
    if (i < len && formula[i] === "]") {
      i++; // skip closing ]
    }
    return { specials, columns, end: i };
  }

  // Simple column reference: [Column]
  const start = i;
  while (i < len && formula[i] !== "]") {
    i++;
  }
  const name = formula.slice(start, i).trim();
  if (name.length > 0) {
    columns.push(name);
  }
  if (i < len && formula[i] === "]") {
    i++; // skip closing ]
  }
  return { specials, columns, end: i };
}

/**
 * Read a single bracketed item starting after the opening `[`.
 * Returns the text content and position after the closing `]`.
 * Handles nested `'` escaping within bracket content (Excel uses `'` to escape
 * special chars like `]`, `[`, `#` inside column names — but this is rare).
 */
function readBracketedItem(formula: string, pos: number): { value: string; end: number } {
  const len = formula.length;
  let i = pos;
  let result = "";
  while (i < len && formula[i] !== "]") {
    if (formula[i] === "'" && i + 1 < len) {
      // Escape: the next character is literal
      result += formula[i + 1];
      i += 2;
    } else {
      result += formula[i];
      i++;
    }
  }
  if (i < len && formula[i] === "]") {
    i++; // skip ]
  }
  return { value: result.trim(), end: i };
}

// ============================================================================
// Tokenizer
// ============================================================================

/**
 * Tokenise formula text, with or without the leading `=` a user types.
 *
 * **Both spellings occur and neither is wrong.** A spreadsheet UI shows `=B5+B6`, an OOXML `<f>`
 * element holds `B5+B6`, and a caller of this library writes whichever they were thinking of — so
 * formula text arriving here has a leading `=` about four times out of five, measured across every
 * workbook the examples produce (205 of 252).
 *
 * Rejecting those was not a small inconvenience. The XLSB writer tokenises before it can emit a
 * token stream, so every one of those formulas was refused, reported as inexpressible and written as
 * a blank — two hundred valid formulas silently degraded because of one character. Handling it in
 * the tokeniser rather than at each call site is what stops the next consumer from rediscovering it.
 */
export function tokenize(formula: string): Token[] {
  const tokens: Token[] = [];
  // Leading whitespace then an optional `=`, which is notation rather than an operator: nothing in
  // the grammar below can begin with one, so there is no ambiguity to resolve.
  const start = /^\s*=/.exec(formula);
  let i = start === null ? 0 : start[0].length;
  const len = formula.length;

  // Track whether previous token could produce a value
  // (used to distinguish unary vs binary +/-)
  function lastTokenIsValue(): boolean {
    if (tokens.length === 0) {
      return false;
    }
    const last = tokens[tokens.length - 1];
    return (
      last.type === TokenType.Number ||
      last.type === TokenType.String ||
      last.type === TokenType.Boolean ||
      last.type === TokenType.CellRef ||
      last.type === TokenType.Range ||
      last.type === TokenType.CloseParen ||
      last.type === TokenType.CloseBrace ||
      last.type === TokenType.Percent ||
      last.type === TokenType.Name ||
      last.type === TokenType.Error ||
      last.type === TokenType.ColRange ||
      last.type === TokenType.RowRange ||
      last.type === TokenType.StructuredRef
    );
  }

  /**
   * True if the previous token produces a reference (cell / range / area).
   * Used to detect Excel's intersection operator — a whitespace character
   * that separates two refs (e.g. `A1:A10 B1:B10`).
   *
   * Intentionally narrower than {@link lastTokenIsValue}: scalars (numbers,
   * strings, booleans, errors) are not references, so whitespace that
   * follows them must not be treated as an intersection operator.
   */
  function lastTokenIsRef(): boolean {
    if (tokens.length === 0) {
      return false;
    }
    const last = tokens[tokens.length - 1];
    return (
      last.type === TokenType.CellRef ||
      last.type === TokenType.Range ||
      last.type === TokenType.ColRange ||
      last.type === TokenType.RowRange ||
      last.type === TokenType.StructuredRef ||
      last.type === TokenType.CloseParen ||
      last.type === TokenType.Name
    );
  }

  /**
   * True if `ch` can start a reference-producing token: a cell ref, range,
   * sheet-qualified ref (`Sheet!`, `'Sheet'!`), named range, external ref,
   * or a parenthesised ref expression.
   */
  function couldStartRef(ch: string): boolean {
    return isAlpha(ch) || ch === "$" || ch === "_" || ch === "'" || ch === "[" || ch === "(";
  }

  while (i < len) {
    const ch = formula[i];

    // Whitespace — normally ignored, but between two refs it is Excel's
    // intersection operator (e.g. `A1:A10 B1:B10` → intersection of areas).
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      // Consume every consecutive whitespace character in one go.
      while (i < len) {
        const c = formula[i];
        if (c === " " || c === "\t" || c === "\n" || c === "\r") {
          i++;
        } else {
          break;
        }
      }
      // Emit an intersection token only when the previous token is a ref
      // AND the next character can start another ref. Emits at most one
      // token per whitespace run.
      if (i < len && lastTokenIsRef() && couldStartRef(formula[i])) {
        tokens.push({ type: TokenType.Intersect });
      }
      continue;
    }

    // String literals
    if (ch === '"') {
      i++; // skip opening quote
      // Fast path: walk forward looking for a closing quote. In the common
      // case (no escaped quotes) we emit a single `slice` rather than
      // growing a string byte by byte. The slow path falls back to the
      // explicit escape-aware concat when we actually see `""`.
      const start = i;
      let closed = false;
      let firstEscape = -1;
      while (i < len) {
        if (formula[i] === '"') {
          if (i + 1 < len && formula[i + 1] === '"') {
            firstEscape = i;
            break;
          }
          closed = true;
          break;
        }
        i++;
      }
      let str: string;
      if (firstEscape !== -1) {
        // At least one escaped quote — use the classic byte-by-byte loop
        // starting from the first escape so the prefix can still come
        // from `slice`.
        str = formula.slice(start, firstEscape);
        i = firstEscape;
        while (i < len) {
          if (formula[i] === '"') {
            if (i + 1 < len && formula[i + 1] === '"') {
              str += '"';
              i += 2;
            } else {
              i++;
              closed = true;
              break;
            }
          } else {
            str += formula[i];
            i++;
          }
        }
      } else if (closed) {
        str = formula.slice(start, i);
        i++; // consume closing quote
      } else {
        str = formula.slice(start, i);
      }
      if (!closed) {
        // Unterminated string literal — reject at tokenize time so we
        // never hand the parser a truncated value that could alias to a
        // different formula. Excel rejects this outright.
        throw new FormulaParseError("Unterminated string literal", i);
      }
      tokens.push({ type: TokenType.String, value: str });
      continue;
    }

    // Error literals (#N/A, #REF!, #DIV/0!, etc.)
    // Match greedily against the known Excel error literals (case-insensitive),
    // preferring the longest match so that "#N/A" isn't parsed as "#N" + "/A".
    if (ch === "#") {
      const matched = matchErrorLiteral(formula, i);
      if (matched) {
        tokens.push({ type: TokenType.Error, value: matched.value });
        i = matched.end;
        continue;
      }
      // Fallback: consume through any unknown `#...` token and emit it
      // as a #NAME? error. Unknown error literals (`#FOOBAR!`) are what
      // Excel itself surfaces as #NAME?, and consumers downstream
      // whitelist a fixed set of error codes — letting arbitrary strings
      // like `#FOOBAR!` or bare `#` leak through breaks their enum
      // checks. Normalising to #NAME? here keeps error propagation safe.
      i++;
      while (
        i < len &&
        formula[i] !== " " &&
        formula[i] !== "," &&
        formula[i] !== ")" &&
        formula[i] !== "+" &&
        formula[i] !== "-" &&
        formula[i] !== "*" &&
        formula[i] !== "/" &&
        formula[i] !== "^" &&
        formula[i] !== "&" &&
        formula[i] !== "=" &&
        formula[i] !== "<" &&
        formula[i] !== ">" &&
        formula[i] !== "}"
      ) {
        i++;
      }
      tokens.push({ type: TokenType.Error, value: "#NAME?" });
      continue;
    }

    // External workbook reference: [Book.xlsx]Sheet!A1
    // When [ appears and is NOT preceded by a value token (not array literal context),
    // consume the bracketed workbook name and subsequent sheet!ref as a Name token.
    // This allows the engine to fall back to cached results gracefully.
    //
    // But: a bare [...] can also be a standalone structured reference
    // ([@Col], [#Headers], [[#This Row],[Col]], [Column Name]). Only treat it
    // as an external ref when it really is followed by a `Sheet!` suffix;
    // otherwise fall through to the structured-reference branch below.
    if (ch === "[" && !lastTokenIsValue()) {
      // Peek at first non-whitespace char after [ — @ or # always means a
      // structured reference, never an external workbook reference.
      const peek = skipHorizontalWhitespace(formula, i + 1, len);
      const firstCh = peek < len ? formula[peek] : "";
      const looksStructured = firstCh === "@" || firstCh === "#" || firstCh === "[";

      if (!looksStructured) {
        // Try to parse as an external ref: [WorkbookName]Sheet!...
        let scan = i + 1;
        let hasClose = false;
        while (scan < len) {
          if (formula[scan] === "]") {
            hasClose = true;
            scan++;
            break;
          }
          scan++;
        }
        // Validate: after the closing ], we must see a sheet name (or quoted
        // sheet name) followed by `!`. Otherwise this isn't an external ref.
        let isExternal = false;
        if (hasClose && scan < len) {
          let p = scan;
          if (formula[p] === "'") {
            // Quoted sheet name — scan to matching '
            p++;
            while (p < len) {
              if (formula[p] === "'") {
                if (p + 1 < len && formula[p + 1] === "'") {
                  p += 2;
                } else {
                  p++;
                  break;
                }
              } else {
                p++;
              }
            }
            if (p < len && formula[p] === "!") {
              isExternal = true;
            }
          } else {
            // Unquoted sheet name — identifier chars, then !
            const sheetStart = p;
            while (p < len && (isAlphaNumOrUnderscore(formula[p]) || formula[p] === "$")) {
              p++;
            }
            if (p > sheetStart && p < len && formula[p] === "!") {
              isExternal = true;
            }
          }
        }

        if (isExternal) {
          // External workbook references are unsupported — consume the full
          // ref syntax (including any `:CELL` range suffix) so downstream
          // tokens aren't polluted, then emit a single `#REF!` error token.
          // The boundary logic preserved here matches the pre-simplification
          // tokenizer exactly so the range of characters consumed is stable.
          i = scan;
          while (
            i < len &&
            formula[i] !== "+" &&
            formula[i] !== "-" &&
            formula[i] !== "*" &&
            formula[i] !== "/" &&
            formula[i] !== "^" &&
            formula[i] !== "&" &&
            formula[i] !== "=" &&
            formula[i] !== "<" &&
            formula[i] !== ">" &&
            formula[i] !== ")" &&
            formula[i] !== "," &&
            formula[i] !== " " &&
            formula[i] !== "}" &&
            formula[i] !== ":" &&
            formula[i] !== "%" &&
            formula[i] !== ";" &&
            formula[i] !== "{"
          ) {
            i++;
          }
          // Extend consumption through `:CELL` if this is a range form
          // like [Book]Sheet!A1:A5. Without this, `:` would split the
          // external ref and pollute downstream tokens.
          if (i < len && formula[i] === ":") {
            let q = i + 1;
            // Optional $ absolute markers, column letters, optional $, row digits
            if (q < len && formula[q] === "$") {
              q++;
            }
            const colStart = q;
            while (q < len && isAsciiAlpha(formula[q])) {
              q++;
            }
            if (q > colStart) {
              if (q < len && formula[q] === "$") {
                q++;
              }
              const rowStart = q;
              while (q < len && isDigit(formula[q])) {
                q++;
              }
              if (q > rowStart) {
                // Valid `:CELL` suffix — consume it as part of the ref
                i = q;
              }
            }
          }
          tokens.push({ type: TokenType.Error, value: "#REF!" });
          continue;
        }
        // Not an external ref — fall through to the structured-reference
        // branch below, which handles bare [Column Name] etc.
      }
    }

    // Array constant braces
    if (ch === "{") {
      tokens.push({ type: TokenType.OpenBrace });
      i++;
      continue;
    }
    if (ch === "}") {
      tokens.push({ type: TokenType.CloseBrace });
      i++;
      continue;
    }

    // Semicolons (array row separator)
    if (ch === ";") {
      tokens.push({ type: TokenType.Semicolon });
      i++;
      continue;
    }

    // Numbers (and potential whole-row ranges like 1:5)
    if (isDigit(ch) || (ch === "." && i + 1 < len && isDigit(formula[i + 1]))) {
      const start = i;
      while (i < len && isDigit(formula[i])) {
        i++;
      }
      // Check for whole-row range: pure integer followed by : and another integer
      const isInteger = i > start && formula[start] !== "." && i < len && formula[i] === ":";
      if (isInteger) {
        const row1Str = formula.slice(start, i);
        const row1 = parseInt(row1Str, 10);
        if (row1 >= 1 && row1 <= 1048576) {
          const colonPos = i;
          i++; // skip :
          // Optional $ before second row number
          const start2 = i;
          if (i < len && formula[i] === "$") {
            i++;
          }
          const rowStart2 = i;
          while (i < len && isDigit(formula[i])) {
            i++;
          }
          if (i > rowStart2) {
            const row2Str = formula.slice(rowStart2, i);
            const row2 = parseInt(row2Str, 10);
            if (row2 >= 1 && row2 <= 1048576) {
              tokens.push({
                type: TokenType.RowRange,
                value: row1Str + ":" + formula.slice(start2, i)
              });
              continue;
            }
          }
          // Not a valid row range, backtrack
          i = colonPos;
        }
      }
      // Fractional part — only consume the `.` when at least one digit
      // follows. This prevents "1..2" from being tokenised as "1." + ".2"
      // with the first `.` silently absorbed into the integer number.
      if (i < len && formula[i] === "." && i + 1 < len && isDigit(formula[i + 1])) {
        i++;
        while (i < len && isDigit(formula[i])) {
          i++;
        }
      }
      // Scientific notation. Only commit to consuming `e[+-]?` when at least
      // one digit actually follows — otherwise restore position and stop the
      // number here, so `1e` or `1e+` don't parse as the number `1`.
      if (i < len && (formula[i] === "E" || formula[i] === "e")) {
        const expStart = i;
        let j = i + 1;
        if (j < len && (formula[j] === "+" || formula[j] === "-")) {
          j++;
        }
        if (j < len && isDigit(formula[j])) {
          // Commit: consume e, optional sign, and the digit run.
          i = j;
          while (i < len && isDigit(formula[i])) {
            i++;
          }
        } else {
          // Not a valid exponent — leave the `e`/`E` for the identifier lexer.
          i = expStart;
        }
      }
      tokens.push({ type: TokenType.Number, value: formula.slice(start, i) });
      continue;
    }

    // Quoted sheet name: 'Sheet Name'! or 3D ref 'Sheet1:Sheet3'!
    if (ch === "'") {
      i++; // skip opening quote
      // Fast path: scan to the first `'` — most sheet names don't contain
      // an escaped quote, so we can slice the prefix verbatim instead of
      // growing a string byte-by-byte.
      const start = i;
      let firstEscape = -1;
      while (i < len) {
        if (formula[i] === "'") {
          if (i + 1 < len && formula[i + 1] === "'") {
            firstEscape = i;
            break;
          }
          break;
        }
        i++;
      }
      let sheetName: string;
      if (firstEscape !== -1) {
        sheetName = formula.slice(start, firstEscape);
        i = firstEscape;
        // Slow path from the first escape: consume `''` pairs and
        // literal characters until the terminating single `'`.
        while (i < len) {
          if (formula[i] === "'") {
            if (i + 1 < len && formula[i + 1] === "'") {
              sheetName += "'";
              i += 2;
            } else {
              i++;
              break;
            }
          } else {
            sheetName += formula[i];
            i++;
          }
        }
      } else {
        sheetName = formula.slice(start, i);
        if (i < len && formula[i] === "'") {
          i++; // consume closing quote
        }
      }
      // Expect ! after
      if (i < len && formula[i] === "!") {
        i++; // skip !
      }
      // Check for 3D reference: sheetName contains an unquoted colon separating two sheet names
      // e.g. 'Sheet1:Sheet3' → startSheet="Sheet1", endSheet="Sheet3"
      const colonIdx = sheetName.indexOf(":");
      if (colonIdx > 0 && colonIdx < sheetName.length - 1) {
        const startSheet = sheetName.slice(0, colonIdx);
        const endSheet = sheetName.slice(colonIdx + 1);
        tokens.push({
          type: TokenType.SheetRef,
          sheetName: startSheet,
          endSheetName: endSheet
        });
      } else {
        tokens.push({
          type: TokenType.SheetRef,
          sheetName
        });
      }
      continue;
    }

    // Standalone structured reference: [@Column] or [[#This Row],[Column]]
    if (ch === "[") {
      const sr = parseStructuredRefBrackets(formula, i);
      tokens.push({
        type: TokenType.StructuredRef,
        tableName: "",
        columns: sr.columns,
        specials: sr.specials
      });
      i = sr.end;
      continue;
    }

    // Identifiers: cell refs, function names, booleans, named ranges, sheet refs
    if (isAlpha(ch) || ch === "$" || ch === "_") {
      const start = i;

      // Collect $-prefixed or alpha-numeric identifier
      while (i < len && (isAlphaNumOrUnderscore(formula[i]) || formula[i] === "$")) {
        i++;
      }

      const word = formula.slice(start, i);

      // Check for sheet reference: WORD!
      if (i < len && formula[i] === "!") {
        i++; // skip !
        tokens.push({
          type: TokenType.SheetRef,
          sheetName: word
        });
        continue;
      }

      // Check for 3D sheet reference: WORD:WORD!<ref>
      // (e.g. Sheet1:Sheet3!A1, Q1:Q4!A1).
      //
      // Priority rule: when we see `WORD:WORD!` followed by an actual
      // cell/range reference, that whole prefix is a 3D SheetRef —
      // even when the first WORD looks like a cell reference on its
      // own (sheet names like "Q1" are common). Previously we bailed
      // out of this branch whenever `parseCellRef(word) !== null`,
      // which left workbooks with sheets named Q1..Q4 unable to use
      // 3D formulas.
      //
      // The fallback path below (RangeRef for `A1:B2`-shaped inputs)
      // still fires when there is NO `!` — the lookahead disambiguates
      // the two cases cleanly.
      if (i < len && formula[i] === ":") {
        const colonPos3D = i;
        let j = i + 1;
        // Collect the second sheet name (alphanumeric + underscore + .)
        while (j < len && (isAlphaNumOrUnderscore(formula[j]) || formula[j] === "$")) {
          j++;
        }
        if (j > colonPos3D + 1 && j < len && formula[j] === "!") {
          const endSheet = formula.slice(colonPos3D + 1, j);
          // Peek past `!` — accept the 3D reading only if a recognisable
          // cell or range reference follows. Otherwise fall through
          // so `A1:A3` (no trailing `!`) keeps its RangeRef reading.
          const afterBang = j + 1;
          if (afterBang < len && looksLikeCellRefStart(formula, afterBang)) {
            i = afterBang; // skip past !
            tokens.push({
              type: TokenType.SheetRef,
              sheetName: word,
              endSheetName: endSheet
            });
            continue;
          }
        }
      }

      // Check for structured reference: WORD[...]
      if (i < len && formula[i] === "[") {
        const sr = parseStructuredRefBrackets(formula, i);
        tokens.push({
          type: TokenType.StructuredRef,
          tableName: word,
          columns: sr.columns,
          specials: sr.specials
        });
        i = sr.end;
        continue;
      }

      // Check for function call: WORD(
      if (i < len && formula[i] === "(") {
        tokens.push({ type: TokenType.Function, name: word.toUpperCase() });
        // Don't consume the '(' — it will be consumed in the next iteration
        continue;
      }

      // Check for boolean literals
      const upper = word.toUpperCase();
      if (upper === "TRUE" || upper === "FALSE") {
        tokens.push({ type: TokenType.Boolean, value: upper as "TRUE" | "FALSE" });
        continue;
      }

      // Check for cell reference
      const ref = parseCellRef(word);
      if (ref) {
        const cellToken: Token = {
          type: TokenType.CellRef,
          col: ref.col,
          row: ref.row,
          colAbsolute: ref.colAbsolute,
          rowAbsolute: ref.rowAbsolute
        };
        tokens.push(cellToken);
        // Check if this is part of a range (A1:B2)
        if (i < len && formula[i] === ":") {
          // Peek ahead for another cell ref
          const colonPos = i;
          i++; // skip :
          const rangeStart = i;
          while (i < len && (isAlphaNumOrUnderscore(formula[i]) || formula[i] === "$")) {
            i++;
          }
          const secondWord = formula.slice(rangeStart, i);
          const ref2 = parseCellRef(secondWord);
          if (ref2) {
            // It's a range — replace the last CellRef token with a Range token
            tokens[tokens.length - 1] = {
              type: TokenType.Range,
              value:
                (ref.colAbsolute ? "$" : "") +
                ref.col +
                (ref.rowAbsolute ? "$" : "") +
                ref.row +
                ":" +
                (ref2.colAbsolute ? "$" : "") +
                ref2.col +
                (ref2.rowAbsolute ? "$" : "") +
                ref2.row
            };
          } else {
            // Not a valid range, push : as operator and backtrack
            i = colonPos; // backtrack — let : be handled normally
          }
        }
        continue;
      }

      // Otherwise it's a named range / defined name — but check for whole-column range first (A:B, $A:$B)
      // A whole-column ref looks like: [pure-alpha or $+alpha] followed by ':'
      if (i < len && formula[i] === ":") {
        // Check if 'word' is a pure column reference (optional $ + letters only, no digits)
        const colRefMatch = /^(\$?)([A-Za-z]{1,3})$/.exec(word);
        if (colRefMatch) {
          const col1Abs = colRefMatch[1] === "$";
          const col1 = colRefMatch[2].toUpperCase();
          // Validate column <= XFD
          if (col1.length <= 3 && (col1.length < 3 || col1 <= "XFD")) {
            const colonPos = i;
            i++; // skip :
            // Read the second column ref
            const start2 = i;
            if (i < len && formula[i] === "$") {
              i++;
            }
            const colStart2 = i;
            while (i < len && isAsciiAlpha(formula[i])) {
              i++;
            }
            // Ensure it's ONLY letters (no digits follow = not a cell ref)
            const afterLetters = i;
            const isFollowedByDigit = i < len && isDigit(formula[i]);
            if (!isFollowedByDigit && afterLetters > colStart2) {
              const part2 = formula.slice(start2, i);
              const col2Match = /^(\$?)([A-Za-z]{1,3})$/.exec(part2);
              if (col2Match) {
                const col2 = col2Match[2].toUpperCase();
                if (col2.length <= 3 && (col2.length < 3 || col2 <= "XFD")) {
                  tokens.push({
                    type: TokenType.ColRange,
                    value: (col1Abs ? "$" : "") + col1 + ":" + part2.toUpperCase()
                  });
                  continue;
                }
              }
            }
            // Not a valid column range, backtrack
            i = colonPos;
          }
        }
        // Check for absolute whole-row range: $1:$5
        const absRowMatch = /^(\$)(\d+)$/.exec(word);
        if (absRowMatch) {
          const row1 = parseInt(absRowMatch[2], 10);
          if (row1 >= 1 && row1 <= 1048576) {
            const colonPos = i;
            i++; // skip :
            const start2 = i;
            if (i < len && formula[i] === "$") {
              i++;
            }
            const rowStart2 = i;
            while (i < len && isDigit(formula[i])) {
              i++;
            }
            if (i > rowStart2) {
              const row2 = parseInt(formula.slice(rowStart2, i), 10);
              if (row2 >= 1 && row2 <= 1048576) {
                tokens.push({
                  type: TokenType.RowRange,
                  value: word + ":" + formula.slice(start2, i)
                });
                continue;
              }
            }
            i = colonPos;
          }
        }
      }
      tokens.push({ type: TokenType.Name, value: word });
      continue;
    }

    // Operators and punctuation
    if (ch === "(") {
      tokens.push({ type: TokenType.OpenParen });
      i++;
      continue;
    }
    if (ch === ")") {
      tokens.push({ type: TokenType.CloseParen });
      i++;
      continue;
    }
    if (ch === ",") {
      tokens.push({ type: TokenType.Comma });
      i++;
      continue;
    }
    if (ch === ":") {
      tokens.push({ type: TokenType.Colon });
      i++;
      continue;
    }
    if (ch === "%") {
      tokens.push({ type: TokenType.Percent });
      i++;
      continue;
    }

    // Multi-character operators
    if (ch === "<") {
      if (i + 1 < len && formula[i + 1] === "=") {
        tokens.push({ type: TokenType.Operator, value: "<=" });
        i += 2;
        continue;
      }
      if (i + 1 < len && formula[i + 1] === ">") {
        tokens.push({ type: TokenType.Operator, value: "<>" });
        i += 2;
        continue;
      }
      tokens.push({ type: TokenType.Operator, value: "<" });
      i++;
      continue;
    }
    if (ch === ">") {
      if (i + 1 < len && formula[i + 1] === "=") {
        tokens.push({ type: TokenType.Operator, value: ">=" });
        i += 2;
        continue;
      }
      tokens.push({ type: TokenType.Operator, value: ">" });
      i++;
      continue;
    }
    if (ch === "=") {
      tokens.push({ type: TokenType.Operator, value: "=" });
      i++;
      continue;
    }
    if (ch === "&") {
      tokens.push({ type: TokenType.Operator, value: "&" });
      i++;
      continue;
    }
    if (ch === "^") {
      tokens.push({ type: TokenType.Operator, value: "^" });
      i++;
      continue;
    }
    if (ch === "*") {
      tokens.push({ type: TokenType.Operator, value: "*" });
      i++;
      continue;
    }
    if (ch === "/") {
      tokens.push({ type: TokenType.Operator, value: "/" });
      i++;
      continue;
    }

    // + and - : unary or binary
    if (ch === "+" || ch === "-") {
      if (!lastTokenIsValue()) {
        tokens.push({ type: TokenType.UnaryPrefix, value: ch });
      } else {
        tokens.push({ type: TokenType.Operator, value: ch });
      }
      i++;
      continue;
    }

    // @ implicit intersection prefix (Excel 365)
    if (ch === "@") {
      tokens.push({ type: TokenType.AtSign });
      i++;
      continue;
    }

    // Unknown character — skip
    i++;
  }

  return tokens;
}

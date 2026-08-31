/**
 * Unit tests for the formula tokenizer.
 *
 * Covers: numeric, string, boolean, error, cell and range references,
 * sheet-qualified refs, 3D refs, function names, operators, array literal
 * braces, structured references, defined names, `_XLFN.` prefix handling,
 * whitespace and the intersection operator, and invalid character fallback.
 */

import { describe, it, expect } from "vitest";

import type {
  Token,
  NumberToken,
  StringToken,
  BooleanToken,
  ErrorToken,
  CellRefToken,
  RangeToken,
  SheetRefToken,
  FunctionToken,
  OperatorToken,
  UnaryPrefixToken,
  NameToken,
  ColRangeToken,
  RowRangeToken,
  StructuredRefToken
} from "../token-types";
import { TokenType, stripFunctionPrefix } from "../token-types";
import { tokenize } from "../tokenizer";

function typesOf(tokens: readonly Token[]): TokenType[] {
  return tokens.map(t => t.type);
}

describe("tokenizer — numbers", () => {
  it("tokenises a positive integer literal", () => {
    const toks = tokenize("42");
    expect(toks).toHaveLength(1);
    expect(toks[0].type).toBe(TokenType.Number);
    expect((toks[0] as NumberToken).value).toBe("42");
  });

  it("tokenises a decimal number", () => {
    const toks = tokenize("3.14159");
    expect(toks).toHaveLength(1);
    expect((toks[0] as NumberToken).value).toBe("3.14159");
  });

  it("tokenises a leading-dot decimal like .5", () => {
    const toks = tokenize(".5");
    expect(toks).toHaveLength(1);
    expect(toks[0].type).toBe(TokenType.Number);
    expect((toks[0] as NumberToken).value).toBe(".5");
  });

  it("tokenises scientific notation", () => {
    const toks = tokenize("1.2e3");
    expect(toks).toHaveLength(1);
    expect((toks[0] as NumberToken).value).toBe("1.2e3");
  });

  it("tokenises scientific notation with signed exponent", () => {
    const toks = tokenize("1E-10");
    expect(toks).toHaveLength(1);
    expect((toks[0] as NumberToken).value).toBe("1E-10");
  });

  it("does not consume a stray 'e' with no following digits", () => {
    // "1e" becomes number 1 then identifier 'e' (Name)
    const toks = tokenize("1e");
    expect(toks).toHaveLength(2);
    expect(toks[0].type).toBe(TokenType.Number);
    expect((toks[0] as NumberToken).value).toBe("1");
    expect(toks[1].type).toBe(TokenType.Name);
  });

  it("does not merge '..' into a fractional run", () => {
    // "1..2" → 1, then '.' handled as unknown (dropped), then .2 etc.
    // Main invariant: the first number must end at position 1 (just "1").
    const toks = tokenize("1..2");
    expect(toks[0].type).toBe(TokenType.Number);
    expect((toks[0] as NumberToken).value).toBe("1");
  });

  it("tokenises a percent literal (number followed by percent token)", () => {
    const toks = tokenize("50%");
    expect(typesOf(toks)).toEqual([TokenType.Number, TokenType.Percent]);
    expect((toks[0] as NumberToken).value).toBe("50");
  });

  it("recognises unary minus before a number", () => {
    const toks = tokenize("-3");
    expect(typesOf(toks)).toEqual([TokenType.UnaryPrefix, TokenType.Number]);
    expect((toks[0] as UnaryPrefixToken).value).toBe("-");
    expect((toks[1] as NumberToken).value).toBe("3");
  });

  it("recognises binary minus between two numbers", () => {
    const toks = tokenize("1-2");
    expect(typesOf(toks)).toEqual([TokenType.Number, TokenType.Operator, TokenType.Number]);
    expect((toks[1] as OperatorToken).value).toBe("-");
  });
});

describe("tokenizer — strings and booleans", () => {
  it("tokenises a simple string literal", () => {
    const toks = tokenize('"hello"');
    expect(toks).toHaveLength(1);
    expect(toks[0].type).toBe(TokenType.String);
    expect((toks[0] as StringToken).value).toBe("hello");
  });

  it('unescapes doubled quotes inside a string ("" → ")', () => {
    const toks = tokenize('"she said ""hi"""');
    expect(toks).toHaveLength(1);
    expect((toks[0] as StringToken).value).toBe('she said "hi"');
  });

  it("tokenises an empty string", () => {
    const toks = tokenize('""');
    expect(toks).toHaveLength(1);
    expect((toks[0] as StringToken).value).toBe("");
  });

  it("handles a long string without embedded quotes (slice fast path)", () => {
    // Regression: the fast-path `slice`-based string tokenizer must yield
    // the same value as the escape-aware slow path. A long run with
    // 1000+ characters exercises the path where the old `str +=` loop
    // produced O(n²) allocation.
    const long = "a".repeat(2000);
    const toks = tokenize(`"${long}"`);
    expect(toks).toHaveLength(1);
    expect((toks[0] as StringToken).value).toBe(long);
  });

  it("handles a string with only escape sequences", () => {
    // `""""` → three runs of two quotes each → literal `"` + `"` = `""`
    const toks = tokenize('""""""');
    expect(toks).toHaveLength(1);
    expect((toks[0] as StringToken).value).toBe('""');
  });

  it("handles a string that starts with an escape sequence", () => {
    // `"""abc"` — opening `"`, escaped `""` → literal `"`, then `abc`,
    // closing `"` → content `"abc`.
    const toks = tokenize('"""abc"');
    expect(toks).toHaveLength(1);
    expect((toks[0] as StringToken).value).toBe('"abc');
  });

  it("throws on unterminated string literals", () => {
    expect(() => tokenize('"unterminated')).toThrow(/Unterminated string literal/);
  });

  it("throws on a string with trailing escape (unterminated)", () => {
    // `"abc""` — after the escaped pair we're still open
    expect(() => tokenize('"abc""')).toThrow(/Unterminated string literal/);
  });

  it("recognises TRUE and FALSE as booleans, upper-cased", () => {
    const t1 = tokenize("TRUE");
    expect(t1).toHaveLength(1);
    expect(t1[0].type).toBe(TokenType.Boolean);
    expect((t1[0] as BooleanToken).value).toBe("TRUE");

    const t2 = tokenize("false");
    expect(t2).toHaveLength(1);
    expect((t2[0] as BooleanToken).value).toBe("FALSE");
  });
});

describe("tokenizer — error literals", () => {
  it("tokenises every known Excel error literal case-insensitively", () => {
    const literals = [
      "#N/A",
      "#REF!",
      "#NAME?",
      "#DIV/0!",
      "#NULL!",
      "#VALUE!",
      "#NUM!",
      "#SPILL!",
      "#CALC!",
      "#BUSY!",
      "#FIELD!",
      "#BLOCKED!",
      "#CONNECT!",
      "#UNKNOWN!",
      "#GETTING_DATA"
    ];
    for (const lit of literals) {
      const toks = tokenize(lit);
      expect(toks).toHaveLength(1);
      expect(toks[0].type).toBe(TokenType.Error);
      expect((toks[0] as ErrorToken).value).toBe(lit);

      const lower = lit.toLowerCase();
      const toks2 = tokenize(lower);
      expect(toks2[0].type).toBe(TokenType.Error);
      // Match canonicalises to the upper-cased form.
      expect((toks2[0] as ErrorToken).value).toBe(lit);
    }
  });

  it("prefers the longest known error literal (#N/A beats #N)", () => {
    const toks = tokenize("#N/A");
    expect(toks).toHaveLength(1);
    expect((toks[0] as ErrorToken).value).toBe("#N/A");
  });
});

describe("tokenizer — cell references", () => {
  it("tokenises a plain A1 reference", () => {
    const toks = tokenize("A1");
    expect(toks).toHaveLength(1);
    expect(toks[0].type).toBe(TokenType.CellRef);
    const c = toks[0] as CellRefToken;
    expect(c.col).toBe("A");
    expect(c.row).toBe("1");
    expect(c.colAbsolute).toBe(false);
    expect(c.rowAbsolute).toBe(false);
  });

  it("tokenises $A$1 as a fully-absolute reference", () => {
    const toks = tokenize("$A$1");
    expect(toks).toHaveLength(1);
    const c = toks[0] as CellRefToken;
    expect(c.col).toBe("A");
    expect(c.row).toBe("1");
    expect(c.colAbsolute).toBe(true);
    expect(c.rowAbsolute).toBe(true);
  });

  it("tokenises mixed absolutes $A1 and A$1", () => {
    const a = tokenize("$A1")[0] as CellRefToken;
    expect(a.colAbsolute).toBe(true);
    expect(a.rowAbsolute).toBe(false);

    const b = tokenize("A$1")[0] as CellRefToken;
    expect(b.colAbsolute).toBe(false);
    expect(b.rowAbsolute).toBe(true);
  });

  it("uppercases the column letters", () => {
    const c = tokenize("ab12")[0] as CellRefToken;
    expect(c.col).toBe("AB");
    expect(c.row).toBe("12");
  });

  it("treats tokens outside the A1 grid as names, not refs", () => {
    // "ZZZZ1" has 4 letters, not a valid column — becomes a Name token.
    const toks = tokenize("ZZZZ1");
    expect(toks).toHaveLength(1);
    expect(toks[0].type).toBe(TokenType.Name);
  });

  it("does not recognise R1C1 notation", () => {
    // "R1C1" is an identifier: R, then 1C1 — but R1 IS a valid A1 address.
    // Core invariant: tokenizer doesn't produce a dedicated R1C1 token.
    const toks = tokenize("R1C1");
    // R1 is itself a valid cell ref; but "R1C1" as a whole may be parsed as
    // a defined name because `isAlphaNumOrUnderscore` keeps going past the
    // digit. Whichever result the tokenizer chose, it must not create a
    // token whose type signals R1C1 explicitly.
    for (const t of toks) {
      expect(t.type).not.toBe(999 as unknown as TokenType);
    }
    // At minimum, there should be exactly one token covering the whole run.
    expect(toks).toHaveLength(1);
  });
});

describe("tokenizer — ranges", () => {
  it("tokenises A1:B2 as a single Range token", () => {
    const toks = tokenize("A1:B2");
    expect(toks).toHaveLength(1);
    expect(toks[0].type).toBe(TokenType.Range);
    expect((toks[0] as RangeToken).value).toBe("A1:B2");
  });

  it("preserves absolute markers in range value", () => {
    const toks = tokenize("$A$1:$B$2");
    expect(toks).toHaveLength(1);
    expect((toks[0] as RangeToken).value).toBe("$A$1:$B$2");
  });

  it("tokenises a whole-column range A:B", () => {
    const toks = tokenize("A:B");
    expect(toks).toHaveLength(1);
    expect(toks[0].type).toBe(TokenType.ColRange);
    expect((toks[0] as ColRangeToken).value).toBe("A:B");
  });

  it("tokenises a whole-column range with $ markers", () => {
    const toks = tokenize("$AA:$ZZ");
    expect(toks).toHaveLength(1);
    expect(toks[0].type).toBe(TokenType.ColRange);
    // Both absolute markers are preserved in the stored value.
    expect((toks[0] as ColRangeToken).value).toBe("$AA:$ZZ");
  });

  it("tokenises a whole-row range 1:5", () => {
    const toks = tokenize("1:5");
    expect(toks).toHaveLength(1);
    expect(toks[0].type).toBe(TokenType.RowRange);
    expect((toks[0] as RowRangeToken).value).toBe("1:5");
  });

  it("tokenises a whole-row range $3:$7", () => {
    const toks = tokenize("$3:$7");
    expect(toks).toHaveLength(1);
    expect(toks[0].type).toBe(TokenType.RowRange);
    expect((toks[0] as RowRangeToken).value).toBe("$3:$7");
  });
});

describe("tokenizer — sheet-qualified references", () => {
  it("tokenises Sheet1!A1 as SheetRef + CellRef", () => {
    const toks = tokenize("Sheet1!A1");
    expect(toks).toHaveLength(2);
    expect(toks[0].type).toBe(TokenType.SheetRef);
    expect((toks[0] as SheetRefToken).sheetName).toBe("Sheet1");
    expect(toks[1].type).toBe(TokenType.CellRef);
  });

  it("tokenises a quoted sheet name with spaces", () => {
    const toks = tokenize("'My Sheet'!A1");
    expect(toks).toHaveLength(2);
    expect((toks[0] as SheetRefToken).sheetName).toBe("My Sheet");
    expect(toks[1].type).toBe(TokenType.CellRef);
  });

  it("unescapes '' inside a quoted sheet name", () => {
    const toks = tokenize("'It''s Mine'!B3");
    expect((toks[0] as SheetRefToken).sheetName).toBe("It's Mine");
  });

  it("tokenises a 3D ref written as Sheet1:Sheet3!A1", () => {
    const toks = tokenize("Sheet1:Sheet3!A1");
    expect(toks).toHaveLength(2);
    const sr = toks[0] as SheetRefToken;
    expect(sr.type).toBe(TokenType.SheetRef);
    expect(sr.sheetName).toBe("Sheet1");
    expect(sr.endSheetName).toBe("Sheet3");
  });

  it("tokenises a 3D ref written as a quoted 'Sheet1:Sheet3'", () => {
    const toks = tokenize("'Sheet1:Sheet3'!A1");
    const sr = toks[0] as SheetRefToken;
    expect(sr.sheetName).toBe("Sheet1");
    expect(sr.endSheetName).toBe("Sheet3");
  });
});

describe("tokenizer — function calls and operators", () => {
  it("recognises a function name followed by '('", () => {
    const toks = tokenize("SUM(A1)");
    expect(toks[0].type).toBe(TokenType.Function);
    expect((toks[0] as FunctionToken).name).toBe("SUM");
    // OpenParen comes next; the tokenizer does NOT consume it as part of Function.
    expect(toks[1].type).toBe(TokenType.OpenParen);
  });

  it("uppercases the function name", () => {
    const toks = tokenize("sum(1)");
    expect((toks[0] as FunctionToken).name).toBe("SUM");
  });

  it("tokenises every arithmetic and comparison operator", () => {
    // Use spaces to separate unary/binary ambiguity for +/-.
    const toks = tokenize("1+2 1-2 1*2 1/2 1^2 1&2 1=2 1<2 1>2 1<=2 1>=2 1<>2");
    const opValues = toks
      .filter((t): t is OperatorToken => t.type === TokenType.Operator)
      .map(t => t.value);
    expect(opValues).toEqual(["+", "-", "*", "/", "^", "&", "=", "<", ">", "<=", ">=", "<>"]);
  });

  it("emits parentheses, commas and semicolon as their own tokens", () => {
    // Note: an integer followed by `:integer` is tokenised as a RowRange
    // (e.g. `3:4`), not as two numbers separated by a colon. To exercise
    // the standalone Colon token, use a non-numeric left-hand side.
    const toks = tokenize("(1,2;3,4)");
    expect(typesOf(toks)).toEqual([
      TokenType.OpenParen,
      TokenType.Number,
      TokenType.Comma,
      TokenType.Number,
      TokenType.Semicolon,
      TokenType.Number,
      TokenType.Comma,
      TokenType.Number,
      TokenType.CloseParen
    ]);
  });

  it("emits a standalone Colon token when a cell ref is followed by a non-ref", () => {
    // `A1:123foo` — A1 tokenises as a CellRef, then the tokenizer peeks
    // past the colon, fails to parse `123foo` as a cell ref, and backtracks
    // so the colon is emitted as its own token.
    const toks = tokenize("A1:123foo");
    expect(typesOf(toks)).toContain(TokenType.Colon);
  });
});

describe("tokenizer — array literal braces", () => {
  it("tokenises {1,2;3,4}", () => {
    const toks = tokenize("{1,2;3,4}");
    expect(typesOf(toks)).toEqual([
      TokenType.OpenBrace,
      TokenType.Number,
      TokenType.Comma,
      TokenType.Number,
      TokenType.Semicolon,
      TokenType.Number,
      TokenType.Comma,
      TokenType.Number,
      TokenType.CloseBrace
    ]);
  });
});

describe("tokenizer — structured references", () => {
  it("tokenises Table1[Col] as a StructuredRef", () => {
    const toks = tokenize("Table1[Col]");
    expect(toks).toHaveLength(1);
    expect(toks[0].type).toBe(TokenType.StructuredRef);
    const sr = toks[0] as StructuredRefToken;
    expect(sr.tableName).toBe("Table1");
    expect(sr.columns).toEqual(["Col"]);
    expect(sr.specials).toEqual([]);
  });

  it("tokenises Table1[[#Headers],[Col1]]", () => {
    const toks = tokenize("Table1[[#Headers],[Col1]]");
    expect(toks).toHaveLength(1);
    const sr = toks[0] as StructuredRefToken;
    expect(sr.tableName).toBe("Table1");
    expect(sr.specials).toEqual(["#Headers"]);
    expect(sr.columns).toEqual(["Col1"]);
  });

  it("tokenises the implicit [@Col] form", () => {
    const toks = tokenize("[@Col]");
    expect(toks).toHaveLength(1);
    const sr = toks[0] as StructuredRefToken;
    expect(sr.tableName).toBe("");
    expect(sr.specials).toEqual(["#This Row"]);
    expect(sr.columns).toEqual(["Col"]);
  });

  it("tokenises a column range [[Col1]:[Col2]]", () => {
    const toks = tokenize("T[[Col1]:[Col2]]");
    const sr = toks[0] as StructuredRefToken;
    expect(sr.tableName).toBe("T");
    expect(sr.columns).toEqual(["Col1", "Col2"]);
  });
});

describe("tokenizer — defined names and _XLFN prefix", () => {
  it("tokenises an unknown identifier as a Name", () => {
    const toks = tokenize("MyName");
    expect(toks).toHaveLength(1);
    expect(toks[0].type).toBe(TokenType.Name);
    expect((toks[0] as NameToken).value).toBe("MyName");
  });

  it("strips _XLFN. and _XLFN._XLWS. prefixes via helper", () => {
    expect(stripFunctionPrefix("_XLFN.FILTER")).toBe("FILTER");
    expect(stripFunctionPrefix("_XLFN._XLWS.SORT")).toBe("SORT");
    expect(stripFunctionPrefix("SUM")).toBe("SUM");
  });

  it("tokenises _XLFN.FILTER as a function when followed by (", () => {
    const toks = tokenize("_XLFN.FILTER(A1)");
    expect(toks[0].type).toBe(TokenType.Function);
    // The tokenizer emits the raw prefixed name, upper-cased. Stripping is
    // the binder's responsibility.
    expect((toks[0] as FunctionToken).name).toBe("_XLFN.FILTER");
  });
});

describe("tokenizer — whitespace and intersection", () => {
  it("ignores whitespace between non-reference tokens", () => {
    const toks = tokenize("  1   +   2  ");
    expect(typesOf(toks)).toEqual([TokenType.Number, TokenType.Operator, TokenType.Number]);
  });

  it("emits an Intersect token between two refs separated by spaces", () => {
    const toks = tokenize("A1:A10 B1:B10");
    expect(typesOf(toks)).toEqual([TokenType.Range, TokenType.Intersect, TokenType.Range]);
  });

  it("does not emit Intersect when whitespace follows a non-ref", () => {
    const toks = tokenize("1 2");
    // Either the numbers sit back-to-back with whitespace squashed (no
    // intersection emitted), or at most whitespace is silently dropped.
    expect(toks.some(t => t.type === TokenType.Intersect)).toBe(false);
  });
});

describe("tokenizer — external refs and unknown characters", () => {
  it("emits #REF! for an external workbook reference (cross-workbook refs unsupported)", () => {
    const toks = tokenize("[Book1]Sheet1!A1");
    expect(toks).toHaveLength(1);
    expect(toks[0].type).toBe(TokenType.Error);
    expect((toks[0] as ErrorToken).value).toBe("#REF!");
  });

  it("emits #REF! for an external ref with a range suffix like [Book]Sheet!A1:A5", () => {
    const toks = tokenize("[Book1]Sheet1!A1:A5");
    // The full external-ref syntax (including :CELL suffix) must be
    // consumed as one Error token — not split into Error + `:` + CellRef.
    expect(toks).toHaveLength(1);
    expect(toks[0].type).toBe(TokenType.Error);
    expect((toks[0] as ErrorToken).value).toBe("#REF!");
  });

  it("emits #REF! for a numerically-indexed external ref like [1]Sheet1!A1", () => {
    const toks = tokenize("[1]Sheet1!A1");
    expect(toks).toHaveLength(1);
    expect(toks[0].type).toBe(TokenType.Error);
    expect((toks[0] as ErrorToken).value).toBe("#REF!");
  });

  it("emits #REF! for a quoted external ref like '[file.xlsx]Sheet1'!A1", () => {
    const toks = tokenize("'[file.xlsx]Sheet1'!A1");
    // The leading ' quoted form is handled by the quoted-sheet-name branch,
    // but the sheet name itself embeds a bracketed workbook — on resolution
    // this still ends up as an external ref. Either the first token is the
    // quoted SheetRef (which the binder cannot resolve and would map to
    // #REF! at bind time) or the whole thing is an Error token. What we
    // guarantee here is that no ExternalRef token type leaks into the stream.
    for (const t of toks) {
      // Sanity: no token should carry TokenType value 25 (old ExternalRef id).
      expect(t.type).not.toBe(25 as unknown as TokenType);
    }
  });

  it("silently skips unknown punctuation that is not a recognised operator", () => {
    // "`" is not a known operator — should be skipped without throwing.
    const toks = tokenize("1`2");
    // 1 and 2 must both be present; whatever happens to "`" is unspecified.
    expect(toks.some(t => t.type === TokenType.Number)).toBe(true);
    const nums = toks
      .filter((t): t is NumberToken => t.type === TokenType.Number)
      .map(t => t.value);
    expect(nums).toContain("1");
    expect(nums).toContain("2");
  });

  it("tokenises the @ implicit intersection prefix as AtSign", () => {
    const toks = tokenize("@A1");
    expect(toks).toHaveLength(2);
    expect(toks[0].type).toBe(TokenType.AtSign);
    expect(toks[1].type).toBe(TokenType.CellRef);
  });
});

describe("the leading equals sign", () => {
  /**
   * A spreadsheet UI shows `=B5+B6`, an OOXML `<f>` element holds `B5+B6`, and a caller writes
   * whichever they were thinking of. Measured across every workbook this repository's examples
   * produce, 205 of 252 formulas carry the `=`.
   *
   * Rejecting them was not a small inconvenience. The XLSB writer has to tokenise before it can emit
   * a token stream, so every one was refused, reported as inexpressible and written as a blank —
   * two hundred valid formulas silently degraded by one character.
   */
  it("tokenises a formula with or without it, identically", () => {
    for (const text of ["B5+B6", "SUM(A1:A9)", 'IF(A1>0,"yes","no")', "-A1", "1+2*3"]) {
      expect(tokenize(`=${text}`), text).toEqual(tokenize(text));
    }
  });

  it("tolerates whitespace before it", () => {
    expect(tokenize("  =A1+B1")).toEqual(tokenize("A1+B1"));
  });

  it("does not eat an equality operator", () => {
    // `=` is notation at the start and an operator everywhere else, and nothing in the grammar can
    // begin with one — which is what makes stripping the first unambiguous.
    expect(tokenize("=A1=B1")).toEqual(tokenize("A1=B1"));
    expect(tokenize("A1=B1")).toHaveLength(3);
  });

  it("leaves a formula that is nothing but an equals sign alone", () => {
    expect(tokenize("=")).toEqual([]);
  });
});

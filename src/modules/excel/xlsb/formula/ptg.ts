/**
 * BIFF12 `Ptg` token streams ⇄ formula AST.
 *
 * ## What this file does and does not own
 *
 * BIFF12 stores a formula as a reverse-polish stream of `Ptg` tokens, not as text. Turning
 * that into something usable needs two things: a mapping between tokens and expression
 * structure, and a way to get from structure to text. Only the first is specific to XLSB,
 * and this file is only the first.
 *
 * The second is `@formula`: `tokenize` + `parse` for text → AST, and `printAst` for AST →
 * text. Sharing that is not opportunistic reuse — the alternative is assembling text while
 * walking the token stack, which means reimplementing operator precedence and
 * parenthesisation. A mistake there does not produce a syntax error; it produces a
 * different formula that parses cleanly and computes something else. `=-2^2` is `4` in
 * Excel and `-4` almost everywhere else, and that is the kind of detail a second
 * implementation gets wrong.
 *
 * So the pipeline is:
 *
 * ```text
 * read:   Ptg bytes ──► AST ──► text        (this file, then Formula.print)
 * write:  text ──► AST ──► Ptg bytes        (Formula.tokenize/parse, then this file)
 * ```
 *
 * The AST turned out to fit the token set closely — `CellRefNode` already carries absolute
 * flags and a sheet pair for 3D references, `UnionRefNode` is `PtgMemFunc`, `MissingNode`
 * is `PtgMissArg`. Nothing had to be added to it.
 *
 * `StructuredRefNode` *corresponds* to `PtgList`, but neither is implemented: a structured
 * reference is refused by name below. This comment used to list the pair alongside the ones that
 * work, and a `PtgContext.tables` field sat beside it that nothing ever filled in and nothing ever
 * read — scaffolding that read as a finished feature. Tables themselves are written (see
 * `xlsb/tables.ts`); resolving `Table1[Column]` to a token that indexes one is the remaining half.
 *
 * ## Unsupported tokens fail loudly
 *
 * A token this codec does not model throws `ExcelNotSupportedError` naming the token. It
 * never returns a partial expression: half a formula is worse than no formula, because it
 * looks like it worked.
 */

import { ExcelNotSupportedError, XlsbParseError } from "@excel/errors";
import { decodeCol, encodeCol } from "@excel/utils/address";
import { XLSB_MAX_COLUMNS, XLSB_MAX_ROWS } from "@excel/xlsb/binary";
import { errorCodeOf, errorTextOf } from "@excel/xlsb/error-values";
import {
  NodeType,
  type AstNode,
  type CellRefNode,
  type ColRangeRefNode,
  type RowRangeRefNode,
  type StructuredRefNode
} from "@formula/syntax/ast";
import { BinaryReader, BinaryWriter, concatUint8Arrays } from "@utils/binary";

/** Ptg identifiers this codec understands. Base values, before the class bits. */
const Ptg = {
  Exp: 0x01,
  Add: 0x03,
  Sub: 0x04,
  Mul: 0x05,
  Div: 0x06,
  Power: 0x07,
  Concat: 0x08,
  Lt: 0x09,
  Le: 0x0a,
  Eq: 0x0b,
  Ge: 0x0c,
  Gt: 0x0d,
  Ne: 0x0e,
  Isect: 0x0f,
  Union: 0x10,
  Range: 0x11,
  Uplus: 0x12,
  Uminus: 0x13,
  Percent: 0x14,
  Paren: 0x15,
  MissArg: 0x16,
  Str: 0x17,
  Attr: 0x19,
  Err: 0x1c,
  Bool: 0x1d,
  Int: 0x1e,
  Num: 0x1f,
  // Class-tagged tokens: the low five bits identify the token, the upper bits its class
  // (reference / value / array), which does not change the payload.
  Array: 0x00,
  Func: 0x01,
  FuncVar: 0x02,
  Name: 0x03,
  Ref: 0x04,
  Area: 0x05,
  MemArea: 0x06,
  MemFunc: 0x09,
  RefErr: 0x0a,
  AreaErr: 0x0b,
  RefN: 0x0c,
  AreaN: 0x0d,
  NameX: 0x19,
  Ref3d: 0x1a,
  Area3d: 0x1b,
  /**
   * `PtgList`. Reserved as 0x18 by MS-XLSB 2.5.98.52 and always followed by an `eptg` of 0x19 — it is
   * one of the "extended" tokens, whose real identity is the second byte.
   */
  List: 0x18
} as const;

/**
 * The operand class of a class-tagged token, added to the classless base values in `Ptg` above.
 *
 * **These two were swapped**, and every use of them was therefore inverted: references came out value-class and
 * function calls reference-class. The classic table settles it in three independent places — `PtgRef` is `0x24`
 * in the reference class (`0x04 | 0x20`), `PtgRef3d` is `0x3A` (`0x1A | 0x20`), and `PtgFuncVar` is `0x42` in
 * the value class (`0x02 | 0x40`) — and so does Excel, which writes `0x3A` for the reference a defined name
 * resolves to where this wrote `0x5A`.
 *
 * The class is not decoration. A reference in the value class is dereferenced to a single value before the
 * surrounding function sees it, so `SUM` over a value-class area gets one number rather than a range.
 */
const REFERENCE_CLASS = 0x20;
const VALUE_CLASS = 0x40;

const BINARY_OP_BY_PTG: ReadonlyMap<number, string> = new Map([
  [Ptg.Add, "+"],
  [Ptg.Sub, "-"],
  [Ptg.Mul, "*"],
  [Ptg.Div, "/"],
  [Ptg.Power, "^"],
  [Ptg.Concat, "&"],
  [Ptg.Lt, "<"],
  [Ptg.Le, "<="],
  [Ptg.Eq, "="],
  [Ptg.Ge, ">="],
  [Ptg.Gt, ">"],
  [Ptg.Ne, "<>"],
  [Ptg.Isect, " "],
  [Ptg.Range, ":"]
]);

const PTG_BY_BINARY_OP: ReadonlyMap<string, number> = new Map(
  [...BINARY_OP_BY_PTG].map(([ptg, op]) => [op, ptg])
);

/** Context a token stream needs to be interpretable. */
export interface PtgContext {
  /** Sheet names in workbook declaration order — the order `BrtBundleSh` emits them. */
  readonly sheetNames?: readonly string[];
  /**
   * The `BrtExternSheet` table: what a 3D reference's `ixti` actually indexes.
   *
   * A `PtgRef3d` does **not** carry a sheet index. It carries an index into this table, whose
   * entries then name a range of sheets in a supporting book. Treating `ixti` as a sheet index
   * directly is self-consistent between a reader and a writer and wrong against Excel: in
   * `issues.xlsb` the table is `[{first:0,last:0}, {first:2,last:2}]`, so `ixti = 1` means the
   * *third* sheet, and reading it as the second silently retargets the reference.
   *
   * Absent means the identity mapping, which is what a file with no `BrtExternSheet` implies and
   * what this library's own writer emits a real table for.
   */
  readonly externSheets?: readonly { readonly first: number; readonly last: number }[];
  /** Defined names in declaration order; `PtgName` is a one-based index into this. */
  readonly definedNames?: readonly string[];
  /**
   * Tables by name, for `PtgList`.
   *
   * A structured reference names a table and a column *by name*, and the token carries an `idList` and a
   * column *index* — so resolving one needs the table's id and its column order, which only the package
   * writer knows. There was a field like this here once that nothing filled in and nothing read; it was
   * removed for that reason. This one is populated by `write/package.ts` and read by `emitStructuredRef`.
   *
   * `sheet` is here because `PtgList` carries an `ixti` — it is a *3D* reference, like `PtgRef3d`, and
   * naming the table is not enough to locate it. That field was written as a hard-coded 0, which is only
   * right when the table happens to sit on whichever sheet `BrtExternSheet` entry 0 names. It usually
   * does not: entry 0 of this writer's identity table is the *first* sheet, so every structured reference
   * in a workbook whose table lives anywhere else pointed at the wrong sheet.
   */
  readonly tables?: ReadonlyMap<
    string,
    { readonly id: number; readonly columns: readonly string[]; readonly sheet: string }
  >;
  /** Cell the formula sits in, for the relative forms `PtgRefN` / `PtgAreaN`. */
  readonly origin?: { readonly row: number; readonly column: number };
  /**
   * Whether to *emit* the relative forms rather than only read them.
   *
   * A conditional-formatting rule's formula is stored once for a whole range and shifted per cell, so its
   * references are offsets from `origin`. A cell formula's are positions. The decoder has always needed
   * `origin` to read a `PtgRefN`; this is the encoder's half, and it is opt-in because turning every cell
   * formula into offsets would be catastrophic and silent.
   */
  readonly relativeToOrigin?: boolean;
}

/** A shared-formula reference: this cell defers to the formula at `row`/`column`. */
export interface SharedFormulaReference {
  readonly sharedRow: number;
  readonly sharedColumn: number;
}

/** Bytes a `PtgExtraCol` occupies — a single `Col`, MS-XLSB 2.5.98.42. */
export const PTG_EXTRA_COL_SIZE = 4;

/** Bytes a `PtgExp` occupies in the `Rgce`: the token and a four-byte `Rw`, and nothing else. */
export const PTG_EXP_SIZE = 5;

/**
 * The `Rgce` and `RgbExtra` of a cell that defers to the shared or array formula at `row`/`column`.
 *
 * Both halves are returned together because neither is meaningful alone — the token says which row and the
 * extra says which column, and a writer that emitted one without the other would produce a formula pointing
 * at column 0 of the right row. Verified against Excel: `01 08 00 00 00` with an `RgbExtra` of
 * `02 00 00 00` is cell C9 deferring to the array formula whose master is C9.
 */
export function encodeSharedFormulaReference(
  row: number,
  column: number
): { readonly rgce: Uint8Array; readonly rgbExtra: Uint8Array } {
  return {
    rgce: new BinaryWriter().writeUint8(Ptg.Exp).writeUint32(row).toUint8Array(),
    rgbExtra: new BinaryWriter().writeUint32(column).toUint8Array()
  };
}

// =============================================================================
// Decode: Ptg → AST
// =============================================================================

/**
 * Decode a token stream into an AST, or report that it defers to a shared formula.
 *
 * `PtgExp` alone means the cell's formula lives elsewhere — Excel's way of storing one
 * expression for a filled range — so that is returned rather than treated as an expression.
 *
 * `extra` is the `RgbExtra` that follows the `Rgce` in a `CellParsedFormula`, and it is not optional in
 * practice for a `PtgExp`: **the token carries only the row.** The column lives in a `PtgExtraCol` over in
 * `RgbExtra` (MS-XLSB 2.5.98.40 and 2.5.98.42), so a five-byte `Rgce` is the whole token and the four bytes
 * that complete it are elsewhere in the record.
 *
 * This used to read the column as a `u16` from the `Rgce` itself, which made the token seven bytes. Excel's
 * are five — `01 08 00 00 00`, verified in `poi-62815.xlsb` and `poi-bug66682.xlsb` — so the decode
 * overran and threw, and the sheet reader's `catch` turned every shared and array formula in those files
 * into "could not be decoded". Nothing failed loudly; the formulas simply were not there.
 */
export function decodePtg(
  tokens: Uint8Array,
  context: PtgContext,
  where: string,
  extra?: Uint8Array
): AstNode | SharedFormulaReference {
  const reader = new BinaryReader(tokens, 0, where);
  const stack: AstNode[] = [];

  while (reader.remaining > 0) {
    const raw = reader.readUint8();
    const base = raw & 0x1f;

    // Untagged tokens first: their identifier is the whole byte, so they must be matched
    // before the low-five-bit form or `PtgStr` (0x17) collides with a tagged token.
    if (raw === Ptg.Exp) {
      const row = reader.readUint32();
      if (reader.remaining !== 0) {
        throw new XlsbParseError(where, "PtgExp must be the only token in the stream");
      }
      if (extra === undefined || extra.length < PTG_EXTRA_COL_SIZE) {
        throw new XlsbParseError(
          where,
          "PtgExp needs a PtgExtraCol in RgbExtra to supply its column"
        );
      }
      return {
        sharedRow: row,
        sharedColumn: new DataView(extra.buffer, extra.byteOffset, extra.byteLength).getUint32(
          0,
          true
        )
      };
    }
    const binaryOp = BINARY_OP_BY_PTG.get(raw);
    if (binaryOp !== undefined) {
      const right = pop(stack, where);
      const left = pop(stack, where);
      stack.push({ type: NodeType.BinaryOp, op: binaryOp, left, right });
      continue;
    }
    if (raw === Ptg.Union) {
      // The comma operator produces a union. Flattened so `(a,b,c)` is one node rather
      // than a nest, matching what the parser builds from the same text.
      const right = pop(stack, where);
      const left = pop(stack, where);
      const areas = left.type === NodeType.UnionRef ? [...left.areas, right] : [left, right];
      stack.push({ type: NodeType.UnionRef, areas });
      continue;
    }

    switch (raw) {
      case Ptg.Uplus:
        stack.push({ type: NodeType.UnaryOp, op: "+", operand: pop(stack, where) });
        continue;
      case Ptg.Uminus:
        stack.push({ type: NodeType.UnaryOp, op: "-", operand: pop(stack, where) });
        continue;
      case Ptg.Percent:
        stack.push({ type: NodeType.Percent, operand: pop(stack, where) });
        continue;
      case Ptg.Paren:
        // Nothing to do: the AST does not record redundant parentheses, and the printer
        // re-inserts the ones precedence requires.
        continue;
      case Ptg.MissArg:
        stack.push({ type: NodeType.Missing });
        continue;
      case Ptg.Str:
        stack.push({ type: NodeType.String, value: readPtgString(reader, where) });
        continue;
      case Ptg.Err: {
        const code = reader.readUint8();
        const error = errorTextOf(code);
        if (error === undefined) {
          throw new XlsbParseError(where, `unknown error code 0x${code.toString(16)} in PtgErr`);
        }
        stack.push({ type: NodeType.Error, value: error });
        continue;
      }
      case Ptg.Bool:
        stack.push({ type: NodeType.Boolean, value: reader.readUint8() !== 0 });
        continue;
      case Ptg.Int:
        stack.push({ type: NodeType.Number, value: reader.readUint16() });
        continue;
      case Ptg.Num:
        stack.push({ type: NodeType.Number, value: reader.readFloat64() });
        continue;
      case Ptg.Attr:
        skipAttribute(reader, where);
        continue;
      default:
        break;
    }

    decodeClassTagged(raw, base, reader, stack, context, where);
  }

  if (stack.length !== 1) {
    throw new XlsbParseError(
      where,
      `token stream left ${stack.length} expressions on the stack instead of one`
    );
  }
  return stack[0]!;
}

function decodeClassTagged(
  raw: number,
  base: number,
  reader: BinaryReader,
  stack: AstNode[],
  context: PtgContext,
  where: string
): void {
  switch (base) {
    case Ptg.Func: {
      // **A fixed-arity call, and this used to throw.** The token carries no argument count — the count is
      // implied by the function — so decoding one needs an arity table, and the comment here said this codec
      // "does not carry" it. The consequence was that *no* formula Excel wrote for any of the 256 fixed-arity
      // functions could be read: `ROUND`, `MOD`, `MID`, `DATE`, `TEXT` and every other fixed signature.
      const functionId = reader.readUint16() & 0x7fff;
      const name = FUNCTION_NAME_BY_ID.get(functionId);
      if (name === undefined) {
        throw new ExcelNotSupportedError(
          `Read XLSB formula at ${where}`,
          `built-in function id ${functionId} is not in this codec's table`
        );
      }
      const arity = ARITY_BY_ID.get(functionId);
      if (arity === undefined) {
        // A `PtgFunc` naming a function this codec knows to be variadic is a contradiction: the token says the
        // count is implied and the table says there is none to imply. Reported rather than guessed, because
        // guessing means silently taking the wrong number of operands off the stack.
        throw new XlsbParseError(
          where,
          `${name} was called through PtgFunc, which implies a fixed argument count, but it is variadic`
        );
      }
      if (stack.length < arity) {
        throw new XlsbParseError(
          where,
          `${name} wants ${arity} argument(s) but the stack holds ${stack.length}`
        );
      }
      const args = stack.splice(stack.length - arity, arity);
      stack.push({ type: NodeType.FunctionCall, name, args });
      return;
    }
    case Ptg.FuncVar: {
      const argumentCount = reader.readUint8() & 0x7f;
      const functionId = reader.readUint16() & 0x7fff;
      // `0x00FF` is not a function: it means "the callee is the first operand", which is how Excel calls
      // anything the `Ftab` has no id for. The first of the `cparams` is therefore the `PtgName` naming the
      // function, and the rest are its arguments.
      if (functionId === IFTAB_CALL_BY_NAME) {
        if (stack.length < argumentCount || argumentCount < 1) {
          throw new XlsbParseError(
            where,
            `a call through a name wants ${argumentCount} operand(s) but the stack holds ${stack.length}`
          );
        }
        const operands = stack.splice(stack.length - argumentCount, argumentCount);
        const callee = operands[0]!;
        if (callee.type !== NodeType.Name) {
          throw new XlsbParseError(
            where,
            `a call through iftab 0x00FF must name its function, and the first operand is not a name`
          );
        }
        stack.push({
          type: NodeType.FunctionCall,
          // The `_xlfn.` prefix is the file format's, not the formula's: a reader must give back
          // `XLOOKUP(…)`, which is what the author wrote and what the XLSX container stores.
          name: callee.name.startsWith(FUTURE_FUNCTION_PREFIX)
            ? callee.name.slice(FUTURE_FUNCTION_PREFIX.length)
            : callee.name,
          args: operands.slice(1)
        });
        return;
      }
      const name = FUNCTION_NAME_BY_ID.get(functionId);
      if (name === undefined) {
        throw new ExcelNotSupportedError(
          `Read XLSB formula at ${where}`,
          `built-in function id ${functionId} is not in this codec's table`
        );
      }
      if (stack.length < argumentCount) {
        throw new XlsbParseError(
          where,
          `${name} wants ${argumentCount} argument(s) but the stack holds ${stack.length}`
        );
      }
      const args = stack.splice(stack.length - argumentCount, argumentCount);
      stack.push({ type: NodeType.FunctionCall, name, args });
      return;
    }
    case Ptg.Name: {
      const index = reader.readUint32();
      const name = context.definedNames?.[index - 1];
      if (name === undefined) {
        throw new XlsbParseError(
          where,
          `PtgName references defined name ${index}, which is absent`
        );
      }
      stack.push({ type: NodeType.Name, name });
      return;
    }
    case Ptg.Ref:
      stack.push(readRef(reader, undefined, undefined));
      return;
    case Ptg.Area:
      stack.push(readArea(reader, undefined, undefined));
      return;
    case Ptg.RefN: {
      const origin = requireOrigin(context, where, "PtgRefN");
      stack.push(readRelativeRef(reader, origin));
      return;
    }
    case Ptg.AreaN: {
      const origin = requireOrigin(context, where, "PtgAreaN");
      stack.push(readRelativeArea(reader, origin));
      return;
    }
    case Ptg.Ref3d: {
      const { sheet, endSheet } = readSheetPair(reader, context, where);
      stack.push(readRef(reader, sheet, endSheet));
      return;
    }
    case Ptg.List: {
      // The `eptg` that follows, which the specification fixes at 0x19. Consumed even though its value is
      // known, because skipping it shifts every field after it.
      reader.readUint8();
      reader.readUint16(); // ixti
      const flags = reader.readUint16();
      const listIndex = reader.readUint32();
      const first = reader.readUint16();
      const last = reader.readUint16();
      const table = [...(context.tables ?? [])].find(([, entry]) => entry.id === listIndex);
      if (table === undefined) {
        throw new XlsbParseError(
          where,
          `PtgList names table ${listIndex}, which this file does not declare`
        );
      }
      const [tableName, entry] = table;
      const columnCount = flags & 0x03;
      const columns =
        columnCount === 0
          ? []
          : columnCount === 1
            ? [entry.columns[first] ?? ""]
            : [entry.columns[first] ?? "", entry.columns[last] ?? ""];
      stack.push({
        type: NodeType.StructuredRef,
        tableName,
        columns: columns.filter(name => name !== ""),
        specials: specialsOf((flags >>> 2) & 0x1f)
      });
      return;
    }
    case Ptg.Area3d: {
      const { sheet, endSheet } = readSheetPair(reader, context, where);
      stack.push(readArea(reader, sheet, endSheet));
      return;
    }
    case Ptg.RefErr:
      reader.skip(6);
      stack.push({ type: NodeType.Error, value: "#REF!" });
      return;
    case Ptg.AreaErr:
      reader.skip(12);
      stack.push({ type: NodeType.Error, value: "#REF!" });
      return;
    case Ptg.MemFunc:
      // A cached reference subexpression. The length prefix is followed by the tokens
      // themselves, which the loop decodes; nothing needs to be pushed here.
      reader.skip(2);
      return;
    case Ptg.MemArea:
      // As `PtgMemFunc`, but the cached area list lives in the record's extra data, which
      // the caller rejects — so reaching this means the stream is inconsistent.
      reader.skip(6);
      return;
    default:
      throw new ExcelNotSupportedError(
        `Read XLSB formula at ${where}`,
        `Ptg token 0x${raw.toString(16).padStart(2, "0")} is not supported yet`
      );
  }
}

/**
 * `PtgAttr` carries hints, not expression structure.
 *
 * The one that matters is `bitSum` — `SUM` with a single argument is encoded as an
 * attribute rather than a function call — and it is handled by leaving the operand on the
 * stack, which is what the following tokens expect.
 */
function skipAttribute(reader: BinaryReader, where: string): void {
  const flags = reader.readUint8();
  if ((flags & 0x04) !== 0) {
    // bitChoose: a jump table whose length is the number of entries.
    const count = reader.readUint16();
    reader.skip((count + 1) * 2);
    return;
  }
  if ((flags & 0x40) !== 0) {
    // bitSpace: two bytes describing whitespace the author wrote. Dropped, because the
    // printer decides spacing.
    reader.skip(2);
    return;
  }
  void where;
  reader.skip(2);
}

/**
 * `PtgStr`: a two-byte character count, then UTF-16LE. No flag byte.
 *
 * Established from Excel's own output. The obvious guess is that this is BIFF8's
 * `XLUnicodeString`, which carries a flag byte selecting between Latin-1 and UTF-16 — and
 * an earlier version of this decoder assumed exactly that. On a real `=("a"&"b")` the
 * tokens are `17 01 00 61 00`, five bytes: the ptg, a count of one, and one UTF-16 code
 * unit. A flag byte would have consumed the `61` and then read `00 17` as a character,
 * producing a plausible string from the wrong bytes and desynchronising the rest of the
 * stream.
 */
function readPtgString(reader: BinaryReader, where: string): string {
  const length = reader.readUint16();
  if (length > Math.floor(reader.remaining / 2)) {
    throw new XlsbParseError(where, `PtgStr declares ${length} character(s) beyond the stream`);
  }
  let text = "";
  for (let index = 0; index < length; index++) {
    text += String.fromCharCode(reader.readUint16());
  }
  return text;
}

function readSheetPair(
  reader: BinaryReader,
  context: PtgContext,
  where: string
): { sheet: string; endSheet: string | undefined } {
  const ixti = reader.readUint16();
  // Resolved through `BrtExternSheet`, not used as a sheet index. See `PtgContext.externSheets`.
  const entry = context.externSheets?.[ixti] ?? { first: ixti, last: ixti };
  const sheet = context.sheetNames?.[entry.first];
  if (sheet === undefined) {
    throw new XlsbParseError(
      where,
      `3D reference ixti ${ixti} resolves to sheet ${entry.first}, which is not in the workbook`
    );
  }
  // A table entry spanning several sheets is a `Sheet1:Sheet3!A1` style reference.
  const endSheet = entry.last !== entry.first ? context.sheetNames?.[entry.last] : undefined;
  return { sheet, endSheet };
}

function requireOrigin(
  context: PtgContext,
  where: string,
  token: string
): { row: number; column: number } {
  if (!context.origin) {
    throw new XlsbParseError(where, `${token} is relative but no origin cell was supplied`);
  }
  return context.origin;
}

/** `RgceLoc`: row as `u32`, then column with its two absolute-reference flags. */
function readRef(
  reader: BinaryReader,
  sheet: string | undefined,
  endSheet: string | undefined
): CellRefNode {
  const row = reader.readUint32();
  const columnAndFlags = reader.readUint16();
  return cellRef(row, columnAndFlags, sheet, endSheet);
}

function readArea(
  reader: BinaryReader,
  sheet: string | undefined,
  endSheet: string | undefined
): AstNode {
  const firstRow = reader.readUint32();
  const lastRow = reader.readUint32();
  const firstColumn = reader.readUint16();
  const lastColumn = reader.readUint16();

  // An axis pinned to the sheet's full extent is a *whole-row* or *whole-column* reference, and reading
  // it back as an ordinary range loses the shape: `$1:$1` becomes `$A$1:$XFD$1`, which computes the same
  // thing but is not what the author wrote — and for `_xlnm.Print_Titles` it is not even valid, because
  // Excel only accepts a whole-axis reference there.
  const spansAllColumns =
    (firstColumn & 0x3fff) === 0 && (lastColumn & 0x3fff) === XLSB_MAX_COLUMNS - 1;
  const spansAllRows = firstRow === 0 && lastRow === XLSB_MAX_ROWS - 1;
  if (spansAllColumns && !spansAllRows) {
    return {
      type: NodeType.RowRangeRef,
      startRow: firstRow + 1,
      endRow: lastRow + 1,
      ...(sheet === undefined ? {} : { sheet }),
      ...(endSheet === undefined ? {} : { endSheet })
    };
  }
  if (spansAllRows && !spansAllColumns) {
    return {
      type: NodeType.ColRangeRef,
      startCol: encodeCol(firstColumn & 0x3fff),
      endCol: encodeCol(lastColumn & 0x3fff),
      ...(sheet === undefined ? {} : { sheet }),
      ...(endSheet === undefined ? {} : { endSheet })
    };
  }

  return {
    type: NodeType.RangeRef,
    start: cellRef(firstRow, firstColumn, undefined, undefined),
    end: cellRef(lastRow, lastColumn, undefined, undefined),
    ...(sheet === undefined ? {} : { sheet }),
    ...(endSheet === undefined ? {} : { endSheet })
  };
}

function readRelativeRef(
  reader: BinaryReader,
  origin: { row: number; column: number }
): CellRefNode {
  // In the relative form the stored values are offsets from the cell holding the formula.
  //
  // **The row offset wraps through the row field's width, not the integer's.** Excel stores -1 as `0xFFFFF` —
  // the widest row an XLSB addresses — so reading the four bytes as a signed 32-bit integer yields +1048575 and
  // a reference a million rows below the formula. Masking to 20 bits first and sign-extending from there is
  // also robust to the 32-bit form: `0xFFFFFFFF & 0xFFFFF` is `0xFFFFF`, which sign-extends to -1.
  //
  // This is worth naming as the pattern rather than the incident. The writer used to emit `0xFFFFFFFF` and this
  // read it back as -1, so the two agreed perfectly and only Excel disagreed — the eighth time in this module
  // that a reader and a writer have shared one wrong belief. The test that pinned it compared a value written
  // here against a value read here, which is exactly the test that cannot catch it.
  const rowOffset = signExtend20(reader.readUint32() & ROW_MASK);
  const columnAndFlags = reader.readUint16();
  const columnOffset = signExtend14(columnAndFlags & 0x3fff);
  return cellRef(
    ((columnAndFlags & 0x8000) !== 0 ? origin.row + rowOffset : rowOffset) >>> 0,
    (columnAndFlags & 0xc000) |
      (((columnAndFlags & 0x4000) !== 0 ? origin.column + columnOffset : columnOffset) & 0x3fff),
    undefined,
    undefined
  );
}

function readRelativeArea(reader: BinaryReader, origin: { row: number; column: number }): AstNode {
  const start = readRelativeRef(reader, origin);
  const end = readRelativeRef(reader, origin);
  return { type: NodeType.RangeRef, start, end };
}

/** 14-bit two's-complement column offset. */
function signExtend14(value: number): number {
  return value >= 0x2000 ? value - 0x4000 : value;
}

/** A 20-bit row offset read as a signed value — `0xFFFFF` is -1, not 1048575. */
function signExtend20(value: number): number {
  return value >= 0x80000 ? value - 0x100000 : value;
}

function cellRef(
  row: number,
  columnAndFlags: number,
  sheet: string | undefined,
  endSheet: string | undefined
): CellRefNode {
  // The two high bits are the absolute-reference flags — set means *relative*, which is
  // the inversion that makes a hand-written decoder produce `$A$1` for `A1`.
  const rowRelative = (columnAndFlags & 0x8000) !== 0;
  const columnRelative = (columnAndFlags & 0x4000) !== 0;
  return {
    type: NodeType.CellRef,
    col: encodeCol(columnAndFlags & 0x3fff),
    row: String(row + 1),
    colAbsolute: !columnRelative,
    rowAbsolute: !rowRelative,
    ...(sheet === undefined ? {} : { sheet }),
    ...(endSheet === undefined ? {} : { endSheet })
  };
}

function pop(stack: AstNode[], where: string): AstNode {
  const node = stack.pop();
  if (node === undefined) {
    throw new XlsbParseError(where, "operator with no operand on the stack");
  }
  return node;
}

// =============================================================================
// Encode: AST → Ptg
// =============================================================================

/** Encode an AST as a `Rgce` token stream. */
export function encodePtg(node: AstNode, context: PtgContext, where: string): Uint8Array {
  const writer = new BinaryWriter();
  // **A formula that is nothing but a reference wants that reference as a value.**
  //
  // An operand's class states what its consumer does with it, and the consumer of the outermost operand is the
  // cell: it displays a value. Excel writes `44` — `PtgRef | value` — for `=A1`, and for the body of an array
  // formula that is a bare reference; this writer wrote `24`, the reference class, everywhere.
  //
  // Deliberately narrow. `SUM(A1:A2)` really does hand `SUM` a *reference*, and Excel writes the reference class
  // there — which this writer already does. Getting the general rule right means propagating each function's
  // expectation down to its arguments, and that is a larger change with no observed defect driving it; the case
  // measured against Excel's own bytes is the bare one, so that is the case handled. The gap is recorded here
  // rather than guessed at.
  emit(node, writer, context, where, node.type === NodeType.CellRef);
  return writer.toUint8Array();
}

function emit(
  node: AstNode,
  writer: BinaryWriter,
  context: PtgContext,
  where: string,
  /** The cell consumes this operand directly, so it wants a value rather than a reference. */
  asValue = false
): void {
  switch (node.type) {
    case NodeType.Number:
      // The compact integer form where it fits, exactly as Excel does.
      if (Number.isInteger(node.value) && node.value >= 0 && node.value <= 0xffff) {
        writer.writeUint8(Ptg.Int).writeUint16(node.value);
      } else {
        writer.writeUint8(Ptg.Num).writeFloat64(node.value);
      }
      return;
    case NodeType.String: {
      if (node.value.length > 0xffff) {
        unsupported(where, "a string literal longer than 65535 characters");
      }
      writer.writeUint8(Ptg.Str).writeUint16(node.value.length);
      for (let index = 0; index < node.value.length; index++) {
        writer.writeUint16(node.value.charCodeAt(index));
      }
      return;
    }
    case NodeType.Boolean:
      writer.writeUint8(Ptg.Bool).writeUint8(node.value ? 1 : 0);
      return;
    case NodeType.Error: {
      const code = errorCodeOf(node.value);
      if (code === undefined) {
        unsupported(where, `the error value ${node.value}`);
      }
      writer.writeUint8(Ptg.Err).writeUint8(code!);
      return;
    }
    case NodeType.Missing:
      writer.writeUint8(Ptg.MissArg);
      return;
    case NodeType.BinaryOp: {
      emit(node.left, writer, context, where);
      emit(node.right, writer, context, where);
      const ptg = PTG_BY_BINARY_OP.get(node.op);
      if (ptg === undefined) {
        unsupported(where, `the operator "${node.op}"`);
      }
      writer.writeUint8(ptg!);
      return;
    }
    case NodeType.UnaryOp:
      emit(node.operand, writer, context, where);
      writer.writeUint8(node.op === "-" ? Ptg.Uminus : Ptg.Uplus);
      return;
    case NodeType.Percent:
      emit(node.operand, writer, context, where);
      writer.writeUint8(Ptg.Percent);
      return;
    case NodeType.CellRef:
      emitCellRef(node, writer, context, where, asValue);
      return;
    case NodeType.RangeRef: {
      const start = decodeCellRef(node.start, where);
      const end = decodeCellRef(node.end, where);
      // **A range in a template is `PtgAreaN`, for the same reason a cell in one is `PtgRefN`.** The decoder
      // has always read this token; nothing ever wrote it, so a shared `=SUM(B2:D2)` filled downwards named
      // row 2 from every row — the identical defect the single-cell form had, one token along. `=SUM(A1:A10)`
      // filled across is the commonest formula in a spreadsheet, so this is not a corner.
      if (
        node.sheet === undefined &&
        context.relativeToOrigin === true &&
        context.origin !== undefined
      ) {
        writer.writeUint8(Ptg.AreaN | VALUE_CLASS);
        writer
          .writeUint32(relativeRowOffset(start.row, node.start, context))
          .writeUint32(relativeRowOffset(end.row, node.end, context));
        writer
          .writeUint16(relativeColumnOffset(start.columnAndFlags, node.start, context))
          .writeUint16(relativeColumnOffset(end.columnAndFlags, node.end, context));
        return;
      }
      if (node.sheet !== undefined) {
        writer.writeUint8(Ptg.Area3d | REFERENCE_CLASS);
        writer.writeUint16(sheetIndex(node.sheet, context, where, node.endSheet));
      } else {
        writer.writeUint8(Ptg.Area | REFERENCE_CLASS);
      }
      writer.writeUint32(start.row).writeUint32(end.row);
      writer.writeUint16(start.columnAndFlags).writeUint16(end.columnAndFlags);
      return;
    }
    case NodeType.FunctionCall: {
      const id = FUNCTION_ID_BY_NAME.get(node.name.toUpperCase());
      // **A function the `Ftab` has no id for is called through a name, not through an id.** That is Excel's
      // own mechanism for anything newer than the enumeration — `XLOOKUP`, `TEXTJOIN`, `CONFIDENCE.T`, the
      // whole `_xlfn.` family — and it is the only way such a call can be written at all. See
      // {@link emitFutureFunctionCall}.
      if (id === undefined) {
        emitFutureFunctionCall(node, writer, context, where);
        return;
      }
      for (const argument of node.args) {
        emit(argument, writer, context, where);
      }
      // **A fixed-arity function is called through `PtgFunc`, which carries no argument count.** Using
      // `PtgFuncVar` for one is a formula Excel repairs — see `FIXED_ARITY`. The two tokens differ by a single
      // byte, so nothing short of Excel or a byte comparison against it could have caught this.
      const arity = ARITY_BY_ID.get(id);
      if (arity === undefined) {
        writer
          .writeUint8(Ptg.FuncVar | VALUE_CLASS)
          .writeUint8(node.args.length)
          .writeUint16(id);
        return;
      }
      if (node.args.length !== arity) {
        // The count is implied by the token, so a call with the wrong number of arguments cannot be *expressed*
        // — there is nowhere to put the real count. Refused by name rather than written with the implied arity,
        // which would silently change what the formula computes.
        unsupported(
          where,
          `a call to ${node.name} with ${node.args.length} argument(s), which takes exactly ${arity}`
        );
      }
      writer.writeUint8(Ptg.Func | VALUE_CLASS).writeUint16(id);
      return;
    }
    case NodeType.Name: {
      const index = indexOf(context).names.get(node.name.toUpperCase()) ?? -1;
      if (index === -1) {
        unsupported(where, `the name ${node.name}, which the workbook does not define`);
      }
      writer.writeUint8(Ptg.Name | REFERENCE_CLASS).writeUint32(index + 1);
      return;
    }
    case NodeType.UnionRef: {
      // The members, then one union operator per join — the shape the decoder flattens.
      node.areas.forEach((area, index) => {
        emit(area, writer, context, where);
        if (index > 0) {
          writer.writeUint8(Ptg.Union);
        }
      });
      return;
    }
    // A whole-row or whole-column reference is an ordinary `PtgArea` with the *other* axis pinned to the
    // sheet's limit — that is what `A:A` and `$1:$1` are in a token stream, and Excel writes them that
    // way. There is no `PtgAreaWholeRow`; the pair was refused here because the codec had no lowering
    // step, not because the format lacks a form for it.
    //
    // The absolute flags matter and are not cosmetic. `A:A` means *every* row, so the row bounds are
    // absolute; leaving them relative would make the reference shift when the formula is copied, which
    // for a print title is the difference between "repeat row 1" and "repeat the row above me".
    case NodeType.ColRangeRef:
    case NodeType.RowRangeRef: {
      const whole = wholeAxisArea(node);
      if (node.sheet !== undefined) {
        writer.writeUint8(Ptg.Area3d | REFERENCE_CLASS);
        writer.writeUint16(sheetIndex(node.sheet, context, where, node.endSheet));
      } else {
        writer.writeUint8(Ptg.Area | REFERENCE_CLASS);
      }
      writer.writeUint32(whole.firstRow).writeUint32(whole.lastRow);
      writer.writeUint16(whole.firstColumn).writeUint16(whole.lastColumn);
      return;
    }
    case NodeType.StructuredRef:
      emitStructuredRef(node, writer, context, where);
      return;
    case NodeType.Array:
      // Each needs a token whose payload lives in the record's extra data or in the table
      // definitions, neither of which this codec carries yet. Named individually rather
      // than lumped together, because a caller deciding whether XLSB is usable for their
      // workbook needs to know which one stopped them.
      unsupported(where, "an array constant");
      return;
  }
}

/**
 * A whole-row or whole-column reference as `PtgArea` bounds.
 *
 * The pinned axis runs the sheet's full extent and is marked absolute; the named axis carries the
 * reference's own columns or rows, also absolute, because `A:A` does not move.
 *
 * The column field is a `u16` holding the column in its low 14 bits with two flag bits above it, which is
 * why the absolute markers are folded in here rather than written separately.
 */
function wholeAxisArea(node: ColRangeRefNode | RowRangeRefNode): {
  readonly firstRow: number;
  readonly lastRow: number;
  readonly firstColumn: number;
  readonly lastColumn: number;
} {
  // Both flags clear means absolute — the bits mark *relative*, which is the opposite of how the `$`
  // markers read, and getting it backwards produces a reference that drifts when copied.
  const absolute = (column: number): number => column & 0x3fff;
  if (node.type === NodeType.RowRangeRef) {
    return {
      firstRow: node.startRow - 1,
      lastRow: node.endRow - 1,
      firstColumn: absolute(0),
      lastColumn: absolute(XLSB_MAX_COLUMNS - 1)
    };
  }
  return {
    firstRow: 0,
    lastRow: XLSB_MAX_ROWS - 1,
    firstColumn: absolute(decodeCol(node.startCol)),
    lastColumn: absolute(decodeCol(node.endCol))
  };
}

/**
 * `PtgList` — MS-XLSB 2.5.98.52. Twelve bytes.
 *
 * ```text
 * ptg          u8    0x18 with the class bits, then a mandatory 0x19 `eptg`
 * eptg         u8
 * ixti         u16
 * flags        u16   columns (2 bits), rowType (5), then seven more
 * listIndex    u32   the table's own `idList`
 * colFirst     u16   zero-based, *relative to the table*
 * colLast      u16
 * ```
 *
 * **The column indices are relative to the table, not to the sheet.** `Table1[Amount]` where the table
 * starts at column C and `Amount` is its third column is `colFirst = 2`, not 4. Resolving that needs the
 * table's column order, which is why `PtgContext.tables` exists.
 *
 * `rowType` is what `[#Data]`, `[#Headers]`, `[#Totals]` and `[#All]` become. A bare `Table1[Amount]`
 * means the data region, which is `DATA` — and `DATA` is 0, so a writer that forgot the field would
 * produce the right answer for the common case and the wrong one for every qualified reference.
 *
 * **A column *span* comes back as a column *list*.** `Table1[[Qty]:[Note]]` and `Table1[[Qty],[Note]]`
 * parse to the same `StructuredRefNode` — both give `columns: ["Qty", "Note"]` — and `printAst` prints
 * the comma form. The token distinguishes them (`columns = 2` versus a list), but the AST between them
 * does not, so the round trip normalises one spelling into the other.
 *
 * This is a real difference from XLSX and worth naming: XLSX stores the formula as *text* and returns it
 * verbatim, while XLSB stores tokens and therefore goes through the AST. The two references select the
 * same cells and compute the same result, so nothing is lost but the spelling — and closing the gap
 * means teaching the AST to distinguish a span from a list, which is a formula-module change rather than
 * a codec one.
 */
function emitStructuredRef(
  node: StructuredRefNode,
  writer: BinaryWriter,
  context: PtgContext,
  where: string
): void {
  const table = context.tables?.get(node.tableName);
  if (table === undefined) {
    // A reference to a table this workbook does not define. Refused by name rather than written with a
    // guessed id: an `idList` matching no `BrtBeginList` is a reference Excel reports as broken.
    unsupported(where, `a structured reference to the unknown table ${node.tableName}`);
    return;
  }
  const rowType = rowTypeOf(node.specials);
  // `columns`: 0 for the whole table, 1 for one column, 2 for a span.
  const first = node.columns.length === 0 ? -1 : table.columns.indexOf(node.columns[0]);
  const last =
    node.columns.length < 2 ? first : table.columns.indexOf(node.columns[node.columns.length - 1]);
  if (node.columns.length > 0 && (first < 0 || last < 0)) {
    unsupported(where, `a structured reference to a column ${node.tableName} does not have`);
    return;
  }
  const columns = node.columns.length === 0 ? 0 : node.columns.length === 1 ? 1 : 2;
  let flags = columns & 0x03;
  flags |= (rowType & 0x1f) << 2;
  // **The byte is exactly 0x18 — `PtgList` carries no operand class.** Its `ptg` field is *seven* bits wide
  // (MS-XLSB 2.5.98.52: "ptg (7 bits): Reserved. This value MUST be 0x18"), with the eighth bit a reserved
  // flag that MUST be 0. There is no room for a class tag, so OR-ing `REFERENCE_CLASS` in did not label the
  // token — it overwrote bit 5 *of the ptg field itself* and produced 0x38, an identifier the specification
  // does not define. Excel writes 0x18.
  //
  // This survived because the decoder recovers the base with `raw & 0x1f`, which maps 0x38 back to 0x18: the
  // token round-tripped through this codec perfectly and went out malformed. Same trap as the function table
  // and the operand classes — a shared table or a shared mask cannot check itself.
  writer.writeUint8(Ptg.List);
  // `eptg`, which the specification fixes at 0x19. It is not a length or a variant — omitting it shifts
  // every field after it.
  writer.writeUint8(0x19);
  // `ixti` — the sheet the *table* is on, resolved through `BrtExternSheet` exactly as `PtgRef3d` does.
  //
  // This was a literal `0`, and 0 is not a neutral value: it is the first entry of the extern-sheet table,
  // which for this writer's identity table is the first *sheet*. So a structured reference resolved to
  // whatever happened to be sheet 1 rather than to the table's own sheet, and every formula in a workbook
  // whose table sits elsewhere was retargeted. Excel repairs such a file, and reports it twice over — once
  // against the table part the reference misses, and once against `workbook.bin`, which is where the
  // extern-sheet table it failed to resolve through actually lives.
  //
  // Nothing here could have caught it: the decoder reads `listIndex` to find the table and *discards*
  // `ixti`, because a table name locates a table on its own. Reader and writer therefore agreed on a
  // round trip while the file was wrong — the same shape as the operand classes, the function table and
  // the `0x38` above. The gate has to compare against Excel's bytes or against the resolved sheet, never
  // against this codec's own output.
  writer.writeUint16(sheetIndex(table.sheet, context, where));
  writer.writeUint16(flags);
  writer.writeUint32(table.id);
  writer.writeUint16(Math.max(0, first));
  writer.writeUint16(Math.max(0, last));
}

/** The inverse of {@link rowTypeOf}: the `[#…]` specifiers a `rowType` stands for. */
function specialsOf(rowType: number): string[] {
  switch (rowType) {
    case 0x01:
      return ["#All"];
    case 0x02:
      return ["#Headers"];
    case 0x06:
      return ["#Headers", "#Data"];
    case 0x08:
      return ["#Totals"];
    case 0x0c:
      return ["#Data", "#Totals"];
    case 0x10:
      return ["#This Row"];
    default:
      // `DATA` and `DATA2` both mean the data region, which is what a bare reference means — so neither
      // needs a specifier on the way back out.
      return [];
  }
}

/** `PtgRowType`, MS-XLSB 2.5.98.73, from the `[#…]` specifiers a reference carries. */
function rowTypeOf(specials: readonly string[]): number {
  const has = (name: string): boolean =>
    specials.some(entry => entry.toLowerCase() === name.toLowerCase());
  if (has("#All")) {
    return 0x01;
  }
  if (has("#This Row") || has("@")) {
    return 0x10;
  }
  const headers = has("#Headers");
  const totals = has("#Totals");
  const data = has("#Data");
  if (headers && data) {
    return 0x06;
  }
  if (data && totals) {
    return 0x0c;
  }
  if (headers) {
    return 0x02;
  }
  if (totals) {
    return 0x08;
  }
  // No specifier means the data region, which is `DATA` — and `DATA` is 0.
  return 0x00;
}

function emitCellRef(
  node: CellRefNode,
  writer: BinaryWriter,
  context: PtgContext,
  where: string,
  /** The cell consumes this reference directly — see `encodePtg`. */
  asValue = false
): void {
  const { row, columnAndFlags } = decodeCellRef(node, where);
  if (node.sheet !== undefined) {
    writer.writeUint8(Ptg.Ref3d | REFERENCE_CLASS);
    writer.writeUint16(sheetIndex(node.sheet, context, where, node.endSheet));
    writer.writeUint32(row).writeUint16(columnAndFlags);
    return;
  }
  // **`PtgRefN` when the caller asked for offsets.** A conditional-formatting rule's formula is written once
  // and applied to every cell in its range, so its references have to be *offsets from the range's top-left*
  // rather than positions. Excel writes `PtgRefN` there; this wrote `PtgRef` with the relative flags set, which
  // states an absolute cell and leaves how it shifts up to the reader. For the first cell of the range the two
  // agree, which is why the difference is easy to miss and wrong for every cell after it.
  //
  // `origin` doubles as the switch: the decoder already requires it to *read* a `PtgRefN`, and a caller that
  // supplies one is a caller working in offsets.
  if (context.relativeToOrigin === true && context.origin !== undefined) {
    const relativeRow = node.rowAbsolute ? row : row - context.origin.row;
    const relativeColumn = node.colAbsolute
      ? columnAndFlags & 0x3fff
      : (columnAndFlags & 0x3fff) - context.origin.column;
    // **Value class, not reference.** Excel writes `4c` here and this wrote `2c`; the difference is the one
    // that has cost this codec the most — an operand's class says what the *consumer* wants of it, and a
    // reference handed to `SEARCH` is wanted as a value. The reference class is for an operand a function
    // dereferences itself, which is not what a conditional-formatting predicate does with a cell.
    writer.writeUint8(Ptg.RefN | VALUE_CLASS);
    // **Offsets wrap at the width of the field they name, not at the width of the integer holding it.** A row
    // offset of -1 is `0xFFFFF` and a column offset of -1 is `0x3FFF` — the largest row and column an XLSB
    // addresses — because that is what Excel writes: `poi-62815.xlsb` stores `=<the cell above> + 1` as
    // `4c ff ff 0f 00 00 c0 …`, and `poi-bug66682.xlsb` stores a column offset of -1 as `… 00 ff ff`.
    //
    // Writing `relativeRow >>> 0` gave `0xFFFFFFFF` instead, which is not a row this format can express. The
    // conditional-formatting caller never revealed it because its offsets are measured from the top-left of
    // its own range and are therefore never negative; a shared formula filled downwards is negative in every
    // cell but the first.
    writer
      .writeUint32(relativeRow & ROW_MASK)
      .writeUint16(((columnAndFlags & 0xc000) | (relativeColumn & 0x3fff)) & 0xffff);
    return;
  }
  writer.writeUint8(Ptg.Ref | (asValue ? VALUE_CLASS : REFERENCE_CLASS));
  writer.writeUint32(row).writeUint16(columnAndFlags);
}

function decodeCellRef(node: CellRefNode, where: string): { row: number; columnAndFlags: number } {
  const row = Number(node.row) - 1;
  const column = decodeCol(node.col);
  if (!Number.isInteger(row) || row < 0 || column < 0) {
    throw new XlsbParseError(where, `cannot encode the reference ${node.col}${node.row}`);
  }
  // Set means relative, so an absolute reference clears the bit.
  const flags = (node.rowAbsolute ? 0 : 0x8000) | (node.colAbsolute ? 0 : 0x4000);
  return { row, columnAndFlags: flags | (column & 0x3fff) };
}

/**
 * Lookup tables for a context, built once and cached on it.
 *
 * `indexOf` per reference is O(names) and O(sheets), which a workbook with a few hundred names and a
 * few thousand formulas pays on every single one of them. The cache hangs off the context rather than
 * a module-level map so it cannot outlive the write it belongs to, and it is keyed by identity, so a
 * caller that mutates a context between calls gets a fresh one by handing over a fresh object — which
 * is what `writeXlsbPackage` does.
 *
 * Semantics are unchanged on purpose: `indexOf` is exact and case-sensitive, and so is this. Making
 * name lookup case-insensitive here would be a different behaviour wearing an optimisation's clothes.
 */
interface ContextIndex {
  readonly names: Map<string, number>;
  readonly sheets: Map<string, number>;
  readonly externBySheet: Map<number, number>;
  /** `first:last` → `ixti`, including spans appended while encoding. */
  readonly spans: Map<string, number>;
  /**
   * Whether anything encoded through this context resolved an `ixti`.
   *
   * The workbook writer needs this to decide whether to emit the extern-sheet block at all — see
   * {@link externSheetWasUsed}. Recorded here rather than inferred from the finished bytes because the
   * question is "did a token need one", and only the encoder knows.
   */
  usedExternSheet: boolean;
}

/** The `Ftab` id reserved for a function called through a `PtgName` — see {@link emitFutureFunctionCall}. */
const IFTAB_CALL_BY_NAME = 0x00ff;

/** The prefix Excel gives a future function's stub name. */
const FUTURE_FUNCTION_PREFIX = "_xlfn.";

/**
 * `#NAME?` as an `Rgce` — the body Excel gives a future function's stub.
 *
 * `PtgErr` (`0x1c`) then the `BErr` byte `0x1D`. Verified against Excel's own repair output, whose
 * `_xlfn.AVERAGEIF` and `_xlfn.SINGLE` both carry exactly `1c 1d` with a `cce` of 2.
 */
export const FUTURE_FUNCTION_STUB_RGCE = Uint8Array.of(0x1c, 0x1d);

/**
 * `BrtName.flags` for a future function's stub.
 *
 * `fHidden | fFunc | fProc | fFutureFunction`, and MS-XLSB 2.4.674 makes that combination mandatory rather
 * than stylistic: `fFutureFunction` MUST be 0 unless `fHidden` is 1, `fFunc` is 1, `fProc` is 1, `fOB` is 0,
 * `fCalcExp` is 0, `fgrp` is 0, `fPublished` is 0, `fBuiltin` is 0, `fWorkbookParam` is 0, the comment is NULL
 * and `itab` is `0xFFFFFFFF`. Excel's own stubs are `0x0002000b`, which is this value.
 *
 * (Excel's `_xlfn.SINGLE` is `0x0002001b` — the same plus `fCalcExp`, which its own constraint forbids
 * alongside `fFutureFunction`. The constraint-satisfying form is written here rather than the observed
 * inconsistency; `SINGLE` returning an array is presumably why Excel sets the extra bit.)
 */
/** The widest row an XLSB addresses, and therefore the modulus a negative row offset wraps through. */
const ROW_MASK = 0xfffff;

/**
 * A row as an offset from the template's origin, unless the reference pinned it with `$`.
 *
 * An absolute row stays absolute inside a template — `B$1` filled downwards must keep naming row 1 — so the
 * `$` decides per axis whether this is an offset at all. That is why the two axes are separate helpers rather
 * than one that takes a pair.
 */
function relativeRowOffset(
  row: number,
  node: { readonly rowAbsolute?: boolean },
  context: PtgContext
): number {
  return node.rowAbsolute === true ? row : (row - context.origin!.row) & ROW_MASK;
}

/** A column as an offset from the template's origin, preserving the two `$` flags in the high bits. */
function relativeColumnOffset(
  columnAndFlags: number,
  node: { readonly colAbsolute?: boolean },
  context: PtgContext
): number {
  const flags = columnAndFlags & 0xc000;
  const column = columnAndFlags & 0x3fff;
  const offset = node.colAbsolute === true ? column : column - context.origin!.column;
  return (flags | (offset & 0x3fff)) & 0xffff;
}

export const FUTURE_FUNCTION_FLAGS = 0x0002000b;

/**
 * Whether `name` is a function this codec must call through a stub rather than by id.
 *
 * Exported so the workbook writer can create the stubs it will need *before* the formulas are encoded — a
 * `PtgName` is a one-based index into the names list, so a name discovered mid-encoding would have to be
 * appended, and the list has already been counted by then.
 */
export function isFutureFunction(name: string): boolean {
  return !FUNCTION_ID_BY_NAME.has(name.toUpperCase());
}

/**
 * The stub name for a future function: `_xlfn.` and the name upper-cased, which is how Excel spells one.
 *
 * **The case is normalised deliberately, and it does cost something.** A round trip turns `unknownFunction()` into
 * `UNKNOWNFUNCTION()` — `verify:xlsb-corpus` reports it on `poi-bug66682`, where the difference is recorded as
 * expected. Preserving the author's spelling instead was tried and reverted, for a reason worth keeping:
 *
 * A mixed-case name that no function table knows is, in practice, a user-defined function — and a UDF is *not* a
 * future function. `_xlfn.` asserts "Excel has this function and the file's schema version predates it", so Excel
 * resolves `_xlfn.FOO` against its own function list rather than against a macro. `poi-bug66682` shows Excel's own
 * distinction: it carries `_xlfn.XLOOKUP` **and** a bare, unprefixed `unknownFunction`.
 *
 * So a UDF is already mis-encoded by the prefix, whatever case it keeps — preserving the spelling fixes nothing
 * functional. Meanwhile the reverse risk is real: a caller may type `=xlookup(…)` in lower case, and writing
 * `_xlfn.xlookup` is a spelling Excel has never been observed to produce. Telling a UDF from a future function needs
 * a list of Excel's post-2007 functions, and the nearest thing here — the formula engine's 448-function registry —
 * is not one: it holds `XLOOKUP`, `CONCAT` and `TEXTJOIN` but lacks `IFS`, `LET`, `LAMBDA` and `SWITCH`. Using it as
 * the discriminator would write four common functions in whatever case they were typed.
 *
 * Between a cosmetic loss on an already-broken encoding and an unverified spelling on working functions, this takes
 * the first. The information that would settle it — the file's own name table, which says `unknownFunction` is a
 * plain visible name — is read and reported (`undefinedNames`) but not modelled: see `read/parts.ts`.
 */
export function futureFunctionStubName(name: string): string {
  return `${FUTURE_FUNCTION_PREFIX}${name.toUpperCase()}`;
}

/**
 * Emit a call to a function the `Ftab` cannot name.
 *
 * The shape is Excel's, read off `poi-bug66682.xlsb`: `23 02 00 00 00 42 01 ff 00` — a `PtgName` for the stub,
 * then `PtgFuncVar` whose `tab` is `0x00FF` and whose `cparams` **counts the name as one of them**. So a call
 * with two arguments is `PtgName`, the two arguments, then `cparams = 3`.
 *
 * `0x00FF` is deliberately absent from `FUNCTION_TABLE`: it is not a function, it is "the callee is the first
 * operand". Adding it to the table would let a formula name it directly, which is not a thing a formula can do.
 *
 * The stub must already exist. It is refused rather than invented here because the name index has to be stable
 * across the whole workbook, and {@link isFutureFunction} exists so the writer can collect them up front.
 */
function emitFutureFunctionCall(
  node: Extract<AstNode, { type: NodeType.FunctionCall }>,
  writer: BinaryWriter,
  context: PtgContext,
  where: string
): void {
  const stub = futureFunctionStubName(node.name);
  const index = indexOf(context).names.get(stub.toUpperCase()) ?? -1;
  if (index === -1) {
    unsupported(
      where,
      `the function ${node.name}, which needs a ${stub} defined name this workbook does not carry`
    );
    return;
  }
  writer.writeUint8(Ptg.Name | REFERENCE_CLASS).writeUint32(index + 1);
  for (const argument of node.args) {
    emit(argument, writer, context, where);
  }
  writer
    .writeUint8(Ptg.FuncVar | VALUE_CLASS)
    .writeUint8(node.args.length + 1)
    .writeUint16(IFTAB_CALL_BY_NAME);
}

const CONTEXT_INDEX = new WeakMap<object, ContextIndex>();

function indexOf(context: PtgContext): ContextIndex {
  const cached = CONTEXT_INDEX.get(context);
  if (cached !== undefined) {
    return cached;
  }
  // **Keyed upper-case, because a defined name in Excel is case-insensitive.** `MyRange` and `myrange` are one name,
  // and a formula may spell it either way — so a case-sensitive index resolves one of them and refuses the other.
  //
  // It is also what lets a future-function stub keep the case it was written with. The tokenizer upper-cases every
  // function name (`syntax/tokenizer.ts`, correct for a case-insensitive language), so `emitFutureFunctionCall` asks
  // for `_xlfn.UNKNOWNFUNCTION` while the stub the writer registered from the formula *source* is
  // `_xlfn.unknownFunction`. Under a case-sensitive lookup those miss each other, which is why the stub name used to
  // be upper-cased too — agreeing with the parser at the cost of the author's spelling.
  const names = new Map<string, number>();
  (context.definedNames ?? []).forEach((name, index) => {
    // First wins, which is what `indexOf` returned for a duplicated name.
    const key = name.toUpperCase();
    if (!names.has(key)) {
      names.set(key, index);
    }
  });
  const sheets = new Map<string, number>();
  (context.sheetNames ?? []).forEach((sheet, index) => {
    if (!sheets.has(sheet)) {
      sheets.set(sheet, index);
    }
  });
  const externBySheet = new Map<number, number>();
  (context.externSheets ?? []).forEach((entry, index) => {
    if (entry.first === entry.last && !externBySheet.has(entry.first)) {
      externBySheet.set(entry.first, index);
    }
  });
  const spans = new Map<string, number>();
  (context.externSheets ?? []).forEach((entry, index) => {
    spans.set(`${entry.first}:${entry.last}`, index);
  });
  const built: ContextIndex = { names, sheets, externBySheet, spans, usedExternSheet: false };
  CONTEXT_INDEX.set(context, built);
  return built;
}

/**
 * The `ixti` for a sheet — an index into `BrtExternSheet`, not into the sheet list.
 *
 * With an explicit table, the entry naming exactly that one sheet is the answer. Without one the
 * identity mapping is assumed, which is only sound because this library's writer emits an identity
 * table alongside; a writer that omitted the table would leave every 3D reference pointing into
 * nothing, which is the bug this function's previous form produced.
 */
function sheetIndex(sheet: string, context: PtgContext, where: string, endSheet?: string): number {
  const index = indexOf(context);
  const sheetPosition = index.sheets.get(sheet) ?? -1;
  if (sheetPosition === -1) {
    throw new XlsbParseError(where, `sheet ${sheet} is not in the workbook`);
  }
  if (context.externSheets === undefined) {
    // No table supplied means the identity mapping is assumed, which is only sound because this library's
    // writer emits one alongside — so the block is still needed.
    indexOf(context).usedExternSheet = true;
    return sheetPosition;
  }
  // A reference across a *span* of sheets — `Sheet1:Sheet3!A1`. `itabFirst` and `itabLast` are the two
  // fields an entry already has, and the decoder has always read a difference between them as a span;
  // the writer ignored `endSheet` entirely and emitted the entry for the *first* sheet, so
  // `SUM(Sheet1:Sheet3!A1)` was written as `SUM(Sheet1!A1)` — a different answer, silently.
  if (endSheet !== undefined) {
    const endPosition = index.sheets.get(endSheet) ?? -1;
    if (endPosition === -1) {
      throw new XlsbParseError(where, `sheet ${endSheet} is not in the workbook`);
    }
    return internExternSheet(context, index, sheetPosition, endPosition, where);
  }
  const ixti = index.externBySheet.get(sheetPosition) ?? -1;
  if (ixti === -1) {
    throw new XlsbParseError(
      where,
      `sheet ${sheet} has no single-sheet BrtExternSheet entry to reference it by`
    );
  }
  index.usedExternSheet = true;
  return ixti;
}

/**
 * Whether anything encoded through `context` resolved an `ixti`.
 *
 * The extern-sheet block — `BrtBeginExternals`, `BrtSupSelf`, `BrtExternSheet`, `BrtEndExternals` — was written
 * unconditionally, on the reasoning that omitting it wrongly would leave every 3D reference pointing at nothing
 * while writing it needlessly cost four records. That was the right trade **while the condition was unknown**,
 * and the note left behind said what would settle it: "a flag the Ptg encoder sets when it emits an `ixti`".
 * This is that flag, and this function is the only thing in the codec that resolves one.
 *
 * The rule it yields matches Excel across all fifteen oracle references: the block appears for conditional
 * formats, pivots, tables, defined names, charts and sparklines, and not for the nine cases whose formulas are
 * plain cell references. Note that those six are *not* the ones with a 3D reference in a worksheet cell — a
 * conditional-formatting rule, a pivot source, a chart series and a sparkline range each carry references of
 * their own, which is why counting cell formulas produced the wrong answer.
 */
export function externSheetWasUsed(context: PtgContext): boolean {
  return CONTEXT_INDEX.get(context)?.usedExternSheet ?? false;
}

/**
 * The `ixti` for a sheet span, appending an entry when the table has none.
 *
 * The table is built by the writer as an identity mapping — one single-sheet entry per sheet — because
 * that is what makes `ixti = sheet position` true by construction. A span has no such entry, so one is
 * added; the worksheets are serialised before the workbook part, so an entry appended while a formula is
 * being encoded still reaches the file.
 *
 * The entry *layout* is established from Excel's output (`issues.xlsb` carries `{0,0}` and `{2,2}`).
 * What is inferred is the value: no corpus workbook contains an entry whose `itabFirst` and `itabLast`
 * differ, so `INFERRED_VALUES.externSheetSpan` records that this reading of the two fields comes from
 * their names and from the decoder's long-standing interpretation rather than from observed bytes.
 */
function internExternSheet(
  context: PtgContext,
  index: ContextIndex,
  first: number,
  last: number,
  where: string
): number {
  const key = `${first}:${last}`;
  const existing = index.spans.get(key);
  if (existing !== undefined) {
    index.usedExternSheet = true;
    return existing;
  }
  const table = context.externSheets;
  if (!Array.isArray(table)) {
    // A caller that handed a frozen table cannot be given a span, and quietly narrowing the reference
    // is the outcome this whole function exists to remove.
    throw new XlsbParseError(
      where,
      `a reference across sheets ${first}..${last} needs a BrtExternSheet entry, and the table ` +
        `supplied cannot take one`
    );
  }
  const ixti = table.length;
  index.usedExternSheet = true;
  (table as { first: number; last: number }[]).push({ first, last });
  index.spans.set(key, ixti);
  return ixti;
}

function unsupported(where: string, what: string): never {
  throw new ExcelNotSupportedError(
    `Write XLSB formula at ${where}`,
    `${what} is not supported yet`
  );
}

// =============================================================================
// Function identifiers
// =============================================================================

/**
 * Built-in function ids — the complete `Ftab` from MS-XLSB 2.5.98.10, transcribed.
 *
 * **This was a hand-maintained subset of 104 entries, and twelve of them named the wrong function.** Not
 * missing — *wrong*, which is worse, because a wrong pair is silent in both directions. `FIND` was written as
 * 82, and 82 is `SEARCH`; a workbook containing `=FIND("a",A1)` was saved as `=SEARCH("a",A1)`, which is
 * case-insensitive and accepts wildcards, so Excel opened the file without complaint and computed a different
 * answer. The full list of what the twelve actually encoded: `FIND`→SEARCH, `ISNUMBER`→CHAR, `FINDB`→FIND,
 * `TEXT`→INDIRECT, `ODD`→FISHER, `STDEVP`→DEVSQ, `GETPIVOTDATA`→STDEVA, `IFERROR`→ISEVEN, `COUNTIFS`→BESSELY,
 * `SUMIFS`→BESSELI, `AVERAGEIF`→XNPV, `AVERAGEIFS`→PRICEMAT.
 *
 * **Nothing here could have caught that**, and the reason is worth keeping: the encoder and the decoder read
 * the same table, so `FIND` went out as 82 and came back as `FIND`. Every round-trip test passed. Only Excel
 * disagreed, and only about the answer — never about whether the file was valid. This is the same shape as
 * the reference/value operand classes having been swapped: a table shared by both directions cannot be
 * validated by using it in both directions.
 *
 * So the subset is gone. All 475 numeric ids are here, generated from the specification's table rather than
 * curated, because a curated subset is a list that drifts from the thing it describes — and the drift is
 * invisible. `__tests__/function-table.test.ts` pins the count and the twelve corrected pairs.
 *
 * **Sixty-one of these are macro-sheet commands** (`SET.NAME`, `GET.CELL`, `ADD.BAR`) rather than worksheet
 * functions. They are real `iftab` values and belong in the table: the decoder needs them to read a macro
 * sheet, and the encoder reaches one only if a formula names it.
 *
 * **What is still missing is a different mechanism, not a missing row.** A *future function* — `XLOOKUP`,
 * `TEXTJOIN`, `IFS`, `CONCAT`, every `*.DIST` — has no `iftab` at all. It is encoded as `PtgName` pointing at
 * a defined name whose `fFutureFunction` bit is set, with an `_xlfn.` prefix on the stored name. That needs
 * name-table machinery this codec does not have yet, so those functions are still refused by name, which is
 * the correct behaviour until it exists.
 */
const FUNCTION_TABLE: readonly (readonly [number, string])[] = [
  [0, "COUNT"],
  [1, "IF"],
  [2, "ISNA"],
  [3, "ISERROR"],
  [4, "SUM"],
  [5, "AVERAGE"],
  [6, "MIN"],
  [7, "MAX"],
  [8, "ROW"],
  [9, "COLUMN"],
  [10, "NA"],
  [11, "NPV"],
  [12, "STDEV"],
  [13, "DOLLAR"],
  [14, "FIXED"],
  [15, "SIN"],
  [16, "COS"],
  [17, "TAN"],
  [18, "ATAN"],
  [19, "PI"],
  [20, "SQRT"],
  [21, "EXP"],
  [22, "LN"],
  [23, "LOG10"],
  [24, "ABS"],
  [25, "INT"],
  [26, "SIGN"],
  [27, "ROUND"],
  [28, "LOOKUP"],
  [29, "INDEX"],
  [30, "REPT"],
  [31, "MID"],
  [32, "LEN"],
  [33, "VALUE"],
  [34, "TRUE"],
  [35, "FALSE"],
  [36, "AND"],
  [37, "OR"],
  [38, "NOT"],
  [39, "MOD"],
  [40, "DCOUNT"],
  [41, "DSUM"],
  [42, "DAVERAGE"],
  [43, "DMIN"],
  [44, "DMAX"],
  [45, "DSTDEV"],
  [46, "VAR"],
  [47, "DVAR"],
  [48, "TEXT"],
  [49, "LINEST"],
  [50, "TREND"],
  [51, "LOGEST"],
  [52, "GROWTH"],
  [53, "GOTO"],
  [54, "HALT"],
  [55, "RETURN"],
  [56, "PV"],
  [57, "FV"],
  [58, "NPER"],
  [59, "PMT"],
  [60, "RATE"],
  [61, "MIRR"],
  [62, "IRR"],
  [63, "RAND"],
  [64, "MATCH"],
  [65, "DATE"],
  [66, "TIME"],
  [67, "DAY"],
  [68, "MONTH"],
  [69, "YEAR"],
  [70, "WEEKDAY"],
  [71, "HOUR"],
  [72, "MINUTE"],
  [73, "SECOND"],
  [74, "NOW"],
  [75, "AREAS"],
  [76, "ROWS"],
  [77, "COLUMNS"],
  [78, "OFFSET"],
  [79, "ABSREF"],
  [80, "RELREF"],
  [81, "ARGUMENT"],
  [82, "SEARCH"],
  [83, "TRANSPOSE"],
  [84, "ERROR"],
  [85, "STEP"],
  [86, "TYPE"],
  [87, "ECHO"],
  [88, "SET.NAME"],
  [89, "CALLER"],
  [90, "DEREF"],
  [91, "WINDOWS"],
  [93, "DOCUMENTS"],
  [94, "ACTIVE.CELL"],
  [95, "SELECTION"],
  [96, "RESULT"],
  [97, "ATAN2"],
  [98, "ASIN"],
  [99, "ACOS"],
  [100, "CHOOSE"],
  [101, "HLOOKUP"],
  [102, "VLOOKUP"],
  [103, "LINKS"],
  [104, "INPUT"],
  [105, "ISREF"],
  [106, "GET.FORMULA"],
  [107, "GET.NAME"],
  [108, "SET.VALUE"],
  [109, "LOG"],
  [110, "EXEC"],
  [111, "CHAR"],
  [112, "LOWER"],
  [113, "UPPER"],
  [114, "PROPER"],
  [115, "LEFT"],
  [116, "RIGHT"],
  [117, "EXACT"],
  [118, "TRIM"],
  [119, "REPLACE"],
  [120, "SUBSTITUTE"],
  [121, "CODE"],
  [122, "NAMES"],
  [123, "DIRECTORY"],
  [124, "FIND"],
  [125, "CELL"],
  [126, "ISERR"],
  [127, "ISTEXT"],
  [128, "ISNUMBER"],
  [129, "ISBLANK"],
  [130, "T"],
  [131, "N"],
  [132, "FOPEN"],
  [133, "FCLOSE"],
  [134, "FSIZE"],
  [135, "FREADLN"],
  [136, "FREAD"],
  [137, "FWRITELN"],
  [138, "FWRITE"],
  [139, "FPOS"],
  [140, "DATEVALUE"],
  [141, "TIMEVALUE"],
  [142, "SLN"],
  [143, "SYD"],
  [144, "DDB"],
  [145, "GET.DEF"],
  [146, "REFTEXT"],
  [147, "TEXTREF"],
  [148, "INDIRECT"],
  [149, "REGISTER"],
  [150, "CALL"],
  [151, "ADD.BAR"],
  [152, "ADD.MENU"],
  [153, "ADD.COMMAND"],
  [154, "ENABLE.COMMAND"],
  [155, "CHECK.COMMAND"],
  [156, "RENAME.COMMAND"],
  [157, "SHOW.BAR"],
  [158, "DELETE.MENU"],
  [159, "DELETE.COMMAND"],
  [160, "GET.CHART.ITEM"],
  [161, "DIALOG.BOX"],
  [162, "CLEAN"],
  [163, "MDETERM"],
  [164, "MINVERSE"],
  [165, "MMULT"],
  [166, "FILES"],
  [167, "IPMT"],
  [168, "PPMT"],
  [169, "COUNTA"],
  [170, "CANCEL.KEY"],
  [171, "FOR"],
  [172, "WHILE"],
  [173, "BREAK"],
  [174, "NEXT"],
  [175, "INITIATE"],
  [176, "REQUEST"],
  [177, "POKE"],
  [178, "EXECUTE"],
  [179, "TERMINATE"],
  [180, "RESTART"],
  [181, "HELP"],
  [182, "GET.BAR"],
  [183, "PRODUCT"],
  [184, "FACT"],
  [185, "GET.CELL"],
  [186, "GET.WORKSPACE"],
  [187, "GET.WINDOW"],
  [188, "GET.DOCUMENT"],
  [189, "DPRODUCT"],
  [190, "ISNONTEXT"],
  [191, "GET.NOTE"],
  [192, "NOTE"],
  [193, "STDEVP"],
  [194, "VARP"],
  [195, "DSTDEVP"],
  [196, "DVARP"],
  [197, "TRUNC"],
  [198, "ISLOGICAL"],
  [199, "DCOUNTA"],
  [200, "DELETE.BAR"],
  [201, "UNREGISTER"],
  [204, "USDOLLAR"],
  [205, "FINDB"],
  [206, "SEARCHB"],
  [207, "REPLACEB"],
  [208, "LEFTB"],
  [209, "RIGHTB"],
  [210, "MIDB"],
  [211, "LENB"],
  [212, "ROUNDUP"],
  [213, "ROUNDDOWN"],
  [214, "ASC"],
  [215, "DBCS"],
  [216, "RANK"],
  [219, "ADDRESS"],
  [220, "DAYS360"],
  [221, "TODAY"],
  [222, "VDB"],
  [223, "ELSE"],
  [224, "ELSE.IF"],
  [225, "END.IF"],
  [226, "FOR.CELL"],
  [227, "MEDIAN"],
  [228, "SUMPRODUCT"],
  [229, "SINH"],
  [230, "COSH"],
  [231, "TANH"],
  [232, "ASINH"],
  [233, "ACOSH"],
  [234, "ATANH"],
  [235, "DGET"],
  [236, "CREATE.OBJECT"],
  [237, "VOLATILE"],
  [238, "LAST.ERROR"],
  [239, "CUSTOM.UNDO"],
  [240, "CUSTOM.REPEAT"],
  [241, "FORMULA.CONVERT"],
  [242, "GET.LINK.INFO"],
  [243, "TEXT.BOX"],
  [244, "INFO"],
  [245, "GROUP"],
  [246, "GET.OBJECT"],
  [247, "DB"],
  [248, "PAUSE"],
  [251, "RESUME"],
  [252, "FREQUENCY"],
  [253, "ADD.TOOLBAR"],
  [254, "DELETE.TOOLBAR"],
  [256, "RESET.TOOLBAR"],
  [257, "EVALUATE"],
  [258, "GET.TOOLBAR"],
  [259, "GET.TOOL"],
  [260, "SPELLING.CHECK"],
  [261, "ERROR.TYPE"],
  [262, "APP.TITLE"],
  [263, "WINDOW.TITLE"],
  [264, "SAVE.TOOLBAR"],
  [265, "ENABLE.TOOL"],
  [266, "PRESS.TOOL"],
  [267, "REGISTER.ID"],
  [268, "GET.WORKBOOK"],
  [269, "AVEDEV"],
  [270, "BETADIST"],
  [271, "GAMMALN"],
  [272, "BETAINV"],
  [273, "BINOMDIST"],
  [274, "CHIDIST"],
  [275, "CHIINV"],
  [276, "COMBIN"],
  [277, "CONFIDENCE"],
  [278, "CRITBINOM"],
  [279, "EVEN"],
  [280, "EXPONDIST"],
  [281, "FDIST"],
  [282, "FINV"],
  [283, "FISHER"],
  [284, "FISHERINV"],
  [285, "FLOOR"],
  [286, "GAMMADIST"],
  [287, "GAMMAINV"],
  [288, "CEILING"],
  [289, "HYPGEOMDIST"],
  [290, "LOGNORMDIST"],
  [291, "LOGINV"],
  [292, "NEGBINOMDIST"],
  [293, "NORMDIST"],
  [294, "NORMSDIST"],
  [295, "NORMINV"],
  [296, "NORMSINV"],
  [297, "STANDARDIZE"],
  [298, "ODD"],
  [299, "PERMUT"],
  [300, "POISSON"],
  [301, "TDIST"],
  [302, "WEIBULL"],
  [303, "SUMXMY2"],
  [304, "SUMX2MY2"],
  [305, "SUMX2PY2"],
  [306, "CHITEST"],
  [307, "CORREL"],
  [308, "COVAR"],
  [309, "FORECAST"],
  [310, "FTEST"],
  [311, "INTERCEPT"],
  [312, "PEARSON"],
  [313, "RSQ"],
  [314, "STEYX"],
  [315, "SLOPE"],
  [316, "TTEST"],
  [317, "PROB"],
  [318, "DEVSQ"],
  [319, "GEOMEAN"],
  [320, "HARMEAN"],
  [321, "SUMSQ"],
  [322, "KURT"],
  [323, "SKEW"],
  [324, "ZTEST"],
  [325, "LARGE"],
  [326, "SMALL"],
  [327, "QUARTILE"],
  [328, "PERCENTILE"],
  [329, "PERCENTRANK"],
  [330, "MODE"],
  [331, "TRIMMEAN"],
  [332, "TINV"],
  [334, "MOVIE.COMMAND"],
  [335, "GET.MOVIE"],
  [336, "CONCATENATE"],
  [337, "POWER"],
  [338, "PIVOT.ADD.DATA"],
  [339, "GET.PIVOT.TABLE"],
  [340, "GET.PIVOT.FIELD"],
  [341, "GET.PIVOT.ITEM"],
  [342, "RADIANS"],
  [343, "DEGREES"],
  [344, "SUBTOTAL"],
  [345, "SUMIF"],
  [346, "COUNTIF"],
  [347, "COUNTBLANK"],
  [348, "SCENARIO.GET"],
  [349, "OPTIONS.LISTS.GET"],
  [350, "ISPMT"],
  [351, "DATEDIF"],
  [352, "DATESTRING"],
  [353, "NUMBERSTRING"],
  [354, "ROMAN"],
  [355, "OPEN.DIALOG"],
  [356, "SAVE.DIALOG"],
  [357, "VIEW.GET"],
  [358, "GETPIVOTDATA"],
  [359, "HYPERLINK"],
  [360, "PHONETIC"],
  [361, "AVERAGEA"],
  [362, "MAXA"],
  [363, "MINA"],
  [364, "STDEVPA"],
  [365, "VARPA"],
  [366, "STDEVA"],
  [367, "VARA"],
  [368, "BAHTTEXT"],
  [369, "THAIDAYOFWEEK"],
  [370, "THAIDIGIT"],
  [371, "THAIMONTHOFYEAR"],
  [372, "THAINUMSOUND"],
  [373, "THAINUMSTRING"],
  [374, "THAISTRINGLENGTH"],
  [375, "ISTHAIDIGIT"],
  [376, "ROUNDBAHTDOWN"],
  [377, "ROUNDBAHTUP"],
  [378, "THAIYEAR"],
  [379, "RTD"],
  [380, "CUBEVALUE"],
  [381, "CUBEMEMBER"],
  [382, "CUBEMEMBERPROPERTY"],
  [383, "CUBERANKEDMEMBER"],
  [384, "HEX2BIN"],
  [385, "HEX2DEC"],
  [386, "HEX2OCT"],
  [387, "DEC2BIN"],
  [388, "DEC2HEX"],
  [389, "DEC2OCT"],
  [390, "OCT2BIN"],
  [391, "OCT2HEX"],
  [392, "OCT2DEC"],
  [393, "BIN2DEC"],
  [394, "BIN2OCT"],
  [395, "BIN2HEX"],
  [396, "IMSUB"],
  [397, "IMDIV"],
  [398, "IMPOWER"],
  [399, "IMABS"],
  [400, "IMSQRT"],
  [401, "IMLN"],
  [402, "IMLOG2"],
  [403, "IMLOG10"],
  [404, "IMSIN"],
  [405, "IMCOS"],
  [406, "IMEXP"],
  [407, "IMARGUMENT"],
  [408, "IMCONJUGATE"],
  [409, "IMAGINARY"],
  [410, "IMREAL"],
  [411, "COMPLEX"],
  [412, "IMSUM"],
  [413, "IMPRODUCT"],
  [414, "SERIESSUM"],
  [415, "FACTDOUBLE"],
  [416, "SQRTPI"],
  [417, "QUOTIENT"],
  [418, "DELTA"],
  [419, "GESTEP"],
  [420, "ISEVEN"],
  [421, "ISODD"],
  [422, "MROUND"],
  [423, "ERF"],
  [424, "ERFC"],
  [425, "BESSELJ"],
  [426, "BESSELK"],
  [427, "BESSELY"],
  [428, "BESSELI"],
  [429, "XIRR"],
  [430, "XNPV"],
  [431, "PRICEMAT"],
  [432, "YIELDMAT"],
  [433, "INTRATE"],
  [434, "RECEIVED"],
  [435, "DISC"],
  [436, "PRICEDISC"],
  [437, "YIELDDISC"],
  [438, "TBILLEQ"],
  [439, "TBILLPRICE"],
  [440, "TBILLYIELD"],
  [441, "PRICE"],
  [442, "YIELD"],
  [443, "DOLLARDE"],
  [444, "DOLLARFR"],
  [445, "NOMINAL"],
  [446, "EFFECT"],
  [447, "CUMPRINC"],
  [448, "CUMIPMT"],
  [449, "EDATE"],
  [450, "EOMONTH"],
  [451, "YEARFRAC"],
  [452, "COUPDAYBS"],
  [453, "COUPDAYS"],
  [454, "COUPDAYSNC"],
  [455, "COUPNCD"],
  [456, "COUPNUM"],
  [457, "COUPPCD"],
  [458, "DURATION"],
  [459, "MDURATION"],
  [460, "ODDLPRICE"],
  [461, "ODDLYIELD"],
  [462, "ODDFPRICE"],
  [463, "ODDFYIELD"],
  [464, "RANDBETWEEN"],
  [465, "WEEKNUM"],
  [466, "AMORDEGRC"],
  [467, "AMORLINC"],
  [469, "ACCRINT"],
  [470, "ACCRINTM"],
  [471, "WORKDAY"],
  [472, "NETWORKDAYS"],
  [473, "GCD"],
  [474, "MULTINOMIAL"],
  [475, "LCM"],
  [476, "FVSCHEDULE"],
  [477, "CUBEKPIMEMBER"],
  [478, "CUBESET"],
  [479, "CUBESETCOUNT"],
  [480, "IFERROR"],
  [481, "COUNTIFS"],
  [482, "SUMIFS"],
  [483, "AVERAGEIF"],
  [484, "AVERAGEIFS"]
];

/**
 * The arity of every fixed-arity function, by `iftab`.
 *
 * **`PtgFunc` and `PtgFuncVar` are not interchangeable, and this codec used only the second one.** A function
 * with a fixed signature is called through `PtgFunc`, which carries no argument count because the count is
 * implied; a variadic one is called through `PtgFuncVar`, which carries it. Emitting `PtgFuncVar` for `MOD` —
 * exactly two arguments — produced a formula Excel repaired: `Repaired Records: Conditional formatting from
 * /xl/worksheets/sheet1.bin`, in six sheets of one workbook. Excel's own bytes for the same rule are
 * `41 27 00` where this wrote `42 02 27 00`.
 *
 * The reader had the mirror of the same gap and was louder about it: `PtgFunc` threw
 * `not supported yet`, so **no formula Excel wrote for any fixed-arity function could be read at all**.
 *
 * Derived from the `Parameters` column of MS-XLSB 2.5.98.10 rather than curated: a signature is fixed when its
 * grammar has no repetition (`*`), no optional group (`[`) and no alternation, and the arity is then the number
 * of terms. 256 of the 475 functions are fixed. Hand-listing that many would drift, and the drift would be
 * invisible — the two tokens differ by one byte and both decode through this same codec.
 */
const FIXED_ARITY: readonly (readonly [number, number])[] = [
  [2, 1],
  [3, 1],
  [10, 0],
  [15, 1],
  [16, 1],
  [17, 1],
  [18, 1],
  [19, 0],
  [20, 1],
  [21, 1],
  [22, 1],
  [23, 1],
  [24, 1],
  [25, 1],
  [26, 1],
  [27, 2],
  [30, 2],
  [31, 3],
  [32, 1],
  [33, 1],
  [34, 0],
  [35, 0],
  [38, 1],
  [39, 2],
  [40, 3],
  [41, 3],
  [42, 3],
  [43, 3],
  [44, 3],
  [45, 3],
  [47, 3],
  [48, 2],
  [53, 1],
  [61, 3],
  [63, 0],
  [65, 3],
  [66, 3],
  [67, 1],
  [68, 1],
  [69, 1],
  [71, 1],
  [72, 1],
  [73, 1],
  [74, 0],
  [75, 1],
  [76, 1],
  [77, 1],
  [79, 2],
  [80, 2],
  [83, 1],
  [85, 0],
  [86, 1],
  [89, 0],
  [90, 1],
  [94, 0],
  [95, 0],
  [97, 2],
  [98, 1],
  [99, 1],
  [105, 1],
  [106, 1],
  [108, 2],
  [111, 1],
  [112, 1],
  [113, 1],
  [114, 1],
  [118, 1],
  [119, 4],
  [121, 1],
  [126, 1],
  [127, 1],
  [128, 1],
  [129, 1],
  [130, 1],
  [131, 1],
  [133, 1],
  [134, 1],
  [135, 1],
  [136, 2],
  [137, 2],
  [138, 2],
  [140, 1],
  [141, 1],
  [142, 3],
  [143, 4],
  [161, 1],
  [162, 1],
  [163, 1],
  [164, 1],
  [165, 2],
  [172, 1],
  [173, 0],
  [174, 0],
  [175, 2],
  [176, 2],
  [177, 3],
  [178, 2],
  [179, 1],
  [184, 1],
  [186, 1],
  [189, 3],
  [190, 1],
  [195, 3],
  [196, 3],
  [198, 1],
  [199, 3],
  [200, 1],
  [201, 1],
  [207, 4],
  [210, 3],
  [211, 3],
  [212, 2],
  [213, 2],
  [214, 1],
  [215, 1],
  [221, 0],
  [223, 0],
  [224, 1],
  [225, 0],
  [229, 1],
  [230, 1],
  [231, 1],
  [232, 1],
  [233, 1],
  [234, 1],
  [235, 3],
  [238, 0],
  [244, 1],
  [245, 0],
  [252, 2],
  [254, 1],
  [256, 1],
  [257, 1],
  [261, 1],
  [265, 3],
  [266, 3],
  [271, 1],
  [273, 4],
  [274, 2],
  [275, 2],
  [276, 2],
  [277, 3],
  [278, 3],
  [279, 1],
  [280, 3],
  [281, 3],
  [282, 3],
  [283, 1],
  [284, 1],
  [285, 2],
  [286, 4],
  [287, 3],
  [288, 2],
  [289, 4],
  [290, 3],
  [291, 3],
  [292, 3],
  [293, 4],
  [294, 1],
  [295, 3],
  [296, 1],
  [297, 3],
  [298, 1],
  [299, 2],
  [300, 3],
  [301, 3],
  [302, 4],
  [303, 2],
  [304, 2],
  [305, 2],
  [306, 2],
  [307, 2],
  [308, 2],
  [309, 3],
  [310, 2],
  [311, 2],
  [312, 2],
  [313, 2],
  [314, 2],
  [315, 2],
  [316, 4],
  [325, 2],
  [326, 2],
  [327, 2],
  [328, 2],
  [331, 2],
  [332, 2],
  [337, 2],
  [342, 1],
  [343, 1],
  [346, 2],
  [347, 1],
  [349, 1],
  [350, 4],
  [351, 3],
  [352, 1],
  [353, 2],
  [360, 1],
  [368, 1],
  [369, 1],
  [370, 1],
  [371, 1],
  [372, 1],
  [373, 1],
  [374, 1],
  [375, 1],
  [376, 1],
  [377, 1],
  [378, 1],
  [382, 3],
  [385, 1],
  [392, 1],
  [393, 1],
  [396, 2],
  [397, 2],
  [398, 2],
  [399, 1],
  [400, 1],
  [401, 1],
  [402, 1],
  [403, 1],
  [404, 1],
  [405, 1],
  [406, 1],
  [407, 1],
  [408, 1],
  [409, 1],
  [410, 1],
  [414, 4],
  [415, 1],
  [416, 1],
  [417, 2],
  [420, 1],
  [421, 1],
  [422, 2],
  [424, 1],
  [425, 2],
  [426, 2],
  [427, 2],
  [428, 2],
  [430, 3],
  [438, 3],
  [439, 3],
  [440, 3],
  [443, 2],
  [444, 2],
  [445, 2],
  [446, 2],
  [447, 6],
  [448, 6],
  [449, 2],
  [450, 2],
  [464, 2],
  [476, 2],
  [479, 1],
  [480, 2]
];

/** `iftab` → argument count, for the fixed-arity functions. Absent means variadic. */
const ARITY_BY_ID: ReadonlyMap<number, number> = new Map(FIXED_ARITY);

/**
 * The two function tables, for the cross-checks that keep them from drifting apart.
 *
 * **They are two transcriptions of one specification table, related only by a bare number.** `FUNCTION_TABLE` maps an
 * `iftab` to a name and `FIXED_ARITY` maps the same `iftab` to a parameter count; the first came from the specification's
 * name column and the second from a syntax judgement on its `Parameters` column. Nothing connected them, and both the
 * decoder and the encoder look each up separately, so an id present in one and absent from the other is a silent
 * degradation rather than an error.
 *
 * That matters more here than duplication usually does, because of how an arity mistake fails: `PtgFunc` has nowhere to
 * record the real argument count, so a wrong arity produces a file Excel opens without complaint and evaluates
 * differently — and a round trip cannot see it, since the encoder and decoder share the same wrong entry. It is the exact
 * shape of the twelve `iftab` defects this table's own history records.
 *
 * Exported so `__tests__/function-table.test.ts` can assert what no type can: that every id in one appears in the other,
 * that neither has a duplicate, and that the counts are what they are.
 */
export const FUNCTION_TABLES = { names: FUNCTION_TABLE, arities: FIXED_ARITY } as const;

const FUNCTION_NAME_BY_ID: ReadonlyMap<number, string> = new Map(FUNCTION_TABLE);
const FUNCTION_ID_BY_NAME: ReadonlyMap<string, number> = new Map(
  FUNCTION_TABLE.map(([id, name]) => [name, id])
);

/**
 * Wrap a token stream as a parsed formula: `cce`, the tokens, then an empty `rgcb`.
 *
 * `CellParsedFormula` (MS-XLSB 2.5.98.3) and `DVParsedFormula` (2.5.98.8) have the same four-part
 * layout, so one function serves both. They differ in what the token stream is *allowed* to contain —
 * a data validation formula may not carry `PtgExp`, `PtgList`, `PtgUnion` and a dozen others — but that
 * is a constraint on the caller's tokens, not on this framing, and enforcing it here would put a rule
 * about data validation inside a function cells also use.
 *
 * The `rgcb` trailer is always empty. It carries ancillary data for the token forms this library does
 * not emit — array constants and their like — and those are refused at the point of encoding, so there
 * is never anything to put in it.
 */
export function encodeParsedFormula(tokens: Uint8Array, extra?: Uint8Array): Uint8Array {
  return concatUint8Arrays([
    new BinaryWriter().writeUint32(tokens.length).toUint8Array(),
    tokens,
    // `cb`, the length of the `RgbExtra` that follows. Zero for every formula whose tokens are
    // self-contained; four for a `PtgExp`, whose column lives out here in a `PtgExtraCol`.
    new BinaryWriter().writeUint32(extra?.length ?? 0).toUint8Array(),
    ...(extra === undefined ? [] : [extra])
  ]);
}

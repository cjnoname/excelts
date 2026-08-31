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
 * is `PtgMissArg`, `StructuredRefNode` is `PtgList`. Nothing had to be added to it.
 *
 * ## Unsupported tokens fail loudly
 *
 * A token this codec does not model throws `ExcelNotSupportedError` naming the token. It
 * never returns a partial expression: half a formula is worse than no formula, because it
 * looks like it worked.
 */

import { ExcelNotSupportedError, XlsbParseError } from "@excel/errors";
import { decodeCol, encodeCol } from "@excel/utils/address";
import { NodeType, type AstNode, type CellRefNode } from "@formula/syntax/ast";
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
  Area3d: 0x1b
} as const;

/** Value class for a class-tagged token. `0x20` is the value class. */
const VALUE_CLASS = 0x20;
/** Reference class, used for tokens that must yield a reference. */
const REFERENCE_CLASS = 0x40;

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

/** Error values, by the code BIFF12 stores. */
const ERROR_BY_CODE: ReadonlyMap<number, string> = new Map([
  [0x00, "#NULL!"],
  [0x07, "#DIV/0!"],
  [0x0f, "#VALUE!"],
  [0x17, "#REF!"],
  [0x1d, "#NAME?"],
  [0x24, "#NUM!"],
  [0x2a, "#N/A"]
]);

const CODE_BY_ERROR: ReadonlyMap<string, number> = new Map(
  [...ERROR_BY_CODE].map(([code, error]) => [error, code])
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
  /** Tables by id, for `PtgList`. */
  readonly tables?: ReadonlyMap<
    number,
    { readonly name: string; readonly columns: readonly string[] }
  >;
  /** Cell the formula sits in, for the relative forms `PtgRefN` / `PtgAreaN`. */
  readonly origin?: { readonly row: number; readonly column: number };
}

/** A shared-formula reference: this cell defers to the formula at `row`/`column`. */
export interface SharedFormulaReference {
  readonly sharedRow: number;
  readonly sharedColumn: number;
}

// =============================================================================
// Decode: Ptg → AST
// =============================================================================

/**
 * Decode a token stream into an AST, or report that it defers to a shared formula.
 *
 * `PtgExp` alone means the cell's formula lives elsewhere — Excel's way of storing one
 * expression for a filled range — so that is returned rather than treated as an expression.
 */
export function decodePtg(
  tokens: Uint8Array,
  context: PtgContext,
  where: string
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
      const column = reader.readUint16();
      if (reader.remaining !== 0) {
        throw new XlsbParseError(where, "PtgExp must be the only token in the stream");
      }
      return { sharedRow: row, sharedColumn: column };
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
        const error = ERROR_BY_CODE.get(code);
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
      // Fixed-arity call. The arity comes from the function table, which this codec does
      // not carry — so a fixed-arity call is decoded by consuming what the stack holds
      // only when the id is one we can name.
      throw new ExcelNotSupportedError(
        `Read XLSB formula at ${where}`,
        `PtgFunc (fixed-arity call, id ${reader.readUint16()}) is not supported yet`
      );
    }
    case Ptg.FuncVar: {
      const argumentCount = reader.readUint8() & 0x7f;
      const functionId = reader.readUint16() & 0x7fff;
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
  const rowOffset = reader.readInt32();
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
  emit(node, writer, context, where);
  return writer.toUint8Array();
}

function emit(node: AstNode, writer: BinaryWriter, context: PtgContext, where: string): void {
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
      const code = CODE_BY_ERROR.get(node.value);
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
      emitCellRef(node, writer, context, where);
      return;
    case NodeType.RangeRef: {
      if (node.sheet !== undefined) {
        writer.writeUint8(Ptg.Area3d | REFERENCE_CLASS);
        writer.writeUint16(sheetIndex(node.sheet, context, where, node.endSheet));
      } else {
        writer.writeUint8(Ptg.Area | REFERENCE_CLASS);
      }
      const start = decodeCellRef(node.start, where);
      const end = decodeCellRef(node.end, where);
      writer.writeUint32(start.row).writeUint32(end.row);
      writer.writeUint16(start.columnAndFlags).writeUint16(end.columnAndFlags);
      return;
    }
    case NodeType.FunctionCall: {
      for (const argument of node.args) {
        emit(argument, writer, context, where);
      }
      const id = FUNCTION_ID_BY_NAME.get(node.name.toUpperCase());
      if (id === undefined) {
        unsupported(where, `the function ${node.name}`);
      }
      writer
        .writeUint8(Ptg.FuncVar | VALUE_CLASS)
        .writeUint8(node.args.length)
        .writeUint16(id!);
      return;
    }
    case NodeType.Name: {
      const index = indexOf(context).names.get(node.name) ?? -1;
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
    case NodeType.Array:
    case NodeType.ColRangeRef:
    case NodeType.RowRangeRef:
    case NodeType.StructuredRef:
      // Each needs a token whose payload lives in the record's extra data or in the table
      // definitions, neither of which this codec carries yet. Named individually rather
      // than lumped together, because a caller deciding whether XLSB is usable for their
      // workbook needs to know which one stopped them.
      unsupported(
        where,
        node.type === NodeType.Array
          ? "an array constant"
          : node.type === NodeType.StructuredRef
            ? "a structured reference"
            : "a whole-row or whole-column reference"
      );
      return;
  }
}

function emitCellRef(
  node: CellRefNode,
  writer: BinaryWriter,
  context: PtgContext,
  where: string
): void {
  const { row, columnAndFlags } = decodeCellRef(node, where);
  if (node.sheet !== undefined) {
    writer.writeUint8(Ptg.Ref3d | REFERENCE_CLASS);
    writer.writeUint16(sheetIndex(node.sheet, context, where, node.endSheet));
  } else {
    writer.writeUint8(Ptg.Ref | REFERENCE_CLASS);
  }
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
}

const CONTEXT_INDEX = new WeakMap<object, ContextIndex>();

function indexOf(context: PtgContext): ContextIndex {
  const cached = CONTEXT_INDEX.get(context);
  if (cached !== undefined) {
    return cached;
  }
  const names = new Map<string, number>();
  (context.definedNames ?? []).forEach((name, index) => {
    // First wins, which is what `indexOf` returned for a duplicated name.
    if (!names.has(name)) {
      names.set(name, index);
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
  const built: ContextIndex = { names, sheets, externBySheet, spans };
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
  return ixti;
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
 * Built-in function ids, from `[MS-XLSB]`'s `Ftab`.
 *
 * A subset, and the subset is the contract: a function absent from here fails the write
 * with its name rather than being encoded as something else. Extending it is a matter of
 * adding a verified pair, not of changing any logic.
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
  [46, "VAR"],
  [56, "PV"],
  [57, "FV"],
  [58, "NPER"],
  [59, "PMT"],
  [63, "RAND"],
  [64, "MATCH"],
  [65, "DATE"],
  [66, "TIME"],
  [67, "DAY"],
  [68, "MONTH"],
  [69, "YEAR"],
  [74, "NOW"],
  [76, "ROWS"],
  [77, "COLUMNS"],
  [82, "FIND"],
  [97, "ATAN2"],
  [98, "ASIN"],
  [99, "ACOS"],
  [100, "CHOOSE"],
  [101, "HLOOKUP"],
  [102, "VLOOKUP"],
  [111, "ISNUMBER"],
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
  [124, "FINDB"],
  [148, "TEXT"],
  [162, "CLEAN"],
  [169, "COUNTA"],
  [183, "PRODUCT"],
  [190, "ISNONTEXT"],
  [212, "ROUNDUP"],
  [213, "ROUNDDOWN"],
  [216, "RANK"],
  [219, "ADDRESS"],
  [220, "DAYS360"],
  [221, "TODAY"],
  [227, "MEDIAN"],
  [228, "SUMPRODUCT"],
  [269, "AVEDEV"],
  [276, "COMBIN"],
  [279, "EVEN"],
  [283, "ODD"],
  [318, "STDEVP"],
  [321, "SUMSQ"],
  [345, "SUMIF"],
  [346, "COUNTIF"],
  [347, "COUNTBLANK"],
  [359, "HYPERLINK"],
  [366, "GETPIVOTDATA"],
  [420, "IFERROR"],
  [427, "COUNTIFS"],
  [428, "SUMIFS"],
  [430, "AVERAGEIF"],
  [431, "AVERAGEIFS"],
  // Observed in Excel's own output: `="a"&"b"` is stored as a CONCATENATE call with two
  // arguments rather than as the `&` operator, so a codec that only knew the operator
  // would fail to read a formula the user wrote with `&`.
  [336, "CONCATENATE"]
];

const FUNCTION_NAME_BY_ID: ReadonlyMap<number, string> = new Map(FUNCTION_TABLE);
const FUNCTION_ID_BY_NAME: ReadonlyMap<string, number> = new Map(
  FUNCTION_TABLE.map(([id, name]) => [name, id])
);

/** Wrap a token stream as a `CellParsedFormula`: length, tokens, then an empty extra block. */
export function encodeCellParsedFormula(tokens: Uint8Array): Uint8Array {
  return concatUint8Arrays([
    new BinaryWriter().writeUint32(tokens.length).toUint8Array(),
    tokens,
    new BinaryWriter().writeUint32(0).toUint8Array()
  ]);
}

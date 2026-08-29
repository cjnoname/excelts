import { ErrorValue } from "@excel/core/enums";
import { ExcelNotSupportedError, XlsbParseError } from "@excel/errors";
import type { CellErrorValue } from "@excel/types";
import { colCache } from "@excel/utils/col-cache";
import { XlsbBinaryReader } from "@excel/xlsb/binary";
import {
  XLSB_BUILTIN_FUNCTION_NAMES,
  XLSB_FIXED_ARGUMENT_COUNTS
} from "@excel/xlsb/formula-functions";
import type {
  AstNode,
  CellRefNode,
  NameNode,
  RangeRefNode,
  StructuredRefNode
} from "@formula/syntax/ast";
import { NodeType } from "@formula/syntax/ast";
import { parse } from "@formula/syntax/parser";
import { tokenize } from "@formula/syntax/tokenizer";

interface FormulaFunction {
  id: number;
  name: string;
  fixedArgs?: number;
}

interface FormulaExpression {
  text: string;
  precedence: number;
}

export interface XlsbFormulaContext {
  sheetNames: readonly string[];
  externalSheets: readonly {
    externalLink: number;
    firstSheet: number;
    lastSheet: number;
  }[];
  currentSheetIndex?: number;
  tables?: readonly {
    id: number;
    name: string;
    sheetIndex: number;
    range: string;
    columns: readonly string[];
  }[];
  definedNames?: readonly {
    name: string;
    localSheetId?: number;
  }[];
}

export interface XlsbFormulaReference {
  row: number;
  column: number;
}

interface FormulaCompileOptions {
  sharedOrigin?: { row: number; column: number };
}

const FUNCTIONS_BY_ID = new Map<number, FormulaFunction>();
XLSB_BUILTIN_FUNCTION_NAMES.forEach((name, id) => {
  if (name) {
    FUNCTIONS_BY_ID.set(id, { id, name, fixedArgs: XLSB_FIXED_ARGUMENT_COUNTS.get(id) });
  }
});
const FUNCTIONS: Record<string, FormulaFunction> = Object.fromEntries(
  [...FUNCTIONS_BY_ID.values()].map(definition => [definition.name.toUpperCase(), definition])
);

const BINARY_TOKENS: Record<string, number> = {
  "+": 0x03,
  "-": 0x04,
  "*": 0x05,
  "/": 0x06,
  "^": 0x07,
  "&": 0x08,
  "<": 0x09,
  "<=": 0x0a,
  "=": 0x0b,
  ">=": 0x0c,
  ">": 0x0d,
  "<>": 0x0e
};

const TOKEN_OPERATORS: Record<number, string> = Object.fromEntries(
  Object.entries(BINARY_TOKENS).map(([operator, token]) => [token, operator])
);

const ERROR_CODES: Record<string, number> = {
  [ErrorValue.Null]: 0,
  [ErrorValue.DivZero]: 7,
  [ErrorValue.Value]: 15,
  [ErrorValue.Ref]: 23,
  [ErrorValue.Name]: 29,
  [ErrorValue.Num]: 36,
  [ErrorValue.NotApplicable]: 42
};

const ERRORS_BY_CODE = new Map<number, string>(
  Object.entries(ERROR_CODES).map(([error, code]) => [code, error])
);

export function compileCellFormula(
  formula: string,
  address: string,
  context: XlsbFormulaContext
): Uint8Array {
  return compileFormula(formula, address, context, {});
}

export function compileSharedFormula(
  formula: string,
  address: string,
  context: XlsbFormulaContext
): Uint8Array {
  const origin = colCache.decodeAddress(address);
  return compileFormula(formula, address, context, {
    sharedOrigin: { row: origin.row - 1, column: origin.col - 1 }
  });
}

function compileFormula(
  formula: string,
  address: string,
  context: XlsbFormulaContext,
  options: FormulaCompileOptions
): Uint8Array {
  const source = formula.startsWith("=") ? formula.slice(1) : formula;
  let ast: AstNode;
  try {
    ast = parse(tokenize(source));
  } catch (cause) {
    throw new ExcelNotSupportedError(
      `Write XLSB formula at ${address}`,
      "formula cannot be parsed",
      {
        cause
      }
    );
  }
  const bytes: number[] = [];
  compileNode(ast, bytes, address, context, options);
  const payload = new Uint8Array(8 + bytes.length);
  const view = new DataView(payload.buffer);
  view.setUint32(0, bytes.length, true);
  payload.set(bytes, 4);
  view.setUint32(4 + bytes.length, 0, true);
  return payload;
}

export function parseCellFormula(
  reader: XlsbBinaryReader,
  address: string,
  context: XlsbFormulaContext
): string {
  const parsed = parseCellFormulaValue(reader, address, context);
  if (typeof parsed !== "string") {
    throw new ExcelNotSupportedError(
      `Read XLSB formula at ${address}`,
      "shared or array formula token requires its following formula record"
    );
  }
  return parsed;
}

export function parseCellFormulaValue(
  reader: XlsbBinaryReader,
  address: string,
  context: XlsbFormulaContext
): string | XlsbFormulaReference {
  reader.u16();
  const tokenLength = reader.u32();
  const tokens = reader.slice(tokenLength);
  const extraLength = reader.u32();
  const extra = reader.slice(extraLength);
  if (tokens.length === 5 && tokens[0] === 0x01 && extra.length === 4) {
    const row = new DataView(tokens.buffer, tokens.byteOffset + 1, 4).getUint32(0, true);
    const column = new DataView(extra.buffer, extra.byteOffset, 4).getUint32(0, true);
    if (row >= 1_048_576 || column >= 16_384) {
      throw new XlsbParseError(`formula at ${address}`, "PtgExp points outside the XLSB grid");
    }
    return { row, column };
  }
  if (extra.length > 0) {
    throw new ExcelNotSupportedError(
      `Read XLSB formula at ${address}`,
      "formula has an RgbExtra payload that is not supported yet"
    );
  }
  return decodeTokens(tokens, address, context);
}

export function parseNameFormula(
  reader: XlsbBinaryReader,
  name: string,
  context: XlsbFormulaContext
): string | undefined {
  return parseParsedFormula(reader, `defined name ${name}`, context, true);
}

export function parseStandaloneFormula(
  reader: XlsbBinaryReader,
  address: string,
  context: XlsbFormulaContext
): string {
  return parseParsedFormula(reader, address, context)!;
}

function parseParsedFormula(
  reader: XlsbBinaryReader,
  address: string,
  context: XlsbFormulaContext,
  allowEmpty = false
): string | undefined {
  const tokenLength = reader.u32();
  const tokens = reader.slice(tokenLength);
  const extraLength = reader.u32();
  const extra = reader.slice(extraLength);
  if (extra.length > 0) {
    throw new ExcelNotSupportedError(
      `Read XLSB formula at ${address}`,
      "formula has an RgbExtra payload that is not supported yet"
    );
  }
  if (allowEmpty && tokens.length === 0) {
    return undefined;
  }
  return decodeTokens(tokens, address, context);
}

function compileNode(
  node: AstNode,
  output: number[],
  address: string,
  context: XlsbFormulaContext,
  options: FormulaCompileOptions
): void {
  switch (node.type) {
    case NodeType.Number:
      if (Number.isInteger(node.value) && node.value >= 0 && node.value <= 0xffff) {
        output.push(0x1e);
        pushU16(output, node.value);
      } else {
        output.push(0x1f);
        pushF64(output, node.value);
      }
      return;
    case NodeType.String:
      if (node.value.length > 255) {
        unsupportedFormula(address, "string literals longer than 255 characters");
      }
      output.push(0x17);
      pushU16(output, node.value.length);
      pushUtf16(output, node.value);
      return;
    case NodeType.Boolean:
      output.push(0x1d, node.value ? 1 : 0);
      return;
    case NodeType.Error: {
      const code = ERROR_CODES[node.value.toUpperCase()];
      if (code === undefined) {
        unsupportedFormula(address, `error literal ${node.value}`);
      }
      output.push(0x1c, code);
      return;
    }
    case NodeType.CellRef:
      compileReference(node, output, address, context, options);
      return;
    case NodeType.RangeRef:
      compileRange(node, output, address, context, options);
      return;
    case NodeType.StructuredRef:
      compileStructuredReference(node, output, address, context);
      return;
    case NodeType.Name:
      compileDefinedNameReference(node, output, address, context);
      return;
    case NodeType.BinaryOp: {
      compileNode(node.left, output, address, context, options);
      compileNode(node.right, output, address, context, options);
      const token = BINARY_TOKENS[node.op];
      if (token === undefined) {
        unsupportedFormula(address, `operator ${node.op}`);
      }
      output.push(token);
      return;
    }
    case NodeType.UnaryOp:
      compileNode(node.operand, output, address, context, options);
      if (node.op !== "+" && node.op !== "-") {
        unsupportedFormula(address, `unary operator ${node.op}`);
      }
      output.push(node.op === "+" ? 0x12 : 0x13);
      return;
    case NodeType.Percent:
      compileNode(node.operand, output, address, context, options);
      output.push(0x14);
      return;
    case NodeType.FunctionCall:
      compileFunction(node.name, node.args, output, address, context, options);
      return;
    case NodeType.Missing:
      output.push(0x16);
      return;
    default:
      unsupportedFormula(address, NodeType[node.type]);
  }
}

function compileReference(
  node: CellRefNode,
  output: number[],
  address: string,
  context: XlsbFormulaContext,
  options: FormulaCompileOptions
): void {
  const row = Number(node.row) - 1;
  const column = colCache.l2n(node.col) - 1;
  validateReference(row, column, address);
  if (node.sheet) {
    if (options.sharedOrigin) {
      unsupportedFormula(address, "cross-sheet references in shared formulas");
    }
    output.push(0x5a);
    pushU16(output, externalSheetIndex(context, node.sheet, node.endSheet, address));
  } else if (options.sharedOrigin && (!node.rowAbsolute || !node.colAbsolute)) {
    output.push(0x4c);
  } else {
    output.push(0x44);
  }
  const encodedRow =
    options.sharedOrigin && !node.rowAbsolute ? row - options.sharedOrigin.row : row;
  const encodedColumn =
    options.sharedOrigin && !node.colAbsolute ? column - options.sharedOrigin.column : column;
  pushU32(output, encodedRow & 0x000fffff);
  pushU16(
    output,
    (encodedColumn & 0x3fff) | (node.rowAbsolute ? 0 : 0x4000) | (node.colAbsolute ? 0 : 0x8000)
  );
}

function compileRange(
  node: RangeRefNode,
  output: number[],
  address: string,
  context: XlsbFormulaContext,
  options: FormulaCompileOptions
): void {
  const sheet = node.sheet ?? node.start.sheet;
  const endSheet = node.endSheet ?? node.start.endSheet;
  const firstRow = Number(node.start.row) - 1;
  const lastRow = Number(node.end.row) - 1;
  const firstColumn = colCache.l2n(node.start.col) - 1;
  const lastColumn = colCache.l2n(node.end.col) - 1;
  validateReference(firstRow, firstColumn, address);
  validateReference(lastRow, lastColumn, address);
  if (sheet) {
    if (options.sharedOrigin) {
      unsupportedFormula(address, "cross-sheet ranges in shared formulas");
    }
    output.push(0x5b);
    pushU16(output, externalSheetIndex(context, sheet, endSheet, address));
  } else if (
    options.sharedOrigin &&
    (!node.start.rowAbsolute ||
      !node.start.colAbsolute ||
      !node.end.rowAbsolute ||
      !node.end.colAbsolute)
  ) {
    output.push(0x4d);
  } else {
    output.push(0x45);
  }
  pushU32(
    output,
    (options.sharedOrigin && !node.start.rowAbsolute
      ? firstRow - options.sharedOrigin.row
      : firstRow) & 0x000fffff
  );
  pushU32(
    output,
    (options.sharedOrigin && !node.end.rowAbsolute ? lastRow - options.sharedOrigin.row : lastRow) &
      0x000fffff
  );
  pushU16(
    output,
    ((options.sharedOrigin && !node.start.colAbsolute
      ? firstColumn - options.sharedOrigin.column
      : firstColumn) &
      0x3fff) |
      (node.start.rowAbsolute ? 0 : 0x4000) |
      (node.start.colAbsolute ? 0 : 0x8000)
  );
  pushU16(
    output,
    ((options.sharedOrigin && !node.end.colAbsolute
      ? lastColumn - options.sharedOrigin.column
      : lastColumn) &
      0x3fff) |
      (node.end.rowAbsolute ? 0 : 0x4000) |
      (node.end.colAbsolute ? 0 : 0x8000)
  );
}

function compileStructuredReference(
  node: StructuredRefNode,
  output: number[],
  address: string,
  context: XlsbFormulaContext
): void {
  const table = findFormulaTable(node, address, context);
  const columnIndexes = node.columns.map(column =>
    table.columns.findIndex(candidate => candidate.toLowerCase() === column.toLowerCase())
  );
  if (columnIndexes.some(index => index < 0)) {
    unsupportedFormula(address, `unknown structured-reference column in ${node.columns.join(":")}`);
  }
  if (columnIndexes.length > 2) {
    unsupportedFormula(address, "structured references spanning more than two column endpoints");
  }
  const columns = columnIndexes.length === 0 ? 0 : columnIndexes.length === 1 ? 1 : 2;
  const firstColumn = columnIndexes[0] ?? 0;
  const lastColumn = columnIndexes[1] ?? firstColumn;
  if (columns === 2 && lastColumn < firstColumn) {
    unsupportedFormula(address, "structured-reference column range is reversed");
  }
  const rowType = structuredReferenceRowType(node.specials, address);
  const externalSheet = context.externalSheets.findIndex(
    entry =>
      entry.externalLink === 0 &&
      entry.firstSheet === table.sheetIndex &&
      entry.lastSheet === table.sheetIndex
  );
  if (externalSheet < 0) {
    unsupportedFormula(address, `table ${table.name} has no BIFF12 external-sheet entry`);
  }
  output.push(0x18, 0x19);
  pushU16(output, externalSheet);
  pushU16(output, columns | (rowType << 2) | (1 << 10));
  pushU32(output, table.id);
  pushU16(output, firstColumn);
  pushU16(output, lastColumn);
}

function compileDefinedNameReference(
  node: NameNode,
  output: number[],
  address: string,
  context: XlsbFormulaContext
): void {
  const normalized = node.name.toLowerCase();
  const candidates = (context.definedNames ?? [])
    .map((definedName, index) => ({ definedName, index }))
    .filter(({ definedName }) => definedName.name.toLowerCase() === normalized);
  const match =
    candidates.find(({ definedName }) => definedName.localSheetId === context.currentSheetIndex) ??
    candidates.find(({ definedName }) => definedName.localSheetId === undefined);
  if (!match) {
    unsupportedFormula(address, `reference to unknown defined name ${node.name}`);
  }
  output.push(0x43);
  pushU32(output, match.index + 1);
}

function compileFunction(
  name: string,
  args: AstNode[],
  output: number[],
  address: string,
  context: XlsbFormulaContext,
  options: FormulaCompileOptions
): void {
  if (args.length > 255) {
    unsupportedFormula(address, `function ${name} with more than 255 arguments`);
  }
  const normalized = name.toUpperCase();
  const definition = FUNCTIONS[normalized];
  if (!definition) {
    if (args.length === 255) {
      unsupportedFormula(address, `user-defined function ${name} with more than 254 arguments`);
    }
    compileDefinedNameReference({ type: NodeType.Name, name }, output, address, context);
    args.forEach(argument => compileNode(argument, output, address, context, options));
    output.push(0x42, args.length + 1);
    pushU16(output, 0xff);
    return;
  }
  args.forEach(argument => compileNode(argument, output, address, context, options));
  if (definition.fixedArgs === args.length) {
    output.push(0x41);
    pushU16(output, definition.id);
  } else {
    output.push(0x42, args.length);
    pushU16(output, definition.id);
  }
}

function decodeTokens(tokens: Uint8Array, address: string, context: XlsbFormulaContext): string {
  const reader = new XlsbBinaryReader(tokens, `formula tokens at ${address}`);
  const stack: FormulaExpression[] = [];
  while (reader.remaining > 0) {
    const rawToken = reader.u8();
    if (TOKEN_OPERATORS[rawToken]) {
      const right = popExpression(stack, address);
      const left = popExpression(stack, address);
      stack.push(binaryExpression(left, right, TOKEN_OPERATORS[rawToken]!));
      continue;
    }
    switch (rawToken) {
      case 0x0f:
      case 0x10:
      case 0x11: {
        const right = popExpression(stack, address);
        const left = popExpression(stack, address);
        stack.push(
          binaryExpression(left, right, rawToken === 0x0f ? " " : rawToken === 0x10 ? "," : ":")
        );
        break;
      }
      case 0x12:
      case 0x13: {
        const operand = popExpression(stack, address);
        stack.push({ text: `${rawToken === 0x12 ? "+" : "-"}${wrap(operand, 7)}`, precedence: 7 });
        break;
      }
      case 0x14: {
        const operand = popExpression(stack, address);
        stack.push({ text: `${wrap(operand, 8)}%`, precedence: 8 });
        break;
      }
      case 0x15: {
        const operand = popExpression(stack, address);
        stack.push({ text: `(${operand.text})`, precedence: 9 });
        break;
      }
      case 0x16:
        stack.push({ text: "", precedence: 9 });
        break;
      case 0x17: {
        const length = reader.u16();
        let value = "";
        for (let i = 0; i < length; i++) {
          value += String.fromCharCode(reader.u16());
        }
        stack.push({ text: `"${value.replaceAll('"', '""')}"`, precedence: 9 });
        break;
      }
      case 0x19:
        decodeAttribute(reader, stack, address);
        break;
      case 0x1c: {
        const code = reader.u8();
        stack.push({ text: ERRORS_BY_CODE.get(code) ?? ErrorValue.Value, precedence: 9 });
        break;
      }
      case 0x1d:
        stack.push({ text: reader.u8() === 0 ? "FALSE" : "TRUE", precedence: 9 });
        break;
      case 0x1e:
        stack.push({ text: String(reader.u16()), precedence: 9 });
        break;
      case 0x1f:
        stack.push({ text: String(reader.f64()), precedence: 9 });
        break;
      default:
        decodeClassifiedToken(rawToken, reader, stack, address, context);
        break;
    }
  }
  if (stack.length !== 1) {
    throw new XlsbParseError(
      `formula at ${address}`,
      `token stack ended with ${stack.length} expressions instead of one`
    );
  }
  return stack[0]!.text;
}

function decodeClassifiedToken(
  rawToken: number,
  reader: XlsbBinaryReader,
  stack: FormulaExpression[],
  address: string,
  context: XlsbFormulaContext
): void {
  const token = rawToken & 0x1f;
  if (rawToken >= 0x20 && token === 0x01) {
    decodeFunction(reader.u16(), undefined, stack, address);
    return;
  }
  if (rawToken >= 0x20 && token === 0x02) {
    const argumentCount = reader.u8();
    const functionId = reader.u16() & 0x7fff;
    decodeFunction(functionId, argumentCount, stack, address);
    return;
  }
  switch (token) {
    case 0x01:
      throw new ExcelNotSupportedError(
        `Read XLSB formula at ${address}`,
        "shared or array formula token is not supported yet"
      );
    case 0x03:
      stack.push(definedNameExpression(reader.u32(), context, address));
      return;
    case 0x04:
      stack.push(referenceExpression(reader));
      return;
    case 0x05:
      stack.push(areaExpression(reader));
      return;
    case 0x06:
      reader.skip(6);
      return;
    case 0x09:
      reader.skip(2);
      return;
    case 0x0a:
      reader.skip(6);
      stack.push({ text: ErrorValue.Ref, precedence: 9 });
      return;
    case 0x0b:
      reader.skip(12);
      stack.push({ text: `${ErrorValue.Ref}:${ErrorValue.Ref}`, precedence: 9 });
      return;
    case 0x0c:
      stack.push(relativeReferenceExpression(reader, address));
      return;
    case 0x0d:
      stack.push(relativeAreaExpression(reader, address));
      return;
    case 0x1a:
      stack.push(externalReferenceExpression(reader, context, address));
      return;
    case 0x1b:
      stack.push(externalAreaExpression(reader, context, address));
      return;
    case 0x18:
      stack.push(structuredReferenceExpression(reader, context, address));
      return;
    default:
      throw new ExcelNotSupportedError(
        `Read XLSB formula at ${address}`,
        `unsupported Ptg token 0x${rawToken.toString(16).padStart(2, "0")}`
      );
  }
}

function definedNameExpression(
  oneBasedIndex: number,
  context: XlsbFormulaContext,
  address: string
): FormulaExpression {
  const definedName = context.definedNames?.[oneBasedIndex - 1];
  if (!definedName || oneBasedIndex === 0) {
    throw new XlsbParseError(
      `formula at ${address}`,
      `defined-name index ${oneBasedIndex} does not exist`
    );
  }
  return { text: definedName.name, precedence: 9 };
}

function structuredReferenceExpression(
  reader: XlsbBinaryReader,
  context: XlsbFormulaContext,
  address: string
): FormulaExpression {
  if (reader.u8() !== 0x19) {
    throw new XlsbParseError(`formula at ${address}`, "PtgList has an invalid extended token id");
  }
  const externalSheet = reader.u16();
  const flags = reader.u16();
  const tableId = reader.u32();
  const firstColumn = reader.u16();
  const lastColumn = reader.u16();
  const table = context.tables?.find(candidate => candidate.id === tableId);
  if (!table) {
    throw new ExcelNotSupportedError(
      `Read XLSB formula at ${address}`,
      `structured reference targets unknown table id ${tableId}`
    );
  }
  const sheet = context.externalSheets[externalSheet];
  if (!sheet || sheet.externalLink !== 0 || sheet.firstSheet !== table.sheetIndex) {
    throw new XlsbParseError(
      `formula at ${address}`,
      `PtgList table ${table.name} has an inconsistent sheet reference`
    );
  }
  const columns = flags & 0x03;
  const rowType = (flags >>> 2) & 0x1f;
  const columnNames =
    columns === 0
      ? []
      : columns === 1
        ? [table.columns[firstColumn]]
        : [table.columns[firstColumn], table.columns[lastColumn]];
  if (columns > 2 || columnNames.some(column => column === undefined)) {
    throw new XlsbParseError(`formula at ${address}`, "PtgList has invalid table columns");
  }
  return {
    text: formatStructuredReference(table.name, rowType, columnNames as string[]),
    precedence: 9
  };
}

function externalReferenceExpression(
  reader: XlsbBinaryReader,
  context: XlsbFormulaContext,
  address: string
): FormulaExpression {
  const prefix = externalSheetPrefix(reader.u16(), context, address);
  const reference = referenceExpression(reader);
  return { text: `${prefix}!${reference.text}`, precedence: 9 };
}

function externalAreaExpression(
  reader: XlsbBinaryReader,
  context: XlsbFormulaContext,
  address: string
): FormulaExpression {
  const prefix = externalSheetPrefix(reader.u16(), context, address);
  const area = areaExpression(reader);
  return { text: `${prefix}!${area.text}`, precedence: 9 };
}

function referenceExpression(reader: XlsbBinaryReader): FormulaExpression {
  const row = reader.u32();
  const column = reader.u16();
  return { text: formatReference(row, column), precedence: 9 };
}

function areaExpression(reader: XlsbBinaryReader): FormulaExpression {
  const firstRow = reader.u32();
  const lastRow = reader.u32();
  const firstColumn = reader.u16();
  const lastColumn = reader.u16();
  return {
    text: `${formatReference(firstRow, firstColumn)}:${formatReference(lastRow, lastColumn)}`,
    precedence: 9
  };
}

function relativeReferenceExpression(reader: XlsbBinaryReader, address: string): FormulaExpression {
  const origin = colCache.decodeAddress(address);
  const row = reader.u32();
  const column = reader.u16();
  return {
    text: formatRelativeReference(row, column, origin.row - 1, origin.col - 1),
    precedence: 9
  };
}

function relativeAreaExpression(reader: XlsbBinaryReader, address: string): FormulaExpression {
  const origin = colCache.decodeAddress(address);
  const firstRow = reader.u32();
  const lastRow = reader.u32();
  const firstColumn = reader.u16();
  const lastColumn = reader.u16();
  return {
    text: `${formatRelativeReference(firstRow, firstColumn, origin.row - 1, origin.col - 1)}:${formatRelativeReference(lastRow, lastColumn, origin.row - 1, origin.col - 1)}`,
    precedence: 9
  };
}

function decodeFunction(
  functionId: number,
  argumentCount: number | undefined,
  stack: FormulaExpression[],
  address: string
): void {
  if (functionId === 0xff) {
    if (argumentCount === undefined || argumentCount < 1 || stack.length < argumentCount) {
      throw new XlsbParseError(
        `formula at ${address}`,
        "user-defined function has an invalid argument count"
      );
    }
    const args = stack.splice(stack.length - argumentCount, argumentCount);
    const [name, ...parameters] = args;
    stack.push({
      text: `${name!.text}(${parameters.map(argument => argument.text).join(",")})`,
      precedence: 9
    });
    return;
  }
  const entry = FUNCTIONS_BY_ID.get(functionId);
  if (!entry) {
    throw new ExcelNotSupportedError(
      `Read XLSB formula at ${address}`,
      `unknown built-in function 0x${functionId.toString(16)}`
    );
  }
  const count = argumentCount ?? entry.fixedArgs;
  if (count === undefined) {
    throw new XlsbParseError(
      `formula at ${address}`,
      `function ${entry.name} does not declare an argument count`
    );
  }
  if (stack.length < count) {
    throw new XlsbParseError(
      `formula at ${address}`,
      `function ${entry.name} needs ${count} stack values`
    );
  }
  const args = stack.splice(stack.length - count, count);
  stack.push({
    text: `${entry.name}(${args.map(argument => argument.text).join(",")})`,
    precedence: 9
  });
}

function decodeAttribute(
  reader: XlsbBinaryReader,
  stack: FormulaExpression[],
  address: string
): void {
  const type = reader.u8();
  if (type === 0x10) {
    reader.skip(2);
    const expression = popExpression(stack, address);
    stack.push({ text: `SUM(${expression.text})`, precedence: 9 });
    return;
  }
  if (type === 0x04) {
    const count = reader.u16();
    reader.skip((count + 1) * 2);
    return;
  }
  reader.skip(2);
}

function binaryExpression(
  left: FormulaExpression,
  right: FormulaExpression,
  operator: string
): FormulaExpression {
  const precedence = operatorPrecedence(operator);
  const wrapRightAtSame = operator === "-" || operator === "/" || operator === "^";
  return {
    text: `${wrap(left, precedence)}${operator}${wrap(right, precedence + (wrapRightAtSame ? 1 : 0))}`,
    precedence
  };
}

function operatorPrecedence(operator: string): number {
  if (operator === " " || operator === "," || operator === ":") {
    return 1;
  }
  if (["=", "<>", "<", "<=", ">", ">="].includes(operator)) {
    return 2;
  }
  if (operator === "&") {
    return 3;
  }
  if (operator === "+" || operator === "-") {
    return 4;
  }
  if (operator === "*" || operator === "/") {
    return 5;
  }
  if (operator === "^") {
    return 6;
  }
  return 0;
}

function wrap(expression: FormulaExpression, minimumPrecedence: number): string {
  return expression.precedence < minimumPrecedence ? `(${expression.text})` : expression.text;
}

function popExpression(stack: FormulaExpression[], address: string): FormulaExpression {
  const expression = stack.pop();
  if (!expression) {
    throw new XlsbParseError(`formula at ${address}`, "token stack underflow");
  }
  return expression;
}

function formatReference(row: number, encodedColumn: number): string {
  const column = encodedColumn & 0x3fff;
  const columnAbsolute = (encodedColumn & 0x8000) === 0;
  const rowAbsolute = (encodedColumn & 0x4000) === 0;
  return `${columnAbsolute ? "$" : ""}${colCache.n2l(column + 1)}${rowAbsolute ? "$" : ""}${row + 1}`;
}

function formatRelativeReference(
  encodedRow: number,
  encodedColumn: number,
  originRow: number,
  originColumn: number
): string {
  const columnRelative = (encodedColumn & 0x8000) !== 0;
  const rowRelative = (encodedColumn & 0x4000) !== 0;
  const rawColumn = encodedColumn & 0x3fff;
  const rowOffset = encodedRow >= 0x80000 ? encodedRow - 0x100000 : encodedRow;
  const columnOffset = rawColumn >= 0x2000 ? rawColumn - 0x4000 : rawColumn;
  const row = rowRelative ? originRow + rowOffset : encodedRow;
  const column = columnRelative ? originColumn + columnOffset : rawColumn;
  return `${columnRelative ? "" : "$"}${colCache.n2l(column + 1)}${rowRelative ? "" : "$"}${row + 1}`;
}

function validateReference(row: number, column: number, address: string): void {
  if (row < 0 || row >= 1_048_576 || column < 0 || column >= 16_384) {
    unsupportedFormula(address, `reference outside the XLSB grid (${row + 1}, ${column + 1})`);
  }
}

function findFormulaTable(
  node: StructuredRefNode,
  address: string,
  context: XlsbFormulaContext
): NonNullable<XlsbFormulaContext["tables"]>[number] {
  const tables = context.tables ?? [];
  if (node.tableName) {
    const table = tables.find(
      candidate => candidate.name.toLowerCase() === node.tableName.toLowerCase()
    );
    if (table) {
      return table;
    }
    unsupportedFormula(address, `reference to unknown table ${node.tableName}`);
  }
  const cell = colCache.decodeAddress(address);
  const table = tables.find(candidate => {
    if (candidate.sheetIndex !== context.currentSheetIndex) {
      return false;
    }
    const range = colCache.decode(candidate.range);
    return (
      "dimensions" in range &&
      cell.row >= range.top &&
      cell.row <= range.bottom &&
      cell.col >= range.left &&
      cell.col <= range.right
    );
  });
  if (table) {
    return table;
  }
  unsupportedFormula(address, "implicit structured reference outside a table");
}

function structuredReferenceRowType(specials: readonly string[], address: string): number {
  if (specials.length === 0) {
    return 0;
  }
  const key = [...specials].sort().join("|");
  const rowTypes: Record<string, number> = {
    "#All": 1,
    "#Headers": 2,
    "#Data": 4,
    "#Data|#Headers": 6,
    "#Totals": 8,
    "#Data|#Totals": 12,
    "#This Row": 16
  };
  const rowType = rowTypes[key];
  if (rowType === undefined) {
    unsupportedFormula(address, `structured-reference row selection ${specials.join(", ")}`);
  }
  return rowType;
}

function formatStructuredReference(
  tableName: string,
  rowType: number,
  columns: readonly string[]
): string {
  const specials: Record<number, string[]> = {
    0: [],
    1: ["#All"],
    2: ["#Headers"],
    4: ["#Data"],
    6: ["#Headers", "#Data"],
    8: ["#Totals"],
    12: ["#Data", "#Totals"],
    16: ["#This Row"]
  };
  const rowSpecials = specials[rowType];
  if (!rowSpecials) {
    return `${tableName}[#REF!]`;
  }
  if (rowSpecials.length === 0 && columns.length === 1) {
    return `${tableName}[${columns[0]}]`;
  }
  if (rowSpecials.length === 0 && columns.length === 0) {
    return tableName;
  }
  const parts = [...rowSpecials.map(value => `[${value}]`)];
  if (columns.length === 1) {
    parts.push(`[${columns[0]}]`);
  }
  if (columns.length === 2) {
    parts.push(`[${columns[0]}]:[${columns[1]}]`);
  }
  return `${tableName}[${parts.join(",")}]`;
}

function externalSheetIndex(
  context: XlsbFormulaContext,
  sheet: string,
  endSheet: string | undefined,
  address: string
): number {
  const firstSheet = findSheetIndex(context.sheetNames, sheet);
  const lastSheet = findSheetIndex(context.sheetNames, endSheet ?? sheet);
  if (firstSheet < 0 || lastSheet < 0) {
    unsupportedFormula(
      address,
      `reference to unknown sheet ${endSheet ? `${sheet}:${endSheet}` : sheet}`
    );
  }
  const index = context.externalSheets.findIndex(
    external =>
      external.externalLink === 0 &&
      external.firstSheet === firstSheet &&
      external.lastSheet === lastSheet
  );
  if (index < 0) {
    unsupportedFormula(address, `3D sheet range ${sheet}:${endSheet ?? sheet}`);
  }
  return index;
}

function externalSheetPrefix(index: number, context: XlsbFormulaContext, address: string): string {
  const external = context.externalSheets[index];
  if (!external) {
    throw new XlsbParseError(
      `formula at ${address}`,
      `external-sheet index ${index} does not exist`
    );
  }
  if (external.externalLink !== 0) {
    throw new ExcelNotSupportedError(
      `Read XLSB formula at ${address}`,
      `external-sheet index ${index} refers to another workbook`
    );
  }
  if (external.firstSheet === -1 || external.lastSheet === -1) {
    return ErrorValue.Ref.slice(0, -1);
  }
  const first = context.sheetNames[external.firstSheet];
  const last = context.sheetNames[external.lastSheet];
  if (!first || !last) {
    throw new XlsbParseError(
      `formula at ${address}`,
      `external-sheet index ${index} refers to a missing worksheet`
    );
  }
  const range = first === last ? first : `${first}:${last}`;
  return quoteSheetName(range);
}

function findSheetIndex(sheetNames: readonly string[], name: string): number {
  const normalized = name.toLowerCase();
  return sheetNames.findIndex(sheet => sheet.toLowerCase() === normalized);
}

function quoteSheetName(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) ? name : `'${name.replaceAll("'", "''")}'`;
}

function unsupportedFormula(address: string, feature: string): never {
  throw new ExcelNotSupportedError(
    `Write XLSB formula at ${address}`,
    `${feature} is not implemented`
  );
}

function pushU16(output: number[], value: number): void {
  output.push(value & 0xff, (value >>> 8) & 0xff);
}

function pushU32(output: number[], value: number): void {
  output.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
}

function pushF64(output: number[], value: number): void {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, value, true);
  output.push(...bytes);
}

function pushUtf16(output: number[], value: string): void {
  for (let i = 0; i < value.length; i++) {
    pushU16(output, value.charCodeAt(i));
  }
}

export function formulaResultErrorCode(value: CellErrorValue): number | undefined {
  return ERROR_CODES[value.error];
}

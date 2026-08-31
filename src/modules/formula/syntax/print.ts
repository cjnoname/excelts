/**
 * Print an AST back to formula text.
 *
 * The missing half of this module. `tokenize` and `parse` turn text into a tree and there
 * was no way back, which is an odd shape for a syntax layer to have: anything that
 * *transforms* a formula, normalises one, or reconstructs one from another representation
 * has to build strings by hand, and every such caller reimplements the one genuinely
 * difficult part — deciding where parentheses are required.
 *
 * The immediate consumer is the XLSB formula codec. BIFF12 stores a formula as a
 * reverse-polish token stream rather than as text, so reading one means `Ptg → AST → text`
 * and writing one means `text → AST → Ptg`. Without a printer the read direction has to
 * assemble text while walking the token stack, which means reimplementing precedence — and
 * a mistake there does not produce a syntax error, it produces a *different formula* that
 * parses fine and computes something else.
 *
 * ## Parenthesisation is minimal, and that is a normalisation
 *
 * Parentheses are emitted only where precedence or associativity requires them. `=(A1)`
 * prints as `=A1`; `=(A1+A2)*3` keeps its parentheses because dropping them would change
 * the tree. This is a deliberate choice and it is worth being precise about the
 * consequence: the AST does not record redundant parentheses, so a round trip through it
 * cannot preserve them. Excel does the same thing when a formula is edited.
 *
 * The invariant that matters is therefore structural, not textual, and it is what the
 * tests assert: `parse(tokenize(print(ast)))` is deep-equal to `ast`, and printing is
 * idempotent.
 *
 * ## Precedence lives in one place
 *
 * The binding powers below mirror `parser.ts`. They are not a second opinion about Excel's
 * precedence — if the two ever disagree, the round-trip test fails, which is the point of
 * expressing the invariant that way rather than by comparing strings.
 */

import { NodeType, type AstNode, type CellRefNode } from "@formula/syntax/ast";

/**
 * Left/right binding power of an infix operator, mirroring `parser.ts`.
 *
 * Higher binds tighter. `left < right` is left-associative.
 */
function infixBindingPower(op: string): readonly [number, number] {
  switch (op) {
    case "=":
    case "<>":
    case "<":
    case ">":
    case "<=":
    case ">=":
      return [10, 11];
    case "&":
      return [20, 21];
    case "+":
    case "-":
      return [30, 31];
    case "*":
    case "/":
      return [40, 41];
    case "^":
      // Left-associative in Excel, unlike the mathematical convention.
      return [60, 61];
    case ",":
      // Reference union. Only legal inside parentheses, which `UnionRef` supplies.
      return [8, 9];
    case ":":
      return [90, 91];
    case " ":
      // Intersection. Binds tighter than arithmetic, looser than range.
      return [80, 81];
    default:
      return [0, 0];
  }
}

/** Unary `+`/`-`, which bind tighter than `^` in Excel. */
const PREFIX_BINDING_POWER = 70;
/** Postfix `%`, tighter than any prefix operator. */
const PERCENT_BINDING_POWER = 75;
/** A leaf never needs parenthesising. */
const ATOM_BINDING_POWER = 100;

/** Print an AST as formula text, without a leading `=`. */
export function printAst(node: AstNode): string {
  return print(node).text;
}

interface Printed {
  readonly text: string;
  /**
   * Binding power of the outermost operator, so a parent can decide whether this needs
   * wrapping. An atom reports the maximum, so it never does.
   */
  readonly power: number;
}

function print(node: AstNode): Printed {
  switch (node.type) {
    case NodeType.Number:
      return atom(printNumber(node.value));
    case NodeType.String:
      // Excel escapes a quote by doubling it.
      return atom(`"${node.value.replaceAll('"', '""')}"`);
    case NodeType.Boolean:
      return atom(node.value ? "TRUE" : "FALSE");
    case NodeType.Error:
      return atom(node.value);
    case NodeType.Missing:
      return atom("");
    case NodeType.Name:
      return atom(node.name);
    case NodeType.CellRef:
      return atom(printCellRef(node));
    case NodeType.RangeRef:
      return atom(
        `${sheetPrefix(node.sheet, node.endSheet)}${printLocalCellRef(node.start)}:` +
          `${printLocalCellRef(node.end)}`
      );
    case NodeType.ColRangeRef:
      return atom(`${sheetPrefix(node.sheet, node.endSheet)}${node.startCol}:${node.endCol}`);
    case NodeType.RowRangeRef:
      return atom(`${sheetPrefix(node.sheet, node.endSheet)}${node.startRow}:${node.endRow}`);
    case NodeType.StructuredRef:
      return atom(printStructuredRef(node.tableName, node.columns, node.specials));
    case NodeType.Array:
      return atom(
        `{${node.rows.map(row => row.map(cell => print(cell).text).join(",")).join(";")}}`
      );
    case NodeType.FunctionCall:
      // The argument list supplies its own delimiters, so the call is an atom.
      return atom(`${node.name}(${node.args.map(arg => print(arg).text).join(",")})`);
    case NodeType.UnionRef:
      // The parentheses are what make it a union; without them the commas would be
      // argument separators.
      return atom(`(${node.areas.map(area => print(area).text).join(",")})`);
    case NodeType.Percent: {
      const operand = print(node.operand);
      return {
        text: `${wrap(operand, PERCENT_BINDING_POWER)}%`,
        power: PERCENT_BINDING_POWER
      };
    }
    case NodeType.UnaryOp: {
      const operand = print(node.operand);
      return {
        text: `${node.op}${wrap(operand, PREFIX_BINDING_POWER)}`,
        power: PREFIX_BINDING_POWER
      };
    }
    case NodeType.BinaryOp: {
      const [leftPower, rightPower] = infixBindingPower(node.op);
      const left = print(node.left);
      const right = print(node.right);
      // A left operand may bind exactly as tightly as this operator and still not need
      // parentheses, because evaluation is left-to-right at equal precedence. A right
      // operand at equal precedence does need them, or the tree re-associates.
      const separator = node.op === " " ? " " : node.op;
      return {
        text: `${wrap(left, leftPower)}${separator}${wrap(right, rightPower)}`,
        power: leftPower
      };
    }
  }
}

function atom(text: string): Printed {
  return { text, power: ATOM_BINDING_POWER };
}

/**
 * Wrap when the child binds strictly looser than its position requires.
 *
 * One predicate serves both operands of an infix operator, because the asymmetry is
 * already in the binding powers: `left < right` by one, so a left operand at equal
 * precedence passes and a right operand at equal precedence does not. That is what makes
 * `1-2-3` print without parentheses while `1-(2-3)` keeps them.
 */
function wrap(child: Printed, required: number): string {
  return child.power < required ? `(${child.text})` : child.text;
}

/**
 * Print a number the way Excel writes it.
 *
 * `String(x)` is right for everything a formula can hold except the exponent form, where
 * JavaScript writes `1e+21` and Excel writes `1E+21`. Numbers are the one leaf where a
 * printer that "just works" silently produces text the tokenizer would read back
 * differently.
 */
function printNumber(value: number): string {
  const text = String(value);
  return text.includes("e") ? text.toUpperCase() : text;
}

function printCellRef(node: CellRefNode): string {
  return `${sheetPrefix(node.sheet, node.endSheet)}${printLocalCellRef(node)}`;
}

function printLocalCellRef(node: CellRefNode): string {
  return `${node.colAbsolute ? "$" : ""}${node.col}${node.rowAbsolute ? "$" : ""}${node.row}`;
}

/**
 * `Sheet1!`, `Sheet1:Sheet3!`, or `'My Sheet'!` when quoting is required.
 *
 * A sheet name needs quoting when it contains anything outside the unquoted set, and an
 * apostrophe inside it is doubled — the same rule as a string literal.
 */
function sheetPrefix(sheet: string | undefined, endSheet: string | undefined): string {
  if (sheet === undefined) {
    return "";
  }
  const first = quoteSheetName(sheet);
  const last = endSheet === undefined ? undefined : quoteSheetName(endSheet);
  // A quoted 3D reference quotes the pair, not each half: 'A B:C D'!A1.
  if (last !== undefined) {
    return needsQuoting(sheet) || needsQuoting(endSheet!)
      ? `'${escapeSheetName(sheet)}:${escapeSheetName(endSheet!)}'!`
      : `${sheet}:${endSheet}!`;
  }
  return `${first}!`;
}

function needsQuoting(name: string): boolean {
  // Unquoted sheet names allow letters, digits, underscore and full stop, and may not
  // start with a digit. Anything else — a space, a hyphen, a quote — needs quoting.
  return !/^[A-Za-z_\\][A-Za-z0-9_.\\]*$/.test(name);
}

function escapeSheetName(name: string): string {
  return name.replaceAll("'", "''");
}

function quoteSheetName(name: string): string {
  return needsQuoting(name) ? `'${escapeSheetName(name)}'` : name;
}

/**
 * `Table1[Column]`, `Table1[[#Data],[Column]]`, `[@Column]`.
 *
 * The bracket form depends on how many parts there are: a single column with no special
 * item is written bare, and anything else needs each part in its own brackets.
 */
function printStructuredRef(
  tableName: string,
  columns: readonly string[],
  specials: readonly string[]
): string {
  const parts = [
    ...specials.map(special => `[${special}]`),
    ...columns.map(column => `[${column}]`)
  ];
  if (parts.length === 0) {
    return `${tableName}[]`;
  }
  if (parts.length === 1 && specials.length === 0) {
    return `${tableName}${parts[0]}`;
  }
  return `${tableName}[${parts.join(",")}]`;
}

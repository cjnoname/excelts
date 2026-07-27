/**
 * AST Node Types for Formula Parser
 *
 * Defines the Abstract Syntax Tree node types as a proper discriminated union.
 * Each node variant carries only the data relevant to its type.
 */

// ============================================================================
// Node Type Enum
// ============================================================================

export enum NodeType {
  Number = 1,
  String = 2,
  Boolean = 3,
  Error = 4,
  CellRef = 5,
  RangeRef = 6,
  BinaryOp = 7,
  UnaryOp = 8,
  FunctionCall = 9,
  Array = 10,
  Percent = 11,
  Name = 12,
  ColRangeRef = 13,
  RowRangeRef = 14,
  StructuredRef = 15,
  Missing = 16,
  UnionRef = 17
}

// ============================================================================
// Individual Node Interfaces
// ============================================================================

export interface NumberNode {
  type: NodeType.Number;
  value: number;
}

export interface StringNode {
  type: NodeType.String;
  value: string;
}

export interface BooleanNode {
  type: NodeType.Boolean;
  value: boolean;
}

export interface ErrorNode {
  type: NodeType.Error;
  value: string;
}

export interface CellRefNode {
  type: NodeType.CellRef;
  /** Uppercase column letters, e.g. "A" */
  col: string;
  /** Row number as string, e.g. "1" */
  row: string;
  colAbsolute: boolean;
  rowAbsolute: boolean;
  /** Optional sheet name for cross-sheet references */
  sheet?: string;
  /** Optional end sheet name for 3D references (e.g. Sheet1:Sheet3!A1) */
  endSheet?: string;
}

export interface RangeRefNode {
  type: NodeType.RangeRef;
  /** Top-left cell */
  start: CellRefNode;
  /** Bottom-right cell */
  end: CellRefNode;
  /** Sheet name — both start and end share same sheet */
  sheet?: string;
  /** Optional end sheet name for 3D references (e.g. Sheet1:Sheet3!A1:B2) */
  endSheet?: string;
}

export interface BinaryOpNode {
  type: NodeType.BinaryOp;
  op: string;
  left: AstNode;
  right: AstNode;
}

export interface UnaryOpNode {
  type: NodeType.UnaryOp;
  op: string;
  operand: AstNode;
}

export interface FunctionCallNode {
  type: NodeType.FunctionCall;
  name: string;
  args: AstNode[];
}

export interface ArrayNode {
  type: NodeType.Array;
  /** rows[i][j] = element */
  rows: AstNode[][];
}

export interface PercentNode {
  type: NodeType.Percent;
  operand: AstNode;
}

export interface NameNode {
  type: NodeType.Name;
  name: string;
}

export interface ColRangeRefNode {
  type: NodeType.ColRangeRef;
  /** Start column (e.g. "A") */
  startCol: string;
  /** End column (e.g. "B") */
  endCol: string;
  /** Optional sheet name */
  sheet?: string;
  /** Optional end sheet name for 3D references */
  endSheet?: string;
}

export interface RowRangeRefNode {
  type: NodeType.RowRangeRef;
  /** Start row (1-based) */
  startRow: number;
  /** End row (1-based) */
  endRow: number;
  /** Optional sheet name */
  sheet?: string;
  /** Optional end sheet name for 3D references */
  endSheet?: string;
}

export interface StructuredRefNode {
  type: NodeType.StructuredRef;
  /** Table name (empty string for implicit [@Col] syntax) */
  tableName: string;
  /** Column references (e.g. ["Column1", "Column2"] for a column range) */
  columns: string[];
  /** Special items (e.g. ["#Headers", "#Data", "#Totals", "#All", "#This Row"]) */
  specials: string[];
}

/** Represents an omitted/missing argument in a function call (e.g., the middle arg in IF(A1,,0)). */
export interface MissingNode {
  type: NodeType.Missing;
}

/**
 * A reference union produced by the comma operator inside
 * parentheses — `(A1:B2, D4:E5)`. Each member is itself a
 * reference-producing sub-expression. INDEX's `area_num` parameter
 * selects which element of the union to read.
 */
export interface UnionRefNode {
  type: NodeType.UnionRef;
  /** The union members, in syntactic order. */
  areas: AstNode[];
}

// ============================================================================
// Discriminated Union
// ============================================================================

export type AstNode =
  | NumberNode
  | StringNode
  | BooleanNode
  | ErrorNode
  | CellRefNode
  | RangeRefNode
  | BinaryOpNode
  | UnaryOpNode
  | FunctionCallNode
  | ArrayNode
  | PercentNode
  | NameNode
  | ColRangeRefNode
  | RowRangeRefNode
  | StructuredRefNode
  | MissingNode
  | UnionRefNode;

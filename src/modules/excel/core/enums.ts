/**
 * OOXML enumerations, as plain constant objects + same-named derived types.
 *
 * Deliberately NOT TypeScript `enum`s: an `enum` compiles to a runtime IIFE
 * that bundlers cannot tree-shake, and its reverse map (`ValueType[2]`) is
 * dead weight nobody reads. A `const … as const` object plus
 * `type X = (typeof X)[keyof typeof X]` gives the same `X.Member` ergonomics in
 * both value and type position, is eliminated when unused, and rejects stray
 * `number`s that a numeric enum would silently accept.
 *
 * `ValueType`, `FormulaType` and `ErrorValue` are part of the public
 * `documonster/excel` surface (see `index.base.ts`).
 */
export const ValueType = {
  Null: 0,
  Merge: 1,
  Number: 2,
  String: 3,
  Date: 4,
  Hyperlink: 5,
  Formula: 6,
  SharedString: 7,
  RichText: 8,
  Boolean: 9,
  Error: 10,
  JSON: 11, // Internal type for JSON values that serialize as String
  Checkbox: 12
} as const;
export type ValueType = (typeof ValueType)[keyof typeof ValueType];

export const FormulaType = {
  None: 0,
  Master: 1,
  Shared: 2
} as const;
export type FormulaType = (typeof FormulaType)[keyof typeof FormulaType];

export const RelationshipType = {
  None: 0,
  OfficeDocument: 1,
  Worksheet: 2,
  CalcChain: 3,
  SharedStrings: 4,
  Styles: 5,
  Theme: 6,
  Hyperlink: 7
} as const;
export type RelationshipType = (typeof RelationshipType)[keyof typeof RelationshipType];

export const ReadingOrder = {
  LeftToRight: 1,
  RightToLeft: 2
} as const;
export type ReadingOrder = (typeof ReadingOrder)[keyof typeof ReadingOrder];

export const ErrorValue = {
  NotApplicable: "#N/A",
  Ref: "#REF!",
  Name: "#NAME?",
  DivZero: "#DIV/0!",
  Null: "#NULL!",
  Value: "#VALUE!",
  Num: "#NUM!",
  Spill: "#SPILL!",
  Calc: "#CALC!"
} as const;
export type ErrorValue = (typeof ErrorValue)[keyof typeof ErrorValue];

export const Enums = {
  ValueType,
  FormulaType,
  RelationshipType,
  ReadingOrder,
  ErrorValue
};

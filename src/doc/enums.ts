export enum ValueType {
  Null = 0,
  Merge = 1,
  Number = 2,
  String = 3,
  Date = 4,
  Hyperlink = 5,
  Formula = 6,
  SharedString = 7,
  RichText = 8,
  Boolean = 9,
  Error = 10,
  JSON = 11 // Internal type for JSON values that serialize as String
}

export enum FormulaType {
  None = 0,
  Master = 1,
  Shared = 2
}

export enum RelationshipType {
  None = 0,
  OfficeDocument = 1,
  Worksheet = 2,
  CalcChain = 3,
  SharedStrings = 4,
  Styles = 5,
  Theme = 6,
  Hyperlink = 7
}

export enum DocumentType {
  Xlsx = 1
}

export enum ReadingOrder {
  LeftToRight = 1,
  RightToLeft = 2
}

export const ErrorValue = {
  NotApplicable: "#N/A",
  Ref: "#REF!",
  Name: "#NAME?",
  DivZero: "#DIV/0!",
  Null: "#NULL!",
  Value: "#VALUE!",
  Num: "#NUM!"
} as const;

export type ErrorValueType = (typeof ErrorValue)[keyof typeof ErrorValue];

export const Enums = {
  ValueType,
  FormulaType,
  RelationshipType,
  DocumentType,
  ReadingOrder,
  ErrorValue
};

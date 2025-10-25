import { objectFromProps, range, toSortedArray } from "../utils/utils.js";

interface PivotTableModel {
  sourceSheet: any;
  rows: string[];
  columns: string[];
  values: string[];
  metric?: string;
}

interface CacheField {
  name: string;
  sharedItems: any[] | null;
}

interface PivotTable {
  sourceSheet: any;
  rows: number[];
  columns: number[];
  values: number[];
  metric: string;
  cacheFields: CacheField[];
  cacheId: string;
}

// TK(2023-10-10): turn this into a class constructor.

function makePivotTable(worksheet: any, model: PivotTableModel): PivotTable {
  // Example `model`:
  // {
  //   // Source of data: the entire sheet range is taken,
  //   // akin to `worksheet1.getSheetValues()`.
  //   sourceSheet: worksheet1,
  //
  //   // Pivot table fields: values indicate field names;
  //   // they come from the first row in `worksheet1`.
  //   rows: ['A', 'B'],
  //   columns: ['C'],
  //   values: ['E'], // only 1 item possible for now
  //   metric: 'sum', // only 'sum' possible for now
  // }

  validate(worksheet, model);

  const { sourceSheet } = model;
  const { rows, columns, values } = model;

  const cacheFields = makeCacheFields(sourceSheet, [...rows, ...columns]);

  const nameToIndex = cacheFields.reduce(
    (result: Record<string, number>, cacheField: CacheField, index: number) => {
      result[cacheField.name] = index;
      return result;
    },
    {} as Record<string, number>
  );
  const rowIndices = rows.map(row => nameToIndex[row]);
  const columnIndices = columns.map(column => nameToIndex[column]);
  const valueIndices = values.map(value => nameToIndex[value]);

  // form pivot table object
  return {
    sourceSheet,
    rows: rowIndices,
    columns: columnIndices,
    values: valueIndices,
    metric: "sum",
    cacheFields,
    // defined in <pivotTableDefinition> of xl/pivotTables/pivotTable1.xml;
    // also used in xl/workbook.xml
    cacheId: "10"
  };
}

function validate(worksheet: any, model: PivotTableModel): void {
  if (worksheet.workbook.pivotTables.length === 1) {
    throw new Error(
      "A pivot table was already added. At this time, ExcelTS supports at most one pivot table per file."
    );
  }

  if (model.metric && model.metric !== "sum") {
    throw new Error('Only the "sum" metric is supported at this time.');
  }

  const headerNames = model.sourceSheet.getRow(1).values.slice(1);
  const isInHeaderNames = objectFromProps(headerNames, true);
  for (const name of [...model.rows, ...model.columns, ...model.values]) {
    if (!isInHeaderNames[name]) {
      throw new Error(`The header name "${name}" was not found in ${model.sourceSheet.name}.`);
    }
  }

  if (!model.rows.length) {
    throw new Error("No pivot table rows specified.");
  }

  if (!model.columns.length) {
    throw new Error("No pivot table columns specified.");
  }

  if (model.values.length !== 1) {
    throw new Error("Exactly 1 value needs to be specified at this time.");
  }
}

function makeCacheFields(worksheet: any, fieldNamesWithSharedItems: string[]): CacheField[] {
  // Cache fields are used in pivot tables to reference source data.
  //
  // Example
  // -------
  // Turn
  //
  //  `worksheet` sheet values [
  //    ['A', 'B', 'C', 'D', 'E'],
  //    ['a1', 'b1', 'c1', 4, 5],
  //    ['a1', 'b2', 'c1', 4, 5],
  //    ['a2', 'b1', 'c2', 14, 24],
  //    ['a2', 'b2', 'c2', 24, 35],
  //    ['a3', 'b1', 'c3', 34, 45],
  //    ['a3', 'b2', 'c3', 44, 45]
  //  ];
  //  fieldNamesWithSharedItems = ['A', 'B', 'C'];
  //
  // into
  //
  //  [
  //    { name: 'A', sharedItems: ['a1', 'a2', 'a3'] },
  //    { name: 'B', sharedItems: ['b1', 'b2'] },
  //    { name: 'C', sharedItems: ['c1', 'c2', 'c3'] },
  //    { name: 'D', sharedItems: null },
  //    { name: 'E', sharedItems: null }
  //  ]

  const names = worksheet.getRow(1).values;
  const nameToHasSharedItems = objectFromProps(fieldNamesWithSharedItems, true);

  const aggregate = (columnIndex: number): any[] => {
    const columnValues = worksheet.getColumn(columnIndex).values.splice(2);
    const columnValuesAsSet = new Set(columnValues);
    return toSortedArray(columnValuesAsSet);
  };

  // make result
  const result: CacheField[] = [];
  for (const columnIndex of range(1, names.length)) {
    const name = names[columnIndex];
    const sharedItems = nameToHasSharedItems[name] ? aggregate(columnIndex) : null;
    result.push({ name, sharedItems });
  }
  return result;
}

export { makePivotTable };

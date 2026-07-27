export interface ChartTableSnapshot {
  readonly name: string;
  readonly displayName?: string;
  readonly ref: string;
  readonly columns: readonly string[];
  readonly headerRow: boolean;
  readonly totalsRow: boolean;
}

export interface ChartWorksheetSnapshot {
  readonly name: string;
  readonly orderNo?: number;
  readonly cells: ReadonlyMap<string, unknown>;
  readonly tables: readonly ChartTableSnapshot[];
}

export interface ChartDefinedNameSnapshot {
  readonly name: string;
  readonly ranges: readonly string[];
  readonly localSheetId?: number;
}

export interface ChartDataSnapshot {
  readonly worksheets: readonly ChartWorksheetSnapshot[];
  readonly worksheetsByName: ReadonlyMap<string, ChartWorksheetSnapshot>;
  readonly definedNames: readonly ChartDefinedNameSnapshot[];
  readonly date1904: boolean;
  readonly contextSheetName?: string;
  readonly contextLocalSheetId?: number;
}

export function chartSnapshotCellKey(row: number, col: number): string {
  return `${row}:${col}`;
}

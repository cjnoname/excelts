import type { Row } from "../../doc/row.js";

export class ColumnSum {
  private columns: number[];
  private sums: number[];
  public count: number = 0;

  constructor(columns: number[]) {
    this.columns = columns;
    this.sums = [];
    for (const column of this.columns) {
      this.sums[column] = 0;
    }
  }

  add(row: Row): void {
    for (const column of this.columns) {
      this.sums[column] += row.getCell(column).value as number;
    }
    this.count++;
  }

  toString(): string {
    return this.sums.join(", ");
  }

  toAverages(): string {
    return this.sums.map(value => (value ? value / this.count : value)).join(", ");
  }
}

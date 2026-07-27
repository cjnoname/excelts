import type { WorkbookSnapshot } from "@formula/integration/workbook-snapshot";
import { snapshotCellKey } from "@formula/integration/workbook-snapshot";

export interface SpillAvailabilityOptions {
  readonly snapshot: WorkbookSnapshot;
  readonly sheetName: string;
  readonly sourceRow: number;
  readonly sourceCol: number;
  readonly rows: number;
  readonly cols: number;
  readonly isReusableGhost: (row: number, col: number) => boolean;
  readonly isClaimed: (row: number, col: number) => boolean;
}

export function isSpillAvailable(options: SpillAvailabilityOptions): boolean {
  const { snapshot, sheetName, sourceRow, sourceCol, rows, cols } = options;
  const ws = snapshot.worksheetsByName.get(sheetName.toLowerCase());
  if (!ws || sourceRow + rows - 1 > 1048576 || sourceCol + cols - 1 > 16384) {
    return false;
  }
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const row = sourceRow + r;
      const col = sourceCol + c;
      if (
        ws.mergedRegions.some(
          region =>
            row >= region.top && row <= region.bottom && col >= region.left && col <= region.right
        )
      ) {
        return false;
      }
      if (r === 0 && c === 0) {
        continue;
      }
      if (options.isClaimed(row, col)) {
        return false;
      }
      const cell = ws.cells.get(snapshotCellKey(row, col));
      if (!cell || options.isReusableGhost(row, col)) {
        continue;
      }
      if (cell.formulaKind !== "none" || cell.value !== null) {
        return false;
      }
    }
  }
  return true;
}

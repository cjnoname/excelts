import { Range } from "../../../doc/range.js";
import { colCache } from "../../../utils/col-cache.js";
import { Enums } from "../../../doc/enums.js";

interface MergeData {
  address: string;
  master: string;
}

class Merges {
  declare private merges: { [key: string]: Range };
  declare private hash?: { [key: string]: Range };

  constructor() {
    // optional mergeCells is array of ranges (like the xml)
    this.merges = {};
  }

  add(merge: MergeData): void {
    // merge is {address, master}
    if (this.merges[merge.master]) {
      this.merges[merge.master].expandToAddress(merge.address);
    } else {
      const range = `${merge.master}:${merge.address}`;
      this.merges[merge.master] = new Range(range);
    }
  }

  get mergeCells(): string[] {
    return Object.values(this.merges).map((merge: Range) => merge.range);
  }

  reconcile(mergeCells: string[], rows: any[]): void {
    // reconcile merge list with merge cells
    mergeCells.forEach((merge: string) => {
      const dimensions: any = colCache.decode(merge);
      for (let i = dimensions.top; i <= dimensions.bottom; i++) {
        const row = rows[i - 1];
        for (let j = dimensions.left; j <= dimensions.right; j++) {
          const cell = row.cells[j - 1];
          if (!cell) {
            // nulls are not included in document - so if master cell has no value - add a null one here
            row.cells[j] = {
              type: Enums.ValueType.Null,
              address: colCache.encodeAddress(i, j)
            };
          } else if (cell.type === Enums.ValueType.Merge) {
            cell.master = dimensions.tl;
          }
        }
      }
    });
  }

  getMasterAddress(address: string): string | undefined {
    // if address has been merged, return its master's address. Assumes reconcile has been called
    const range = this.hash![address];
    return range && range.tl;
  }
}

export { Merges };

import { ColumnOutOfBoundsError, InvalidAddressError } from "@excel/errors";
import type { DecodedAddress, Location } from "@excel/types";

const addressRegex = /^[A-Z]+\d+$/;

// Internal type with required $col$row for caching
type CachedAddress = DecodedAddress & { $col$row: string };

export type DecodedRange = Location & {
  tl: string | CachedAddress;
  br: string | CachedAddress;
  dimensions: string;
  sheetName?: string;
};

interface ErrorReference {
  error: string;
  sheetName?: string;
}

type DecodeExResult = CachedAddress | DecodedRange | ErrorReference;

interface ColCache {
  _dictionary: string[];
  _l2nFill: number;
  _l2n: Record<string, number>;
  _n2l: string[];
  _hash: Record<string, CachedAddress>;
  _level(n: number): number;
  _fill(level: number): void;
  l2n(l: string): number;
  n2l(n: number): string;
  validateAddress(value: string): boolean;
  decodeCol(value: string): number;
  decodeAddress(value: string): CachedAddress;
  getAddress(r: number | string, c?: number): CachedAddress;
  decode(value: string): CachedAddress | DecodedRange;
  decodeEx(value: string): DecodeExResult;
  encodeAddress(row: number, col: number): string;
  encode(...args: number[]): string;
  compareAddress(a: string, b: string): number;
  inRange(range: number[], address: number[]): boolean;
}

// =========================================================================
// Column Letter to Number conversion
const colCache: ColCache = {
  _dictionary: [
    "A",
    "B",
    "C",
    "D",
    "E",
    "F",
    "G",
    "H",
    "I",
    "J",
    "K",
    "L",
    "M",
    "N",
    "O",
    "P",
    "Q",
    "R",
    "S",
    "T",
    "U",
    "V",
    "W",
    "X",
    "Y",
    "Z"
  ],
  _l2nFill: 0,
  _l2n: {} as Record<string, number>,
  _n2l: [] as string[],
  _level(n: number): number {
    if (n <= 26) {
      return 1;
    }
    if (n <= 26 * 26) {
      return 2;
    }
    return 3;
  },
  _fill(level: number): void {
    let c: string;
    let v: number;
    let l1: number;
    let l2: number;
    let l3: number;
    let n = 1;
    if (level >= 4) {
      // Defensive invariant: Excel's column space (XFD = 16,384) caps at
      // three letters, so neither `l2n` nor `n2l` should ever ask for a
      // higher level. Both callers validate before reaching here; if
      // this branch fires it indicates a programming error in a future
      // caller, not a user input problem — surface that clearly rather
      // than reusing `ColumnOutOfBoundsError` (which would lie about
      // the offending column, since `level` is a letter-count, not a
      // column number).
      throw new Error(
        `colCache._fill: invariant violated — level ${level} exceeds the 3-letter cap; callers must validate before invoking _fill`
      );
    }
    if (this._l2nFill < 1 && level >= 1) {
      while (n <= 26) {
        c = this._dictionary[n - 1];
        this._n2l[n] = c;
        this._l2n[c] = n;
        n++;
      }
      this._l2nFill = 1;
    }
    if (this._l2nFill < 2 && level >= 2) {
      n = 27;
      while (n <= 26 + 26 * 26) {
        v = n - (26 + 1);
        l1 = v % 26;
        l2 = Math.floor(v / 26);
        c = this._dictionary[l2] + this._dictionary[l1];
        this._n2l[n] = c;
        this._l2n[c] = n;
        n++;
      }
      this._l2nFill = 2;
    }
    if (this._l2nFill < 3 && level >= 3) {
      n = 26 + 26 * 26 + 1;
      while (n <= 16384) {
        v = n - (26 * 26 + 26 + 1);
        l1 = v % 26;
        l2 = Math.floor(v / 26) % 26;
        l3 = Math.floor(v / (26 * 26));
        c = this._dictionary[l3] + this._dictionary[l2] + this._dictionary[l1];
        this._n2l[n] = c;
        this._l2n[c] = n;
        n++;
      }
      this._l2nFill = 3;
    }
  },
  l2n(l: string): number {
    if (!this._l2n[l]) {
      // Excel's column space stops at XFD (16,384) — three letters is
      // the maximum width any valid column letter can have. Reject
      // longer inputs explicitly here, BEFORE handing the length to
      // `_fill`, so the thrown error carries the actual offending
      // letter (`AAAA`) rather than the level integer (`4`) — matching
      // what the equivalent `n2l(n > 16384)` and `decodeAddress` paths
      // already report.
      if (l.length > 3) {
        throw new ColumnOutOfBoundsError(l, "Excel supports columns from 1 to 16384");
      }
      this._fill(l.length);
    }
    if (!this._l2n[l]) {
      throw new ColumnOutOfBoundsError(l, `Invalid column letter: ${l}`);
    }
    return this._l2n[l];
  },
  n2l(n: number): string {
    if (n < 1 || n > 16384) {
      throw new ColumnOutOfBoundsError(n);
    }
    if (!this._n2l[n]) {
      this._fill(this._level(n));
    }
    return this._n2l[n];
  },

  // =========================================================================
  // Address processing
  _hash: {} as Record<string, CachedAddress>,

  /**
   * Extract column number from a cell address string (e.g. "A1" → 1, "AA11" → 27).
   * Lightweight alternative to decodeAddress() when only the column is needed.
   * Avoids object allocation, string construction, and cache overhead.
   */
  decodeCol(value: string): number {
    let col = 0;
    for (let i = 0; i < value.length; i++) {
      const c = value.charCodeAt(i);
      if (c >= 65 && c <= 90) {
        col = col * 26 + c - 64;
      } else {
        break;
      }
    }
    return col;
  },

  // check if value looks like an address
  validateAddress(value: string): boolean {
    if (!addressRegex.test(value)) {
      throw new InvalidAddressError(value);
    }
    return true;
  },

  // convert address string into structure
  decodeAddress(value: string): CachedAddress {
    if (!value || typeof value !== "string") {
      throw new InvalidAddressError(String(value));
    }
    const addr = value.length < 5 && this._hash[value];
    if (addr) {
      return addr;
    }

    // Fast path: parse column letters and row digits directly from char codes.
    // Avoids intermediate string concatenation for the common case.
    let colNumber: number | undefined = 0;
    let rowNumber: number | undefined = 0;
    let hasCol = false;
    let hasRow = false;
    let colEnd = 0; // index where col letters end
    let colStart = 0; // index where col letters start (after any $)

    for (let i = 0; i < value.length; i++) {
      const char = value.charCodeAt(i);
      if (char === 36) {
        // '$' — skip it
        if (!hasCol && !hasRow) {
          colStart = i + 1;
        }
        continue;
      }
      if (!hasRow && char >= 65 && char <= 90) {
        hasCol = true;
        colNumber = colNumber * 26 + char - 64;
        colEnd = i + 1;
      } else if (char >= 48 && char <= 57) {
        hasRow = true;
        rowNumber = rowNumber * 10 + char - 48;
      } else if (hasRow && hasCol) {
        break;
      }
    }

    if (!hasCol) {
      colNumber = undefined;
    } else if (colNumber > 16384) {
      const col = value.slice(0, colEnd);
      throw new ColumnOutOfBoundsError(col, `Invalid column letter: ${col}`);
    }
    if (!hasRow) {
      rowNumber = undefined;
    }

    // Build canonical address string only when needed
    const col = hasCol ? value.slice(colStart, colEnd) : "";
    const row = hasRow ? String(rowNumber) : "";
    const canonical = col + row;

    const address: CachedAddress = {
      address: canonical,
      col: colNumber!,
      row: rowNumber!,
      $col$row: `$${col}$${row}`
    };

    // mem fix - cache only the tl 100x100 square
    if (colNumber! <= 100 && rowNumber! <= 100) {
      this._hash[canonical] = address;
      this._hash[address.$col$row] = address;
    }

    return address;
  },

  // convert r,c into structure (if only 1 arg, assume r is address string)
  getAddress(r: number | string, c?: number): CachedAddress {
    if (c) {
      const address = this.n2l(c) + r;
      return this.decodeAddress(address);
    }
    return this.decodeAddress(r as string);
  },

  // convert [address], [tl:br] into address structures
  decode(value: string) {
    if (!value || typeof value !== "string") {
      throw new InvalidAddressError(String(value));
    }
    const parts = value.split(":");
    if (parts.length === 2) {
      const tl = this.decodeAddress(parts[0]);
      const br = this.decodeAddress(parts[1]);
      const result: DecodedRange = {
        top: Math.min(tl.row, br.row),
        left: Math.min(tl.col, br.col),
        bottom: Math.max(tl.row, br.row),
        right: Math.max(tl.col, br.col),
        tl: "",
        br: "",
        dimensions: ""
      };
      // reconstruct tl, br and dimensions
      result.tl = this.n2l(result.left) + result.top;
      result.br = this.n2l(result.right) + result.bottom;
      result.dimensions = `${result.tl}:${result.br}`;
      return result;
    }
    return this.decodeAddress(value);
  },

  // convert [sheetName!][$]col[$]row[[$]col[$]row] into address or range structures
  decodeEx(value: string): DecodeExResult {
    if (!value || typeof value !== "string") {
      throw new InvalidAddressError(String(value));
    }
    // Use possessive quantifiers to prevent catastrophic backtracking (ReDoS)
    const groups = value.match(/^(?:(?:(?:'((?:[^']|'')+?)')|([^'^ !]+?))!)?(.*)$/);

    const sheetName = groups![1] || groups![2]; // Quoted and unquoted groups
    const reference = groups![3]; // Remaining address

    const parts = reference.split(":");
    if (parts.length > 1) {
      const tl = this.decodeAddress(parts[0]);
      const br = this.decodeAddress(parts[1]);
      const top = Math.min(tl.row, br.row);
      const left = Math.min(tl.col, br.col);
      const bottom = Math.max(tl.row, br.row);
      const right = Math.max(tl.col, br.col);

      const tlStr = this.n2l(left) + top;
      const brStr = this.n2l(right) + bottom;

      return {
        top,
        left,
        bottom,
        right,
        sheetName,
        tl: {
          address: tlStr,
          col: left,
          row: top,
          $col$row: `$${this.n2l(left)}$${top}`,
          sheetName
        },
        br: {
          address: brStr,
          col: right,
          row: bottom,
          $col$row: `$${this.n2l(right)}$${bottom}`,
          sheetName
        },
        dimensions: `${tlStr}:${brStr}`
      };
    }
    if (reference.indexOf("#") === 0) {
      return sheetName ? { sheetName, error: reference } : { error: reference };
    }

    const address = this.decodeAddress(reference);
    return sheetName ? { sheetName, ...address } : address;
  },

  // convert row,col into address string
  encodeAddress(row: number, col: number): string {
    return colCache.n2l(col) + row;
  },

  // convert row,col into string address or t,l,b,r into range
  encode(...args: number[]): string {
    switch (args.length) {
      case 2:
        return colCache.encodeAddress(args[0], args[1]);
      case 4:
        return `${colCache.encodeAddress(args[0], args[1])}:${colCache.encodeAddress(args[2], args[3])}`;
      default:
        throw new InvalidAddressError(String(args.length), "Can only encode with 2 or 4 arguments");
    }
  },

  /**
   * Compare two cell addresses by column then row (numeric order).
   *
   * Returns a negative number if `a` should come before `b`,
   * a positive number if `a` should come after `b`, or zero if equal.
   *
   * This avoids the pitfalls of `localeCompare` which treats addresses
   * as strings (e.g. "C10" < "C2") instead of comparing their numeric
   * column and row components.
   */
  compareAddress(a: string, b: string): number {
    const addrA = colCache.decodeAddress(a);
    const addrB = colCache.decodeAddress(b);
    return addrA.col - addrB.col || addrA.row - addrB.row;
  },

  // return true if address is contained within range
  inRange(range: number[], address: number[]): boolean {
    const [left, top, , right, bottom] = range;
    const [col, row] = address;
    return col >= left && col <= right && row >= top && row <= bottom;
  }
};

export { colCache };

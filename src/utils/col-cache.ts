import type { Address, Location } from "../types.js";

const addressRegex = /^[A-Z]+\d+$/;

type Range = Location & {
  tl: string | Address;
  br: string | Address;
  dimensions: string;
  sheetName?: string;
};

interface ErrorReference {
  error: string;
  sheetName?: string;
}

type DecodeExResult = Address | Range | ErrorReference;

interface ColCache {
  _dictionary: string[];
  _l2nFill: number;
  _l2n: Record<string, number>;
  _n2l: string[];
  _hash: Record<string, Address>;
  _level(n: number): number;
  _fill(level: number): void;
  l2n(l: string): number;
  n2l(n: number): string;
  validateAddress(value: string): boolean;
  decodeAddress(value: string): Address;
  getAddress(r: number | string, c?: number): Address;
  decode(value: string): Address | Range;
  decodeEx(value: string): DecodeExResult;
  encodeAddress(row: number, col: number): string;
  encode(...args: number[]): string;
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
      throw new Error("Out of bounds. Excel supports columns from 1 to 16384");
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
      this._fill(l.length);
    }
    if (!this._l2n[l]) {
      throw new Error(`Out of bounds. Invalid column letter: ${l}`);
    }
    return this._l2n[l];
  },
  n2l(n: number): string {
    if (n < 1 || n > 16384) {
      throw new Error(`${n} is out of bounds. Excel supports columns from 1 to 16384`);
    }
    if (!this._n2l[n]) {
      this._fill(this._level(n));
    }
    return this._n2l[n];
  },

  // =========================================================================
  // Address processing
  _hash: {} as Record<string, Address>,

  // check if value looks like an address
  validateAddress(value: string): boolean {
    if (!addressRegex.test(value)) {
      throw new Error(`Invalid Address: ${value}`);
    }
    return true;
  },

  // convert address string into structure
  decodeAddress(value: string): Address {
    const addr = value.length < 5 && this._hash[value];
    if (addr) {
      return addr;
    }
    let hasCol = false;
    let col = "";
    let colNumber: number | undefined = 0;
    let hasRow = false;
    let row = "";
    let rowNumber: number | undefined = 0;
    for (let i = 0, char; i < value.length; i++) {
      char = value.charCodeAt(i);
      // col should before row
      if (!hasRow && char >= 65 && char <= 90) {
        // 65 = 'A'.charCodeAt(0)
        // 90 = 'Z'.charCodeAt(0)
        hasCol = true;
        col += value[i];
        // colNumber starts from 1
        colNumber = colNumber * 26 + char - 64;
      } else if (char >= 48 && char <= 57) {
        // 48 = '0'.charCodeAt(0)
        // 57 = '9'.charCodeAt(0)
        hasRow = true;
        row += value[i];
        // rowNumber starts from 0
        rowNumber = rowNumber * 10 + char - 48;
      } else if (hasRow && hasCol && char !== 36) {
        // 36 = '$'.charCodeAt(0)
        break;
      }
    }
    if (!hasCol) {
      colNumber = undefined;
    } else if (colNumber! > 16384) {
      throw new Error(`Out of bounds. Invalid column letter: ${col}`);
    }
    if (!hasRow) {
      rowNumber = undefined;
    }

    // in case $row$col
    value = col + row;

    const address: Address = {
      address: value,
      col: colNumber!,
      row: rowNumber!,
      $col$row: `$${col}$${row}`
    };

    // mem fix - cache only the tl 100x100 square
    if (colNumber! <= 100 && rowNumber! <= 100) {
      this._hash[value] = address;
      this._hash[address.$col$row] = address;
    }

    return address;
  },

  // convert r,c into structure (if only 1 arg, assume r is address string)
  getAddress(r: number | string, c?: number): Address {
    if (c) {
      const address = this.n2l(c) + r;
      return this.decodeAddress(address);
    }
    return this.decodeAddress(r as string);
  },

  // convert [address], [tl:br] into address structures
  decode(value: string) {
    const parts = value.split(":");
    if (parts.length === 2) {
      const tl = this.decodeAddress(parts[0]);
      const br = this.decodeAddress(parts[1]);
      const result: Range = {
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
        throw new Error("Can only encode with 2 or 4 arguments");
    }
  },

  // return true if address is contained within range
  inRange(range: number[], address: number[]): boolean {
    const [left, top, , right, bottom] = range;
    const [col, row] = address;
    return col >= left && col <= right && row >= top && row <= bottom;
  }
};

export { colCache };

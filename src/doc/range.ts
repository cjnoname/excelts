import { colCache } from "../utils/col-cache.js";

interface RangeModel {
  top: number;
  left: number;
  bottom: number;
  right: number;
  sheetName?: string;
}

interface RowDimensions {
  min: number;
  max: number;
}

interface RowWithDimensions {
  number: number;
  dimensions?: RowDimensions;
}

// used by worksheet to calculate sheet dimensions
class Range {
  model: RangeModel;

  constructor(...args: any[]) {
    this.decode(args);
  }

  setTLBR(
    t: number | string,
    l?: number | string,
    b?: number | string,
    r?: number | string,
    s?: string
  ): void {
    if (arguments.length < 4) {
      // setTLBR(tl, br, s)
      const tl = colCache.decodeAddress(t as string);
      const br = colCache.decodeAddress(l as string);
      this.model = {
        top: Math.min(tl.row, br.row),
        left: Math.min(tl.col, br.col),
        bottom: Math.max(tl.row, br.row),
        right: Math.max(tl.col, br.col),
        sheetName: b as string | undefined
      };

      this.setTLBR(tl.row, tl.col, br.row, br.col, s);
    } else {
      // setTLBR(t, l, b, r, s)
      this.model = {
        top: Math.min(t as number, b as number),
        left: Math.min(l as number, r as number),
        bottom: Math.max(t as number, b as number),
        right: Math.max(l as number, r as number),
        sheetName: s
      };
    }
  }

  decode(argv: any[]): void {
    switch (argv.length) {
      case 5: // [t,l,b,r,s]
        this.setTLBR(argv[0], argv[1], argv[2], argv[3], argv[4]);
        break;
      case 4: // [t,l,b,r]
        this.setTLBR(argv[0], argv[1], argv[2], argv[3]);
        break;

      case 3: // [tl,br,s]
        this.setTLBR(argv[0], argv[1], argv[2]);
        break;
      case 2: // [tl,br]
        this.setTLBR(argv[0], argv[1]);
        break;

      case 1: {
        const value = argv[0];
        if (value instanceof Range) {
          // copy constructor
          this.model = {
            top: value.model.top,
            left: value.model.left,
            bottom: value.model.bottom,
            right: value.model.right,
            sheetName: value.sheetName
          };
        } else if (value instanceof Array) {
          // an arguments array
          this.decode(value);
        } else if (value.top && value.left && value.bottom && value.right) {
          // a model
          this.model = {
            top: value.top,
            left: value.left,
            bottom: value.bottom,
            right: value.right,
            sheetName: value.sheetName
          };
        } else {
          // [sheetName!]tl:br
          const tlbr = colCache.decodeEx(value) as any;
          if (tlbr.top) {
            this.model = {
              top: tlbr.top,
              left: tlbr.left,
              bottom: tlbr.bottom,
              right: tlbr.right,
              sheetName: tlbr.sheetName
            };
          } else {
            this.model = {
              top: tlbr.row,
              left: tlbr.col,
              bottom: tlbr.row,
              right: tlbr.col,
              sheetName: tlbr.sheetName
            };
          }
        }
        break;
      }

      case 0:
        this.model = {
          top: 0,
          left: 0,
          bottom: 0,
          right: 0
        };
        break;

      default:
        throw new Error(`Invalid number of arguments to _getDimensions() - ${argv.length}`);
    }
  }

  get top(): number {
    return this.model.top || 1;
  }

  set top(value: number) {
    this.model.top = value;
  }

  get left(): number {
    return this.model.left || 1;
  }

  set left(value: number) {
    this.model.left = value;
  }

  get bottom(): number {
    return this.model.bottom || 1;
  }

  set bottom(value: number) {
    this.model.bottom = value;
  }

  get right(): number {
    return this.model.right || 1;
  }

  set right(value: number) {
    this.model.right = value;
  }

  get sheetName(): string | undefined {
    return this.model.sheetName;
  }

  set sheetName(value: string | undefined) {
    this.model.sheetName = value;
  }

  get _serialisedSheetName(): string {
    const { sheetName } = this.model;
    if (sheetName) {
      if (/^[a-zA-Z0-9]*$/.test(sheetName)) {
        return `${sheetName}!`;
      }
      return `'${sheetName}'!`;
    }
    return "";
  }

  expand(top: number, left: number, bottom: number, right: number): void {
    if (!this.model.top || top < this.top) {
      this.top = top;
    }
    if (!this.model.left || left < this.left) {
      this.left = left;
    }
    if (!this.model.bottom || bottom > this.bottom) {
      this.bottom = bottom;
    }
    if (!this.model.right || right > this.right) {
      this.right = right;
    }
  }

  expandRow(row: RowWithDimensions | null | undefined): void {
    if (row) {
      const { dimensions, number } = row;
      if (dimensions) {
        this.expand(number, dimensions.min, number, dimensions.max);
      }
    }
  }

  expandToAddress(addressStr: string): void {
    const address = colCache.decodeEx(addressStr) as any;
    this.expand(address.row, address.col, address.row, address.col);
  }

  get tl(): string {
    return colCache.n2l(this.left) + this.top;
  }

  get $t$l(): string {
    return `$${colCache.n2l(this.left)}$${this.top}`;
  }

  get br(): string {
    return colCache.n2l(this.right) + this.bottom;
  }

  get $b$r(): string {
    return `$${colCache.n2l(this.right)}$${this.bottom}`;
  }

  get range(): string {
    return `${this._serialisedSheetName + this.tl}:${this.br}`;
  }

  get $range(): string {
    return `${this._serialisedSheetName + this.$t$l}:${this.$b$r}`;
  }

  get shortRange(): string {
    return this.count > 1 ? this.range : this._serialisedSheetName + this.tl;
  }

  get $shortRange(): string {
    return this.count > 1 ? this.$range : this._serialisedSheetName + this.$t$l;
  }

  get count(): number {
    return (1 + this.bottom - this.top) * (1 + this.right - this.left);
  }

  toString(): string {
    return this.range;
  }

  intersects(other: Range): boolean {
    if (other.sheetName && this.sheetName && other.sheetName !== this.sheetName) {
      return false;
    }
    if (other.bottom < this.top) {
      return false;
    }
    if (other.top > this.bottom) {
      return false;
    }
    if (other.right < this.left) {
      return false;
    }
    if (other.left > this.right) {
      return false;
    }
    return true;
  }

  contains(addressStr: string): boolean {
    const address = colCache.decodeEx(addressStr);
    return this.containsEx(address as any);
  }

  containsEx(address: any): boolean {
    if (address.sheetName && this.sheetName && address.sheetName !== this.sheetName) {
      return false;
    }
    return (
      address.row >= this.top &&
      address.row <= this.bottom &&
      address.col >= this.left &&
      address.col <= this.right
    );
  }

  forEachAddress(cb: (address: string, row: number, col: number) => void): void {
    for (let col = this.left; col <= this.right; col++) {
      for (let row = this.top; row <= this.bottom; row++) {
        cb(colCache.encodeAddress(row, col), row, col);
      }
    }
  }
}

export { Range };
export { Range as Dimensions };

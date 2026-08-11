import { ExcelError } from "@excel/errors";
import type { DecodedAddress } from "@excel/types";
import { colCache } from "@excel/utils/col-cache";

/**
 * Plain-data range record. This is the entire state of a range — there is no
 * class. All operations are free functions in the {@link Range} namespace.
 */
export interface RangeData {
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

/** Input types accepted by {@link Range.create}. */
export type RangeInput = RangeData | string | number | RangeInput[];

function serialisedSheetName(r: RangeData): string {
  const { sheetName } = r;
  if (sheetName) {
    if (/^[a-zA-Z0-9]*$/.test(sheetName)) {
      return `${sheetName}!`;
    }
    return `'${sheetName.replace(/'/g, "''")}'!`;
  }
  return "";
}

function decodeInto(r: RangeData, argv: RangeInput[]): void {
  switch (argv.length) {
    case 5:
      if (
        typeof argv[0] === "number" &&
        typeof argv[1] === "number" &&
        typeof argv[2] === "number" &&
        typeof argv[3] === "number" &&
        typeof argv[4] === "string"
      ) {
        setTLBR(r, argv[0], argv[1], argv[2], argv[3], argv[4]);
      }
      break;
    case 4:
      if (
        typeof argv[0] === "number" &&
        typeof argv[1] === "number" &&
        typeof argv[2] === "number" &&
        typeof argv[3] === "number"
      ) {
        setTLBR(r, argv[0], argv[1], argv[2], argv[3]);
      }
      break;
    case 3:
      if (
        typeof argv[0] === "string" &&
        typeof argv[1] === "string" &&
        typeof argv[2] === "string"
      ) {
        setTLBR(r, argv[0], argv[1], argv[2]);
      }
      break;
    case 2:
      if (typeof argv[0] === "string" && typeof argv[1] === "string") {
        setTLBR(r, argv[0], argv[1]);
      }
      break;
    case 1: {
      const value = argv[0];
      if (Array.isArray(value)) {
        decodeInto(r, value);
      } else if (
        typeof value === "object" &&
        value !== null &&
        "top" in value &&
        "left" in value &&
        "bottom" in value &&
        "right" in value
      ) {
        r.top = value.top;
        r.left = value.left;
        r.bottom = value.bottom;
        r.right = value.right;
        r.sheetName = value.sheetName;
      } else if (typeof value === "string") {
        const decoded = colCache.decodeEx(value);
        if ("top" in decoded) {
          r.top = decoded.top;
          r.left = decoded.left;
          r.bottom = decoded.bottom;
          r.right = decoded.right;
          r.sheetName = decoded.sheetName;
        } else if ("row" in decoded) {
          r.top = decoded.row;
          r.left = decoded.col;
          r.bottom = decoded.row;
          r.right = decoded.col;
          r.sheetName = decoded.sheetName;
        }
      }
      break;
    }
    case 0:
      break;
    default:
      throw new ExcelError(`Invalid number of arguments to Range.create() - ${argv.length}`);
  }
}

function setTLBR(
  r: RangeData,
  t: number | string,
  l: number | string,
  b?: number | string,
  rt?: number,
  s?: string
): void {
  if (typeof t === "string" && typeof l === "string") {
    const tl = colCache.decodeAddress(t);
    const br = colCache.decodeAddress(l);
    r.top = Math.min(tl.row, br.row);
    r.left = Math.min(tl.col, br.col);
    r.bottom = Math.max(tl.row, br.row);
    r.right = Math.max(tl.col, br.col);
    r.sheetName = typeof b === "string" ? b : undefined;
  } else if (
    typeof t === "number" &&
    typeof l === "number" &&
    typeof b === "number" &&
    typeof rt === "number"
  ) {
    r.top = Math.min(t, b);
    r.left = Math.min(l, rt);
    r.bottom = Math.max(t, b);
    r.right = Math.max(l, rt);
    r.sheetName = s;
  }
}

/**
 * Range namespace — free functions over the plain-data {@link RangeData}.
 * Replaces the former `Range`/`Dimensions` class. Used by worksheet to
 * compute sheet dimensions and by xforms to encode/decode A1 references.
 */
export function rangeCreate(...args: RangeInput[]): RangeData {
  const r: RangeData = { top: 0, left: 0, bottom: 0, right: 0 };
  decodeInto(r, args);
  return r;
}

export function rangeSetTLBR(
  r: RangeData,
  t: number | string,
  l: number | string,
  b?: number | string,
  rt?: number,
  s?: string
): void {
  setTLBR(r, t, l, b, rt, s);
}

export function rangeTop(r: RangeData): number {
  return r.top || 1;
}

export function rangeLeft(r: RangeData): number {
  return r.left || 1;
}

export function rangeBottom(r: RangeData): number {
  return r.bottom || 1;
}

export function rangeRight(r: RangeData): number {
  return r.right || 1;
}

export function rangeExpand(
  r: RangeData,
  top: number,
  left: number,
  bottom: number,
  right: number
): void {
  if (!r.top || top < rangeTop(r)) {
    r.top = top;
  }
  if (!r.left || left < rangeLeft(r)) {
    r.left = left;
  }
  if (!r.bottom || bottom > rangeBottom(r)) {
    r.bottom = bottom;
  }
  if (!r.right || right > rangeRight(r)) {
    r.right = right;
  }
}

export function rangeExpandRow(r: RangeData, row: RowWithDimensions | null | undefined): void {
  if (row) {
    const { dimensions, number } = row;
    if (dimensions) {
      rangeExpand(r, number, dimensions.min, number, dimensions.max);
    }
  }
}

export function rangeExpandToAddress(r: RangeData, addressStr: string): void {
  const address = colCache.decodeEx(addressStr);
  if ("row" in address && "col" in address) {
    rangeExpand(r, address.row, address.col, address.row, address.col);
  }
}

export function rangeTl(r: RangeData): string {
  return colCache.n2l(rangeLeft(r)) + rangeTop(r);
}

export function rangeAbsoluteTopLeft(r: RangeData): string {
  return `$${colCache.n2l(rangeLeft(r))}$${rangeTop(r)}`;
}

export function rangeBr(r: RangeData): string {
  return colCache.n2l(rangeRight(r)) + rangeBottom(r);
}

export function rangeAbsoluteBottomRight(r: RangeData): string {
  return `$${colCache.n2l(rangeRight(r))}$${rangeBottom(r)}`;
}

export function rangeRange(r: RangeData): string {
  return `${serialisedSheetName(r) + rangeTl(r)}:${rangeBr(r)}`;
}

export function rangeAbsolute(r: RangeData): string {
  return `${serialisedSheetName(r) + rangeAbsoluteTopLeft(r)}:${rangeAbsoluteBottomRight(r)}`;
}

export function rangeShortRange(r: RangeData): string {
  return rangeCount(r) > 1 ? rangeRange(r) : serialisedSheetName(r) + rangeTl(r);
}

export function rangeAbsoluteShort(r: RangeData): string {
  return rangeCount(r) > 1 ? rangeAbsolute(r) : serialisedSheetName(r) + rangeAbsoluteTopLeft(r);
}

export function rangeCount(r: RangeData): number {
  return (1 + rangeBottom(r) - rangeTop(r)) * (1 + rangeRight(r) - rangeLeft(r));
}

export function rangeToString(r: RangeData): string {
  return rangeRange(r);
}

export function rangeIntersects(r: RangeData, other: RangeData): boolean {
  if (other.sheetName && r.sheetName && other.sheetName !== r.sheetName) {
    return false;
  }
  if (rangeBottom(other) < rangeTop(r)) {
    return false;
  }
  if (rangeTop(other) > rangeBottom(r)) {
    return false;
  }
  if (rangeRight(other) < rangeLeft(r)) {
    return false;
  }
  if (rangeLeft(other) > rangeRight(r)) {
    return false;
  }
  return true;
}

export function rangeContains(r: RangeData, addressStr: string): boolean {
  const address = colCache.decodeEx(addressStr);
  if ("row" in address && "col" in address) {
    return rangeContainsEx(r, address);
  }
  return false;
}

export function rangeContainsEx(r: RangeData, address: DecodedAddress): boolean {
  if (address.sheetName && r.sheetName && address.sheetName !== r.sheetName) {
    return false;
  }
  return (
    address.row >= rangeTop(r) &&
    address.row <= rangeBottom(r) &&
    address.col >= rangeLeft(r) &&
    address.col <= rangeRight(r)
  );
}

export function rangeForEachAddress(
  r: RangeData,
  cb: (address: string, row: number, col: number) => void
): void {
  for (let col = rangeLeft(r); col <= rangeRight(r); col++) {
    for (let row = rangeTop(r); row <= rangeBottom(r); row++) {
      cb(colCache.encodeAddress(row, col), row, col);
    }
  }
}

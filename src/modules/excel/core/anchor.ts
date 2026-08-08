import { columnIsCustomWidth } from "@excel/core/column";
import type { WorksheetData as Worksheet } from "@excel/core/worksheet-core";
import { colCache } from "@excel/utils/col-cache";

interface AnchorModel {
  nativeCol: number;
  nativeRow: number;
  nativeColOff: number;
  nativeRowOff: number;
}

interface SimpleAddress {
  col: number;
  row: number;
}

type AddressInput = string | AnchorModel | SimpleAddress;

/**
 * Plain-data drawing anchor (de-classed domain model).
 *
 * Carries the raw OOXML anchor coordinates plus an optional worksheet used to
 * resolve column width / row height when converting between the fractional
 * `col`/`row` representation and the native offset representation.
 */
export interface AnchorData {
  nativeCol: number;
  nativeRow: number;
  nativeColOff: number;
  nativeRowOff: number;
  worksheet?: Worksheet;
}

function isAnchorModel(value: AddressInput): value is AnchorModel {
  return (
    typeof value === "object" &&
    "nativeCol" in value &&
    "nativeRow" in value &&
    "nativeColOff" in value &&
    "nativeRowOff" in value
  );
}

function isSimpleAddress(value: AddressInput): value is SimpleAddress {
  return typeof value === "object" && "col" in value && "row" in value;
}

/** Structural guard: is `value` an {@link AnchorData} record? */
export function isAnchorData(value: unknown): value is AnchorData {
  return (
    typeof value === "object" &&
    value !== null &&
    "nativeCol" in value &&
    "nativeRow" in value &&
    "nativeColOff" in value &&
    "nativeRowOff" in value
  );
}

/** Column width (EMU) at the anchor's native column, or the default 640000. */
export function anchorColWidth(a: AnchorData): number {
  // Read `_columns` directly — `getColumn` extends the array as a side effect,
  // and this is a getter reached from read-only paths (`Anchor.col`, PDF export).
  // A column that does not exist has no custom width, which is the default case.
  const column = a.worksheet?._columns[a.nativeCol];
  return column && columnIsCustomWidth(column) ? Math.floor(column.width! * 10000) : 640000;
}

/** Row height (EMU) at the anchor's native row, or the default 180000. */
export function anchorRowHeight(a: AnchorData): number {
  const height = a.worksheet?._rows[a.nativeRow]?.height;
  return height ? Math.floor(height * 10000) : 180000;
}

/** Fractional column position (native col + offset fraction). */
export function anchorCol(a: AnchorData): number {
  return a.nativeColOff === 0
    ? a.nativeCol
    : a.nativeCol + Math.min(anchorColWidth(a) - 1, a.nativeColOff) / anchorColWidth(a);
}

/** Set the fractional column position, deriving native col + offset. */
export function anchorSetCol(a: AnchorData, v: number): void {
  a.nativeCol = Math.floor(v);
  const fraction = v - a.nativeCol;
  a.nativeColOff = fraction === 0 ? 0 : Math.floor(fraction * anchorColWidth(a));
}

/** Fractional row position (native row + offset fraction). */
export function anchorRow(a: AnchorData): number {
  return a.nativeRowOff === 0
    ? a.nativeRow
    : a.nativeRow + Math.min(anchorRowHeight(a) - 1, a.nativeRowOff) / anchorRowHeight(a);
}

/** Set the fractional row position, deriving native row + offset. */
export function anchorSetRow(a: AnchorData, v: number): void {
  a.nativeRow = Math.floor(v);
  const fraction = v - a.nativeRow;
  a.nativeRowOff = fraction === 0 ? 0 : Math.floor(fraction * anchorRowHeight(a));
}

/**
 * Create an anchor record from a worksheet + address input.
 *
 * `address` may be a string ("A1"), an {@link AnchorModel}, or a
 * `{ col, row }` simple address; `offset` is added to string/simple addresses.
 */
export function anchorCreate(
  worksheet?: Worksheet,
  address?: AddressInput | null,
  offset: number = 0
): AnchorData {
  const a: AnchorData = {
    worksheet,
    nativeCol: 0,
    nativeColOff: 0,
    nativeRow: 0,
    nativeRowOff: 0
  };

  if (!address) {
    return a;
  }
  if (typeof address === "string") {
    const decoded = colCache.decodeAddress(address);
    a.nativeCol = decoded.col + offset;
    a.nativeRow = decoded.row + offset;
  } else if (isAnchorModel(address)) {
    a.nativeCol = address.nativeCol ?? 0;
    a.nativeColOff = address.nativeColOff ?? 0;
    a.nativeRow = address.nativeRow ?? 0;
    a.nativeRowOff = address.nativeRowOff ?? 0;
  } else if (isSimpleAddress(address)) {
    anchorSetCol(a, address.col + offset);
    anchorSetRow(a, address.row + offset);
  }
  return a;
}

/** Coerce an anchor model / existing anchor record into an {@link AnchorData}. */
export function anchorAsInstance(
  model: AddressInput | AnchorData | null | undefined
): AnchorData | null {
  if (model == null) {
    return null;
  }
  if (isAnchorData(model)) {
    return model;
  }
  return anchorCreate(undefined, model);
}

/** Serialize an anchor to its persisted {@link AnchorModel}. */
export function anchorModel(a: AnchorData): AnchorModel {
  return {
    nativeCol: a.nativeCol,
    nativeColOff: a.nativeColOff,
    nativeRow: a.nativeRow,
    nativeRowOff: a.nativeRowOff
  };
}

/** Apply a persisted {@link AnchorModel} onto an anchor record in place. */
export function anchorSetModel(a: AnchorData, value: AnchorModel): void {
  a.nativeCol = value.nativeCol;
  a.nativeColOff = value.nativeColOff;
  a.nativeRow = value.nativeRow;
  a.nativeRowOff = value.nativeRowOff;
}

/** Clone an anchor record, optionally rebinding it to a different worksheet. */
export function anchorClone(a: AnchorData, worksheet?: Worksheet): AnchorData {
  return anchorCreate(worksheet ?? a.worksheet, anchorModel(a));
}

export type { AnchorModel };

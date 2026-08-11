import { InvalidAddressError } from "@excel/errors";
import type { DataValidationRule } from "@excel/types";
import type { DecodedRange } from "@excel/utils/col-cache";
import { colCache } from "@excel/utils/col-cache";

/** The sheet-level data-validation map: A1 address (or `range:` key) → rule. */
export interface DataValidationModel {
  [address: string]: DataValidationRule | undefined;
}

/**
 * Plain-data data-validation registry (de-classed domain model).
 *
 * Keeps the `model` map field (so callers reading `ws.dataValidations.model`
 * are unaffected); add/find/remove become flat helpers.
 */
export interface DataValidationsData {
  model: DataValidationModel;
}

/** Create a data-validation registry, optionally seeded from a parsed model. */
export function createDataValidations(model?: DataValidationModel): DataValidationsData {
  return { model: model || {} };
}

/**
 * Register a validation for a cell or A1 range.
 *
 * Whole-column (`"A:A"`) and whole-row (`"1:3"`) references are expanded to
 * Excel's sheet limits. Ranges are stored as a single `range:` model entry so
 * they serialise to one data-validation element instead of one per cell.
 */
export function dataValidationAdd(
  dv: DataValidationsData,
  ref: string,
  validation: DataValidationRule
): DataValidationRule {
  return (dv.model[validationModelKey(ref)] = validation);
}

/** Excel's hard sheet limits, used to expand whole-column / whole-row refs. */
const EXCEL_MAX_ROW = 1048576;
const EXCEL_MAX_COL_LETTER = "XFD";

/** Whole-column reference, e.g. "A:A" or "A:C" (optionally `$`-anchored). */
const WHOLE_COLUMN_RE = /^\$?([A-Z]{1,3})\$?:\$?([A-Z]{1,3})$/;
/** Whole-row reference, e.g. "1:1" or "2:5" (optionally `$`-anchored). */
const WHOLE_ROW_RE = /^\$?(\d+)\$?:\$?(\d+)$/;
/** A single concrete cell reference, e.g. "A1", "XFD1048576" (no `$`). */
const CELL_RE = /^([A-Z]{1,3})(\d+)$/;

/**
 * Assert that `cell` is a valid, in-bounds A1 cell reference (`A1`..`XFD1048576`).
 * `colCache.decodeEx` is too lenient (it happily returns garbage for "foo",
 * "A0", etc.), so we validate strictly here to avoid persisting a malformed
 * `sqref` that would corrupt the workbook.
 */
function assertValidCell(cell: string, ref: string): void {
  const m = cell.match(CELL_RE);
  if (!m) {
    throw new InvalidAddressError(ref, "not a valid cell or range reference");
  }
  colCache.l2n(m[1]); // throws ColumnOutOfBoundsError if the column is > XFD
  const row = Number(m[2]);
  if (row < 1 || row > EXCEL_MAX_ROW) {
    throw new InvalidAddressError(ref, `row ${row} is outside 1..${EXCEL_MAX_ROW}`);
  }
}

function decodeStrictCell(cell: string, ref: string): { col: number; row: number } {
  assertValidCell(cell, ref);
  const m = cell.match(CELL_RE)!;
  return { col: colCache.l2n(m[1]), row: Number(m[2]) };
}

function normaliseEndpoints(start: string, end: string, ref: string): string {
  const a = decodeStrictCell(start, ref);
  const b = decodeStrictCell(end, ref);
  const top = Math.min(a.row, b.row);
  const left = Math.min(a.col, b.col);
  const bottom = Math.max(a.row, b.row);
  const right = Math.max(a.col, b.col);
  return `${colCache.encodeAddress(top, left)}:${colCache.encodeAddress(bottom, right)}`;
}

/**
 * Normalise a user-supplied A1 range reference into a concrete `top:bottom`
 * range string suitable for a `range:` model key (and for the xlsx `sqref`).
 *
 * Handles the whole-column (`"A:A"`, `"A:C"`) and whole-row (`"1:3"`) shorthand
 * by expanding them to Excel's sheet limits, mirroring how Excel itself stores
 * a validation applied to an entire column (`A1:A1048576`). Any leading
 * `Sheet!` qualifier is stripped, since data-validation `sqref` values are
 * sheet-local. Absolute `$` markers are dropped. Throws
 * {@link InvalidAddressError} for anything that is not a valid cell or range.
 */
function normaliseRangeRef(ref: string): string {
  if (typeof ref !== "string" || ref.length === 0) {
    throw new InvalidAddressError(String(ref), "range reference must be a non-empty string");
  }

  // Strip a leading sheet qualifier: `Sheet1!A1:A10` / `'My Sheet'!A:A`.
  const bang = ref.lastIndexOf("!");
  const local = bang === -1 ? ref : ref.slice(bang + 1);

  const wholeCol = local.match(WHOLE_COLUMN_RE);
  if (wholeCol) {
    return normaliseEndpoints(`${wholeCol[1]}1`, `${wholeCol[2]}${EXCEL_MAX_ROW}`, ref);
  }
  const wholeRow = local.match(WHOLE_ROW_RE);
  if (wholeRow) {
    return normaliseEndpoints(`A${wholeRow[1]}`, `${EXCEL_MAX_COL_LETTER}${wholeRow[2]}`, ref);
  }

  // Concrete cell or cell:cell range — drop absolute markers so keys match the
  // `sqref` form Excel writes, then validate every endpoint strictly.
  const bare = local.replace(/\$/g, "");
  const endpoints = bare.split(":");
  if (endpoints.length > 2) {
    throw new InvalidAddressError(ref, "not a valid cell or range reference");
  }
  if (endpoints.length === 2) {
    return normaliseEndpoints(endpoints[0], endpoints[1], ref);
  }
  assertValidCell(bare, ref);
  return bare;
}

function validationModelKey(ref: string): string {
  const normalised = normaliseRangeRef(ref);
  return normalised.includes(":") ? `range:${normalised}` : normalised;
}

/**
 * Resolve the validation that applies to `address`: first an exact-address
 * match, then any `range:`-prefixed key whose decoded range contains it.
 */
export function dataValidationFind(
  dv: DataValidationsData,
  address: string
): DataValidationRule | undefined {
  // First check direct address match
  const direct = dv.model[address];
  if (direct !== undefined) {
    return direct;
  }

  // Check range: prefixed keys in model (from parsing ranges)
  // Only decode address if we see at least one range key.
  let decoded: { row: number; col: number } | undefined;
  for (const key of Object.keys(dv.model)) {
    if (!key.startsWith("range:")) {
      continue;
    }

    decoded ||= colCache.decodeAddress(address);

    const rangeStr = key.slice(6); // Remove "range:" prefix
    const rangeDecoded = colCache.decodeEx(rangeStr);
    if (!("dimensions" in rangeDecoded)) {
      continue;
    }

    const { tl, br } = rangeDecoded as DecodedRange;
    const tlAddr = typeof tl === "string" ? colCache.decodeAddress(tl) : tl;
    const brAddr = typeof br === "string" ? colCache.decodeAddress(br) : br;
    if (
      decoded.row >= tlAddr.row &&
      decoded.row <= brAddr.row &&
      decoded.col >= tlAddr.col &&
      decoded.col <= brAddr.col
    ) {
      return dv.model[key];
    }
  }

  return undefined;
}

/** Clear the validation registered for a cell or A1 range. */
export function dataValidationRemove(dv: DataValidationsData, ref: string): void {
  dv.model[validationModelKey(ref)] = undefined;
}

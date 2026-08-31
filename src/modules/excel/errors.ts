/**
 * Excel module error types.
 *
 * All Excel-related errors extend ExcelError.
 */

import type { BaseErrorOptions } from "@utils/errors";
import { BaseError } from "@utils/errors";

/**
 * Base class for all Excel-related errors.
 */
export class ExcelError extends BaseError {
  constructor(message: string, options?: BaseErrorOptions) {
    super(message, options);
    this.name = "ExcelError";
  }
}

/**
 * Check if an error is an Excel error.
 */
export function isExcelError(err: unknown): err is ExcelError {
  return err instanceof ExcelError;
}

/**
 * Error thrown when worksheet name validation fails.
 */
export class WorksheetNameError extends ExcelError {
  override name = "WorksheetNameError";
}

/**
 * Error thrown when a cell address or range is invalid.
 */
export class InvalidAddressError extends ExcelError {
  override name = "InvalidAddressError";

  constructor(
    public readonly address: string,
    details?: string,
    options?: BaseErrorOptions
  ) {
    super(
      details ? `Invalid address "${address}": ${details}` : `Invalid address: ${address}`,
      options
    );
  }
}

/**
 * Error thrown when a column number or letter is out of bounds.
 */
export class ColumnOutOfBoundsError extends ExcelError {
  override name = "ColumnOutOfBoundsError";

  constructor(
    public readonly column: number | string,
    details?: string,
    options?: BaseErrorOptions
  ) {
    super(
      details
        ? `Column ${column} is out of bounds: ${details}`
        : `Column ${column} is out of bounds. Excel supports columns from 1 to 16384`,
      options
    );
  }
}

/**
 * Error thrown when a row number is out of bounds.
 */
export class RowOutOfBoundsError extends ExcelError {
  override name = "RowOutOfBoundsError";

  constructor(
    public readonly row: number,
    details?: string,
    options?: BaseErrorOptions
  ) {
    super(
      details ? `Row ${row} is out of bounds: ${details}` : `Row ${row} is out of bounds`,
      options
    );
  }
}

/**
 * Error thrown when trying to merge already merged cells.
 */
export class MergeConflictError extends ExcelError {
  override name = "MergeConflictError";

  constructor(details?: string, options?: BaseErrorOptions) {
    super(details ?? "Cannot merge already merged cells", options);
  }
}

/**
 * Error thrown when a value type cannot be processed.
 */
export class InvalidValueTypeError extends ExcelError {
  override name = "InvalidValueTypeError";

  constructor(
    public readonly valueType: string,
    details?: string,
    options?: BaseErrorOptions
  ) {
    super(details ?? `Cannot process value of type: ${valueType}`, options);
  }
}

/**
 * Error thrown when xlsx (OOXML) parsing encounters unexpected content.
 */
export class XlsxParseError extends ExcelError {
  override name = "XlsxParseError";

  constructor(
    public readonly context: string,
    details?: string,
    options?: BaseErrorOptions
  ) {
    super(details ?? `Unexpected XML content in ${context}`, options);
  }
}

/**
 * Error thrown when XLSB (BIFF12) parsing encounters malformed binary data.
 */
export class XlsbParseError extends ExcelError {
  override name = "XlsbParseError";

  constructor(
    public readonly context: string,
    details?: string,
    options?: BaseErrorOptions
  ) {
    super(details ?? `Unexpected BIFF12 content in ${context}`, options);
  }
}

/**
 * Error thrown when an operation is not supported.
 */
export class ExcelNotSupportedError extends ExcelError {
  override name = "ExcelNotSupportedError";

  constructor(
    public readonly operation: string,
    public readonly reason?: string,
    options?: BaseErrorOptions
  ) {
    super(reason ? `${operation}: ${reason}` : `${operation} is not supported`, options);
  }
}

/**
 * Error thrown when a file operation fails.
 */
export class ExcelFileError extends ExcelError {
  override name = "ExcelFileError";

  constructor(
    public readonly path: string,
    public readonly operation: "read" | "write",
    details?: string,
    options?: BaseErrorOptions
  ) {
    super(
      details
        ? `Failed to ${operation} Excel file "${path}": ${details}`
        : `Failed to ${operation} Excel file "${path}"`,
      options
    );
  }
}

/**
 * Error thrown when a streaming operation fails due to invalid state.
 */
export class ExcelStreamStateError extends ExcelError {
  override name = "ExcelStreamStateError";

  constructor(
    public readonly operation: string,
    public readonly state: string,
    options?: BaseErrorOptions
  ) {
    super(`Cannot ${operation}: ${state}`, options);
  }
}

/**
 * Error thrown when an HTTP download fails.
 */
export class ExcelDownloadError extends ExcelError {
  override name = "ExcelDownloadError";

  constructor(
    public readonly url: string,
    public readonly status: number,
    public readonly statusText: string,
    options?: BaseErrorOptions
  ) {
    super(`Failed to download from "${url}": HTTP ${status} ${statusText}`, options);
  }
}

/**
 * Error thrown when pivot table configuration is invalid.
 */
export class PivotTableError extends ExcelError {
  override name = "PivotTableError";
}

/**
 * Error thrown when chart configuration is invalid.
 */
export class ChartOptionsError extends ExcelError {
  override name = "ChartOptionsError";
}

/**
 * Error thrown when table configuration or operation is invalid.
 */
export class TableError extends ExcelError {
  override name = "TableError";
}

/**
 * Error thrown when image processing fails.
 */
export class ImageError extends ExcelError {
  override name = "ImageError";
}

/**
 * Error thrown when max items limit is exceeded.
 */
export class MaxItemsExceededError extends ExcelError {
  override name = "MaxItemsExceededError";

  constructor(
    public readonly itemType: string,
    public readonly maxItems: number,
    options?: BaseErrorOptions
  ) {
    super(`Max ${itemType} count (${maxItems}) exceeded`, options);
  }
}

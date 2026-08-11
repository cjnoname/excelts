/**
 * CSV Types
 *
 * Centralized type definitions for the CSV module.
 * This file contains all interfaces, types, and type utilities.
 */

import type { FormattedValue as FormattedValueImpl } from "@csv/format/formatted-value";

// =============================================================================
// Row Types
// =============================================================================

/** Header array type (can include undefined/null to skip columns) */
export type HeaderArray = (string | undefined | null)[];

/** Row as array of [header, value] tuples */
export type RowHashArray<V = unknown> = [string, V][];

/** Row as string array (internal parsing output) */
export type RowArray = Array<string | number | boolean | null | undefined>;

/** Row as object (when headers are used) */
export type RowMap = Record<string, string>;

/**
 * Any row type (union of all output formats).
 *
 * Note: This is the OUTPUT type. Internally, parsers always work with string[].
 * The conversion to RowMap or RowHashArray happens at the final output stage.
 */
export type Row = RowArray | RowMap | RowHashArray;

// =============================================================================
// Transform Types
// =============================================================================

/** Header transform function */
export type HeaderTransformFunction = (headers: string[]) => HeaderArray;

/** Row transform callback (for async transforms) */
export type RowTransformCallback<T> = (error?: Error | null, row?: T | null) => void;

/**
 * Row transform function - sync or async.
 *
 * When headers: false/undefined, receives string[]
 * When headers: true/array, receives Record<string, string>
 */
export type RowTransformFunction<I = Row, O = Row> =
  | ((row: I) => O | null)
  | ((row: I, callback: RowTransformCallback<O>) => void);

/** Row validate callback (for async validation) */
export type RowValidateCallback = (
  error?: Error | null,
  isValid?: boolean,
  reason?: string
) => void;

/**
 * Row validate function - sync or async.
 *
 * When headers: false/undefined, receives string[]
 * When headers: true/array, receives Record<string, string>
 */
export type RowValidateFunction<T = Row> =
  | ((row: T) => boolean | { isValid: boolean; reason?: string })
  | ((row: T, callback: RowValidateCallback) => void);

/**
 * Context passed to type-based transform functions.
 */
export interface TransformContext {
  /** Column name (for object rows) or column index (for array rows) */
  column: string | number;
  /** Output record index (0-based, after row filtering) */
  index: number;
}

/**
 * Formatted value with explicit quoting control.
 *
 * Create instances via `quoted()` / `unquoted()`.
 * Use `isFormattedValue()` for runtime checks.
 */
export type FormattedValue = FormattedValueImpl;

/**
 * Result type for transform functions.
 */
export type TransformResult = string | FormattedValue | null | undefined;

/**
 * Type-based transform functions for formatting specific data types.
 */
export interface TypeTransformMap {
  boolean?: (value: boolean, ctx: TransformContext) => TransformResult;
  date?: (value: Date, ctx: TransformContext) => TransformResult;
  number?: (value: number, ctx: TransformContext) => TransformResult;
  bigint?: (value: bigint, ctx: TransformContext) => TransformResult;
  object?: (value: Record<string, unknown>, ctx: TransformContext) => TransformResult;
  string?: (value: string, ctx: TransformContext) => TransformResult;
  /** Row-level transform (runs first, return null to skip) */
  row?: (row: Row, sourceIndex: number) => Row | null;
}

// =============================================================================
// Dynamic Typing Types
// =============================================================================

/**
 * Dynamic typing configuration for automatic type conversion.
 */
export type DynamicTypingConfig = boolean | Record<string, boolean | ((value: string) => unknown)>;

/**
 * Cast date configuration for automatic date parsing.
 */
export type CastDateConfig = boolean | string[];

// =============================================================================
// Column Configuration
// =============================================================================

/**
 * Column configuration for formatting.
 */
export interface ColumnConfig {
  /** Key to access data in the source object */
  key: string;
  /** Header name for output (defaults to key) */
  header?: string;
}

// =============================================================================
// Column Mismatch Handling
// =============================================================================

/**
 * Strategy for handling rows with fewer columns than expected.
 * - 'error': Treat as invalid (emit error, skip if skipRecordsWithError)
 * - 'pad': Pad with empty strings to match expected column count
 */
export type ColumnMismatchLess = "error" | "pad";

/**
 * Strategy for handling rows with more columns than expected.
 * - 'error': Treat as invalid (emit error, skip if skipRecordsWithError)
 * - 'truncate': Discard extra columns silently
 * - 'keep': Keep extra columns (appended as _extra array in record)
 */
export type ColumnMismatchMore = "error" | "truncate" | "keep";

/**
 * Configuration for handling column count mismatches.
 *
 * @example
 * // Strict: error on any mismatch (default)
 * columnMismatch: { less: 'error', more: 'error' }
 *
 * // Lenient: pad missing, truncate extra
 * columnMismatch: { less: 'pad', more: 'truncate' }
 *
 * // Keep extra columns for debugging
 * columnMismatch: { less: 'pad', more: 'keep' }
 */
export interface ColumnMismatchConfig {
  /** How to handle rows with fewer columns than expected */
  less: ColumnMismatchLess;
  /** How to handle rows with more columns than expected */
  more: ColumnMismatchMore;
}

// =============================================================================
// Error Types
// =============================================================================

/** CSV error codes for parse errors and skipped records */
export type CsvErrorCode = "TooManyFields" | "TooFewFields" | "MissingQuotes" | "ParseError";

/**
 * CSV record error - used for both parse errors and skipped records.
 */
export interface CsvRecordError {
  code: CsvErrorCode;
  message: string;
  /** 1-based line number where the error occurred */
  line: number;
  /** Raw unparsed line content (when available) */
  raw?: string;
}

/** OnSkip callback type - called when a record is skipped due to error */
export type OnSkipCallback = (error: CsvRecordError, record: string[] | null) => void;

// =============================================================================
// Parse Options
// =============================================================================

/** Shared base options */
export interface CsvBaseOptions {
  /** Field delimiter (default: ",") */
  delimiter?: string;
  /** Quote character (default: '"'), set to false/null to disable */
  quote?: string | false | null;
  /** Escape character (default: same as quote) */
  escape?: string | false | null;
  /** Enable object mode for streams (default: true) */
  objectMode?: boolean;
}

/**
 * CSV parsing options
 */
export interface CsvParseOptions extends CsvBaseOptions {
  /** Delimiters to try during auto-detection (when delimiter is "") */
  delimitersToGuess?: string[];
  /** Line ending character(s) (default: auto-detect) */
  lineEnding?: string;
  /** Skip empty lines: true, false, or "greedy" (also skips whitespace-only) */
  skipEmptyLines?: boolean | "greedy";
  /** Trim whitespace from both sides */
  trim?: boolean;
  /** Left trim only */
  ltrim?: boolean;
  /** Right trim only */
  rtrim?: boolean;
  /** Header handling: true, array, or transform function */
  headers?: boolean | HeaderArray | HeaderTransformFunction;
  /** Comment character - lines starting with this are ignored */
  comment?: string;
  /**
   * Maximum number of data rows to parse (excludes header row).
   * Counts only actual data rows that pass validation.
   * Example: maxRows: 10 returns at most 10 data rows.
   */
  maxRows?: number;
  /**
   * Stop parsing at this line number (1-based, inclusive).
   * Counts all lines in the file including skipped lines, comments, and headers.
   * Example: toLine: 100 stops after processing line 100 of the source file.
   * Use maxRows for row-count limits; use toLine for file position limits.
   */
  toLine?: number;
  /** Number of lines to skip at the beginning */
  skipLines?: number;
  /** Number of data rows to skip (after header) */
  skipRows?: number;
  /** Maximum bytes per row (safety limit) */
  maxRowBytes?: number;
  /**
   * How to handle column count mismatches.
   * Default: { less: 'error', more: 'error' } (strict)
   *
   * @example
   * // Lenient: pad missing columns, truncate extra
   * columnMismatch: { less: 'pad', more: 'truncate' }
   */
  columnMismatch?: ColumnMismatchConfig;
  /** Group columns with same name into arrays */
  groupColumnsByName?: boolean;
  /** Return records as object keyed by column value */
  objname?: string;
  /**
   * Character encoding of the input bytes — any label `TextDecoder` accepts
   * (`"utf-8"`, `"windows-1252"`, `"shift_jis"`, …). Defaults to `"utf-8"`.
   *
   * Deliberately not Node's `BufferEncoding`: decoding goes through
   * `TextDecoder`, which speaks WHATWG labels (and rejects `"base64"`/`"hex"`),
   * and this type is part of the browser surface.
   */
  encoding?: string;
  /** Synchronous row transform function */
  rowTransform?: (row: Row) => Row | null | undefined;
  /** Synchronous validate function */
  validate?: (row: Row) => boolean | { isValid: boolean; reason?: string };
  /** Fast parsing mode (no quote detection) */
  fastMode?: boolean;
  /** Dynamic typing configuration */
  dynamicTyping?: DynamicTypingConfig;
  /** Auto-detect and convert date strings */
  castDate?: CastDateConfig;
  /** Chunk callback for batch processing */
  chunk?: (rows: Row[], meta: ChunkMeta) => boolean | void | Promise<boolean | void>;
  /** Rows per chunk */
  chunkSize?: number;
  /** Callback before parsing first chunk */
  beforeFirstChunk?: (chunk: string) => string | void;
  /** Include additional info about each record */
  info?: boolean;
  /** Include raw string in info (requires info: true) */
  raw?: boolean;
  /** Allow unescaped quotes mid-field */
  relaxQuotes?: boolean;
  /** Skip malformed records instead of throwing */
  skipRecordsWithError?: boolean;
  /** Skip records where all values are empty */
  skipRecordsWithEmptyValues?: boolean;
  /** Callback when record is skipped due to error */
  onSkip?: OnSkipCallback;
}

/**
 * CSV formatting options
 */
export interface CsvFormatOptions extends CsvBaseOptions {
  /**
   * Emit bytes instead of strings on the readable side (default: follows
   * {@link CsvBaseOptions.objectMode}, i.e. strings).
   *
   * A formatter is asymmetric: the writable side takes rows (objects/arrays) and
   * the readable side produces CSV. `objectMode` sets *both* sides, so leaving
   * the readable side in object mode makes the stream emit `string` chunks —
   * which cannot be piped into anything expecting bytes (an upload body,
   * `Readable.toWeb()`, `Buffer.concat`) even though it otherwise looks like a
   * normal byte stream.
   *
   * Set this to `false` to keep rows on the writable side but produce a real
   * byte stream: the pushed CSV text is encoded as UTF-8 by the stream itself,
   * on both Node and the browser.
   */
  readableObjectMode?: boolean;
  /** Line ending character(s) (default: "\n") */
  lineEnding?: string;
  /** Decimal separator for numbers (default: ".") */
  decimalSeparator?: "." | ",";
  /**
   * Quote specific columns by name, index, or all.
   * - `true`: Quote all columns
   * - `false`: Quote only when necessary (default)
   * - `boolean[]`: Quote by column index
   * - `Record<string, boolean>`: Quote by column name
   */
  quoteColumns?: boolean | boolean[] | Record<string, boolean>;
  /**
   * Quote header fields.
   * - `true`: Quote all headers
   * - `false`: Quote only when necessary (default)
   * - `boolean[]`: Quote by header index
   * - `Record<string, boolean>`: Quote by header name
   */
  quoteHeaders?: boolean | boolean[] | Record<string, boolean>;
  /** Header handling: true (auto-detect), array, or false */
  headers?: string[] | boolean | null;
  /** Column configuration with key/header separation */
  columns?: (string | ColumnConfig)[];
  /**
   * Whether to write headers.
   * - `true`: Always write headers (even if no data rows)
   * - `false`: Never write headers
   * - Default: `true` when headers are provided/detected
   */
  writeHeaders?: boolean;
  /** Include BOM for UTF-8 */
  bom?: boolean;
  /** Include trailing newline after last row */
  trailingNewline?: boolean;
  /** Escape formula characters (CSV injection protection) */
  escapeFormulae?: boolean;
  /** Type-based transform configuration */
  typeTransform?: TypeTransformMap;
}

// =============================================================================
// Parse Result Types
// =============================================================================

/**
 * Metadata for chunk callback
 */
export interface ChunkMeta {
  /** Total data rows processed so far */
  cursor: number;
  /** Rows in current chunk */
  rowCount: number;
  /** Whether this is the first chunk */
  isFirstChunk: boolean;
  /** Whether this is the last chunk */
  isLastChunk: boolean;
}

/**
 * Parsing metadata
 */
export interface CsvParseMeta {
  delimiter: string;
  linebreak: string;
  aborted: boolean;
  truncated: boolean;
  cursor: number;
  fields?: string[];
  renamedHeaders?: Record<string, string> | null;
}

/**
 * Parse result with metadata
 */
export interface CsvParseResult<T = string[]> {
  headers?: string[];
  rows: T[];
  invalidRows?: { row: string[]; reason: string }[];
  errors?: CsvRecordError[];
  meta: CsvParseMeta;
}

/**
 * Parse result when objname option is used.
 * Note: rows is an object keyed by the objname column value, not an array.
 */
export interface CsvParseResultWithObjname<T = Record<string, unknown>> {
  headers?: string[];
  /** Object mapping objname column values to records */
  rows: Record<string, T | RecordWithInfo<T>>;
  invalidRows?: { row: string[]; reason: string }[];
  errors?: CsvRecordError[];
  meta: CsvParseMeta;
}

/**
 * Additional information about a parsed record
 */
export interface RecordInfo {
  /** Zero-based index of this data row (excluding headers and skipped rows) */
  index: number;
  /** 1-based line number where this record starts in the input */
  line: number;
  /**
   * Character offset (not byte offset) where this record starts in the input.
   * For ASCII-only content this equals the byte offset, but for multi-byte
   * UTF-8 characters the actual byte position will differ.
   */
  offset: number;
  /** Whether each field in the record was quoted */
  quoted: boolean[];
  /** Raw unparsed line content (only present when `raw: true` option is set) */
  raw?: string;
  /** Length of invalid field (internal use) */
  invalid_field_length?: number;
}

/**
 * Record with info metadata
 */
export interface RecordWithInfo<T = Record<string, unknown>> {
  record: T;
  info: RecordInfo;
}

// =============================================================================
// Parse Options with Better Type Inference
// =============================================================================

/**
 * Options for array output mode (no headers).
 * When `headers` is false/undefined, transform/validate receive string[].
 *
 * Note: This is a documentation/usage type. Use CsvParseOptions for general cases.
 */
export interface CsvParseArrayOptions extends CsvParseOptions {
  headers?: false | undefined;
}

/**
 * Options for object output mode (with headers).
 * When `headers` is true/array/function, transform/validate receive Record<string, string>.
 *
 * Note: This is a documentation/usage type. Use CsvParseOptions for general cases.
 */
export interface CsvParseObjectOptions extends CsvParseOptions {
  headers: true | HeaderArray | HeaderTransformFunction;
}

// =============================================================================
// Type Guards and Helpers
// =============================================================================

// Re-export from formatted-value for compatibility
export { isFormattedValue, quoted, unquoted } from "@csv/format/formatted-value";

/**
 * Check if transform function is synchronous.
 *
 * This uses Function.length (the number of declared parameters) to distinguish
 * sync from async transforms:
 * - Sync transforms: `(row) => transformedRow` (1 parameter)
 * - Async transforms: `(row, callback) => void` (2 parameters)
 *
 * **Important**: This heuristic relies on the function having the expected
 * number of parameters. Functions with optional parameters or rest parameters
 * may not work correctly with this check.
 *
 * @example
 * ```ts
 * // Sync transform - detected correctly
 * const syncFn = (row: Row) => ({ ...row, processed: true });
 * isSyncTransform(syncFn); // true
 *
 * // Async transform - detected correctly
 * const asyncFn = (row: Row, cb: RowTransformCallback) => {
 *   setTimeout(() => cb(null, row), 100);
 * };
 * isSyncTransform(asyncFn); // false
 * ```
 */
export function isSyncTransform<I, O>(
  transform: RowTransformFunction<I, O>
): transform is (row: I) => O | null {
  return transform.length < 2;
}

/**
 * Check if validate function is synchronous.
 *
 * This uses Function.length (the number of declared parameters) to distinguish
 * sync from async validators:
 * - Sync validators: `(row) => boolean | { isValid, reason }` (1 parameter)
 * - Async validators: `(row, callback) => void` (2 parameters)
 *
 * **Important**: This heuristic relies on the function having the expected
 * number of parameters. Functions with optional parameters or rest parameters
 * may not work correctly with this check.
 *
 * @example
 * ```ts
 * // Sync validator - detected correctly
 * const syncFn = (row: Row) => row.name !== "";
 * isSyncValidate(syncFn); // true
 *
 * // Async validator - detected correctly
 * const asyncFn = (row: Row, cb: RowValidateCallback) => {
 *   setTimeout(() => cb(null, true), 100);
 * };
 * isSyncValidate(asyncFn); // false
 * ```
 */
export function isSyncValidate<T>(
  validate: RowValidateFunction<T>
): validate is (row: T) => boolean | { isValid: boolean; reason?: string } {
  return validate.length < 2;
}

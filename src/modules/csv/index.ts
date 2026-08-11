/**
 * CSV Module - Public API
 *
 * Pure CSV parsing/formatting functionality with no Excel dependencies.
 * For CSV-Worksheet integration, use Workbook.readCsv/writeCsv methods instead.
 *
 * Design principles:
 * - Only export types and functions that are part of the PUBLIC API
 * - Internal utilities (like format helpers) are used internally but not exported
 * - This reduces bundle size and simplifies the public interface
 */

// =============================================================================
// Core Types (from types.ts)
// =============================================================================

export type {
  // Row types
  HeaderArray,
  RowHashArray,
  RowArray,
  RowMap,
  Row,

  // Transform types
  HeaderTransformFunction,
  RowTransformCallback,
  RowTransformFunction,
  RowValidateCallback,
  RowValidateFunction,
  TransformContext,
  FormattedValue,
  TransformResult,
  TypeTransformMap,

  // Dynamic typing
  DynamicTypingConfig,
  CastDateConfig,

  // Column config
  ColumnConfig,

  // Error types (unified)
  CsvErrorCode,
  CsvRecordError,
  OnSkipCallback,

  // Options (general)
  CsvParseOptions,
  CsvFormatOptions,

  // Options (type-safe variants for better inference)
  CsvParseArrayOptions,
  CsvParseObjectOptions,

  // Parse results
  ChunkMeta,
  CsvParseMeta,
  RecordInfo,
  RecordWithInfo,
  CsvParseResult,
  CsvParseResultWithObjname,

  // Column mismatch config
  ColumnMismatchConfig,
  ColumnMismatchLess,
  ColumnMismatchMore
} from "@csv/types";

// =============================================================================
// Core API — the `Csv` domain namespace (tree-shaken via `export * as`)
// =============================================================================

export * as Csv from "@csv/surface/csv";

// Type-only re-exports for the generator + number utilities (the value
// functions live on the `Csv` namespace; these are the option/result types).
export type {
  CsvGenerateOptions,
  CsvGenerateResult,
  ColumnDef,
  GeneratorColumnConfig,
  BuiltinColumnType,
  GeneratorFn,
  GeneratorContext,
  StopCondition,
  StopContext
} from "@csv/utils/generate";
export type { DecimalSeparator } from "@csv/utils/number";

// Streaming/async parser input + row shapes.
export type { CsvAsyncInput, ParsedRow } from "@csv/parse/async";

// =============================================================================
// Errors
// =============================================================================

export { CsvError, CsvWorkerError, isCsvError } from "@csv/errors";

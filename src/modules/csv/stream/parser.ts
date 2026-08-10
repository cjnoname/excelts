/**
 * CSV Parser Stream
 *
 * True streaming CSV parser using cross-platform stream module.
 * Works identically in both Node.js and Browser environments.
 */

import { DEFAULT_LINEBREAK_REGEX, getUtf8ByteLength } from "@csv/constants";
// Import shared core functionality from parse/
import type { ParseConfig } from "@csv/parse/config";
import { createParseConfig, toScannerConfig } from "@csv/parse/config";
import { convertRowToObject, filterValidHeaders } from "@csv/parse/helpers";
import { splitLinesWithEndings } from "@csv/parse/lines";
import {
  processCompletedRow as processCompletedRowCore,
  shouldSkipRow as shouldSkipRowCore
} from "@csv/parse/row-processor";
// Import Scanner for efficient batch scanning
import type { Scanner } from "@csv/parse/scanner";
import { createScanner } from "@csv/parse/scanner";
import type { ParseState } from "@csv/parse/state";
import { createParseState, getUnquotedArray } from "@csv/parse/state";
import type {
  CsvParseOptions,
  RowTransformFunction,
  RowValidateFunction,
  Row,
  RowTransformCallback,
  RowValidateCallback,
  ChunkMeta,
  RecordInfo,
  RecordWithInfo,
  CsvRecordError
} from "@csv/types";
import { isSyncTransform, isSyncValidate } from "@csv/types";
import { detectDelimiter, stripBom } from "@csv/utils/detect";
import { applyDynamicTypingToRow, applyDynamicTypingToArrayRow } from "@csv/utils/dynamic-typing";
import { Transform } from "@stream";

/**
 * Transform stream that parses CSV data row by row
 *
 * @example
 * ```ts
 * const parser = new CsvParserStream({ headers: true });
 * readable.pipe(parser).on('data', (row) => console.log(row));
 * ```
 */
export class CsvParserStream extends Transform {
  // -------------------------------------------------------------------------
  // Configuration & State (shared with parse-core)
  // -------------------------------------------------------------------------
  private options: CsvParseOptions;
  private parseConfig: ParseConfig;
  private parseState: ParseState;

  /**
   * Shared sink array for processCompletedRowCore's errors parameter.
   * The streaming parser emits errors via 'data-invalid' events instead,
   * so this array is cleared after each call to prevent unbounded growth.
   */
  private readonly parseErrorsSink: CsvRecordError[] = [];

  // -------------------------------------------------------------------------
  // Streaming-specific state (not in parse-core)
  // -------------------------------------------------------------------------
  private buffer: string = "";
  private decoder: TextDecoder;
  private scanner: Scanner; // Scanner instance for efficient batch scanning
  private _rowTransform: ((row: Row, cb: RowTransformCallback<Row>) => void) | null = null;
  private _rowValidator: ((row: Row, cb: RowValidateCallback) => void) | null = null;

  // Delimiter detection
  private autoDetectDelimiter: boolean = false;
  private delimiterDetected: boolean = false;

  // Chunk callback support
  private chunkBuffer: Row[] = [];
  private chunkSize: number;
  private totalRowsProcessed: number = 0;
  private isFirstChunk: boolean = true;
  private chunkAborted: boolean = false;

  // Pre-processing flags
  private beforeFirstChunkApplied: boolean = false;
  private bomStripped: boolean = false;

  // Stream control
  private toLineReached: boolean = false;
  private headersEmitted: boolean = false;
  private totalCharsProcessed: number = 0;

  // Backpressure handling
  private backpressure: boolean = false;
  private pendingCallback: ((error?: Error | null) => void) | null = null;

  // Improve public typing without relying on generic Transform types.
  declare push: (chunk: Row | string | null) => boolean;
  declare write: {
    (chunk: Uint8Array, callback?: (error?: Error | null) => void): boolean;
    (chunk: Uint8Array, encoding?: string, callback?: (error?: Error | null) => void): boolean;
    (chunk: string, callback?: (error?: Error | null) => void): boolean;
    (chunk: string, encoding?: string, callback?: (error?: Error | null) => void): boolean;
  };

  constructor(options: CsvParseOptions = {}) {
    // In objectMode (default), emit Row objects; when objectMode === false, emit JSON strings.
    super({ objectMode: options.objectMode !== false });
    this.options = options;
    this.chunkSize = options.chunkSize ?? 1000;

    // Reuse a single decoder instance and enable streaming decode to correctly handle
    // multi-byte characters split across chunks.
    // Use options.encoding if provided (default: utf-8)
    this.decoder = new TextDecoder(options.encoding || "utf-8");

    // Check if auto-detection is requested (delimiter === "")
    const delimiterOption = options.delimiter ?? ",";
    this.autoDetectDelimiter = delimiterOption === "";

    // Create unified config and state using parse-core factory
    const { config } = createParseConfig({ options });
    this.parseConfig = config;
    this.parseState = createParseState(config);

    // Create Scanner instance for efficient batch scanning
    this.scanner = createScanner(toScannerConfig(config));

    // Apply transform/validate from options if provided
    if (options.rowTransform) {
      this.transform(options.rowTransform);
    }
    if (options.validate) {
      this.validate(options.validate);
    }
  }

  /**
   * Called when downstream is ready for more data (backpressure released).
   * Resume processing if we were paused due to backpressure.
   */
  _read(_size: number): void {
    if (this.backpressure && this.pendingCallback) {
      this.backpressure = false;
      const callback = this.pendingCallback;
      this.pendingCallback = null;
      // Resume processing
      callback();
    }
  }

  /**
   * Set a transform function to modify rows before emitting
   * Supports both sync and async transforms
   */
  transform<I extends Row = Row, O extends Row = Row>(
    transformFunction: RowTransformFunction<I, O>
  ): this {
    if (typeof transformFunction !== "function") {
      throw new TypeError("The transform should be a function");
    }

    if (isSyncTransform(transformFunction)) {
      this._rowTransform = (row: Row, cb: RowTransformCallback<Row>): void => {
        try {
          const result = transformFunction(row as I);
          cb(null, result as Row);
        } catch (e) {
          cb(e as Error);
        }
      };
    } else {
      this._rowTransform = transformFunction as (row: Row, cb: RowTransformCallback<Row>) => void;
    }
    return this;
  }

  /**
   * Set a validate function to filter rows
   * Invalid rows emit 'data-invalid' event
   */
  validate<T extends Row = Row>(validateFunction: RowValidateFunction<T>): this {
    if (typeof validateFunction !== "function") {
      throw new TypeError("The validate should be a function");
    }

    if (isSyncValidate(validateFunction)) {
      this._rowValidator = (row: Row, cb: RowValidateCallback): void => {
        try {
          const result = validateFunction(row as T);
          if (typeof result === "boolean") {
            cb(null, result);
          } else {
            cb(null, result.isValid, result.reason);
          }
        } catch (e) {
          cb(e as Error);
        }
      };
    } else {
      this._rowValidator = validateFunction as (row: Row, cb: RowValidateCallback) => void;
    }
    return this;
  }

  _transform(
    chunk: Uint8Array | string,
    _encoding: string,
    callback: (error?: Error | null, data?: Row) => void
  ): void {
    // If chunk callback aborted parsing or toLine reached, skip all further processing
    if (this.chunkAborted || this.toLineReached) {
      callback();
      return;
    }

    try {
      const data = typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
      this.buffer += data;

      // Apply beforeFirstChunk on first chunk
      if (!this.beforeFirstChunkApplied && this.options.beforeFirstChunk) {
        this.beforeFirstChunkApplied = true;
        const result = this.options.beforeFirstChunk(this.buffer);
        if (typeof result === "string") {
          this.buffer = result;
        }
      }

      // Strip BOM once, after beforeFirstChunk
      if (!this.bomStripped) {
        this.buffer = stripBom(this.buffer);
        this.bomStripped = true;
      }

      // Auto-detect delimiter on first chunk if requested
      // Defer detection if buffer only contains comments/empty lines
      if (this.autoDetectDelimiter && !this.delimiterDetected) {
        // Quick check: find first non-comment, non-empty line without full split
        const comment = this.options.comment;
        let hasDataLine = false;
        let start = 0;
        const bufLen = this.buffer.length;

        while (start < bufLen) {
          // Find end of line
          let end = start;
          while (end < bufLen && this.buffer[end] !== "\n" && this.buffer[end] !== "\r") {
            end++;
          }

          const line = this.buffer.slice(start, end).trim();
          if (line !== "" && (!comment || !line.startsWith(comment))) {
            hasDataLine = true;
            break;
          }

          // Skip past newline(s)
          start = end;
          if (start < bufLen && this.buffer[start] === "\r") {
            start++;
          }
          if (start < bufLen && this.buffer[start] === "\n") {
            start++;
          }
          if (start === end) {
            break;
          } // No progress, avoid infinite loop
        }

        if (hasDataLine) {
          const shouldSkipEmpty = this.options.skipEmptyLines;
          this.parseConfig.delimiter = detectDelimiter(
            this.buffer,
            this.parseConfig.quote || '"',
            this.options.delimitersToGuess,
            this.options.comment,
            shouldSkipEmpty
          );
          this.delimiterDetected = true;
          // Emit delimiter event so consumers can know which delimiter was detected
          this.emit("delimiter", this.parseConfig.delimiter);
          // Re-create Scanner with the detected delimiter
          this.scanner = createScanner(toScannerConfig(this.parseConfig));
        }
      }

      this.processBuffer(callback);
    } catch (error) {
      callback(error as Error);
    }
  }

  _flush(callback: (error?: Error | null) => void): void {
    // If chunk callback aborted parsing or toLine reached, skip flush
    if (this.chunkAborted || this.toLineReached) {
      callback();
      return;
    }

    try {
      const remainingDecoded = this.decoder.decode();
      if (remainingDecoded) {
        this.buffer += remainingDecoded;
      }

      if (this.buffer) {
        this.processBuffer(err => {
          if (err) {
            callback(err);
            return;
          }
          this.flushCurrentRow(err2 => {
            if (err2) {
              callback(err2);
              return;
            }
            this.flushFinalChunk(callback);
          });
        });
        return;
      }

      this.flushCurrentRow(err => {
        if (err) {
          callback(err);
          return;
        }
        this.flushFinalChunk(callback);
      });
    } catch (error) {
      callback(error as Error);
    }
  }

  /**
   * Clean up resources when stream is destroyed.
   * Handles pending backpressure callbacks and clears buffers.
   */
  _destroy(error: Error | null, callback: (error: Error | null) => void): void {
    // Clear pending backpressure callback to prevent memory leaks
    // The callback is not invoked - the stream is being destroyed
    this.pendingCallback = null;
    this.backpressure = false;

    // Clear buffers
    this.buffer = "";
    this.chunkBuffer = [];

    // Reset scanner if present
    this.scanner.reset();

    callback(error);
  }

  private flushCurrentRow(callback: (error?: Error | null) => void): void {
    // If toLine was reached, don't process remaining data
    if (this.toLineReached) {
      callback();
      return;
    }

    // In fastMode, parsing is line-based and does not use currentField/currentRow.
    // Flush any remaining buffer as a final line when there's no trailing newline.
    if (this.parseConfig.fastMode) {
      this.flushFastModeRemainder(callback);
      return;
    }

    // Use Scanner's flush to process any remaining data at EOF
    const scanResult = this.scanner.flush();
    if (!scanResult || scanResult.fields.length === 0) {
      callback();
      return;
    }

    // Apply trim to fields.
    // Note: scanResult.fields is reused by the streaming scanner; we must copy even when trim is identity.
    const row = this.parseConfig.trimFieldIsIdentity
      ? scanResult.fields.slice()
      : scanResult.fields.map(this.parseConfig.trimField);

    const pendingRows: Row[] = [];
    const action = this._handleParsedRow({
      fields: row,
      charLength: 0, // flush — no further offset tracking needed
      raw: scanResult.raw,
      quoted: scanResult.quoted,
      pendingRows,
      shouldSkipEmpty: this.options.skipEmptyLines || false,
      skipLines: this.options.skipLines ?? 0,
      callback
    });

    if (action === "stop" || action === "error") {
      return;
    }
    this.processPendingRows(pendingRows, callback);
  }

  private flushFastModeRemainder(callback: (error?: Error | null) => void): void {
    let line = this.buffer;
    this.buffer = "";

    // Handle trailing CR that might be from a split CRLF
    // In _flush, there's no more data coming, so trailing \r is a line ending, not content
    if (line.endsWith("\r")) {
      line = line.slice(0, -1);
    }

    if (line === "") {
      callback();
      return;
    }

    const pendingRows: Row[] = [];
    const row = line.split(this.parseConfig.delimiter);
    const trimmedRow = this.parseConfig.trimFieldIsIdentity
      ? row
      : row.map(this.parseConfig.trimField);

    // In fast mode, no fields are quoted
    const quoted = this.parseConfig.infoOption ? getUnquotedArray(trimmedRow.length) : undefined;

    const action = this._handleParsedRow({
      fields: trimmedRow,
      charLength: 0, // flush — no further offset tracking needed
      raw: line,
      quoted,
      pendingRows,
      shouldSkipEmpty: this.options.skipEmptyLines || false,
      skipLines: this.options.skipLines ?? 0,
      callback
    });

    if (action === "stop" || action === "error") {
      return;
    }
    this.processPendingRows(pendingRows, callback);
  }

  /**
   * Push buffered rows to stream with backpressure support
   */
  private pushBufferedRows(rows: Row[], callback: () => void): void {
    const useJson = this.options.objectMode === false;

    let index = 0;
    const processNext = (): void => {
      while (index < rows.length) {
        const row = rows[index++];
        const canContinue = this.push(useJson ? JSON.stringify(row) : row);
        if (!canContinue) {
          this.backpressure = true;
          this.pendingCallback = processNext;
          return;
        }
      }

      callback();
    };

    processNext();
  }

  /**
   * Push a single row to stream with backpressure support
   * @returns false if backpressure is applied (downstream is full)
   */
  private pushRow(row: Row): boolean {
    const useJson = this.options.objectMode === false;
    return this.push(useJson ? JSON.stringify(row) : row);
  }

  /**
   * Invoke chunk callback and handle result (sync or async)
   */
  private invokeChunkCallback(
    rows: Row[],
    meta: ChunkMeta,
    callback: (error?: Error | null) => void
  ): void {
    const result = this.options.chunk!(rows, meta);

    if (result instanceof Promise) {
      result
        .then(shouldContinue => {
          if (shouldContinue === false) {
            this.chunkAborted = true;
          }
          callback();
        })
        .catch(err => callback(err));
    } else {
      if (result === false) {
        this.chunkAborted = true;
      }
      callback();
    }
  }

  /**
   * Flush any remaining rows in the chunk buffer at the end of the stream
   */
  private flushFinalChunk(callback: (error?: Error | null) => void): void {
    if (this.chunkBuffer.length > 0 && this.options.chunk) {
      const chunkRowCount = this.chunkBuffer.length;
      const cursor = this.totalRowsProcessed - chunkRowCount;

      const meta: ChunkMeta = {
        cursor,
        rowCount: chunkRowCount,
        isFirstChunk: this.isFirstChunk,
        isLastChunk: true
      };

      const rows = this.chunkBuffer;
      this.chunkBuffer = [];
      this.pushBufferedRows(rows, () => this.invokeChunkCallback(rows, meta, callback));
    } else {
      callback();
    }
  }

  /**
   * Reset info state for next row (used when skipping rows or after processing)
   */
  private processBuffer(callback: (error?: Error | null) => void): void {
    const { skipEmptyLines = false, skipLines = 0 } = this.options;
    const shouldSkipEmpty = skipEmptyLines;

    // ==========================================================================
    // Fast Mode: Skip quote detection, split directly by delimiter
    // ==========================================================================
    if (this.parseConfig.fastMode) {
      this.processBufferFastMode(callback, shouldSkipEmpty);
      return;
    }

    // ==========================================================================
    // Standard Mode: Full RFC 4180 compliant parsing with quote handling
    // Uses Scanner for efficient indexOf-based batch scanning
    // ==========================================================================
    const pendingRows: Row[] = [];

    // Feed current buffer to scanner (scanner accumulates data internally)
    // The scanner maintains its own internal position tracking
    this.scanner.feed(this.buffer);
    this.buffer = ""; // Clear our buffer since scanner now owns the data

    // Process complete rows from scanner
    let scanResult;
    while ((scanResult = this.scanner.nextRow()) !== null) {
      // Always pass raw so _handleParsedRow can count newlines for accurate lineNumber
      const rawRow = scanResult.raw;
      const rowCharLength = (scanResult.raw?.length ?? 0) + (scanResult.newline?.length ?? 0);

      // Apply trim to fields.
      // Note: scanResult.fields is reused by the streaming scanner; we must copy even when trim is identity.
      const row = this.parseConfig.trimFieldIsIdentity
        ? scanResult.fields.slice()
        : scanResult.fields.map(this.parseConfig.trimField);

      const action = this._handleParsedRow({
        fields: row,
        charLength: rowCharLength,
        raw: rawRow,
        quoted: scanResult.quoted,
        pendingRows,
        shouldSkipEmpty,
        skipLines,
        callback
      });

      if (action === "stop") {
        return;
      }
      if (action === "error") {
        return;
      }
      // "continue" and "skip" both fall through to process next row
    }

    // Scanner internally tracks unconsumed data - no need to reset
    // It will continue from where it left off on the next feed()
    this.processPendingRows(pendingRows, callback);
  }

  private getFastModeCompleteDataEnd(buffer: string): number {
    const { linebreakRegex } = this.parseConfig;

    if (typeof linebreakRegex === "string") {
      const sep = linebreakRegex;
      if (sep === "") {
        return -1;
      }
      const maxStart = buffer.length - sep.length;
      if (maxStart < 0) {
        return -1;
      }
      const idx = buffer.lastIndexOf(sep, maxStart);
      if (idx === -1) {
        return -1;
      }
      return idx + sep.length;
    }

    // Fast path for default newline detection with CRLF chunk-boundary handling.
    if (linebreakRegex === DEFAULT_LINEBREAK_REGEX) {
      const lastLF = buffer.lastIndexOf("\n");
      const lastCR = buffer.lastIndexOf("\r");
      let lastNewlineIndex: number;

      if (lastCR > lastLF) {
        // CR comes after LF - check if this is part of a CRLF at end of buffer.
        // If \r is the last char, we need to wait for more data to see if \n follows.
        if (lastCR === buffer.length - 1) {
          lastNewlineIndex = lastLF;
        } else {
          lastNewlineIndex = lastCR;
        }
      } else {
        lastNewlineIndex = lastLF;
      }

      if (lastNewlineIndex === -1) {
        return -1;
      }

      return lastNewlineIndex + 1;
    }

    const re = new RegExp(linebreakRegex.source, `${linebreakRegex.flags}g`);
    let lastEnd = -1;
    for (let match = re.exec(buffer); match; match = re.exec(buffer)) {
      lastEnd = match.index + match[0].length;
      // Safety: avoid infinite loops for zero-length matches.
      if (match[0].length === 0) {
        re.lastIndex++;
      }
    }
    return lastEnd;
  }

  /**
   * Fast mode buffer processing - skips quote detection, splits directly by delimiter
   */
  private processBufferFastMode(
    callback: (error?: Error | null) => void,
    shouldSkipEmpty: boolean | "greedy"
  ): void {
    const { skipLines = 0 } = this.options;
    const pendingRows: Row[] = [];

    const completeEnd = this.getFastModeCompleteDataEnd(this.buffer);
    // If no complete line, wait for more data
    if (completeEnd === -1) {
      callback();
      return;
    }

    // Process complete lines
    const completeData = this.buffer.slice(0, completeEnd);
    this.buffer = this.buffer.slice(completeEnd);

    for (const { line, lineLengthWithEnding: lineCharLength } of splitLinesWithEndings(
      completeData,
      this.parseConfig.linebreakRegex
    )) {
      // FastMode: skip empty lines early before split (optimization)
      if (line === "" && shouldSkipEmpty) {
        this.parseState.lineNumber++;
        this.totalCharsProcessed += lineCharLength;
        continue;
      }

      // Split by delimiter (fast path - no quote detection)
      const row = line.split(this.parseConfig.delimiter);
      const trimmedRow = this.parseConfig.trimFieldIsIdentity
        ? row
        : row.map(this.parseConfig.trimField);

      // In fast mode, no fields are quoted
      const quoted = this.parseConfig.infoOption ? getUnquotedArray(trimmedRow.length) : undefined;

      const action = this._handleParsedRow({
        fields: trimmedRow,
        charLength: lineCharLength,
        raw: line,
        quoted,
        pendingRows,
        shouldSkipEmpty,
        skipLines,
        callback
      });

      if (action === "stop") {
        return;
      }
      if (action === "error") {
        return;
      }
    }

    this.processPendingRows(pendingRows, callback);
  }

  private buildRow(rawRow: string[], info?: RecordInfo): Row {
    const { dynamicTyping, castDate, groupColumnsByName = false } = this.options;

    let record: Record<string, unknown> | unknown[];

    if (this.options.headers && this.parseState.headerRow) {
      // Use shared utility for row-to-object conversion
      const obj = convertRowToObject(
        rawRow,
        this.parseState.headerRow,
        this.parseState.originalHeaders,
        groupColumnsByName
      );

      // Apply dynamicTyping and/or castDate if configured
      if (dynamicTyping || castDate) {
        record = applyDynamicTypingToRow(
          obj as Record<string, string>,
          dynamicTyping || false,
          castDate
        );
      } else {
        record = obj;
      }
    } else {
      // Array mode
      if (dynamicTyping || castDate) {
        // For array mode, can only use dynamicTyping: true (all columns)
        // or per-column config if we happen to have headers
        record = applyDynamicTypingToArrayRow(
          rawRow,
          this.parseState.headerRow ? filterValidHeaders(this.parseState.headerRow) : null,
          dynamicTyping || false,
          castDate
        );
      } else {
        record = rawRow;
      }
    }

    // Wrap with info if info option is enabled
    if (this.parseConfig.infoOption) {
      if (!info) {
        // Should not happen: parse-core provides info when infoOption is enabled.
        const fallback: RecordInfo = {
          index: 0,
          line: this.parseState.currentRowStartLine,
          offset: this.parseState.currentRowStartOffset,
          quoted: [...this.parseState.currentRowQuoted],
          raw: this.parseConfig.rawOption ? this.parseState.currentRawRow : undefined
        };
        info = fallback;
      }
      // Use unknown cast - when info: true, Row type is extended to RecordWithInfo
      return { record, info } as unknown as Row;
    }

    return record as Row;
  }

  /**
   * Shared per-row handling for all four processing paths (processBuffer, processBufferFastMode,
   * flushCurrentRow, flushFastModeRemainder).
   *
   * Performs: lineNumber increment, toLine/skipLines checks, info tracking, maxRowBytes,
   * raw row assignment, shouldSkipRow, and processCompletedRow delegation.
   *
   * @returns "continue" — row processed, keep going
   *          "skip"     — row skipped, keep going
   *          "stop"     — toLine/maxRows reached; pendingRows already flushed via callback
   *          "error"    — error passed to callback
   */
  private _handleParsedRow(input: {
    fields: string[];
    charLength: number;
    raw: string | undefined;
    quoted: readonly boolean[] | undefined;
    pendingRows: Row[];
    shouldSkipEmpty: boolean | "greedy";
    skipLines: number;
    callback: (error?: Error | null) => void;
  }): "continue" | "skip" | "stop" | "error" {
    const { fields, charLength, raw, quoted, pendingRows, shouldSkipEmpty, skipLines, callback } =
      input;

    // Save the start line BEFORE counting newlines (for accurate info.line on multi-line rows)
    const rowStartLine = this.parseState.lineNumber + 1;

    // Update line number (count newlines in raw content for multi-line quoted fields)
    if (raw !== undefined) {
      let newlines = 1;
      for (let i = 0; i < raw.length; i++) {
        const ch = raw.charCodeAt(i);
        if (ch === 10) {
          newlines++;
        } else if (ch === 13) {
          if (i + 1 < raw.length && raw.charCodeAt(i + 1) === 10) {
            i++;
          }
          newlines++;
        }
      }
      this.parseState.lineNumber += newlines;
    } else {
      this.parseState.lineNumber++;
    }

    // Check toLine - stop parsing at specified line number
    const { toLine } = this.options;
    if (toLine !== undefined && this.parseState.lineNumber > toLine) {
      this.toLineReached = true;
      this.totalCharsProcessed += charLength;
      this.processPendingRows(pendingRows, callback);
      return "stop";
    }

    // Skip lines at beginning
    if (this.parseState.lineNumber <= skipLines) {
      this.totalCharsProcessed += charLength;
      return "skip";
    }

    // Set up info tracking state
    if (this.parseConfig.infoOption) {
      this.parseState.currentRowStartLine = rowStartLine;
      this.parseState.currentRowStartOffset = this.totalCharsProcessed;
      if (quoted) {
        this.parseState.currentRowQuoted = quoted;
      }
    }

    // Update char offset (RecordInfo.offset is character offset)
    this.totalCharsProcessed += charLength;

    // Check maxRowBytes limit
    if (raw !== undefined && this.parseConfig.maxRowBytes !== undefined) {
      const rawBytes = getUtf8ByteLength(raw);
      if (rawBytes > this.parseConfig.maxRowBytes) {
        callback(
          new Error(`Row exceeds the maximum size of ${this.parseConfig.maxRowBytes} bytes`)
        );
        return "error";
      }
    }

    // Set raw row for info tracking
    if (this.parseConfig.rawOption && raw !== undefined) {
      this.parseState.currentRawRow = raw;
    }

    // Skip comment/empty lines
    if (this.shouldSkipRow(fields, shouldSkipEmpty)) {
      return "skip";
    }

    // Process completed row (handles headers, skipRows, column validation, maxRows)
    if (!this.processCompletedRow(fields, pendingRows)) {
      this.processPendingRows(pendingRows, callback);
      return "stop";
    }
    return "continue";
  }

  /**
   * Process a completed row (shared logic for standard and fast mode)
   * Returns true if processing should continue, false if maxRows/toLine reached
   */
  private processCompletedRow(row: string[], pendingRows: Row[]): boolean {
    // State is now unified via accessors - no manual sync needed
    const result = processCompletedRowCore(
      row,
      this.parseState,
      this.parseConfig,
      this.parseErrorsSink,
      this.parseState.lineNumber
    );

    // Clear sink to prevent unbounded memory growth.
    // Errors are reported via result.reason (data-invalid) or onSkip callback;
    // the sink is only used as a shared collector for processCompletedRowCore.
    this.parseErrorsSink.length = 0;

    // Emit headers event when headers become available
    this.emitHeaders();

    // Column mismatch reporting (stream API) - emit event when reason is provided
    if (result.reason) {
      this.emit("data-invalid", row, result.reason);
    }

    if (result.stop) {
      return false;
    }

    if (result.skipped) {
      return true;
    }

    if (result.row) {
      const builtRow = this.buildRow(result.row, result.info);
      // Attach extras to the record for columnMismatch.more: 'keep' (consistent with sync parser)
      if (result.extras && result.extras.length > 0) {
        // When info is enabled, buildRow returns a RecordWithInfo whose
        // actual record lives on `.record`; otherwise builtRow is the record.
        const record = this.parseConfig.infoOption
          ? (builtRow as unknown as RecordWithInfo).record
          : builtRow;
        (record as Record<string, unknown>)._extra = result.extras;
      }
      pendingRows.push(builtRow);
    }
    return true;
  }

  private emitHeaders(): void {
    if (!this.headersEmitted && this.parseState.headerRow) {
      this.headersEmitted = true;
      this.emit("headers", filterValidHeaders(this.parseState.headerRow));
    }
  }

  /**
   * Check if a line should be skipped (comment or empty)
   */
  private shouldSkipRow(row: string[], shouldSkipEmpty: boolean | "greedy"): boolean {
    // Delegate to parse-core to keep sync/stream behavior aligned.
    // Note: row passed here is already split into fields.
    return shouldSkipRowCore(
      row,
      this.parseConfig.comment,
      shouldSkipEmpty,
      false // skipRecordsWithEmptyValues is handled inside processCompletedRowCore
    );
  }

  private processPendingRows(rows: Row[], callback: (error?: Error | null) => void): void {
    if (rows.length === 0) {
      callback();
      return;
    }

    // If chunk callback aborted, skip processing
    if (this.chunkAborted) {
      callback();
      return;
    }

    // Fast path: no transform or validate, push all rows directly
    if (!this._rowTransform && !this._rowValidator) {
      let index = 0;

      const processNextBatch = (): void => {
        while (index < rows.length && !this.chunkAborted) {
          const row = rows[index++];

          if (this.options.chunk) {
            // Collect rows for chunk callback
            this.chunkBuffer.push(row);
            this.totalRowsProcessed++;

            // Check if chunk is full
            if (this.chunkBuffer.length >= this.chunkSize) {
              this.flushChunk(err => {
                if (err) {
                  callback(err);
                  return;
                }
                // If chunk callback aborted, stop processing
                if (this.chunkAborted) {
                  callback();
                  return;
                }
                // Trampoline: yield to event loop periodically to prevent stack overflow
                if (index % 1000 === 0) {
                  setTimeout(processNextBatch, 0);
                } else {
                  processNextBatch();
                }
              });
              return;
            }
          } else {
            // No chunk callback, push directly with backpressure support
            const canContinue = this.pushRow(row);
            if (!canContinue) {
              // Backpressure applied - pause and wait for _read()
              this.backpressure = true;
              this.pendingCallback = () => processNextBatch();
              return;
            }
          }
        }
        callback();
      };

      processNextBatch();
      return;
    }

    // Slow path: process rows one by one with transform/validate
    let index = 0;
    const processNext = (): void => {
      if (index >= rows.length) {
        callback();
        return;
      }

      const row = rows[index++];
      this.transformAndValidateRow(row, (err, result) => {
        if (err) {
          callback(err);
          return;
        }

        if (result && result.isValid && result.row !== null) {
          if (this.options.chunk) {
            // Collect rows for chunk callback
            this.chunkBuffer.push(result.row);
            this.totalRowsProcessed++;

            // Check if chunk is full
            if (this.chunkBuffer.length >= this.chunkSize) {
              this.flushChunk(err2 => {
                if (err2) {
                  callback(err2);
                  return;
                }
                // Continue processing after chunk flush
                if (index % 1000 === 0) {
                  setTimeout(processNext, 0);
                } else {
                  processNext();
                }
              });
              return;
            }
          } else {
            // No chunk callback, push directly with backpressure support
            const canContinue = this.pushRow(result.row);
            if (!canContinue) {
              // Backpressure applied - pause and wait for _read()
              this.backpressure = true;
              this.pendingCallback = () => processNext();
              return;
            }
          }
        } else if (result && !result.isValid) {
          this.emit("data-invalid", result.row, result.reason);
        }

        // Use setTimeout to prevent stack overflow for large datasets
        if (index % 1000 === 0) {
          setTimeout(processNext, 0);
        } else {
          processNext();
        }
      });
    };

    processNext();
  }

  /**
   * Flush the current chunk buffer to the chunk callback
   */
  private flushChunk(callback: (error?: Error | null) => void): void {
    if (this.chunkBuffer.length === 0 || !this.options.chunk) {
      callback();
      return;
    }

    const chunkRowCount = this.chunkBuffer.length;
    const cursor = this.totalRowsProcessed - chunkRowCount;

    const meta: ChunkMeta = {
      cursor,
      rowCount: chunkRowCount,
      isFirstChunk: this.isFirstChunk,
      isLastChunk: false
    };

    this.isFirstChunk = false;

    // Take rows and clear buffer before callback
    const rows = this.chunkBuffer;
    this.chunkBuffer = [];

    // Push rows to stream, then invoke callback
    this.pushBufferedRows(rows, () => this.invokeChunkCallback(rows, meta, callback));
  }

  private transformAndValidateRow(
    row: Row,
    callback: (
      err: Error | null,
      result?: { row: Row | null; isValid: boolean; reason?: string }
    ) => void
  ): void {
    // First apply transform
    if (this._rowTransform) {
      this._rowTransform(row, (transformErr, transformedRow) => {
        if (transformErr) {
          callback(transformErr);
          return;
        }

        if (transformedRow === null || transformedRow === undefined) {
          callback(null, { row: null, isValid: true });
          return;
        }

        // Then validate
        this.validateRow(transformedRow, callback);
      });
    } else {
      this.validateRow(row, callback);
    }
  }

  private validateRow(
    row: Row,
    callback: (
      err: Error | null,
      result?: { row: Row | null; isValid: boolean; reason?: string }
    ) => void
  ): void {
    if (this._rowValidator) {
      this._rowValidator(row, (validateErr, isValid, reason) => {
        if (validateErr) {
          callback(validateErr);
          return;
        }

        callback(null, { row, isValid: isValid ?? false, reason });
      });
    } else {
      callback(null, { row, isValid: true });
    }
  }
}

/**
 * Create parser stream factory
 */
export function createCsvParserStream(options: CsvParseOptions = {}): CsvParserStream {
  return new CsvParserStream(options);
}

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
import {
  applyFirstChunkPreprocessing,
  DELIMITER_DETECTION_SAMPLE_CHARS,
  DELIMITER_DETECTION_SAMPLE_RECORDS,
  delimiterCandidates,
  detectDelimiter,
  isScorableDetectionRecord
} from "@csv/utils/detect";
import { applyDynamicTypingToRow, applyDynamicTypingToArrayRow } from "@csv/utils/dynamic-typing";
import { Transform } from "@stream";

/** How much of the detection sample one delimiter candidate has accumulated. */
interface DetectionCandidateProgress {
  /** Records that can be scored, so neither blank nor comment. */
  records: number;
  /** Characters of those scorable records. */
  scoredChars: number;
  /** Characters of every record consumed, scorable or not. */
  consumedChars: number;
}

/** A candidate's progress plus the scanner producing its records. */
interface DetectionCandidate extends DetectionCandidateProgress {
  scanner: Scanner;
}

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

  /**
   * Whether the unconsumed {@link buffer} may hold a line ending, in fastMode.
   *
   * `buffer += chunk` only builds a rope, which is free, but any string operation on
   * that rope flattens it — copying every byte buffered so far, once per chunk, which is
   * O(bytes^2/chunk), orders of magnitude above searching the pieces themselves. So the arriving chunk is what gets
   * searched, and the buffer is left untouched until that search says there is something
   * to find.
   */
  private fastModeLineEndPending = true;

  /**
   * Last few characters of the unconsumed {@link buffer}, kept while
   * {@link fastModeLineEndPending} is false.
   *
   * A line ending may straddle a chunk boundary — "\r" then "\n", or "|" then "|" for a
   * two-character `lineEnding` — so searching each chunk alone would miss it. Holding one
   * character short of the longest possible ending is enough to see any of them.
   */
  private fastModeBoundaryTail = "";

  /**
   * Length of the {@link buffer} prefix already proven to hold no line ending, in
   * fastMode.
   *
   * This is the backstop for the case {@link fastModeLineEndPending} cannot settle: a
   * buffer ending in CR looks like it may hold an ending, but the CR is undecidable until
   * the next character, so the full search comes back empty. Without the mark that search
   * would start from the beginning every time.
   *
   * Only ever set from {@link processBufferFastMode}, which backs it off far enough that
   * a line ending straddling the mark is still found. See there.
   */
  private fastModeNoLineEndBefore = 0;

  /**
   * Detection-only text since the last confirmed empty/comment record. Keeping it separate
   * lets those records be dropped as they arrive, so readiness never re-scans or flattens the
   * full buffered prefix.
   */
  private delimiterDetectionProbe = "";
  /**
   * Per-candidate incremental scanners counting complete records in the probe.
   *
   * Detection must commit on content, never on how that content was chunked, and it must
   * see the same sample the batch detector uses. Every candidate therefore counts its own
   * records; committing happens once they all have a full sample, or at end of input.
   */
  private delimiterDetectionCandidateRecords = new Map<string, DetectionCandidate>();
  /**
   * Progress for a configured non-CR/LF separator, where records are split the same way for
   * every candidate, so one counter stands in for all of them.
   */
  private delimiterDetectionSeparatorProgress: DetectionCandidateProgress = {
    records: 0,
    scoredChars: 0,
    consumedChars: 0
  };
  /** Text of the record currently being accumulated for the separator counter. */
  private delimiterDetectionCandidateTail = "";

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

  // Improve public typing without relying on generic Transform types. The
  // declared chunk types WIDEN the base signature (they include the base's
  // byte chunk) rather than replace it: `Transform` resolves to Node's
  // non-generic class on the Node build and to the generic
  // `Transform<Uint8Array, Uint8Array>` on the browser build, and a member that
  // dropped the byte arm was not assignable to the latter.
  declare push: (chunk: Row | string | Uint8Array | null, encoding?: string) => boolean;
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
    // `data` is `never`: this stream reports errors through the callback and
    // emits rows through `this.push`, never through the callback's data channel.
    // Typing it so also keeps the override assignable to the byte-typed base
    // `_transform` on the browser build (see the note on `push` above).
    callback: (error?: Error | null, data?: never) => void
  ): void {
    // If chunk callback aborted parsing or toLine reached, skip all further processing
    if (this.chunkAborted || this.toLineReached) {
      callback();
      return;
    }

    try {
      const data = typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });

      // A byte chunk may end inside a multi-byte UTF-8 sequence, in which case TextDecoder
      // legitimately produces no text yet. That is not the first *text* chunk: applying the
      // hook to "" would consume its one chance before the decoded prefix arrives.
      if (typeof chunk !== "string" && data === "" && this.buffer === "") {
        callback();
        return;
      }

      this.buffer += data;
      this.noteFastModeAppend(data);
      if (this.autoDetectDelimiter && !this.delimiterDetected) {
        this.delimiterDetectionProbe += data;
        this.feedDelimiterDetectionCandidates(data);
      }

      this.prepareFirstTextChunk();

      // Nothing may be parsed until the delimiter is known: feeding the buffer to the
      // temporary comma-configured scanner would consume bytes the eventual scanner can
      // never recover. Readiness itself is a constant-time check on the candidate counters.
      if (
        this.autoDetectDelimiter &&
        !this.delimiterDetected &&
        !this.detectDelimiterIfReady(false)
      ) {
        callback();
        return;
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
        this.noteFastModeAppend(remainingDecoded);
        if (this.autoDetectDelimiter && !this.delimiterDetected) {
          this.delimiterDetectionProbe += remainingDecoded;
          this.feedDelimiterDetectionCandidates(remainingDecoded);
        }
      }

      // A hook may produce the whole input, so it must run even when nothing was ever fed.
      this.prepareFirstTextChunk(true);

      // EOF makes the final partial line complete for detection purposes.
      if (this.autoDetectDelimiter && !this.delimiterDetected) {
        this.detectDelimiterIfReady(true);
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
    this.delimiterDetectionProbe = "";
    this.resetDelimiterDetectionCandidate();
    this.resetFastModeLineEndTracking();

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
    this.resetFastModeLineEndTracking();

    // Under the default CR/LF grammar a trailing CR is a line ending whose possible LF can
    // now be ruled out, and the batch splitter yields the empty record that follows it. With a
    // custom separator the CR is ordinary field content.
    if (this.parseConfig.linebreakRegex === DEFAULT_LINEBREAK_REGEX && line.endsWith("\r")) {
      line = line.slice(0, -1);
      if (line === "") {
        // The CR terminated a record that had already been emitted, leaving one empty record
        // behind it — which is what a batch parse of the same text produces.
        this.emitFastModeLine("", callback);
        return;
      }
    }

    if (line === "") {
      callback();
      return;
    }

    this.emitFastModeLine(line, callback);
  }

  /** Emit one fastMode record at EOF. */
  private emitFastModeLine(line: string, callback: (error?: Error | null) => void): void {
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

  /**
   * Run the hook and BOM strip on the first text, exactly as `Csv.parse` does.
   *
   * `atEof` forces it even with nothing buffered, because a hook is allowed to *produce* the
   * input; skipping it for an empty stream made `Csv.parse("")` and a streamed empty input
   * disagree.
   */
  private prepareFirstTextChunk(atEof = false): void {
    if (this.bomStripped || (this.buffer === "" && !atEof)) {
      return;
    }

    const prepared = applyFirstChunkPreprocessing(this.buffer, this.options.beforeFirstChunk);
    this.beforeFirstChunkApplied = true;
    this.bomStripped = true;

    if (prepared === this.buffer) {
      return;
    }

    // The text changed, so anything recorded about the old text — including whatever the
    // detection candidates have already consumed — no longer describes it.
    this.buffer = prepared;
    this.resetFastModeLineEndTracking();
    if (this.autoDetectDelimiter && !this.delimiterDetected) {
      this.delimiterDetectionProbe = prepared;
      this.resetDelimiterDetectionCandidate();
      this.feedDelimiterDetectionCandidates(prepared);
    }
  }

  private resetDelimiterDetectionCandidate(): void {
    this.delimiterDetectionCandidateRecords = new Map();
    this.delimiterDetectionSeparatorProgress = { records: 0, scoredChars: 0, consumedChars: 0 };
    this.delimiterDetectionCandidateTail = "";
  }

  /**
   * Advance every candidate's record count over the arriving data only, so the accumulated
   * probe is never re-scanned and the counts cannot depend on chunk boundaries.
   */
  private feedDelimiterDetectionCandidates(data: string): void {
    if (data === "") {
      return;
    }

    if (this.parseConfig.linebreakRegex !== DEFAULT_LINEBREAK_REGEX) {
      const separator = this.parseConfig.linebreak;
      if (separator === "") {
        return;
      }
      // The whole record is kept, not a `separator.length - 1` tail: whether a record can be
      // scored depends on all of its text, so judging a truncated piece let a comment longer
      // than that tail count towards the sample and made the choice chunk-dependent.
      let pending = this.delimiterDetectionCandidateTail + data;
      let at = pending.indexOf(separator);
      while (at !== -1) {
        const record = pending.slice(0, at);
        const progress = this.delimiterDetectionSeparatorProgress;
        if (this.isScorable(record)) {
          progress.records++;
          progress.scoredChars += record.length;
        }
        progress.consumedChars += at + separator.length;
        pending = pending.slice(at + separator.length);
        at = pending.indexOf(separator);
      }
      this.delimiterDetectionCandidateTail = pending;
      return;
    }

    for (const delimiter of this.delimiterDetectionCandidates()) {
      let entry = this.delimiterDetectionCandidateRecords.get(delimiter);
      if (!entry) {
        entry = {
          scanner: createScanner({ ...toScannerConfig(this.parseConfig), delimiter }),
          records: 0,
          scoredChars: 0,
          consumedChars: 0
        };
        this.delimiterDetectionCandidateRecords.set(delimiter, entry);
      }
      entry.scanner.feed(data);
      let row = entry.scanner.nextRow();
      while (row !== null && !this.candidateSampleComplete(entry)) {
        const raw = row.raw ?? "";
        entry.consumedChars += raw.length + (row.newline?.length ?? 0);
        if (this.isScorable(raw)) {
          entry.records++;
          entry.scoredChars += raw.length;
        }
        row = entry.scanner.nextRow();
      }
    }
  }

  private isScorable(raw: string): boolean {
    return isScorableDetectionRecord(raw, this.options.comment);
  }

  /**
   * The record separator only reaches the sampler when the parse itself will use it, which is
   * fastMode with a configured string. Standard mode always ends records at CR/LF, so passing
   * it there would sample on boundaries the parser never uses — and did so on one side only.
   */
  private detectionLineEnding(): string | undefined {
    return this.parseConfig.fastMode && this.parseConfig.linebreakRegex !== DEFAULT_LINEBREAK_REGEX
      ? this.parseConfig.linebreak
      : undefined;
  }

  private delimiterDetectionCandidates(): readonly string[] {
    return delimiterCandidates(this.options.delimitersToGuess);
  }

  /**
   * Whether the probe holds the whole sample the batch detector would look at.
   *
   * Requiring it of *every* candidate is what makes a stream agree with `Csv.parse`: the
   * winning candidate is chosen by comparing all of their field counts, so a candidate whose
   * quoting still needs more text could otherwise be scored on less of the input than the
   * batch detector scores it on.
   */
  private candidateSampleComplete(entry: DetectionCandidateProgress): boolean {
    if (
      entry.records >= DELIMITER_DETECTION_SAMPLE_RECORDS ||
      entry.scoredChars >= DELIMITER_DETECTION_SAMPLE_CHARS
    ) {
      return true;
    }
    // A candidate whose quoting never closes completes no record at all, so neither bound
    // above can ever be reached and the stream would buffer to end of input before emitting
    // anything. Once it is sitting on this much undigested text, score it with what it has.
    return (
      this.delimiterDetectionProbe.length - entry.consumedChars >= DELIMITER_DETECTION_SAMPLE_CHARS
    );
  }

  private hasFullDelimiterDetectionSample(): boolean {
    if (this.parseConfig.linebreakRegex !== DEFAULT_LINEBREAK_REGEX) {
      return this.candidateSampleComplete(this.delimiterDetectionSeparatorProgress);
    }
    const candidates = this.delimiterDetectionCandidates();
    for (const delimiter of candidates) {
      const entry = this.delimiterDetectionCandidateRecords.get(delimiter);
      if (!entry || !this.candidateSampleComplete(entry)) {
        return false;
      }
    }
    return candidates.length > 0;
  }

  private detectDelimiterIfReady(isEof: boolean): boolean {
    const comment = this.options.comment;
    let start = 0;
    const candidateDelimiters = this.delimiterDetectionCandidates();

    // Commit on content, not on arrival: wait for the same sample the batch detector reads,
    // unless end of input settles it. Anything less makes the chosen delimiter — and so the
    // rows — depend on where the chunk boundaries happened to fall.
    if (!isEof && !this.hasFullDelimiterDetectionSample()) {
      return false;
    }

    // Scored once, not once per skipped record: the sample the detector reads does not change
    // as this loop walks past leading blank and comment records, and re-running it per record
    // made a long comment prefix quadratic.
    const detected = detectDelimiter(
      this.delimiterDetectionProbe,
      this.parseConfig.quote || '"',
      [...candidateDelimiters],
      comment,
      this.options.skipEmptyLines,
      {
        escape: this.parseConfig.escape,
        relaxQuotes: this.parseConfig.relaxQuotes,
        lineEnding: this.detectionLineEnding()
      }
    );
    const recordScanner =
      this.parseConfig.linebreakRegex === DEFAULT_LINEBREAK_REGEX
        ? createScanner({ ...toScannerConfig(this.parseConfig), delimiter: detected })
        : undefined;

    // The probe is only walked, never trimmed: trimming it here made the loop bound stale —
    // an input whose records are all blank or comments then spun forever — and left the
    // committed delimiter scored on different text than `Csv.parse` sees.
    while (start < this.delimiterDetectionProbe.length) {
      let end: number;
      let next: number;
      if (recordScanner) {
        // Delimiter choice can affect whether a quote is at a field start, which in turn
        // determines whether a following newline is inside that field, so the record this
        // loop skips over must be read with the selected candidate's semantics.
        const row = recordScanner.scanRow(this.delimiterDetectionProbe, start, isEof);
        if (!row.complete) {
          return false;
        }

        end = row.rawEnd;
        next = row.endPos;
      } else {
        const separator = this.parseConfig.linebreak;
        const separatorAt =
          separator === "" ? -1 : this.delimiterDetectionProbe.indexOf(separator, start);
        if (separatorAt === -1) {
          if (!isEof) {
            return false;
          }
          end = this.delimiterDetectionProbe.length;
          next = end;
        } else {
          end = separatorAt;
          next = separatorAt + separator.length;
        }
      }

      if (this.isScorable(this.delimiterDetectionProbe.slice(start, end))) {
        this.commitDetectedDelimiter(detected);
        return true;
      }

      if (next <= start) {
        break;
      }
      start = next;
    }

    // At EOF an empty/comment-only input still needs a settled configuration so the
    // ordinary flush path can finish it consistently.
    if (isEof) {
      this.commitDetectedDelimiter(this.parseConfig.delimiter);
      return true;
    }
    return false;
  }

  private commitDetectedDelimiter(delimiter: string): void {
    this.parseConfig.delimiter = delimiter;
    this.delimiterDetected = true;
    this.emit("delimiter", delimiter);
    this.scanner = createScanner(toScannerConfig(this.parseConfig));
    // The detection sample is no longer needed; holding it would pin the prefix for the rest
    // of the stream.
    this.delimiterDetectionProbe = "";
    this.resetDelimiterDetectionCandidate();
  }

  /**
   * Longest line ending the configured linebreak can match, or undefined when that cannot
   * be known: a caller-supplied regex has no bounded match length, and an empty separator
   * matches nothing at all. Both leave the buffer to be searched as before.
   */
  private maxLineEndLength(): number | undefined {
    const { linebreakRegex } = this.parseConfig;
    if (typeof linebreakRegex === "string") {
      return linebreakRegex === "" ? undefined : linebreakRegex.length;
    }
    if (linebreakRegex === DEFAULT_LINEBREAK_REGEX) {
      return 2; // "\r\n"
    }
    return undefined;
  }

  /**
   * Forget what is known about line endings in {@link buffer}, so that the next pass
   * examines it from the start. Used wherever the buffer is replaced or emptied.
   */
  private resetFastModeLineEndTracking(): void {
    this.fastModeLineEndPending = true;
    this.fastModeBoundaryTail = "";
    this.fastModeNoLineEndBefore = 0;
  }

  /**
   * Note that `data` has been appended to {@link buffer}, recording whether it brings a
   * line ending so that {@link processBufferFastMode} can skip the buffer entirely when
   * it does not.
   *
   * Searches the arriving data joined to {@link fastModeBoundaryTail} rather than the
   * buffer, which is the whole point — see {@link fastModeLineEndPending}.
   */
  private noteFastModeAppend(data: string): void {
    if (this.fastModeLineEndPending || data === "") {
      return;
    }

    const maxLineEnd = this.maxLineEndLength();
    if (maxLineEnd === undefined) {
      // No tail is long enough to rule out an ending straddling the boundary, so fall back
      // to searching the buffer.
      this.fastModeLineEndPending = true;
      return;
    }

    // Reached only for a bounded linebreak, which is either a non-empty separator or the
    // default CR/LF pattern.
    const { linebreakRegex } = this.parseConfig;
    const searchable = this.fastModeBoundaryTail + data;
    const found =
      typeof linebreakRegex === "string"
        ? searchable.includes(linebreakRegex)
        : searchable.includes("\n") || searchable.includes("\r");

    if (found) {
      this.fastModeLineEndPending = true;
      this.fastModeBoundaryTail = "";
      return;
    }
    this.fastModeBoundaryTail = searchable.slice(Math.max(0, searchable.length - (maxLineEnd - 1)));
  }

  /**
   * Record that the unconsumed {@link buffer} holds no line ending a further chunk could
   * not supply, and keep the tail needed to spot one that straddles the boundary.
   *
   * Only called where the buffer has just been searched, so it is already flat and
   * reading its tail costs nothing.
   */
  private markFastModeNoLineEnd(): void {
    const maxLineEnd = this.maxLineEndLength();
    if (maxLineEnd === undefined) {
      this.fastModeLineEndPending = true;
      this.fastModeBoundaryTail = "";
      return;
    }
    this.fastModeLineEndPending = false;
    const keep = maxLineEnd - 1;
    this.fastModeBoundaryTail =
      keep === 0 ? "" : this.buffer.slice(Math.max(0, this.buffer.length - keep));
  }

  private getFastModeCompleteDataEnd(buffer: string): number {
    const { linebreakRegex } = this.parseConfig;
    // Neither `lastIndexOf` nor a backwards scan takes a lower bound, so each branch
    // below excludes the already-searched prefix by slicing. V8 makes a slice a view
    // rather than a copy, so that costs an object and not the bytes.
    const searchFrom = this.fastModeNoLineEndBefore;

    if (typeof linebreakRegex === "string") {
      const sep = linebreakRegex;
      if (sep === "") {
        return -1;
      }
      const region = searchFrom === 0 ? buffer : buffer.slice(searchFrom);
      // Use the splitter's exact left-to-right, non-overlapping semantics. `lastIndexOf`
      // picks an overlapping occurrence in `"|||"`, while split consumes the first `"||"`;
      // cutting at the former turns the leftover `"|"` into a spurious row.
      let lastEnd = -1;
      let from = 0;
      while (from <= region.length - sep.length) {
        const idx = region.indexOf(sep, from);
        if (idx === -1) {
          break;
        }
        lastEnd = idx + sep.length;
        from = lastEnd;
      }
      return lastEnd === -1 ? -1 : searchFrom + lastEnd;
    }

    // Fast path for default newline detection with CRLF chunk-boundary handling.
    if (linebreakRegex === DEFAULT_LINEBREAK_REGEX) {
      // A CR at the very end of the buffer is undecidable: the next chunk may start with
      // an LF, making it a CRLF rather than a line ending of its own. Excluding that one
      // character is the whole of the boundary handling — every ending below it is
      // decided by data already in hand.
      const decidable = buffer.endsWith("\r") ? buffer.length - 1 : buffer.length;
      if (decidable <= searchFrom) {
        return -1;
      }

      const region = buffer.slice(searchFrom, decidable);
      const regionLF = region.lastIndexOf("\n");
      const regionCR = region.lastIndexOf("\r");

      if (regionLF === -1 && regionCR === -1) {
        return -1;
      }

      // A CR after the last LF is a lone CR — had an LF followed it, that LF would be
      // the later of the two — and ends its line at itself. Otherwise the last ending is
      // the LF, whether alone or closing a CRLF. Either way the line ends one past it.
      return searchFrom + Math.max(regionLF, regionCR) + 1;
    }

    const region = searchFrom === 0 ? buffer : buffer.slice(searchFrom);
    // Internal config currently reaches this branch only for DEFAULT_LINEBREAK_REGEX, but
    // keep it correct for a directly-constructed ParseConfig too: global may already be
    // present, and sticky means "match exactly here" rather than "find the next ending".
    const flags = `${linebreakRegex.flags.replace(/[gy]/g, "")}g`;
    const re = new RegExp(linebreakRegex.source, flags);
    let lastEnd = -1;
    for (let match = re.exec(region); match; match = re.exec(region)) {
      lastEnd = searchFrom + match.index + match[0].length;
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

    // Nothing has arrived that could end a line, so the buffer is left alone entirely —
    // touching it would flatten the rope built by appending. See fastModeLineEndPending.
    if (!this.fastModeLineEndPending) {
      callback();
      return;
    }

    const completeEnd = this.getFastModeCompleteDataEnd(this.buffer);
    // If no complete line, wait for more data
    if (completeEnd === -1) {
      // The buffer stays, so record that it holds no line ending and spare the next
      // chunk from searching it again. Backing off by one character short of the
      // longest line ending keeps a line ending that straddles the mark reachable —
      // without it, a chunk ending in "\r" would hide the "\r\n" completed by the next
      // one. A caller-supplied regex has no bounded match length, so it gets no mark.
      const maxLineEnd = this.maxLineEndLength();
      this.fastModeNoLineEndBefore =
        maxLineEnd === undefined ? 0 : Math.max(0, this.buffer.length - (maxLineEnd - 1));
      this.markFastModeNoLineEnd();
      callback();
      return;
    }
    this.fastModeNoLineEndBefore = 0;

    // Process complete lines
    const completeData = this.buffer.slice(0, completeEnd);
    this.buffer = this.buffer.slice(completeEnd);
    // The remainder is everything after the last line ending, so by construction it holds
    // none — bar a trailing CR, which the kept tail covers.
    this.markFastModeNoLineEnd();

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

    // Standard mode counts physical CR/LF sequences inside multi-line quoted fields.
    // Fast mode already split this record by its configured `lineEnding`; with a custom
    // separator, CR and LF in `raw` are ordinary content and must not alter `line`,
    // skipLines or toLine.
    if (raw !== undefined && !this.parseConfig.fastMode) {
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

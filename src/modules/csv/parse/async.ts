/**
 * Async CSV Parser
 *
 * Provides async CSV parsing supporting:
 * - String input (delegates to sync parser)
 * - AsyncIterable<string|Uint8Array> inputs
 * - ReadableStream inputs (WHATWG streams)
 *
 * API Semantics:
 * - parseCsvAsync(): Collects all rows into memory, returns full CsvParseResult.
 *   Best for small-to-medium files where you need complete data at once.
 *
 * - parseCsvRows(): True streaming async generator that yields rows one at a time.
 *   Best for large files or when processing rows incrementally.
 *   Memory-efficient as it doesn't buffer the entire result.
 *
 * Note: Both functions are async but have different memory characteristics.
 * parseCsvAsync buffers the entire input; parseCsvRows streams progressively.
 */

import { getUtf8ByteLength } from "@csv/constants";
import { CsvError } from "@csv/errors";
import { parseCsv } from "@csv/parse/sync";
import { CsvParserStream } from "@csv/stream/parser";
import type {
  CsvParseOptions,
  CsvParseArrayOptions,
  CsvParseObjectOptions,
  CsvParseResult,
  RecordWithInfo
} from "@csv/types";
import { isReadableStreamLike, readableStreamToAsyncIterable } from "@stream/utils.base";
import { toError } from "@utils/errors";

/**
 * Rows buffered for the generator's consumer before the parser is paused.
 *
 * Small enough that a slow consumer cannot accumulate the whole input, large enough that a
 * fast one is never throttled between pulls.
 */
const ROW_QUEUE_HIGH_WATER_MARK = 1024;
const ROW_QUEUE_LOW_WATER_MARK = 256;

type AsyncInput = AsyncIterable<string | Uint8Array>;

/**
 * Everything the async / streaming CSV parsers accept as input: a whole CSV
 * string, any async iterable of text or bytes (a Node `Readable`, an async
 * generator, …), or a WHATWG `ReadableStream` of bytes.
 *
 * Narrower than the runtime guard (`isReadableStreamLike` accepts any object
 * with a `getReader`), because these are the chunk shapes `collectText` can
 * actually decode.
 */
export type CsvAsyncInput =
  | string
  | AsyncIterable<string | Uint8Array>
  | ReadableStream<Uint8Array>;

/**
 * A single row produced by the streaming parser.
 *
 * The object / array / with-info variants are the normal (object-mode) output.
 * The `string` arm only occurs with `objectMode: false`, where the parser emits
 * each row as a JSON string.
 */
export type ParsedRow =
  | Record<string, unknown>
  | string[]
  | RecordWithInfo<Record<string, unknown>>
  | RecordWithInfo<string[]>
  | string;

function isAsyncIterable(value: unknown): value is AsyncInput {
  return Boolean(
    value &&
    typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function"
  );
}

function normalizeAsyncInput(input: unknown): AsyncInput {
  if (isAsyncIterable(input)) {
    return input;
  }
  if (isReadableStreamLike(input)) {
    return readableStreamToAsyncIterable(input);
  }
  throw new TypeError("input must be an AsyncIterable or a ReadableStream");
}

/** Result from collectText with optional byte tracking */
interface CollectResult {
  content: string;
  totalBytes: number;
}

/**
 * Collect AsyncIterable<string|Uint8Array> to a complete string.
 * Unified helper for both collectAsyncInput and parseCsvWithProgress.
 *
 * @param input - Async iterable of chunks
 * @param encoding - `TextDecoder` label (default: utf-8)
 * @param onChunk - Optional callback for each chunk (for progress reporting)
 */
async function collectText(
  input: AsyncIterable<string | Uint8Array>,
  encoding?: string,
  onChunk?: (bytesProcessed: number) => void
): Promise<CollectResult> {
  const chunks: string[] = [];
  const decoder = new TextDecoder(encoding || "utf-8");
  let totalBytes = 0;

  for await (const chunk of input) {
    if (typeof chunk === "string") {
      chunks.push(chunk);
      // Always track bytes for consistent semantics
      totalBytes += getUtf8ByteLength(chunk);
    } else {
      chunks.push(decoder.decode(chunk, { stream: true }));
      totalBytes += chunk.length;
    }

    if (onChunk) {
      onChunk(totalBytes);
    }
  }

  // Flush decoder
  const final = decoder.decode();
  if (final) {
    chunks.push(final);
  }

  return { content: chunks.join(""), totalBytes };
}

/**
 * Parse CSV asynchronously.
 *
 * For string input, this simply wraps the sync parser.
 * For AsyncIterable input (streams), collects chunks and parses.
 *
 * @example
 * ```ts
 * // From string
 * const result = await parseCsvAsync("a,b\n1,2", { headers: true });
 *
 * // From fetch response
 * const response = await fetch("data.csv");
 * const result = await parseCsvAsync(response.body, { headers: true });
 *
 * // From file stream (Node.js)
 * import { createReadStream } from "fs";
 * const result = await parseCsvAsync(createReadStream("data.csv"), { headers: true });
 * ```
 */

// =============================================================================
// Function Overloads for Better Type Inference
// =============================================================================

/**
 * Parse CSV async - returns string[][] when no options provided.
 */
export function parseCsvAsync(input: CsvAsyncInput): Promise<string[][]>;

/**
 * Parse CSV async - returns string[][] when headers is false/undefined and no info option.
 */
export function parseCsvAsync(
  input: CsvAsyncInput,
  options: CsvParseArrayOptions & { info?: false }
): Promise<string[][]>;

/**
 * Parse CSV async - returns CsvParseResult with RecordWithInfo when info: true (array mode).
 */
export function parseCsvAsync(
  input: CsvAsyncInput,
  options: CsvParseArrayOptions & { info: true }
): Promise<CsvParseResult<RecordWithInfo<string[]>>>;

/**
 * Parse CSV async - returns CsvParseResult when headers are enabled.
 */
export function parseCsvAsync(
  input: CsvAsyncInput,
  options: CsvParseObjectOptions & { info?: false }
): Promise<CsvParseResult<Record<string, unknown>>>;

/**
 * Parse CSV async - returns CsvParseResult with RecordWithInfo when info: true (object mode).
 */
export function parseCsvAsync(
  input: CsvAsyncInput,
  options: CsvParseObjectOptions & { info: true }
): Promise<CsvParseResult<RecordWithInfo<Record<string, unknown>>>>;

/**
 * Parse CSV async - general overload for backward compatibility.
 */
export function parseCsvAsync(
  input: CsvAsyncInput,
  options: CsvParseOptions
): Promise<
  | string[][]
  | CsvParseResult<Record<string, string>>
  | CsvParseResult<Record<string, unknown>>
  | CsvParseResult<RecordWithInfo<Record<string, unknown>>>
  | CsvParseResult<RecordWithInfo<string[]>>
>;

/**
 * Parse CSV asynchronously (implementation).
 */
export async function parseCsvAsync(
  input: CsvAsyncInput,
  options: CsvParseOptions = {}
): Promise<
  | string[][]
  | CsvParseResult<Record<string, string>>
  | CsvParseResult<Record<string, unknown>>
  | CsvParseResult<RecordWithInfo<Record<string, unknown>>>
  | CsvParseResult<RecordWithInfo<string[]>>
> {
  // If input is a string, use sync parser directly
  if (typeof input === "string") {
    return parseCsv(input, options);
  }

  const asyncInput = normalizeAsyncInput(input);
  const { content } = await collectText(asyncInput, options.encoding);
  return parseCsv(content, options);
}

/**
 * Parse CSV as an async generator, yielding rows as they are parsed.
 * This is the true streaming version that yields rows one at a time.
 *
 * @example
 * ```ts
 * // Process large file row by row
 * for await (const row of parseCsvRows(fileStream, { headers: true })) {
 *   console.log(row);
 * }
 *
 * // With validation
 * for await (const row of parseCsvRows(input, {
 *   headers: true,
 *   validate: (row) => row.id !== ""
 * })) {
 *   // Only valid rows
 * }
 * ```
 */
export async function* parseCsvRows(
  input: CsvAsyncInput,
  options: CsvParseOptions = {}
): AsyncGenerator<ParsedRow, void, unknown> {
  // objname produces a map output in the sync parser, which cannot be produced
  // in a true streaming fashion. Fall back to buffered parsing.
  if (options.objname) {
    let content: string;
    try {
      content =
        typeof input === "string"
          ? input
          : (await collectText(normalizeAsyncInput(input), options.encoding)).content;
    } catch (error) {
      throw new CsvError("Failed to read input for objname parsing", { cause: error });
    }

    let result: ReturnType<typeof parseCsv>;
    try {
      result = parseCsv(content, options);
    } catch (error) {
      throw new CsvError("Failed to parse CSV with objname option", { cause: error });
    }

    if (Array.isArray(result)) {
      for (const row of result) {
        yield row;
      }
      return;
    }

    const rowsValue = (result as CsvParseResult<Record<string, unknown>>).rows;
    if (Array.isArray(rowsValue)) {
      for (const row of rowsValue) {
        yield row;
      }
      return;
    }

    if (rowsValue && typeof rowsValue === "object") {
      for (const row of Object.values(rowsValue)) {
        yield row as ParsedRow;
      }
    }
    return;
  }

  const parser = new CsvParserStream(options);

  type StreamEvent =
    | { type: "data"; value: ParsedRow }
    | { type: "end" }
    | { type: "error"; error: unknown };

  const queue: StreamEvent[] = [];
  let pendingResolve: ((ev: StreamEvent) => void) | null = null;
  let ended = false;
  let streamError: unknown = null;
  let aborted = false;
  let paused = false;

  const pushEvent = (ev: StreamEvent): void => {
    if (pendingResolve) {
      const resolve = pendingResolve;
      pendingResolve = null;
      resolve(ev);
      return;
    }
    queue.push(ev);
  };

  // A `data` listener puts the parser in flowing mode, so without this the parser would read
  // the whole input into `queue` no matter how slowly the consumer of this generator pulls.
  // Pausing hands that backpressure through to the writer loop below, which already waits for
  // `drain`.
  const applyBackpressure = (): void => {
    if (!paused && queue.length >= ROW_QUEUE_HIGH_WATER_MARK) {
      paused = true;
      parser.pause();
    }
  };

  const releaseBackpressure = (): void => {
    if (paused && queue.length <= ROW_QUEUE_LOW_WATER_MARK) {
      paused = false;
      parser.resume();
    }
  };

  const onData = (value: ParsedRow): void => {
    pushEvent({ type: "data", value });
    applyBackpressure();
  };
  const onEnd = (): void => {
    ended = true;
    pushEvent({ type: "end" });
  };
  const onError = (error: unknown): void => {
    streamError = error;
    pushEvent({ type: "error", error });
  };

  parser.on("data", onData);
  parser.once("end", onEnd);
  parser.once("error", onError);

  const writePromise = (async (): Promise<void> => {
    try {
      if (typeof input === "string") {
        parser.end(input);
        return;
      }

      const asyncInput = normalizeAsyncInput(input);

      for await (const chunk of asyncInput) {
        if (aborted) {
          break;
        }
        const canContinue = typeof chunk === "string" ? parser.write(chunk) : parser.write(chunk);
        if (!canContinue) {
          await new Promise<void>(resolve => parser.once("drain", resolve));
        }
      }

      if (!aborted) {
        parser.end();
      } else {
        parser.destroy();
      }
    } catch (e) {
      parser.destroy(e as Error);
    }
  })();

  try {
    while (true) {
      if (queue.length > 0) {
        const ev = queue.shift()!;
        releaseBackpressure();
        if (ev.type === "data") {
          yield ev.value;
          continue;
        }
        if (ev.type === "error") {
          throw toError(ev.error);
        }
        // end
        break;
      }

      if (streamError) {
        throw toError(streamError);
      }
      if (ended) {
        break;
      }

      const ev = await new Promise<StreamEvent>(resolve => {
        pendingResolve = resolve;
      });

      if (ev.type === "data") {
        yield ev.value;
      } else if (ev.type === "error") {
        throw toError(ev.error);
      } else {
        break;
      }
    }
  } finally {
    aborted = true;
    if (paused) {
      // Let the writer loop finish rather than leaving it blocked behind a paused parser.
      paused = false;
      parser.resume();
    }
    // Ensure stream stops as soon as possible.
    parser.destroy();
    // Release the writer if it is waiting for drain (destroy does not emit drain).
    parser.emit("drain");
    parser.off("data", onData);
    parser.off("end", onEnd);
    parser.off("error", onError);
    // Avoid unhandled rejections from the writer task.
    await writePromise.catch(() => undefined);
  }
}

/**
 * Parse CSV with progress callback for large files.
 *
 * @param input - CSV string or async iterable
 * @param options - Parse options
 * @param onProgress - Called periodically with progress info
 */
export async function parseCsvWithProgress(
  input: CsvAsyncInput,
  options: CsvParseOptions = {},
  onProgress?: (info: { rowsProcessed: number; bytesProcessed?: number }) => void
): Promise<
  | string[][]
  | CsvParseResult<Record<string, string>>
  | CsvParseResult<Record<string, unknown>>
  | CsvParseResult<RecordWithInfo<Record<string, unknown>>>
  | CsvParseResult<RecordWithInfo<string[]>>
> {
  // Collect input and track bytes
  let content: string;
  let totalBytes: number;

  if (typeof input === "string") {
    content = input;
    totalBytes = getUtf8ByteLength(content);
  } else {
    const asyncInput = normalizeAsyncInput(input);
    const result = await collectText(
      asyncInput,
      options.encoding,
      onProgress ? bytes => onProgress({ rowsProcessed: 0, bytesProcessed: bytes }) : undefined
    );
    content = result.content;
    totalBytes = result.totalBytes;
  }

  // Parse
  const result = parseCsv(content, options);

  // Report final progress
  if (onProgress) {
    let rowCount: number;
    if (Array.isArray(result)) {
      rowCount = result.length;
    } else if (typeof result.rows === "object" && !Array.isArray(result.rows)) {
      // objname mode: rows is a plain object
      rowCount = Object.keys(result.rows).length;
    } else if (Array.isArray(result.rows)) {
      rowCount = result.rows.length;
    } else {
      rowCount = 0;
    }
    onProgress({ rowsProcessed: rowCount, bytesProcessed: totalBytes });
  }

  return result;
}

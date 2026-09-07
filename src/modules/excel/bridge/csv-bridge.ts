/**
 * CSV ↔ Workbook bridge — free functions.
 *
 * These functions implement the CSV import/export capability as
 * tree-shakeable free functions that take a `Workbook` handle, instead of
 * methods on the `Workbook` class. A consumer who never imports this module
 * pays nothing for the CSV parser/formatter and the `@stream` pipeline they
 * pull in — the core `Workbook` no longer references `@csv` at all.
 *
 * Layer note: this file lives inside the excel module (layer 4), so it may
 * import from `@csv` (layer 2). The csv module never imports excel, so the
 * `readCsv(workbook, ...)` direction (which constructs worksheets) must live
 * here, not in the csv module.
 *
 * Node-only file-path variants (`readCsvFile` / `writeCsvFile`) live in
 * `./csv-bridge.node.ts`.
 */

import { formatCsv } from "@csv/format";
import { parseCsv } from "@csv/parse";
import { CsvParserStream, CsvFormatterStream } from "@csv/stream";
import type { CsvParseOptions, CsvFormatOptions, Row as CsvRow } from "@csv/types";
import type { DecimalSeparator } from "@csv/utils/number";
import { parseNumberFromCsv } from "@csv/utils/number";
import { rowHasValues, rowValues } from "@excel/core/row";
import type { RowData } from "@excel/core/row";
import { addWorksheet, getWorksheet } from "@excel/core/workbook";
import type { Workbook } from "@excel/core/workbook.browser";
import type { Worksheet } from "@excel/core/worksheet";
import { addRow, eachRow } from "@excel/core/worksheet";
import { ExcelDownloadError } from "@excel/errors";
import type { CellValue, CellErrorValue } from "@excel/types";
import { pipeline } from "@stream";
import type { IReadable, IWritable } from "@stream/types";
import { readableStreamToAsyncIterable } from "@stream/utils.base";
import type { DateFormat } from "@utils/datetime";
import { createDateParser, createDateFormatter, createIsoDateFormatter } from "@utils/datetime";

// =============================================================================
// Public CSV option / input types
// =============================================================================

export type CsvInput =
  | string // CSV string or URL (http:// or https://)
  | ArrayBuffer
  | Uint8Array
  | File // Browser File object
  | Blob // Browser Blob object
  | IReadable<Uint8Array | string>; // Readable stream

type CsvOptionsParseFields = Pick<
  CsvParseOptions,
  | "delimiter"
  | "quote"
  | "escape"
  | "delimitersToGuess"
  | "lineEnding"
  | "headers"
  | "skipEmptyLines"
  | "trim"
  | "ltrim"
  | "rtrim"
  | "comment"
  | "maxRows"
  | "toLine"
  | "skipLines"
  | "skipRows"
  | "columnMismatch"
  | "groupColumnsByName"
  | "relaxQuotes"
  | "fastMode"
  | "info"
  | "raw"
  | "skipRecordsWithError"
  | "skipRecordsWithEmptyValues"
  | "onSkip"
>;

type CsvOptionsFormatFields = Pick<
  CsvFormatOptions,
  | "lineEnding"
  | "decimalSeparator"
  | "quoteColumns"
  | "quoteHeaders"
  | "writeHeaders"
  | "escapeFormulae"
>;

interface CsvOptionsExtras {
  sheetName?: string;
  sheetId?: number;
  /**
   * Append mode - when true, data is appended to existing file.
   * Header row is automatically skipped in append mode.
   * @default false
   */
  append?: boolean;
  dateFormats?: readonly DateFormat[];
  dateFormat?: string;
  /**
   * Write dates as the calendar value they are, rather than against the host's local timezone.
   *
   * Defaults to local. Worth turning on when the CSV is meant to be diffed, fixtured or read by a human — a
   * date cell has no timezone, so local output renders `2020-01-15` as `2020-01-14T19:00:00.000-05:00` in New
   * York and gives different bytes on every machine.
   *
   * **Only set it if you control the reader too, or leave `dateFormat` unset.** A named `dateFormat` carries no
   * timezone marker, and the parsers for those forms build local time — so UTC output read back through them
   * loses a day. With no `dateFormat` the output is ISO with an offset and is unambiguous either way. See
   * `createDefaultWriteMapper`.
   */
  dateUTC?: boolean;
  map?(value: CellValue, index: number): CellValue;
  includeEmptyRows?: boolean;
  requestHeaders?: Record<string, string>;
  requestBody?: NonNullable<RequestInit["body"]>;
  withCredentials?: boolean;
  signal?: AbortSignal;
  encoding?: string;
  onProgress?: (loaded: number, total: number) => void;
  stream?: boolean;
  highWaterMark?: number;
}

/** Unified CSV options for both parsing and formatting. */
export interface CsvOptions
  extends CsvOptionsParseFields, CsvOptionsFormatFields, CsvOptionsExtras {}

// =============================================================================
// Constants
// =============================================================================

/**
 * The formats a CSV date column is tried against, when the caller names none.
 *
 * **The millisecond form is first because it is the one this bridge's own writer emits.** It was absent, and
 * the omission was invisible only because the parsers it fell through to did not check their input's width:
 * `2020-01-15T00:00:00.000Z` was matched by the *nineteen-character* `YYYY-MM-DD[T]HH:mm:ss` parser, which
 * consumed the prefix, ignored the `Z` and built the date in **local time**. A writer and a reader that cannot
 * agree on a format, held together by a parser being too permissive to notice.
 */
const DEFAULT_DATE_FORMATS: readonly DateFormat[] = [
  "YYYY-MM-DD[T]HH:mm:ss.SSSZ",
  "YYYY-MM-DD[T]HH:mm:ssZ",
  "YYYY-MM-DD[T]HH:mm:ss",
  "MM-DD-YYYY",
  "YYYY-MM-DD"
];

const SpecialValues: Record<string, boolean | CellErrorValue> = {
  true: true,
  false: false,
  "#N/A": { error: "#N/A" },
  "#REF!": { error: "#REF!" },
  "#NAME?": { error: "#NAME?" },
  "#DIV/0!": { error: "#DIV/0!" },
  "#NULL!": { error: "#NULL!" },
  "#VALUE!": { error: "#VALUE!" },
  "#NUM!": { error: "#NUM!" }
};

// =============================================================================
// Value mappers
// =============================================================================

function createDefaultValueMapper(
  dateFormats: readonly DateFormat[],
  options?: { decimalSeparator?: DecimalSeparator }
): (datum: CellValue) => CellValue {
  const dateParser = createDateParser(dateFormats);
  const decimalSeparator: DecimalSeparator = options?.decimalSeparator ?? ".";

  return function mapValue(datum: CellValue): CellValue {
    if (datum === "") {
      return null;
    }

    if (typeof datum === "string") {
      const datumNumber = parseNumberFromCsv(datum, decimalSeparator);
      if (!Number.isNaN(datumNumber) && datumNumber !== Infinity) {
        return datumNumber;
      }
    } else {
      const datumNumber = Number(datum);
      if (!Number.isNaN(datumNumber) && datumNumber !== Infinity) {
        return datumNumber;
      }
    }

    if (typeof datum === "string") {
      const date = dateParser.parse(datum);
      if (date) {
        return date;
      }

      const special = SpecialValues[datum];
      if (special !== undefined) {
        return special;
      }
    }

    return datum;
  };
}

/**
 * Map a cell value to what the CSV should carry.
 *
 * **`dateUTC` stays defaulted to local, and that is a decision rather than an oversight.** Writing the calendar
 * value would give a more faithful-looking file — a date cell has no timezone, so `2020-01-15` rendering as
 * `2020-01-14T19:00:00.000-05:00` in New York reads as the wrong day, and the same workbook produces different
 * bytes on every machine. But it cannot be the default here, because it is only safe for *self-describing*
 * output:
 *
 * - With no `dateFormat`, the value is written as ISO with an offset, so the instant is preserved and the
 *   reader recovers the cell exactly. The wart is presentational.
 * - With a `dateFormat` such as `"DD/MM/YYYY HH:mm:ss"`, the output carries **no timezone marker at all**, and
 *   the parsers that read those forms build local time (`new Date(y, m - 1, d, …)`). Writing UTC fields into a
 *   format that cannot say so, and reading them back as local, loses a day rather than merely displaying one.
 *
 * So the two halves have to agree, and local-for-local is the pairing that already holds. `dateUTC: true` opts
 * into calendar-value output for a caller who controls both ends — and is worth passing when the CSV is meant
 * to be diffed, fixtured, or read by a human.
 *
 * The genuine defect nearby was not this: `2020-01-15T00:00:00.000Z` used to be read a day early, because the
 * fixed-width parsers did not check their input's width and the millisecond form was missing from
 * {@link DEFAULT_DATE_FORMATS}. Both are fixed at the root, in `@utils/datetime` and above.
 */
function createDefaultWriteMapper(
  dateFormat?: string,
  dateUTC?: boolean
): (value: CellValue) => CellValue {
  const formatter = dateFormat
    ? createDateFormatter(dateFormat, { utc: dateUTC })
    : createIsoDateFormatter(dateUTC);

  return function mapValue(value: CellValue): CellValue {
    if (value === null || value === undefined) {
      return value;
    }
    if (value instanceof Date) {
      return formatter.format(value);
    }
    if (typeof value !== "object") {
      return value;
    }

    const maybeLink = value as { hyperlink?: unknown; text?: unknown };
    if (typeof maybeLink.hyperlink === "string" || typeof maybeLink.text === "string") {
      const url = typeof maybeLink.hyperlink === "string" ? maybeLink.hyperlink : "";
      const text = typeof maybeLink.text === "string" ? maybeLink.text : "";
      return url || text || "";
    }
    if ("formula" in value || "sharedFormula" in value) {
      return (value as { result?: CellValue }).result ?? "";
    }
    const richTextValue = value as { richText?: { text: string }[] };
    if ("richText" in value && Array.isArray(richTextValue.richText)) {
      return richTextValue.richText.map(r => r.text).join("");
    }
    const checkboxValue = value as { checkbox?: unknown };
    if ("checkbox" in value && typeof checkboxValue.checkbox === "boolean") {
      return checkboxValue.checkbox;
    }
    const errorValue = value as { error?: unknown };
    if ("error" in value && typeof errorValue.error === "string") {
      return errorValue.error;
    }
    return JSON.stringify(value);
  };
}

// =============================================================================
// Input detection
// =============================================================================

function isUrl(input: unknown): input is string {
  return typeof input === "string" && /^https?:\/\//i.test(input);
}

function isFile(input: unknown): input is File {
  return typeof File !== "undefined" && input instanceof File;
}

function isBlob(input: unknown): input is Blob {
  return typeof Blob !== "undefined" && input instanceof Blob && !isFile(input);
}

function isReadableStream(input: unknown): input is IReadable<Uint8Array | string> {
  if (!input || typeof input !== "object") {
    return false;
  }
  const obj = input as {
    [Symbol.asyncIterator]?: unknown;
    pipe?: unknown;
    on?: unknown;
  };
  return (
    typeof obj[Symbol.asyncIterator] === "function" ||
    (typeof obj.pipe === "function" && typeof obj.on === "function")
  );
}

// =============================================================================
// Stream helpers
// =============================================================================

function* iterateWorksheetRows(
  worksheet: Worksheet
): Generator<{ row: RowData; rowNumber: number }> {
  const rows = worksheet._rows;
  if (!rows || rows.length === 0) {
    return;
  }
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row && rowHasValues(row)) {
      yield { row, rowNumber: i + 1 };
    }
  }
}

// Structural shape of the CSV formatter's event API. The `any[]` is required
// for interop: `CsvFormatterStream extends Transform`, whose `once`/`off` carry
// Node's overloaded EventEmitter signatures; only `any[]` is assignable to that
// overload set here. `unknown[]`/`never[]` would reject the formatter.
function createDrainRacer(emitter: {
  once(event: string, listener: (...args: any[]) => void): void;
  off(event: string, listener: (...args: any[]) => void): void;
}): () => Promise<void> {
  return () =>
    new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        emitter.off("drain", onDrain);
        emitter.off("error", onError);
        emitter.off("close", onClose);
      };
      const onDrain = (): void => {
        cleanup();
        resolve();
      };
      const onError = (err: Error): void => {
        cleanup();
        reject(err);
      };
      const onClose = (): void => {
        cleanup();
        reject(new Error("stream closed before drain"));
      };
      emitter.once("drain", onDrain);
      emitter.once("error", onError);
      emitter.once("close", onClose);
    });
}

function buildParserOptions(options?: CsvOptions): Partial<CsvParseOptions> {
  return {
    delimiter: options?.delimiter ?? ",",
    quote: options?.quote,
    escape: options?.escape,
    delimitersToGuess: options?.delimitersToGuess,
    lineEnding: options?.lineEnding,
    headers: options?.headers,
    skipEmptyLines: options?.skipEmptyLines,
    trim: options?.trim,
    ltrim: options?.ltrim,
    rtrim: options?.rtrim,
    comment: options?.comment,
    maxRows: options?.maxRows,
    toLine: options?.toLine,
    skipLines: options?.skipLines,
    skipRows: options?.skipRows,
    columnMismatch: options?.columnMismatch,
    groupColumnsByName: options?.groupColumnsByName,
    relaxQuotes: options?.relaxQuotes,
    fastMode: options?.fastMode,
    info: options?.info,
    raw: options?.raw,
    skipRecordsWithError: options?.skipRecordsWithError,
    skipRecordsWithEmptyValues: options?.skipRecordsWithEmptyValues,
    onSkip: options?.onSkip
  };
}

function buildFormatterOptions(options?: CsvOptions) {
  return {
    delimiter: options?.delimiter ?? ",",
    quote: options?.quote,
    escape: options?.escape,
    lineEnding: options?.lineEnding,
    quoteColumns: options?.quoteColumns,
    quoteHeaders: options?.quoteHeaders,
    decimalSeparator: options?.decimalSeparator ?? ".",
    escapeFormulae: options?.escapeFormulae ?? true,
    writeHeaders: options?.writeHeaders
  };
}

// =============================================================================
// Read (cross-platform)
// =============================================================================

/** @internal — shared by read entry points and the Node file variant. */
export function readCsvContent(
  workbook: Workbook,
  content: string | ArrayBuffer | Uint8Array,
  options?: CsvOptions
): Worksheet {
  let str: string;
  if (typeof content === "string") {
    str = content;
  } else if (content instanceof ArrayBuffer || content instanceof Uint8Array) {
    str = new TextDecoder().decode(content);
  } else {
    str = String(content);
  }

  const worksheet = addWorksheet(workbook, options?.sheetName);
  const dateFormats = options?.dateFormats ?? DEFAULT_DATE_FORMATS;
  const decimalSeparator = options?.decimalSeparator;
  const map = options?.map || createDefaultValueMapper(dateFormats, { decimalSeparator });
  const result = parseCsv(str, buildParserOptions(options));

  if (Array.isArray(result)) {
    for (const row of result) {
      addRow(worksheet, row.map(map));
    }
  } else {
    if (result.headers) {
      addRow(worksheet, result.headers);
    }
    for (const rowObj of result.rows) {
      const rowArray = result.headers!.map(h => rowObj[h]);
      addRow(worksheet, rowArray.map(map));
    }
  }

  return worksheet;
}

/** @internal — shared by stream read entry points and the Node file variant. */
export function readCsvStream(
  workbook: Workbook,
  stream: IReadable<Uint8Array | string> | AsyncIterable<Uint8Array | string>,
  options?: CsvOptions
): Promise<Worksheet> {
  const worksheet = addWorksheet(workbook, options?.sheetName);
  const dateFormats = options?.dateFormats ?? DEFAULT_DATE_FORMATS;
  const decimalSeparator = options?.decimalSeparator;
  const map = options?.map || createDefaultValueMapper(dateFormats, { decimalSeparator });
  const parser = new CsvParserStream(buildParserOptions(options));
  const useHeaders = !!options?.headers;
  let headerRow: string[] | null = null;

  return new Promise((resolve, reject) => {
    if (useHeaders) {
      parser.on("headers", (headers: string[]) => {
        headerRow = headers;
        addRow(worksheet, headers);
      });
    }

    parser.on("data", (row: unknown) => {
      if (useHeaders && headerRow && row && typeof row === "object" && !Array.isArray(row)) {
        const rowObj = row as Record<string, CellValue>;
        const rowArray: CellValue[] = headerRow.map(h => rowObj[h]);
        addRow(worksheet, rowArray.map(map));
      } else if (Array.isArray(row)) {
        addRow(worksheet, (row as CellValue[]).map(map));
      }
    });

    // `stream` may be a plain async-iterable (e.g. a Web ReadableStream
    // adapted via readableStreamToAsyncIterable); pipeline accepts it as a
    // source at runtime even though its type union lists concrete streams.
    pipeline(stream as IReadable<Uint8Array | string>, parser)
      .then(() => resolve(worksheet))
      .catch(reject);
  });
}

async function readCsvUrl(
  workbook: Workbook,
  url: string,
  options?: CsvOptions
): Promise<Worksheet> {
  const fetchOptions: RequestInit = {
    method: options?.requestBody ? "POST" : "GET",
    headers: options?.requestHeaders,
    body: options?.requestBody,
    credentials: options?.withCredentials ? "include" : "same-origin",
    signal: options?.signal
  };

  const response = await fetch(url, fetchOptions);
  if (!response.ok) {
    throw new ExcelDownloadError(url, response.status, response.statusText);
  }

  if (options?.stream && response.body) {
    const readable = readableStreamToAsyncIterable<Uint8Array>(response.body);
    return readCsvStream(workbook, readable, options);
  }

  const text = await response.text();
  return readCsvContent(workbook, text, options);
}

async function readCsvFileObject(
  workbook: Workbook,
  file: File,
  options?: CsvOptions
): Promise<Worksheet> {
  const LARGE_FILE_THRESHOLD = 10 * 1024 * 1024;
  if ((options?.stream || file.size > LARGE_FILE_THRESHOLD) && typeof file.stream === "function") {
    const readable = readableStreamToAsyncIterable<Uint8Array>(file.stream());
    return readCsvStream(workbook, readable, options);
  }

  return new Promise<Worksheet>((resolve, reject) => {
    const reader = new FileReader();
    const encoding = options?.encoding ?? "UTF-8";

    if (options?.onProgress) {
      reader.onprogress = event => {
        options.onProgress!(event.loaded, event.total || file.size);
      };
    }

    reader.onload = event => {
      try {
        const content = event.target?.result as string;
        resolve(readCsvContent(workbook, content, options));
      } catch (error) {
        reject(error);
      }
    };

    reader.onerror = () => reject(new Error(`Failed to read file: ${file.name}`));
    reader.readAsText(file, encoding);
  });
}

async function readCsvBlob(
  workbook: Workbook,
  blob: Blob,
  options?: CsvOptions
): Promise<Worksheet> {
  const text = await blob.text();
  return readCsvContent(workbook, text, options);
}

/**
 * Read CSV into a new worksheet on `workbook`. Accepts a CSV string, URL,
 * `ArrayBuffer`/`Uint8Array`, browser `File`/`Blob`, or a readable stream.
 *
 * @example
 * ```ts
 * import { readCsv } from "documonster/excel/csv";
 * await readCsv(workbook, "a,b,c\n1,2,3");
 * await readCsv(workbook, "https://example.com/data.csv");
 * await readCsv(workbook, input, { delimiter: ";", sheetName: "Data" });
 * ```
 */
export async function readCsv(
  workbook: Workbook,
  input: CsvInput,
  options?: CsvOptions
): Promise<Worksheet> {
  if (isUrl(input)) {
    return readCsvUrl(workbook, input, options);
  }
  if (isFile(input)) {
    return readCsvFileObject(workbook, input, options);
  }
  if (isBlob(input)) {
    return readCsvBlob(workbook, input, options);
  }
  if (isReadableStream(input)) {
    return readCsvStream(workbook, input, options);
  }
  return readCsvContent(workbook, input, options);
}

// =============================================================================
// Write (cross-platform)
// =============================================================================

/** @internal — shared by write entry points and the Node file variant. */
export function writeCsvString(workbook: Workbook, options?: CsvOptions): string {
  const worksheet = getWorksheet(workbook, options?.sheetName || options?.sheetId);
  if (!worksheet) {
    return "";
  }

  const map = options?.map || createDefaultWriteMapper(options?.dateFormat, options?.dateUTC);
  const includeEmptyRows = options?.includeEmptyRows !== false;
  const rows: CellValue[][] = [];
  let lastRow = 1;

  eachRow(worksheet, (row: RowData, rowNumber: number) => {
    if (includeEmptyRows) {
      while (lastRow++ < rowNumber - 1) {
        rows.push([]);
      }
    }
    const values = rowValues(row);
    values.shift();
    rows.push(values.map(map));
    lastRow = rowNumber;
  });

  return formatCsv(rows as CsvRow[], buildFormatterOptions(options));
}

/** @internal — shared by write entry points and the Node file variant. */
export async function writeCsvStream(
  workbook: Workbook,
  stream: IWritable<Uint8Array | string>,
  options?: CsvOptions
): Promise<void> {
  const worksheet = getWorksheet(workbook, options?.sheetName || options?.sheetId);
  if (!worksheet) {
    stream.end();
    return;
  }

  const map = options?.map || createDefaultWriteMapper(options?.dateFormat, options?.dateUTC);
  const includeEmptyRows = options?.includeEmptyRows !== false;
  const formatter = new CsvFormatterStream(buildFormatterOptions(options));
  const pipelinePromise = pipeline(formatter, stream);

  const awaitFormatterDrain = createDrainRacer(formatter);

  const writeAndDrain = async (values: CellValue[]): Promise<void> => {
    if (!formatter.write(values as CsvRow)) {
      await awaitFormatterDrain();
    }
  };

  try {
    let lastRow = 1;
    for (const { row, rowNumber } of iterateWorksheetRows(worksheet)) {
      const dataValues = rowValues(row).slice(1).map(map);

      if (includeEmptyRows) {
        while (lastRow++ < rowNumber - 1) {
          await writeAndDrain([]);
        }
      }
      await writeAndDrain(dataValues);
      lastRow = rowNumber;
    }

    formatter.end();
    await pipelinePromise;
  } catch (err) {
    formatter.destroy(err instanceof Error ? err : new Error(String(err)));
    await pipelinePromise.catch(() => {});
    throw err;
  }
}

/**
 * Write a worksheet to CSV. Returns a string, or writes to a provided
 * writable stream.
 *
 * @example
 * ```ts
 * const csv = writeCsv(workbook);
 * await writeCsv(workbook, outputStream, { sheetId: 1 });
 * ```
 */
export function writeCsv(workbook: Workbook, options?: CsvOptions): string;
export function writeCsv(
  workbook: Workbook,
  stream: IWritable<Uint8Array | string>,
  options?: CsvOptions
): Promise<void>;
export function writeCsv(
  workbook: Workbook,
  streamOrOptions?: IWritable<Uint8Array | string> | CsvOptions,
  options?: CsvOptions
): string | Promise<void> {
  if (streamOrOptions && typeof (streamOrOptions as { write?: unknown }).write === "function") {
    return writeCsvStream(workbook, streamOrOptions as IWritable<Uint8Array | string>, options);
  }
  return writeCsvString(workbook, streamOrOptions as CsvOptions | undefined);
}

/** Write a worksheet to a CSV buffer (`Uint8Array`). */
export async function writeCsvBuffer(
  workbook: Workbook,
  options?: CsvOptions
): Promise<Uint8Array> {
  return new TextEncoder().encode(writeCsvString(workbook, options));
}

// =============================================================================
// Streaming surfaces
// =============================================================================

/**
 * Create a readable stream that outputs the worksheet as CSV.
 *
 * This is a **byte stream**: chunks are `Uint8Array` (a `Buffer` on Node) and
 * `objectMode` is off on the readable side, so it can be piped or handed
 * straight to anything that consumes bytes — `stream.pipeline()` into a file,
 * an HTTP response, an SDK upload body, `Readable.toWeb()`, `Buffer.concat`.
 *
 * It used to emit `string` chunks from an object-mode readable side, which is
 * what a CSV *formatter* produces internally. That leaked an implementation
 * detail into a public API and made this stream indistinguishable by type from
 * `Workbook.toStream()` while behaving completely differently: every byte
 * consumer silently received strings instead. Use {@link writeCsv} when a
 * `string` is what you want.
 *
 * The return type is deliberately read-only. The concrete object is a
 * `CsvFormatterStream`, i.e. a `Transform`, but exposing that would put `write()`
 * / `end()` on a stream this function has already wired to a producer: a caller
 * who wrote a row would inject it into the output (or trip `write after end`,
 * depending on where the producer had got to). The Node entry re-narrows the
 * concrete stream to a nominal `stream.Readable`, which adds only read-side
 * members — see {@link createCsvByteStream}.
 */
export function createCsvReadStream(
  workbook: Workbook,
  options?: CsvOptions
): IReadable<Uint8Array> {
  return createCsvByteStream(workbook, options);
}

/**
 * The concrete stream behind {@link createCsvReadStream}.
 *
 * Exists so the Node entry can type its return as the platform's nominal
 * `stream.Readable` without an `as` assertion: on the Node build
 * `CsvFormatterStream extends Transform extends Readable`, so returning the
 * concrete type is enough for the compiler to check the narrowing itself.
 * Consumers get the read-only {@link createCsvReadStream} signature instead.
 *
 * @internal
 */
export function createCsvByteStream(workbook: Workbook, options?: CsvOptions): CsvFormatterStream {
  const worksheet = getWorksheet(workbook, options?.sheetName || options?.sheetId);
  const map = options?.map || createDefaultWriteMapper(options?.dateFormat, options?.dateUTC);
  const includeEmptyRows = options?.includeEmptyRows !== false;
  // Rows in, bytes out: the writable side stays object-mode so `write(row)`
  // keeps taking arrays, while the readable side encodes the CSV text it pushes.
  const formatter = new CsvFormatterStream({
    ...buildFormatterOptions(options),
    readableObjectMode: false
  });

  if (!worksheet) {
    setTimeout(() => formatter.end(), 0);
    return formatter;
  }

  const awaitFormatterDrain = createDrainRacer(formatter);

  const writeAndDrain = (values: CellValue[]): Promise<void> | void => {
    if (formatter.write(values as CsvRow)) {
      return;
    }
    return awaitFormatterDrain();
  };

  (async () => {
    try {
      let lastRow = 1;
      for (const { row, rowNumber } of iterateWorksheetRows(worksheet)) {
        if (formatter.destroyed) {
          return;
        }
        const dataValues = rowValues(row).slice(1).map(map);

        if (includeEmptyRows) {
          while (lastRow++ < rowNumber - 1) {
            const p = writeAndDrain([]);
            if (p) {
              await p;
            }
            if (formatter.destroyed) {
              return;
            }
          }
        }
        const p = writeAndDrain(dataValues);
        if (p) {
          await p;
        }
        lastRow = rowNumber;
      }
      formatter.end();
    } catch (err) {
      formatter.destroy(err instanceof Error ? err : new Error(String(err)));
    }
  })();

  return formatter;
}

/** Create a writable stream that parses CSV into a new worksheet. */
export function createCsvWriteStream(
  workbook: Workbook,
  options?: CsvOptions
): IWritable<Uint8Array | string> {
  const worksheet = addWorksheet(workbook, options?.sheetName);
  const dateFormats = options?.dateFormats ?? DEFAULT_DATE_FORMATS;
  const decimalSeparator = options?.decimalSeparator;
  const map = options?.map || createDefaultValueMapper(dateFormats, { decimalSeparator });
  const parser = new CsvParserStream(buildParserOptions(options));
  const useHeaders = !!options?.headers;
  let headerRow: string[] | null = null;

  if (useHeaders) {
    parser.on("headers", (headers: string[]) => {
      headerRow = headers;
      addRow(worksheet, headers);
    });
  }

  parser.on("data", (row: unknown) => {
    if (useHeaders && headerRow && row && typeof row === "object" && !Array.isArray(row)) {
      const rowObj = row as Record<string, CellValue>;
      const rowArray: CellValue[] = headerRow.map(h => rowObj[h]);
      addRow(worksheet, rowArray.map(map));
    } else if (Array.isArray(row)) {
      addRow(worksheet, (row as CellValue[]).map(map));
    }
  });

  return parser;
}

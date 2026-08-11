// This file is typechecked by `pnpm type` but is NOT executed by Vitest.
//
// It pins the public shape of the workbook stream surface: `toStream` must hand
// back the platform's own readable byte stream (async-iterable, pipeline-
// compatible, and on Node a nominal `stream.Readable`), `toBuffer` must promise
// the `Buffer` it really returns, and `writeStream` must accept any duck-typed
// sink while returning a bare promise.

import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline as nodePipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

import { createCsvReadStream } from "@excel/bridge/csv.node";
import { Workbook } from "@excel/index";
import type { IReadable } from "@stream";
import { pipeline, Writable } from "@stream";

declare const wb: Workbook.Handle;

const options: Workbook.XlsxStreamOptions = { highWaterMark: 1024, zip: { level: 1 } };

const source: IReadable<Uint8Array> = Workbook.toStream(wb, options);
const narrowedSource: Workbook.XlsxReadable = Workbook.toStream(wb);

// Consumers must be able to pull without a cast.
const iterable: AsyncIterable<Uint8Array> = source;

const destination = new Writable({
  write(_chunk, _encoding, callback) {
    callback();
  }
});
const completed: Promise<void> = Workbook.writeStream(wb, destination);
const piped: Promise<void> = pipeline(Workbook.toStream(wb), destination);

// Node ecosystem interop must stay cast-free: `stream.pipeline` for sinks, and
// the nominal `stream.Readable` that SDK upload bodies / `Readable.toWeb()`
// demand — handed over directly, with no `Readable.from()` adapter and no
// `as unknown as Readable` bet on an implementation detail.
const nodePiped: Promise<void> = nodePipeline(
  Workbook.toStream(wb),
  createWriteStream("report.xlsx")
);
const nodeReadable: Readable = Workbook.toStream(wb);
// `toWeb` accepting the value without an adapter is the point here; the variable
// is annotated with Node's own web-stream type because that is what `toWeb`
// returns (it is not the DOM `ReadableStream`).
const webBody: NodeReadableStream = Readable.toWeb(Workbook.toStream(wb));

// The Node entry must promise the `Buffer` it actually returns, so callers never
// reach for a defensive (copying) `Buffer.from(...)`.
declare function wantsBuffer(b: Buffer): void;
export async function bufferSurface(): Promise<void> {
  const bytes: Buffer = await Workbook.toBuffer(wb);
  wantsBuffer(await Workbook.toBuffer(wb));
  void bytes;
}

// `createCsvReadStream` is a byte stream, like `toStream` — chunks must be bytes,
// and a `string` element type must not typecheck.
export async function csvIsBytes(): Promise<void> {
  const csv: IReadable<Uint8Array> = createCsvReadStream(wb);
  const nodeCsv: Readable = createCsvReadStream(wb);
  const webCsv: NodeReadableStream = Readable.toWeb(createCsvReadStream(wb));
  for await (const chunk of csv) {
    const bytes: Uint8Array = chunk;
    // @ts-expect-error a CSV chunk is bytes, never a string
    const notAString: string = chunk;
    void bytes;
    void notAString;
  }
  void nodeCsv;
  void webCsv;
}

// The stream is already wired to a producer, so the writable half of the
// underlying Transform must stay off the public type: writing to it would inject
// rows into the output.
export function csvIsReadOnly(): void {
  const csv = createCsvReadStream(wb);
  // @ts-expect-error a CSV read stream must not expose the formatter's `write`
  csv.write(["injected", "row"]);
  // @ts-expect-error a CSV read stream must not expose the formatter's `end`
  csv.end();
  // @ts-expect-error `_transform` is the Transform internals, not public API
  csv._transform(["x"], "utf8", () => {});
}

const duckDestination: Workbook.XlsxWritable = destination;

void narrowedSource;
void iterable;
void completed;
void piped;
void nodePiped;
void nodeReadable;
void webBody;
void duckDestination;

// This file is typechecked by `pnpm type` but is NOT executed by Vitest.
//
// It pins the public shape of the workbook stream surface: `toStream` must hand
// back a plain readable byte source (async-iterable, pipeline-compatible) and
// `writeStream` must accept any duck-typed sink while returning a bare promise.

import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline as nodePipeline } from "node:stream/promises";

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
// `Readable.from` for SDKs that insist on a nominal `stream.Readable`.
const nodePiped: Promise<void> = nodePipeline(
  Workbook.toStream(wb),
  createWriteStream("report.xlsx")
);
const nodeReadable: Readable = Readable.from(Workbook.toStream(wb));

const duckDestination: Workbook.XlsxWritable = destination;

void narrowedSource;
void iterable;
void completed;
void piped;
void nodePiped;
void nodeReadable;
void duckDestination;

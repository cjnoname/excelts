/** Cross-platform XLSB IO primitives used by the public `Xlsb` surface. */
import type { ArchiveSink } from "@archive/io/archive-sink";
import type { WorkbookData } from "@excel/core/workbook-core";
import {
  collectXlsbInput,
  pipeXlsb,
  readXlsb,
  streamXlsb,
  writeXlsbBytes,
  type XlsbReadOptions,
  type XlsbStreamOptions,
  type XlsbWriteOptions
} from "@excel/xlsb/package";
import { createReadableFromAsyncIterable } from "@stream";
import type { IReadable } from "@stream";

/** Portable readable byte stream returned by {@link toStream}. */
export type XlsbReadable = IReadable<Uint8Array>;
/** Portable writable archive sink accepted by {@link writeStream}. */
export type XlsbWritable = ArchiveSink;
/** Synchronous or asynchronous byte source accepted by {@link readStream}. */
export type XlsbInputStream = AsyncIterable<Uint8Array> | Iterable<Uint8Array>;

/** Serialize a workbook to XLSB bytes. */
export function toBuffer(workbook: WorkbookData, options?: XlsbWriteOptions): Promise<Uint8Array> {
  return writeXlsbBytes(workbook, options);
}

/** Read XLSB bytes into a workbook, mutating and returning `workbook`. */
export function read(
  workbook: WorkbookData,
  data: Uint8Array | ArrayBuffer | ArrayBufferView | string,
  options?: XlsbReadOptions
): Promise<WorkbookData> {
  return readXlsb(workbook, data, options);
}

/** Consume an XLSB byte source, then read it into `workbook`. */
export async function readStream(
  workbook: WorkbookData,
  stream: XlsbInputStream,
  options?: XlsbReadOptions
): Promise<WorkbookData> {
  return readXlsb(workbook, await collectXlsbInput(stream), options);
}

/** Write an XLSB package to an archive sink while respecting backpressure. */
export function writeStream(
  workbook: WorkbookData,
  stream: XlsbWritable,
  options?: XlsbWriteOptions
): Promise<void> {
  return pipeXlsb(workbook, stream, options);
}

/** Serialize a workbook into a pull-driven, cross-platform XLSB byte stream. */
export function toStream(workbook: WorkbookData, options: XlsbStreamOptions = {}): XlsbReadable {
  const { highWaterMark, ...writeOptions } = options;
  return createReadableFromAsyncIterable(streamXlsb(workbook, writeOptions), {
    highWaterMark,
    objectMode: false
  });
}

export type { XlsbReadOptions, XlsbStreamOptions, XlsbWriteOptions } from "@excel/xlsb/package";

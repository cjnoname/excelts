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

export type XlsbReadable = IReadable<Uint8Array>;
export type XlsbWritable = ArchiveSink;
export type XlsbInputStream = AsyncIterable<Uint8Array> | Iterable<Uint8Array>;

export function toBuffer(workbook: WorkbookData, options?: XlsbWriteOptions): Promise<Uint8Array> {
  return writeXlsbBytes(workbook, options);
}

export function read(
  workbook: WorkbookData,
  data: Uint8Array | ArrayBuffer | ArrayBufferView | string,
  options?: XlsbReadOptions
): Promise<WorkbookData> {
  return readXlsb(workbook, data, options);
}

export async function readStream(
  workbook: WorkbookData,
  stream: XlsbInputStream,
  options?: XlsbReadOptions
): Promise<WorkbookData> {
  return readXlsb(workbook, await collectXlsbInput(stream), options);
}

export function writeStream(
  workbook: WorkbookData,
  stream: XlsbWritable,
  options?: XlsbWriteOptions
): Promise<void> {
  return pipeXlsb(workbook, stream, options);
}

export function toStream(workbook: WorkbookData, options: XlsbStreamOptions = {}): XlsbReadable {
  const { highWaterMark, ...writeOptions } = options;
  return createReadableFromAsyncIterable(streamXlsb(workbook, writeOptions), {
    highWaterMark,
    objectMode: false
  });
}

export type { XlsbReadOptions, XlsbStreamOptions, XlsbWriteOptions } from "@excel/xlsb/package";

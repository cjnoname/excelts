import { readFile as readFileBytes, writeFile as writeFileBytes } from "node:fs/promises";
import type { Readable } from "node:stream";

import type { WorkbookData } from "@excel/core/workbook-core";
import {
  read,
  readStream,
  toStream as toPortableStream,
  writeStream,
  type XlsbInputStream,
  type XlsbReadable,
  type XlsbWritable
} from "@excel/core/xlsb-io.browser";
import { ExcelFileError } from "@excel/errors";
import {
  writeXlsbBytes,
  type XlsbReadOptions,
  type XlsbStreamOptions,
  type XlsbWriteOptions
} from "@excel/xlsb/package";

export async function toBuffer(
  workbook: WorkbookData,
  options?: XlsbWriteOptions
): Promise<Buffer> {
  const bytes = await writeXlsbBytes(workbook, options);
  return Buffer.isBuffer(bytes)
    ? bytes
    : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export function toStream(
  workbook: WorkbookData,
  options?: XlsbStreamOptions
): XlsbReadable & Readable {
  return toPortableStream(workbook, options) as XlsbReadable & Readable;
}

export async function readFile(
  workbook: WorkbookData,
  filename: string,
  options?: XlsbReadOptions
): Promise<WorkbookData> {
  try {
    return await read(workbook, await readFileBytes(filename), options);
  } catch (cause) {
    throw new ExcelFileError(filename, "read", undefined, { cause });
  }
}

export async function writeFile(
  workbook: WorkbookData,
  filename: string,
  options?: XlsbWriteOptions
): Promise<void> {
  try {
    await writeFileBytes(filename, await toBuffer(workbook, options));
  } catch (cause) {
    throw new ExcelFileError(filename, "write", undefined, { cause });
  }
}

export { read, readStream, writeStream };
export type {
  XlsbInputStream,
  XlsbReadable,
  XlsbWritable,
  XlsbReadOptions,
  XlsbStreamOptions,
  XlsbWriteOptions
};

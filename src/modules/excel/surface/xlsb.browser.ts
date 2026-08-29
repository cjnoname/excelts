/**
 * `Xlsb` namespace surface for browsers.
 *
 * Includes byte and cross-platform stream IO plus the XLSB-specific option types.
 */
export { read, readStream, toBuffer, toStream, writeStream } from "@excel/core/xlsb-io";
export type {
  XlsbInputStream,
  XlsbReadable,
  XlsbWritable,
  XlsbReadOptions,
  XlsbStreamOptions,
  XlsbWriteOptions
} from "@excel/core/xlsb-io";

/**
 * `Xlsb` namespace surface for Node.js.
 *
 * Includes byte, stream, and file-path IO plus the XLSB-specific option types.
 */
export {
  read,
  readFile,
  readStream,
  toBuffer,
  toStream,
  writeFile,
  writeStream
} from "@excel/core/xlsb-io";
export type {
  XlsbInputStream,
  XlsbReadable,
  XlsbWritable,
  XlsbReadOptions,
  XlsbStreamOptions,
  XlsbWriteOptions
} from "@excel/core/xlsb-io";

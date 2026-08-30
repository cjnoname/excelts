/**
 * ZIP-specific binary helpers.
 *
 * The little-endian scalar reader, writer and free functions live in
 * `@utils/binary` (Layer 0) because ZIP is not the only binary container in this
 * library — BIFF12 in `excel/` and CFB in `word/` need the same primitives, and
 * none of those modules may import each other. What stays here is the part that
 * is genuinely about ZIP: CP437 filename decoding, and the declarative
 * fixed-width header parser the unzip path is written against.
 */

import { decodeCp437 } from "@archive/core/text";
import {
  BinaryReader as LittleEndianReader,
  readUint16LE,
  readUint32LE,
  uint8ArrayToString as decodeUtf8
} from "@utils/binary";

export { readUint16LE, readUint32LE, writeUint16LE, writeUint32LE } from "@utils/binary";

/**
 * Little-endian reader with ZIP's two filename encodings.
 *
 * ZIP stores names as CP437 unless the general-purpose UTF-8 flag is set, so the
 * decode choice belongs to the caller reading the header, not to the reader.
 */
export class BinaryReader extends LittleEndianReader {
  constructor(data: Uint8Array, offset = 0, label = "zip stream") {
    super(data, offset, label);
  }

  readString(length: number, utf8 = true): string {
    const bytes = this.readBytes(length);
    return utf8 ? decodeUtf8(bytes) : decodeCp437(bytes);
  }
}

// =============================================================================
// Format-based parsing (legacy-style declarative parser)
// =============================================================================

/**
 * Parses sequential unsigned little endian numbers from the head of the passed buffer according to
 * the specified format passed. If the buffer is not large enough to satisfy the full format,
 * null values will be assigned to the remaining keys.
 * @param buffer The buffer to sequentially extract numbers from.
 * @param format Expected format to follow when extracting values from the buffer. A list of list entries
 * with the following structure:
 * [
 *   [
 *     <key>,  // Name of the key to assign the extracted number to.
 *     <size>  // The size in bytes of the number to extract. possible values are 1, 2, 4, 8.
 *   ],
 *   ...
 * ]
 * @returns An object with keys set to their associated extracted values.
 */
export function parseFormatted(
  buffer: Uint8Array,
  format: [string, number][]
): Record<string, number | null> {
  const result: Record<string, number | null> = {};
  let offset = 0;
  for (const [key, size] of format) {
    if (buffer.length >= offset + size) {
      switch (size) {
        case 1:
          result[key] = buffer[offset];
          break;
        case 2:
          result[key] = readUint16LE(buffer, offset);
          break;
        case 4:
          result[key] = readUint32LE(buffer, offset);
          break;
        case 8: {
          // Keep behavior (Number) while avoiding BigInt costs.
          const low = readUint32LE(buffer, offset);
          const high = readUint32LE(buffer, offset + 4);
          result[key] = high * 0x100000000 + low;
          break;
        }
        default:
          throw new Error("Unsupported UInt LE size!");
      }
    } else {
      result[key] = null;
    }
    offset += size;
  }
  return result;
}

export function parseFormattedTyped<T>(buffer: Uint8Array, format: [string, number][]): T {
  return parseFormatted(buffer, format) as T;
}

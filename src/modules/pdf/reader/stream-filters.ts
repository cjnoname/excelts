/**
 * PDF stream filter decoder chain.
 *
 * Decodes PDF stream data by applying the appropriate filter(s)
 * specified in the stream dictionary's /Filter entry.
 *
 * Supported filters:
 * - /FlateDecode (zlib/deflate compression)
 * - /ASCII85Decode (ASCII base-85 encoding)
 * - /ASCIIHexDecode (ASCII hexadecimal encoding)
 * - /LZWDecode (LZW compression)
 * - /RunLengthDecode (run-length encoding)
 *
 * @see PDF Reference 1.7, §3.3 - Filters
 */

import { unzlibSync } from "@archive/compression/compress";
import { inflateRaw } from "@archive/compression/deflate-fallback";
import { undoPngFilters } from "@pdf/core/png-filters";
import type { PdfDictValue } from "@pdf/reader/pdf-parser";
import { dictGetNumber, isPdfDict, isPdfArray } from "@pdf/reader/pdf-parser";

// =============================================================================
// Public API
// =============================================================================

/**
 * Decode stream data by applying the filter chain from the stream dictionary.
 */
export function decodeStreamFilters(data: Uint8Array, dict: PdfDictValue): Uint8Array {
  const filter = dict.get("Filter");
  if (filter === undefined || filter === null) {
    return data;
  }

  const decodeParms = dict.get("DecodeParms") ?? dict.get("DP");

  if (typeof filter === "string") {
    // Single filter
    const parms = isPdfDict(decodeParms) ? decodeParms : undefined;
    return applyFilter(data, filter, parms);
  }

  if (isPdfArray(filter)) {
    // Filter chain — apply in order
    let result = data;
    const parmsArray = isPdfArray(decodeParms) ? decodeParms : [];
    for (let i = 0; i < filter.length; i++) {
      const filterName = filter[i] as string;
      const parm = parmsArray[i];
      const parmDict = isPdfDict(parm) ? parm : undefined;
      result = applyFilter(result, filterName, parmDict);
    }
    return result;
  }

  return data;
}

// =============================================================================
// Filter Application
// =============================================================================

function applyFilter(data: Uint8Array, filterName: string, parms?: PdfDictValue): Uint8Array {
  switch (filterName) {
    case "FlateDecode":
    case "Fl":
      return decodeFlateDecode(data, parms);
    case "ASCII85Decode":
    case "A85":
      return decodeAscii85(data);
    case "ASCIIHexDecode":
    case "AHx":
      return decodeAsciiHex(data);
    case "LZWDecode":
    case "LZW":
      return decodeLzw(data, parms);
    case "RunLengthDecode":
    case "RL":
      return decodeRunLength(data);
    case "DCTDecode":
    case "DCT":
      // JPEG data — return as-is (used for image XObjects)
      return data;
    case "JPXDecode":
      // JPEG 2000 — return as-is
      return data;
    case "CCITTFaxDecode":
    case "CCF":
      // CCITT fax — return as-is (would need full CCITT decoder)
      return data;
    case "JBIG2Decode":
      // JBIG2 — return as-is
      return data;
    case "Crypt":
      // Handled by decryption layer — pass through
      return data;
    default:
      // Unknown filter — return as-is
      return data;
  }
}

// =============================================================================
// FlateDecode
// =============================================================================

function decodeFlateDecode(data: Uint8Array, parms?: PdfDictValue): Uint8Array {
  if (data.length === 0) {
    return data;
  }

  let decompressed: Uint8Array;
  try {
    // Try zlib (RFC 1950) first — has 2-byte header
    decompressed = unzlibSync(data);
  } catch {
    try {
      // Fall back to raw deflate
      decompressed = inflateRaw(data);
    } catch {
      // Last resort: return as-is
      return data;
    }
  }

  // Apply predictor if specified
  if (parms) {
    const predictor = dictGetNumber(parms, "Predictor") ?? 1;
    if (predictor > 1) {
      decompressed = undoPredictor(decompressed, parms);
    }
  }

  return decompressed;
}

/**
 * Undo PNG/TIFF predictors used in FlateDecode and LZWDecode streams.
 *
 * @see PDF Reference 1.7, Table 3.8
 */
function undoPredictor(data: Uint8Array, parms: PdfDictValue): Uint8Array {
  const predictor = dictGetNumber(parms, "Predictor") ?? 1;
  const columns = dictGetNumber(parms, "Columns") ?? 1;
  const colors = dictGetNumber(parms, "Colors") ?? 1;
  const bitsPerComponent = dictGetNumber(parms, "BitsPerComponent") ?? 8;

  if (predictor === 1) {
    return data; // No prediction
  }

  if (predictor === 2) {
    // TIFF predictor 2
    return undoTiffPredictor(data, columns, colors, bitsPerComponent);
  }

  if (predictor >= 10 && predictor <= 15) {
    // PNG predictors (10-15)
    return undoPngPredictor(data, columns, colors, bitsPerComponent);
  }

  return data;
}

/**
 * Undo TIFF Predictor 2 (horizontal differencing).
 */
function undoTiffPredictor(
  data: Uint8Array,
  columns: number,
  colors: number,
  bitsPerComponent: number
): Uint8Array {
  const bytesPerPixel = Math.ceil((colors * bitsPerComponent) / 8);
  const rowBytes = Math.ceil((columns * colors * bitsPerComponent) / 8);
  const rows = Math.floor(data.length / rowBytes);
  const result = new Uint8Array(data.length);

  for (let row = 0; row < rows; row++) {
    const rowStart = row * rowBytes;
    // First pixel is unmodified
    for (let i = 0; i < bytesPerPixel; i++) {
      result[rowStart + i] = data[rowStart + i];
    }
    // Subsequent pixels: add previous pixel
    for (let i = bytesPerPixel; i < rowBytes; i++) {
      result[rowStart + i] = (data[rowStart + i] + result[rowStart + i - bytesPerPixel]) & 0xff;
    }
  }

  return result;
}

/**
 * Undo PNG row filters.
 * Each row is preceded by a filter type byte.
 */
function undoPngPredictor(
  data: Uint8Array,
  columns: number,
  colors: number,
  bitsPerComponent: number
): Uint8Array {
  const bytesPerPixel = Math.max(1, Math.ceil((colors * bitsPerComponent) / 8));
  const rowBytes = Math.ceil((columns * colors * bitsPerComponent) / 8);
  const rows = Math.floor(data.length / (rowBytes + 1)); // +1 for the filter byte
  return undoPngFilters(data, rows, rowBytes, bytesPerPixel);
}

// =============================================================================
// ASCII85Decode
// =============================================================================

function decodeAscii85(data: Uint8Array): Uint8Array {
  const output: number[] = [];
  let i = 0;

  while (i < data.length) {
    const b = data[i];

    // Skip whitespace
    if (b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d || b === 0x0c) {
      i++;
      continue;
    }

    // End of data marker ~>
    if (b === 0x7e) {
      break;
    }

    // Special 'z' character = four zero bytes
    if (b === 0x7a) {
      output.push(0, 0, 0, 0);
      i++;
      continue;
    }

    // Decode 5-character group into 4 bytes
    const group: number[] = [];
    while (group.length < 5 && i < data.length) {
      const c = data[i];
      if (c === 0x7e) {
        break; // EOD
      }
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0x0c) {
        i++;
        continue;
      }
      if (c < 0x21 || c > 0x75) {
        i++;
        continue; // Invalid — skip
      }
      group.push(c - 0x21);
      i++;
    }

    if (group.length === 0) {
      break;
    }

    // Pad short final group with 'u' (84) values
    const numBytes = group.length - 1;
    while (group.length < 5) {
      group.push(84);
    }

    const value =
      group[0] * 85 * 85 * 85 * 85 +
      group[1] * 85 * 85 * 85 +
      group[2] * 85 * 85 +
      group[3] * 85 +
      group[4];

    const bytes = [
      (value >>> 24) & 0xff,
      (value >>> 16) & 0xff,
      (value >>> 8) & 0xff,
      value & 0xff
    ];

    for (let j = 0; j < numBytes; j++) {
      output.push(bytes[j]);
    }
  }

  return new Uint8Array(output);
}

// =============================================================================
// ASCIIHexDecode
// =============================================================================

function decodeAsciiHex(data: Uint8Array): Uint8Array {
  const output: number[] = [];
  let highNibble = -1;

  for (let i = 0; i < data.length; i++) {
    const b = data[i];

    // End of data marker >
    if (b === 0x3e) {
      break;
    }

    // Skip whitespace
    if (b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d || b === 0x0c) {
      continue;
    }

    let val: number;
    if (b >= 0x30 && b <= 0x39) {
      val = b - 0x30;
    } else if (b >= 0x41 && b <= 0x46) {
      val = b - 0x41 + 10;
    } else if (b >= 0x61 && b <= 0x66) {
      val = b - 0x61 + 10;
    } else {
      continue;
    }

    if (highNibble < 0) {
      highNibble = val;
    } else {
      output.push((highNibble << 4) | val);
      highNibble = -1;
    }
  }

  // Odd digit — pad with 0
  if (highNibble >= 0) {
    output.push(highNibble << 4);
  }

  return new Uint8Array(output);
}

// =============================================================================
// LZWDecode
// =============================================================================

function decodeLzw(data: Uint8Array, parms?: PdfDictValue): Uint8Array {
  const earlyChange = parms ? (dictGetNumber(parms, "EarlyChange") ?? 1) : 1;
  const output: number[] = [];

  // LZW bit reader
  let bitPos = 0;

  function readBits(n: number): number {
    let result = 0;
    for (let i = 0; i < n; i++) {
      const byteIdx = (bitPos + i) >> 3;
      const bitIdx = 7 - ((bitPos + i) & 7); // MSB first
      if (byteIdx < data.length) {
        result = (result << 1) | ((data[byteIdx] >> bitIdx) & 1);
      }
    }
    bitPos += n;
    return result;
  }

  const CLEAR_TABLE = 256;
  const EOD = 257;
  let codeSize = 9;
  let nextCode = 258;
  let table: Uint8Array[] = [];

  // Initialize table
  function resetTable(): void {
    table = [];
    for (let i = 0; i < 256; i++) {
      table[i] = new Uint8Array([i]);
    }
    table[CLEAR_TABLE] = new Uint8Array(0);
    table[EOD] = new Uint8Array(0);
    nextCode = 258;
    codeSize = 9;
  }

  resetTable();

  let prevEntry: Uint8Array | null = null;

  while (bitPos < data.length * 8) {
    const code = readBits(codeSize);

    if (code === EOD) {
      break;
    }

    if (code === CLEAR_TABLE) {
      resetTable();
      prevEntry = null;
      continue;
    }

    let entry: Uint8Array;
    if (code < nextCode && table[code]) {
      entry = table[code];
    } else if (code === nextCode && prevEntry) {
      // Special case: code not in table yet
      entry = new Uint8Array(prevEntry.length + 1);
      entry.set(prevEntry);
      entry[prevEntry.length] = prevEntry[0];
    } else {
      // Invalid code — bail
      break;
    }

    for (let i = 0; i < entry.length; i++) {
      output.push(entry[i]);
    }

    // Add new entry to table
    if (prevEntry !== null) {
      const newEntry = new Uint8Array(prevEntry.length + 1);
      newEntry.set(prevEntry);
      newEntry[prevEntry.length] = entry[0];
      table[nextCode] = newEntry;
      nextCode++;

      // Increase code size
      const threshold = earlyChange ? nextCode : nextCode + 1;
      if (threshold >= 1 << codeSize && codeSize < 12) {
        codeSize++;
      }
    }

    prevEntry = entry;
  }

  let result: Uint8Array = new Uint8Array(output);

  // Apply predictor if specified
  if (parms) {
    const predictor = dictGetNumber(parms, "Predictor") ?? 1;
    if (predictor > 1) {
      result = undoPredictor(result, parms);
    }
  }

  return result;
}

// =============================================================================
// RunLengthDecode
// =============================================================================

function decodeRunLength(data: Uint8Array): Uint8Array {
  const output: number[] = [];
  let i = 0;

  while (i < data.length) {
    const length = data[i];
    i++;

    if (length === 128) {
      // EOD
      break;
    }

    if (length < 128) {
      // Copy (length + 1) literal bytes
      const count = length + 1;
      for (let j = 0; j < count && i < data.length; j++) {
        output.push(data[i]);
        i++;
      }
    } else {
      // Repeat next byte (257 - length) times
      const count = 257 - length;
      if (i < data.length) {
        const byte = data[i];
        i++;
        for (let j = 0; j < count; j++) {
          output.push(byte);
        }
      }
    }
  }

  return new Uint8Array(output);
}

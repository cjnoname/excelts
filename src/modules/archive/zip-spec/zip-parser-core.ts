/**
 * Shared ZIP parsing primitives.
 *
 * This module contains pure functions for parsing EOCD, ZIP64 EOCD, and Central Directory.
 * Used by both `ZipParser` (in-memory) and `RemoteZipReader` (random-access).
 */

import { ArchiveError, EocdNotFoundError } from "@archive/core/errors";
import type { ZipStringEncoding, ZipStringCodec } from "@archive/core/text";
import { decodeZipPath, decodeZipComment, resolveZipStringCodec } from "@archive/core/text";
import type { AesKeyStrength } from "@archive/crypto/aes";
import { BinaryReader } from "@archive/zip-spec/binary";
import { resolveZipLastModifiedDateFromUnixSeconds } from "@archive/zip-spec/timestamps";
import type { ZipEntryRecord, ZipEntryEncryptionMethod } from "@archive/zip-spec/zip-entry-info";
import { parseZipExtraFields } from "@archive/zip-spec/zip-extra-fields";
import {
  CENTRAL_DIR_HEADER_SIG,
  COMPRESSION_AES,
  UINT16_MAX,
  UINT32_MAX,
  ZIP64_END_OF_CENTRAL_DIR_LOCATOR_SIG,
  ZIP64_END_OF_CENTRAL_DIR_SIG,
  ZIP_OS_MSDOS,
  getUnixModeFromExternalAttributes,
  isSymlinkMode,
  isDirectoryMode
} from "@archive/zip-spec/zip-records";
import { uint8ArrayToString as decodeUtf8 } from "@utils/binary";
// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * Convert a BigInt to Number, throwing if the value exceeds Number.MAX_SAFE_INTEGER.
 * This prevents silent precision loss when parsing ZIP64 fields.
 */
function safeBigIntToNumber(value: bigint, fieldName: string): number {
  if (value > MAX_SAFE) {
    throw new ArchiveError(
      `ZIP64 ${fieldName} value ${value} exceeds Number.MAX_SAFE_INTEGER. ` +
        "The archive may be corrupted or malicious."
    );
  }
  return Number(value);
}

/** Minimum EOCD size (22 bytes fixed + 0-byte comment) */
export const EOCD_MIN_SIZE = 22;

/** Maximum comment size (2^16 - 1) */
export const EOCD_MAX_COMMENT_SIZE = 65535;

/** Maximum bytes to search for EOCD signature */
export const EOCD_MAX_SEARCH_SIZE = EOCD_MIN_SIZE + EOCD_MAX_COMMENT_SIZE;

/** ZIP64 EOCD Locator size */
export const ZIP64_EOCD_LOCATOR_SIZE = 20;

function resolveDecoder(
  options: CentralDirectoryParseOptions
): Pick<ZipStringCodec, "decode"> | undefined {
  return options.encoding ? resolveZipStringCodec(options.encoding) : undefined;
}

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/**
 * Parsed End of Central Directory (EOCD) information.
 */
export interface EOCDInfo {
  diskNumber: number;
  centralDirDisk: number;
  entriesOnDisk: number;
  totalEntries: number;
  centralDirSize: number;
  centralDirOffset: number;
}

/**
 * Parsed ZIP64 End of Central Directory information.
 */
export interface ZIP64EOCDInfo {
  entriesOnDisk: bigint;
  totalEntries: bigint;
  centralDirSize: bigint;
  centralDirOffset: bigint;
}

/**
 * Combined EOCD parse result.
 */
export interface EOCDParseResult {
  eocd: EOCDInfo;
  zip64Eocd: ZIP64EOCDInfo | null;
  comment: string;
}

/**
 * Options for parsing Central Directory entries.
 */
export interface CentralDirectoryParseOptions {
  /** Whether to decode file names as UTF-8 (default: true) */
  decodeStrings?: boolean;

  /** Optional string encoding for legacy (non-UTF8) names/comments. */
  encoding?: ZipStringEncoding;
}

// -----------------------------------------------------------------------------
// EOCD Parsing
// -----------------------------------------------------------------------------

/**
 * Find EOCD signature by searching backwards in a buffer.
 *
 * @param data - Buffer to search (should be the tail of the ZIP file)
 * @param validate - If true, validates the EOCD by checking comment length matches remaining bytes
 * @returns Offset within the buffer, or -1 if not found
 */
export function findEOCDSignature(data: Uint8Array, validate = false): number {
  // Signature bytes (little-endian): 0x06054b50 -> 50 4b 05 06
  const b0 = 0x50;
  const b1 = 0x4b;
  const b2 = 0x05;
  const b3 = 0x06;

  for (let i = data.length - EOCD_MIN_SIZE; i >= 0; i--) {
    if (data[i] === b0 && data[i + 1] === b1 && data[i + 2] === b2 && data[i + 3] === b3) {
      if (validate) {
        // Verify by checking comment length
        const commentLen = data[i + 20]! | (data[i + 21]! << 8);
        const expectedEnd = i + EOCD_MIN_SIZE + commentLen;
        if (expectedEnd === data.length) {
          return i;
        }
      } else {
        return i;
      }
    }
  }
  return -1;
}

/**
 * Find ZIP64 EOCD Locator signature.
 *
 * @param data - Buffer containing the locator (should be 20 bytes before EOCD)
 * @param eocdOffset - Offset of EOCD within the buffer
 * @returns Offset within the buffer, or -1 if not found
 */
export function findZIP64EOCDLocator(data: Uint8Array, eocdOffset: number): number {
  const locatorOffset = eocdOffset - ZIP64_EOCD_LOCATOR_SIZE;
  if (locatorOffset < 0) {
    return -1;
  }

  // Signature bytes (little-endian): 0x07064b50 -> 50 4b 06 07
  if (
    data[locatorOffset] === 0x50 &&
    data[locatorOffset + 1] === 0x4b &&
    data[locatorOffset + 2] === 0x06 &&
    data[locatorOffset + 3] === 0x07
  ) {
    return locatorOffset;
  }

  return -1;
}

/**
 * Parse EOCD from a buffer at the given offset.
 *
 * @param data - Buffer containing EOCD
 * @param offset - Offset of EOCD within the buffer
 * @param decodeStrings - Whether to decode the comment as UTF-8
 * @returns Parsed EOCD info and comment
 */
export function parseEOCD(
  data: Uint8Array,
  offset: number,
  decodeStrings = true,
  decoder?: Pick<ZipStringCodec, "decode">
): { eocd: EOCDInfo; comment: string } {
  const reader = new BinaryReader(data, offset);

  reader.skip(4); // signature
  const diskNumber = reader.readUint16();
  const centralDirDisk = reader.readUint16();
  const entriesOnDisk = reader.readUint16();
  const totalEntries = reader.readUint16();
  const centralDirSize = reader.readUint32();
  const centralDirOffset = reader.readUint32();
  const commentLength = reader.readUint16();

  let comment = "";
  if (commentLength > 0) {
    const commentBytes = reader.readBytes(commentLength);
    if (decodeStrings) {
      comment = decoder ? decoder.decode(commentBytes) : decodeUtf8(commentBytes);
    }
  }

  return {
    eocd: {
      diskNumber,
      centralDirDisk,
      entriesOnDisk,
      totalEntries,
      centralDirSize,
      centralDirOffset
    },
    comment
  };
}

/**
 * Parse ZIP64 EOCD Locator and return the offset of ZIP64 EOCD.
 *
 * @param data - Buffer containing the locator
 * @param offset - Offset of locator within the buffer
 * @returns ZIP64 EOCD file offset, or -1 if invalid
 */
export function parseZIP64EOCDLocator(data: Uint8Array, offset: number): number {
  const reader = new BinaryReader(data, offset);
  const sig = reader.readUint32();

  if (sig !== ZIP64_END_OF_CENTRAL_DIR_LOCATOR_SIG) {
    return -1;
  }

  reader.skip(4); // disk number with ZIP64 EOCD
  return safeBigIntToNumber(reader.readBigUint64(), "EOCD locator offset");
}

/**
 * Parse ZIP64 EOCD.
 *
 * @param data - Buffer containing ZIP64 EOCD
 * @param offset - Offset within the buffer
 * @returns Parsed ZIP64 EOCD info, or null if invalid signature
 */
export function parseZIP64EOCD(data: Uint8Array, offset: number): ZIP64EOCDInfo | null {
  const reader = new BinaryReader(data, offset);
  const sig = reader.readUint32();

  if (sig !== ZIP64_END_OF_CENTRAL_DIR_SIG) {
    return null;
  }

  reader.skip(8); // size of ZIP64 EOCD record
  reader.skip(2); // version made by
  reader.skip(2); // version needed
  reader.skip(4); // disk number
  reader.skip(4); // disk with central dir

  const entriesOnDisk = reader.readBigUint64();
  const totalEntries = reader.readBigUint64();
  const centralDirSize = reader.readBigUint64();
  const centralDirOffset = reader.readBigUint64();

  return {
    entriesOnDisk,
    totalEntries,
    centralDirSize,
    centralDirOffset
  };
}

/**
 * Apply ZIP64 values to EOCD if standard values are maxed out.
 *
 * Mutates the provided `eocd` object.
 */
export function applyZIP64ToEOCD(eocd: EOCDInfo, zip64: ZIP64EOCDInfo): void {
  if (eocd.totalEntries === UINT16_MAX) {
    eocd.totalEntries = safeBigIntToNumber(zip64.totalEntries, "totalEntries");
  }
  if (eocd.entriesOnDisk === UINT16_MAX) {
    eocd.entriesOnDisk = safeBigIntToNumber(zip64.entriesOnDisk, "entriesOnDisk");
  }
  if (eocd.centralDirSize === UINT32_MAX) {
    eocd.centralDirSize = safeBigIntToNumber(zip64.centralDirSize, "centralDirSize");
  }
  if (eocd.centralDirOffset === UINT32_MAX) {
    eocd.centralDirOffset = safeBigIntToNumber(zip64.centralDirOffset, "centralDirOffset");
  }
}

// -----------------------------------------------------------------------------
// Central Directory Parsing
// -----------------------------------------------------------------------------

/**
 * Parse a single Central Directory entry from a BinaryReader.
 *
 * The reader should be positioned at the start of the entry (after signature validation).
 * After this call, the reader is positioned at the next entry (or end of CD).
 *
 * @param reader - BinaryReader positioned after the CD header signature
 * @param decodeStrings - Whether to decode strings as UTF-8
 * @returns Parsed entry info
 */
export function parseCentralDirectoryEntry(
  reader: BinaryReader,
  decodeStrings: boolean,
  decoder?: Pick<ZipStringCodec, "decode">
): ZipEntryRecord {
  const versionMadeBy = reader.readUint16();
  reader.skip(2); // version needed
  const flags = reader.readUint16();
  const compressionMethod = reader.readUint16();
  const lastModTime = reader.readUint16();
  const lastModDate = reader.readUint16();
  const crc32Value = reader.readUint32();
  let compressedSize = reader.readUint32();
  let uncompressedSize = reader.readUint32();
  const fileNameLength = reader.readUint16();
  const extraFieldLength = reader.readUint16();
  const commentLength = reader.readUint16();
  reader.skip(2); // disk number start
  reader.skip(2); // internal attributes
  const externalAttributes = reader.readUint32();
  let localHeaderOffset = reader.readUint32();

  // Read raw bytes first, we need them for CRC32 verification in Unicode extra fields
  const fileNameBytes = fileNameLength > 0 ? reader.readBytes(fileNameLength) : new Uint8Array(0);

  let extraFields = {} as ReturnType<typeof parseZipExtraFields>;
  let rawExtraField: Uint8Array = new Uint8Array(0);

  if (extraFieldLength > 0) {
    rawExtraField = reader.readBytes(extraFieldLength);
    const vars = {
      compressedSize,
      uncompressedSize,
      offsetToLocalFileHeader: localHeaderOffset
    };
    extraFields = parseZipExtraFields(rawExtraField, vars);

    compressedSize = vars.compressedSize;
    uncompressedSize = vars.uncompressedSize;
    localHeaderOffset = vars.offsetToLocalFileHeader ?? localHeaderOffset;
  }

  const commentBytes = commentLength > 0 ? reader.readBytes(commentLength) : new Uint8Array(0);

  // Decode fileName and comment using unified decoder
  // Handles: UTF-8 flag, Unicode extra fields (0x7075/0x6375), CP437 fallback
  const fileName = decodeStrings ? decodeZipPath(fileNameBytes, flags, extraFields, decoder) : "";
  const comment = decodeStrings ? decodeZipComment(commentBytes, flags, extraFields, decoder) : "";

  // Extract Unix mode from external attributes
  const mode = getUnixModeFromExternalAttributes(externalAttributes);
  const madeByOs = (versionMadeBy >> 8) & 0xff;

  // Determine entry type using helper functions
  const isSymlink = isSymlinkMode(mode);
  const isDirectory =
    isDirectoryMode(mode) ||
    (madeByOs === ZIP_OS_MSDOS && (externalAttributes & 0x10) !== 0) ||
    fileName.endsWith("/");
  const isEncrypted = (flags & 0x01) !== 0;

  // Map to ZipEntryType
  const type = isSymlink ? "symlink" : isDirectory ? "directory" : "file";

  const unixSecondsMtime = extraFields.mtimeUnixSeconds;
  const lastModified = resolveZipLastModifiedDateFromUnixSeconds(
    lastModDate,
    lastModTime,
    unixSecondsMtime
  );

  // Determine encryption method
  let encryptionMethod: ZipEntryEncryptionMethod = "none";
  let aesVersion: 1 | 2 | undefined;
  let aesKeyStrength: AesKeyStrength | undefined;
  let originalCompressionMethod: number | undefined;

  if (isEncrypted) {
    if (compressionMethod === COMPRESSION_AES && extraFields.aesInfo) {
      encryptionMethod = "aes";
      aesVersion = extraFields.aesInfo.version;
      aesKeyStrength = extraFields.aesInfo.keyStrength;
      originalCompressionMethod = extraFields.aesInfo.compressionMethod;
    } else {
      encryptionMethod = "zipcrypto";
    }
  }

  return {
    path: fileName,
    type,
    compressedSize,
    compressedSize64: extraFields.compressedSize64,
    uncompressedSize,
    uncompressedSize64: extraFields.uncompressedSize64,
    compressionMethod,
    crc32: crc32Value,
    lastModified,
    localHeaderOffset,
    localHeaderOffset64: extraFields.offsetToLocalFileHeader64,
    comment,
    externalAttributes,
    mode,
    versionMadeBy,
    extraField: rawExtraField,
    isEncrypted,
    encryptionMethod,
    aesVersion,
    aesKeyStrength,
    originalCompressionMethod,
    dosTime: lastModTime
  };
}

/**
 * Parse all Central Directory entries from a buffer.
 *
 * @param data - Buffer containing the entire Central Directory
 * @param totalEntries - Expected number of entries
 * @param options - Parse options
 * @returns Array of parsed entries
 */
export function parseCentralDirectory(
  data: Uint8Array,
  totalEntries: number,
  options: CentralDirectoryParseOptions = {}
): ZipEntryRecord[] {
  return parseCentralDirectoryAt(data, 0, totalEntries, options);
}

/**
 * Parse all Central Directory entries from a buffer starting at a specific offset.
 *
 * @param data - Buffer containing the Central Directory
 * @param offset - Offset within the buffer where CD starts
 * @param totalEntries - Expected number of entries
 * @param options - Parse options
 * @returns Array of parsed entries
 */
export function parseCentralDirectoryAt(
  data: Uint8Array,
  offset: number,
  totalEntries: number,
  options: CentralDirectoryParseOptions = {}
): ZipEntryRecord[] {
  const decodeStrings = options.decodeStrings ?? true;
  const decoder = resolveDecoder(options);

  if (totalEntries === 0) {
    return [];
  }

  const entries: ZipEntryRecord[] = new Array(totalEntries);
  const reader = new BinaryReader(data, offset);

  for (let i = 0; i < totalEntries; i++) {
    const sig = reader.readUint32();
    if (sig !== CENTRAL_DIR_HEADER_SIG) {
      throw new ArchiveError(`Invalid Central Directory header signature at entry ${i}`);
    }

    entries[i] = parseCentralDirectoryEntry(reader, decodeStrings, decoder);
  }

  return entries;
}

// -----------------------------------------------------------------------------
// Combined In-Memory Parsing
// -----------------------------------------------------------------------------

/**
 * Parse a complete ZIP archive from an in-memory buffer.
 *
 * This is a convenience function that handles EOCD + ZIP64 + Central Directory parsing.
 *
 * @param data - Complete ZIP file buffer
 * @param options - Parse options
 * @returns Parsed entries and archive comment
 */
export function parseZipArchiveFromBuffer(
  data: Uint8Array,
  options: CentralDirectoryParseOptions = {}
): { entries: ZipEntryRecord[]; comment: string } {
  const decodeStrings = options.decodeStrings ?? true;
  const decoder = resolveDecoder(options);

  // Find EOCD
  const eocdOffset = findEOCDSignature(data);
  if (eocdOffset === -1) {
    throw new EocdNotFoundError();
  }

  // Parse EOCD
  const { eocd, comment } = parseEOCD(data, eocdOffset, decodeStrings, decoder);

  // Check for ZIP64
  const zip64LocatorOffset = findZIP64EOCDLocator(data, eocdOffset);
  if (zip64LocatorOffset !== -1) {
    const zip64EocdOffset = parseZIP64EOCDLocator(data, zip64LocatorOffset);
    if (zip64EocdOffset >= 0) {
      const zip64Eocd = parseZIP64EOCD(data, zip64EocdOffset);
      if (zip64Eocd) {
        applyZIP64ToEOCD(eocd, zip64Eocd);
      }
    }
  }

  // Parse Central Directory - use offset directly, not subarray
  // This allows reading from a larger buffer without needing exact sizing
  const entries = parseCentralDirectoryAt(data, eocd.centralDirOffset, eocd.totalEntries, options);

  return { entries, comment };
}

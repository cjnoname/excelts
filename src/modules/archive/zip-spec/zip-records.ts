/**
 * ZIP record builders (PKWARE APPNOTE)
 *
 * Shared by streaming zip writer and buffer zip builder.
 */

import { EMPTY_UINT8ARRAY } from "@archive/core/bytes";
import { concatUint8Arrays } from "@utils/binary";

// =============================================================================
// ZIP64 mode type
// =============================================================================

/**
 * Shared ZIP64 mode type.
 *
 * - "auto": write ZIP64 only when required by ZIP limits.
 * - true: force ZIP64 structures.
 * - false: forbid ZIP64; throw if required.
 */
export type Zip64Mode = boolean | "auto";

// =============================================================================
// ZIP format constants (PKWARE APPNOTE)
// =============================================================================

// Signatures
export const LOCAL_FILE_HEADER_SIG = 0x04034b50;
export const CENTRAL_DIR_HEADER_SIG = 0x02014b50;
export const END_OF_CENTRAL_DIR_SIG = 0x06054b50;
export const DATA_DESCRIPTOR_SIG = 0x08074b50;

export const ZIP64_END_OF_CENTRAL_DIR_SIG = 0x06064b50;
export const ZIP64_END_OF_CENTRAL_DIR_LOCATOR_SIG = 0x07064b50;

// Versions
export const VERSION_NEEDED = 20; // 2.0 - supports DEFLATE
export const VERSION_MADE_BY = 20; // 2.0
export const VERSION_ZIP64 = 45; // 4.5 - supports ZIP64

// Compression methods
export const COMPRESSION_STORE = 0;
export const COMPRESSION_DEFLATE = 8;
export const COMPRESSION_AES = 99;

// General purpose bit flags
export const FLAG_ENCRYPTED = 0x0001;
export const FLAG_UTF8 = 0x0800;
export const FLAG_DATA_DESCRIPTOR = 0x0008;

// =============================================================================
// Unix file type constants (from stat.h)
// =============================================================================

/** Unix file type mask */
export const S_IFMT = 0o170000;
/** Unix symbolic link type */
export const S_IFLNK = 0o120000;
/** Unix directory type */
export const S_IFDIR = 0o040000;
/** Unix regular file type */
export const S_IFREG = 0o100000;

// ZIP "version made by" OS codes
/** MS-DOS / Windows OS code */
export const ZIP_OS_MSDOS = 0;
/** Unix OS code */
export const ZIP_OS_UNIX = 3;

// =============================================================================
// Unix mode helpers
// =============================================================================

/**
 * Extract Unix mode from ZIP external attributes.
 * Returns 0 if no Unix mode information is available.
 */
export function getUnixModeFromExternalAttributes(externalAttributes: number): number {
  return (externalAttributes >> 16) & 0xffff;
}

/**
 * Get the OS code from versionMadeBy field.
 */
export function getOsFromVersionMadeBy(versionMadeBy: number | undefined): number {
  return versionMadeBy !== undefined ? (versionMadeBy >> 8) & 0xff : ZIP_OS_MSDOS;
}

/**
 * Check if Unix mode indicates a symbolic link.
 */
export function isSymlinkMode(mode: number): boolean {
  return (mode & S_IFMT) === S_IFLNK;
}

/**
 * Check if Unix mode indicates a directory.
 */
export function isDirectoryMode(mode: number): boolean {
  return (mode & S_IFMT) === S_IFDIR;
}

// ZIP64 / sentinel sizes
export const UINT16_MAX = 0xffff;
export const UINT32_MAX = 0xffffffff;

export const ZIP_LOCAL_FILE_HEADER_FIXED_SIZE = 30;
export const ZIP_CENTRAL_DIR_HEADER_FIXED_SIZE = 46;
export const ZIP_END_OF_CENTRAL_DIR_FIXED_SIZE = 22;

export const ZIP64_END_OF_CENTRAL_DIR_FIXED_SIZE = 56;
export const ZIP64_END_OF_CENTRAL_DIR_LOCATOR_FIXED_SIZE = 20;

export const ZIP64_EXTRA_FIELD_ID = 0x0001;

export interface ZipLocalFileHeaderInput {
  fileName: Uint8Array;
  extraField: Uint8Array;
  flags: number;
  compressionMethod: number;
  dosTime: number;
  dosDate: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  versionNeeded?: number;
}

export function writeLocalFileHeaderInto(
  out: Uint8Array,
  view: DataView,
  offset: number,
  input: ZipLocalFileHeaderInput
): number {
  const versionNeeded = input.versionNeeded ?? VERSION_NEEDED;

  view.setUint32(offset + 0, LOCAL_FILE_HEADER_SIG, true);
  view.setUint16(offset + 4, versionNeeded, true);
  view.setUint16(offset + 6, input.flags, true);
  view.setUint16(offset + 8, input.compressionMethod, true);
  view.setUint16(offset + 10, input.dosTime, true);
  view.setUint16(offset + 12, input.dosDate, true);
  view.setUint32(offset + 14, input.crc32, true);
  view.setUint32(offset + 18, input.compressedSize, true);
  view.setUint32(offset + 22, input.uncompressedSize, true);
  view.setUint16(offset + 26, input.fileName.length, true);
  view.setUint16(offset + 28, input.extraField.length, true);

  out.set(input.fileName, offset + ZIP_LOCAL_FILE_HEADER_FIXED_SIZE);
  if (input.extraField.length > 0) {
    out.set(input.extraField, offset + ZIP_LOCAL_FILE_HEADER_FIXED_SIZE + input.fileName.length);
  }

  return ZIP_LOCAL_FILE_HEADER_FIXED_SIZE + input.fileName.length + input.extraField.length;
}

export function buildLocalFileHeader(input: ZipLocalFileHeaderInput): Uint8Array {
  const header = new Uint8Array(
    ZIP_LOCAL_FILE_HEADER_FIXED_SIZE + input.fileName.length + input.extraField.length
  );
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  writeLocalFileHeaderInto(header, view, 0, input);
  return header;
}

export interface ZipCentralDirectoryHeaderInput {
  fileName: Uint8Array;
  extraField: Uint8Array;
  comment: Uint8Array;
  flags: number;
  compressionMethod: number;
  dosTime: number;
  dosDate: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  versionMadeBy?: number;
  versionNeeded?: number;
  externalAttributes?: number;
}

export function writeCentralDirectoryHeaderInto(
  out: Uint8Array,
  view: DataView,
  offset: number,
  input: ZipCentralDirectoryHeaderInput
): number {
  const versionMadeBy = input.versionMadeBy ?? VERSION_MADE_BY;
  const versionNeeded = input.versionNeeded ?? VERSION_NEEDED;
  const externalAttributes = input.externalAttributes ?? 0;

  view.setUint32(offset + 0, CENTRAL_DIR_HEADER_SIG, true);
  view.setUint16(offset + 4, versionMadeBy, true);
  view.setUint16(offset + 6, versionNeeded, true);
  view.setUint16(offset + 8, input.flags, true);
  view.setUint16(offset + 10, input.compressionMethod, true);
  view.setUint16(offset + 12, input.dosTime, true);
  view.setUint16(offset + 14, input.dosDate, true);
  view.setUint32(offset + 16, input.crc32, true);
  view.setUint32(offset + 20, input.compressedSize, true);
  view.setUint32(offset + 24, input.uncompressedSize, true);
  view.setUint16(offset + 28, input.fileName.length, true);
  view.setUint16(offset + 30, input.extraField.length, true);
  view.setUint16(offset + 32, input.comment.length, true);
  view.setUint16(offset + 34, 0, true); // disk number start
  view.setUint16(offset + 36, 0, true); // internal file attributes
  view.setUint32(offset + 38, externalAttributes, true);
  view.setUint32(offset + 42, input.localHeaderOffset, true);

  out.set(input.fileName, offset + ZIP_CENTRAL_DIR_HEADER_FIXED_SIZE);
  if (input.extraField.length > 0) {
    out.set(input.extraField, offset + ZIP_CENTRAL_DIR_HEADER_FIXED_SIZE + input.fileName.length);
  }
  if (input.comment.length > 0) {
    out.set(
      input.comment,
      offset + ZIP_CENTRAL_DIR_HEADER_FIXED_SIZE + input.fileName.length + input.extraField.length
    );
  }

  return (
    ZIP_CENTRAL_DIR_HEADER_FIXED_SIZE +
    input.fileName.length +
    input.extraField.length +
    input.comment.length
  );
}

export interface ZipEndOfCentralDirectoryInput {
  entryCount: number;
  centralDirSize: number;
  centralDirOffset: number;
  comment: Uint8Array;
}

export function writeEndOfCentralDirectoryInto(
  out: Uint8Array,
  view: DataView,
  offset: number,
  input: ZipEndOfCentralDirectoryInput
): number {
  view.setUint32(offset + 0, END_OF_CENTRAL_DIR_SIG, true);
  view.setUint16(offset + 4, 0, true);
  view.setUint16(offset + 6, 0, true);
  view.setUint16(offset + 8, input.entryCount, true);
  view.setUint16(offset + 10, input.entryCount, true);
  view.setUint32(offset + 12, input.centralDirSize, true);
  view.setUint32(offset + 16, input.centralDirOffset, true);
  view.setUint16(offset + 20, input.comment.length, true);

  if (input.comment.length > 0) {
    out.set(input.comment, offset + ZIP_END_OF_CENTRAL_DIR_FIXED_SIZE);
  }

  return ZIP_END_OF_CENTRAL_DIR_FIXED_SIZE + input.comment.length;
}

export function buildEndOfCentralDirectory(input: ZipEndOfCentralDirectoryInput): Uint8Array {
  const record = new Uint8Array(ZIP_END_OF_CENTRAL_DIR_FIXED_SIZE + input.comment.length);
  const view = new DataView(record.buffer, record.byteOffset, record.byteLength);
  writeEndOfCentralDirectoryInto(record, view, 0, input);
  return record;
}

export function buildDataDescriptor(
  crc32: number,
  compressedSize: number,
  uncompressedSize: number
) {
  const descriptor = new Uint8Array(16);
  const view = new DataView(descriptor.buffer);

  view.setUint32(0, DATA_DESCRIPTOR_SIG, true);
  view.setUint32(4, crc32, true);
  view.setUint32(8, compressedSize, true);
  view.setUint32(12, uncompressedSize, true);

  return descriptor;
}

function writeUint64LE(view: DataView, offset: number, value: number): void {
  // ZIP64 values fit within JS safe integer for our use cases (<= 2^53-1).
  const lo = value >>> 0;
  const hi = Math.floor(value / 0x100000000) >>> 0;
  view.setUint32(offset, lo, true);
  view.setUint32(offset + 4, hi, true);
}

export function buildDataDescriptorZip64(
  crc32: number,
  compressedSize: number,
  uncompressedSize: number
): Uint8Array {
  // Signature(4) + CRC32(4) + compressedSize(8) + uncompressedSize(8)
  const descriptor = new Uint8Array(24);
  const view = new DataView(descriptor.buffer, descriptor.byteOffset, descriptor.byteLength);

  view.setUint32(0, DATA_DESCRIPTOR_SIG, true);
  view.setUint32(4, crc32, true);
  writeUint64LE(view, 8, compressedSize);
  writeUint64LE(view, 16, uncompressedSize);

  return descriptor;
}

export function buildZip64ExtraField(input: {
  uncompressedSize?: number;
  compressedSize?: number;
  localHeaderOffset?: number;
  diskNumberStart?: number;
}): Uint8Array {
  const includeUncompressed = input.uncompressedSize !== undefined;
  const includeCompressed = input.compressedSize !== undefined;
  const includeOffset = input.localHeaderOffset !== undefined;
  const includeDisk = input.diskNumberStart !== undefined;

  let dataLen = 0;
  if (includeUncompressed) {
    dataLen += 8;
  }
  if (includeCompressed) {
    dataLen += 8;
  }
  if (includeOffset) {
    dataLen += 8;
  }
  if (includeDisk) {
    dataLen += 4;
  }

  if (dataLen === 0) {
    return EMPTY_UINT8ARRAY;
  }

  const out = new Uint8Array(4 + dataLen);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint16(0, ZIP64_EXTRA_FIELD_ID, true);
  view.setUint16(2, dataLen, true);

  let off = 4;
  if (includeUncompressed) {
    writeUint64LE(view, off, input.uncompressedSize!);
    off += 8;
  }
  if (includeCompressed) {
    writeUint64LE(view, off, input.compressedSize!);
    off += 8;
  }
  if (includeOffset) {
    writeUint64LE(view, off, input.localHeaderOffset!);
    off += 8;
  }
  if (includeDisk) {
    view.setUint32(off, input.diskNumberStart!, true);
  }

  return out;
}

export function concatExtraFields(a: Uint8Array, b: Uint8Array): Uint8Array {
  return concatUint8Arrays([a, b]);
}

export interface Zip64EndOfCentralDirectoryInput {
  versionMadeBy?: number;
  versionNeeded?: number;
  diskNumber?: number;
  centralDirectoryDiskNumber?: number;
  entryCountOnDisk: number;
  entryCountTotal: number;
  centralDirSize: number;
  centralDirOffset: number;
}

export function writeZip64EndOfCentralDirectoryInto(
  out: Uint8Array,
  view: DataView,
  offset: number,
  input: Zip64EndOfCentralDirectoryInput
): number {
  const versionMadeBy = input.versionMadeBy ?? VERSION_MADE_BY;
  const versionNeeded = input.versionNeeded ?? VERSION_ZIP64;
  const diskNumber = input.diskNumber ?? 0;
  const centralDirectoryDiskNumber = input.centralDirectoryDiskNumber ?? 0;

  view.setUint32(offset + 0, ZIP64_END_OF_CENTRAL_DIR_SIG, true);
  // Size of ZIP64 EOCD record (excluding signature + this 8-byte field)
  writeUint64LE(view, offset + 4, 44);
  view.setUint16(offset + 12, versionMadeBy, true);
  view.setUint16(offset + 14, versionNeeded, true);
  view.setUint32(offset + 16, diskNumber, true);
  view.setUint32(offset + 20, centralDirectoryDiskNumber, true);
  writeUint64LE(view, offset + 24, input.entryCountOnDisk);
  writeUint64LE(view, offset + 32, input.entryCountTotal);
  writeUint64LE(view, offset + 40, input.centralDirSize);
  writeUint64LE(view, offset + 48, input.centralDirOffset);

  return ZIP64_END_OF_CENTRAL_DIR_FIXED_SIZE;
}

export function buildZip64EndOfCentralDirectory(
  input: Zip64EndOfCentralDirectoryInput
): Uint8Array {
  const out = new Uint8Array(ZIP64_END_OF_CENTRAL_DIR_FIXED_SIZE);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  writeZip64EndOfCentralDirectoryInto(out, view, 0, input);

  return out;
}

export interface Zip64EndOfCentralDirectoryLocatorInput {
  zip64EndOfCentralDirectoryDiskNumber?: number;
  zip64EndOfCentralDirectoryOffset: number;
  totalDisks?: number;
}

export function writeZip64EndOfCentralDirectoryLocatorInto(
  out: Uint8Array,
  view: DataView,
  offset: number,
  input: Zip64EndOfCentralDirectoryLocatorInput
): number {
  const zip64EndOfCentralDirectoryDiskNumber = input.zip64EndOfCentralDirectoryDiskNumber ?? 0;
  const totalDisks = input.totalDisks ?? 1;

  view.setUint32(offset + 0, ZIP64_END_OF_CENTRAL_DIR_LOCATOR_SIG, true);
  view.setUint32(offset + 4, zip64EndOfCentralDirectoryDiskNumber, true);
  writeUint64LE(view, offset + 8, input.zip64EndOfCentralDirectoryOffset);
  view.setUint32(offset + 16, totalDisks, true);

  return ZIP64_END_OF_CENTRAL_DIR_LOCATOR_FIXED_SIZE;
}

export function buildZip64EndOfCentralDirectoryLocator(
  input: Zip64EndOfCentralDirectoryLocatorInput
): Uint8Array {
  const out = new Uint8Array(ZIP64_END_OF_CENTRAL_DIR_LOCATOR_FIXED_SIZE);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  writeZip64EndOfCentralDirectoryLocatorInto(out, view, 0, input);
  return out;
}

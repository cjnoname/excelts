import type { ZipStringEncoding } from "@archive/core/text";
import {
  parseFormattedTyped as parseBuffer,
  readUint32LE,
  writeUint32LE
} from "@archive/zip-spec/binary";
import {
  parseDosDateTimeUTC,
  resolveZipLastModifiedDateFromUnixSeconds
} from "@archive/zip-spec/timestamps";
import type { ZipExtraFields, ZipVars } from "@archive/zip-spec/zip-extra-fields";
import { parseZipExtraFields } from "@archive/zip-spec/zip-extra-fields";
import {
  CENTRAL_DIR_HEADER_SIG,
  DATA_DESCRIPTOR_SIG,
  END_OF_CENTRAL_DIR_SIG,
  FLAG_UTF8,
  LOCAL_FILE_HEADER_SIG,
  ZIP64_END_OF_CENTRAL_DIR_LOCATOR_SIG,
  ZIP64_END_OF_CENTRAL_DIR_SIG
} from "@archive/zip-spec/zip-records";

// Shared parseBuffer() formats
export const CRX_HEADER_FORMAT: [string, number][] = [
  ["version", 4],
  ["pubKeyLength", 4],
  ["signatureLength", 4]
];

export const LOCAL_FILE_HEADER_FORMAT: [string, number][] = [
  ["versionsNeededToExtract", 2],
  ["flags", 2],
  ["compressionMethod", 2],
  ["lastModifiedTime", 2],
  ["lastModifiedDate", 2],
  ["crc32", 4],
  ["compressedSize", 4],
  ["uncompressedSize", 4],
  ["fileNameLength", 2],
  ["extraFieldLength", 2]
];

export const DATA_DESCRIPTOR_FORMAT: [string, number][] = [
  ["dataDescriptorSignature", 4],
  ["crc32", 4],
  ["compressedSize", 4],
  ["uncompressedSize", 4]
];

export const CENTRAL_DIRECTORY_FILE_HEADER_FORMAT: [string, number][] = [
  ["versionMadeBy", 2],
  ["versionsNeededToExtract", 2],
  ["flags", 2],
  ["compressionMethod", 2],
  ["lastModifiedTime", 2],
  ["lastModifiedDate", 2],
  ["crc32", 4],
  ["compressedSize", 4],
  ["uncompressedSize", 4],
  ["fileNameLength", 2],
  ["extraFieldLength", 2],
  ["fileCommentLength", 2],
  ["diskNumber", 2],
  ["internalFileAttributes", 2],
  ["externalFileAttributes", 4],
  ["offsetToLocalFileHeader", 4]
];

export const END_OF_CENTRAL_DIRECTORY_FORMAT: [string, number][] = [
  ["diskNumber", 2],
  ["diskStart", 2],
  ["numberOfRecordsOnDisk", 2],
  ["numberOfRecords", 2],
  ["sizeOfCentralDirectory", 4],
  ["offsetToStartOfCentralDirectory", 4],
  ["commentLength", 2]
];

export const DATA_DESCRIPTOR_SIGNATURE_BYTES = writeUint32LE(DATA_DESCRIPTOR_SIG);

// Shared entry metadata helpers
export interface ZipEntryVarsMeta {
  flags: number | null;
  uncompressedSize: number;
  lastModifiedDate: number | null;
  lastModifiedTime: number | null;
}

export type { ZipVars, ZipExtraFields };

export interface ZipEntryPropsMeta {
  path: string;
  pathBuffer: Uint8Array;
  flags: {
    isUnicode: boolean;
  };
}

export interface CrxHeader {
  version: number | null;
  pubKeyLength: number | null;
  signatureLength: number | null;
  publicKey?: Uint8Array;
  signature?: Uint8Array;
}

export interface EntryVars {
  versionsNeededToExtract: number | null;
  flags: number | null;
  compressionMethod: number | null;
  lastModifiedTime: number | null;
  lastModifiedDate: number | null;
  crc32: number | null;
  compressedSize: number | null;
  uncompressedSize: number | null;
  fileNameLength: number | null;
  extraFieldLength: number | null;
  lastModifiedDateTime?: Date;
  crxHeader?: CrxHeader;
}

export interface EntryProps {
  path: string;
  pathBuffer: Uint8Array;
  flags: {
    isUnicode: boolean;
  };
}

export interface DataDescriptorVars {
  dataDescriptorSignature: number | null;
  crc32: number | null;
  compressedSize: number | null;
  uncompressedSize: number | null;
}

export function isZipUnicodeFlag(flags: number | null): boolean {
  return ((flags || 0) & FLAG_UTF8) !== 0;
}

export function isZipDirectoryPath(path: string): boolean {
  if (path.length === 0) {
    return false;
  }
  const last = path.charCodeAt(path.length - 1);
  // Check for '/' (47) or '\\' (92)
  return last === 47 || last === 92;
}

// Re-export from centralized location for backward compatibility
export {
  S_IFMT,
  S_IFLNK,
  S_IFDIR,
  ZIP_OS_MSDOS,
  getUnixModeFromExternalAttributes,
  getOsFromVersionMadeBy,
  isSymlinkMode,
  isDirectoryMode
} from "@archive/zip-spec/zip-records";

/**
 * Legacy entry type detection (without symlink support).
 *
 * Note: For full symlink detection, use buffer-based parsing via ZipParser
 * which reads the Central Directory and has access to externalAttributes.
 */
export function getZipEntryType(path: string, uncompressedSize: number): "Directory" | "File" {
  return uncompressedSize === 0 && isZipDirectoryPath(path) ? "Directory" : "File";
}

export function buildZipEntryProps(
  path: string,
  pathBuffer: Uint8Array,
  flags: number | null
): ZipEntryPropsMeta {
  return {
    path,
    pathBuffer,
    flags: {
      isUnicode: isZipUnicodeFlag(flags)
    }
  };
}

export function resolveZipEntryLastModifiedDateTime(
  vars: ZipEntryVarsMeta,
  extraFields: ZipExtraFields
): Date {
  const dosDate = vars.lastModifiedDate || 0;
  const dosTime = vars.lastModifiedTime || 0;

  const dosDateTime = parseDosDateTimeUTC(dosDate, dosTime);

  const unixSecondsMtime = extraFields.mtimeUnixSeconds;
  if (unixSecondsMtime === undefined) {
    return dosDateTime;
  }

  return resolveZipLastModifiedDateFromUnixSeconds(dosDate, dosTime, unixSecondsMtime);
}

export const parseExtraField = parseZipExtraFields;

export function hasDataDescriptorFlag(flags: number | null): boolean {
  return ((flags || 0) & 0x08) !== 0;
}

export function isFileSizeKnown(flags: number | null, compressedSize: number | null): boolean {
  return !hasDataDescriptorFlag(flags) || (compressedSize || 0) > 0;
}

export type PullFn = (length: number) => Promise<Uint8Array>;

export async function readCrxHeader(pull: PullFn): Promise<CrxHeader> {
  const data = await pull(12);
  const header =
    data.length >= 12 ? parseCrxHeaderFast(data) : parseBuffer<CrxHeader>(data, CRX_HEADER_FORMAT);
  const pubKeyLength = header.pubKeyLength || 0;
  const signatureLength = header.signatureLength || 0;

  const keyAndSig = await pull(pubKeyLength + signatureLength);
  header.publicKey = keyAndSig.subarray(0, pubKeyLength);
  header.signature = keyAndSig.subarray(pubKeyLength);
  return header;
}

export async function readLocalFileHeader(pull: PullFn): Promise<{
  vars: EntryVars;
  fileNameBuffer: Uint8Array;
  extraFieldData: Uint8Array;
}> {
  const data = await pull(26);
  const vars =
    data.length >= 26
      ? parseLocalFileHeaderVarsFast(data)
      : parseBuffer<EntryVars>(data, LOCAL_FILE_HEADER_FORMAT);
  const fileNameBuffer = await pull(vars.fileNameLength || 0);
  const extraFieldData = await pull(vars.extraFieldLength || 0);
  return { vars, fileNameBuffer, extraFieldData };
}

export async function readDataDescriptor(pull: PullFn): Promise<DataDescriptorVars> {
  const data = await pull(16);
  return data.length >= 16
    ? parseDataDescriptorVarsFast(data)
    : parseBuffer<DataDescriptorVars>(data, DATA_DESCRIPTOR_FORMAT);
}

export async function consumeCentralDirectoryFileHeader(pull: PullFn): Promise<void> {
  const data = await pull(42);
  const vars = parseBuffer<Record<string, number | null>>(
    data,
    CENTRAL_DIRECTORY_FILE_HEADER_FORMAT
  );
  await pull(vars.fileNameLength || 0);
  await pull(vars.extraFieldLength || 0);
  await pull(vars.fileCommentLength || 0);
}

export async function consumeEndOfCentralDirectoryRecord(pull: PullFn): Promise<void> {
  const data = await pull(18);
  const vars = parseBuffer<Record<string, number | null>>(data, END_OF_CENTRAL_DIRECTORY_FORMAT);
  await pull(vars.commentLength || 0);
}

// =============================================================================
// Validated Data Descriptor Scan (pure)
// =============================================================================

export function isValidZipRecordSignature(sig: number): boolean {
  switch (sig) {
    case LOCAL_FILE_HEADER_SIG:
    case CENTRAL_DIR_HEADER_SIG:
    case END_OF_CENTRAL_DIR_SIG:
    case ZIP64_END_OF_CENTRAL_DIR_SIG:
    case ZIP64_END_OF_CENTRAL_DIR_LOCATOR_SIG:
      return true;
    default:
      return false;
  }
}

function readUint16LEFromBytes(view: Uint8Array, offset: number): number {
  return (view[offset] | ((view[offset + 1] | 0) << 8)) >>> 0;
}

function parseCrxHeaderFast(data: Uint8Array): CrxHeader {
  return {
    version: readUint32LE(data, 0),
    pubKeyLength: readUint32LE(data, 4),
    signatureLength: readUint32LE(data, 8)
  };
}

function parseLocalFileHeaderVarsFast(data: Uint8Array): EntryVars {
  return {
    versionsNeededToExtract: readUint16LEFromBytes(data, 0),
    flags: readUint16LEFromBytes(data, 2),
    compressionMethod: readUint16LEFromBytes(data, 4),
    lastModifiedTime: readUint16LEFromBytes(data, 6),
    lastModifiedDate: readUint16LEFromBytes(data, 8),
    crc32: readUint32LE(data, 10),
    compressedSize: readUint32LE(data, 14),
    uncompressedSize: readUint32LE(data, 18),
    fileNameLength: readUint16LEFromBytes(data, 22),
    extraFieldLength: readUint16LEFromBytes(data, 24)
  };
}

function parseDataDescriptorVarsFast(data: Uint8Array): DataDescriptorVars {
  return {
    dataDescriptorSignature: readUint32LE(data, 0),
    crc32: readUint32LE(data, 4),
    compressedSize: readUint32LE(data, 8),
    uncompressedSize: readUint32LE(data, 12)
  };
}

export interface ValidatedDataDescriptorScanResult {
  /** Start index of the descriptor within `view`, or -1 when not found yet. */
  foundIndex: number;
  /** Where the caller should resume searching on the next scan of (a mostly unchanged) view. */
  nextSearchFrom: number;
}

// =============================================================================
// Shared Parse Loop (stream-agnostic)
// =============================================================================

export interface ParseOptions {
  verbose?: boolean;
  forceStream?: boolean;
  useWorkerInflate?: boolean;
  workerInflateUrl?: string;
  inputHighWaterMarkBytes?: number;
  inputLowWaterMarkBytes?: number;
  thresholdBytes?: number;
  /** Optional string encoding for legacy (non-UTF8) names. */
  encoding?: ZipStringEncoding;
}

export interface ParseDriverState {
  crxHeader?: CrxHeader;
  reachedCD?: boolean;
}

export interface ParseCoreIO {
  pull(length: number): Promise<Uint8Array>;
  pullUntil(pattern: Uint8Array, includeEof?: boolean): Promise<Uint8Array>;
  setDone(): void;
}

export interface ParseCoreEmitter {
  emitCrxHeader(header: CrxHeader): void;
  emitError(err: Error): void;
  emitClose(): void;
}

export type LocalFileRecordHandler<IO extends ParseCoreIO, Emitter extends ParseCoreEmitter> = (
  opts: ParseOptions,
  io: IO,
  emitter: Emitter,
  state: ParseDriverState
) => Promise<void>;

export const DEFAULT_PARSE_THRESHOLD_BYTES = 5 * 1024 * 1024;

const endDirectorySignature = writeUint32LE(END_OF_CENTRAL_DIR_SIG);

export async function runParseLoopCore<IO extends ParseCoreIO, Emitter extends ParseCoreEmitter>(
  opts: ParseOptions,
  io: IO,
  emitter: Emitter,
  state: ParseDriverState,
  onLocalFileRecord: LocalFileRecordHandler<IO, Emitter>
): Promise<void> {
  while (true) {
    const sigBytes = await io.pull(4);
    if (sigBytes.length === 0) {
      emitter.emitClose();
      return;
    }

    const signature = readUint32LE(sigBytes, 0);

    if (signature === 0x34327243) {
      state.crxHeader = await readCrxHeader(async length => io.pull(length));
      emitter.emitCrxHeader(state.crxHeader);
      continue;
    }

    if (signature === LOCAL_FILE_HEADER_SIG) {
      await onLocalFileRecord(opts, io, emitter, state);
      continue;
    }

    if (signature === CENTRAL_DIR_HEADER_SIG) {
      state.reachedCD = true;
      await consumeCentralDirectoryFileHeader(async length => io.pull(length));
      continue;
    }

    if (signature === END_OF_CENTRAL_DIR_SIG) {
      await consumeEndOfCentralDirectoryRecord(async length => io.pull(length));
      io.setDone();
      emitter.emitClose();
      return;
    }

    if (state.reachedCD) {
      const includeEof = true;
      await io.pullUntil(endDirectorySignature, includeEof);
      await consumeEndOfCentralDirectoryRecord(async length => io.pull(length));
      io.setDone();
      emitter.emitClose();
      return;
    }

    emitter.emitError(new Error("invalid signature: 0x" + signature.toString(16)));
    emitter.emitClose();
    return;
  }
}

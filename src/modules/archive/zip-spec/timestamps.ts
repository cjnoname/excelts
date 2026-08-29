import { ArchiveError } from "@archive/core/errors";
import { concatUint8Arrays } from "@utils/binary";

export const EXTENDED_TIMESTAMP_ID = 0x5455;
export const NTFS_TIMESTAMP_ID = 0x000a;

export interface ZipExtraTimestamps {
  /** Access time. */
  atime?: Date;
  /** Metadata change time (Unix ctime). */
  ctime?: Date;
  /** Creation time (Windows/NTFS "btime"). */
  birthTime?: Date;
}

function clampUint32(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value <= 0) {
    return 0;
  }
  // 0xFFFFFFFF fits JS safe integer.
  if (value >= 0xffffffff) {
    return 0xffffffff;
  }
  return value >>> 0;
}

function unixSecondsFromDate(date: Date): number {
  return clampUint32(Math.floor(date.getTime() / 1000));
}

function fileTimeFromDate(date: Date): bigint {
  if (typeof BigInt !== "function") {
    throw new ArchiveError("NTFS timestamps require BigInt support");
  }
  // Windows FILETIME: 100-nanosecond intervals since 1601-01-01 UTC.
  // JS Date is milliseconds since 1970-01-01 UTC.
  const unixMs = BigInt(date.getTime());
  const EPOCH_DIFF_100NS = 116444736000000000n; // 1601->1970 in 100ns
  return unixMs * 10000n + EPOCH_DIFF_100NS;
}

function buildExtendedTimestampExtraField(modTime: Date, extra?: ZipExtraTimestamps): Uint8Array {
  // Data: [flags:1][mtime?:4][atime?:4][ctime?:4]
  const includeAtime = extra?.atime !== undefined;
  const includeCtime = extra?.ctime !== undefined;

  let flags = 0x01;
  if (includeAtime) {
    flags |= 0x02;
  }
  if (includeCtime) {
    flags |= 0x04;
  }

  const payloadSize = 1 + 4 + (includeAtime ? 4 : 0) + (includeCtime ? 4 : 0);
  const out = new Uint8Array(4 + payloadSize);
  const view = new DataView(out.buffer);

  view.setUint16(0, EXTENDED_TIMESTAMP_ID, true);
  view.setUint16(2, payloadSize, true);
  out[4] = flags;
  view.setUint32(5, unixSecondsFromDate(modTime), true);

  let cursor = 9;
  if (includeAtime) {
    view.setUint32(cursor, unixSecondsFromDate(extra!.atime!), true);
    cursor += 4;
  }
  if (includeCtime) {
    view.setUint32(cursor, unixSecondsFromDate(extra!.ctime!), true);
  }

  return out;
}

function buildNtfsTimestampExtraField(modTime: Date, extra?: ZipExtraTimestamps): Uint8Array {
  if (typeof BigInt !== "function") {
    throw new ArchiveError("NTFS timestamps require BigInt support");
  }
  // NTFS extra field (0x000a)
  // Data:
  //   [reserved:4=0]
  //   [tag:2=0x0001][size:2=32]
  //   [mtime:8][atime:8][ctime:8][btime:8] (FILETIME)
  const atime = extra?.atime ?? modTime;
  const ctime = extra?.ctime ?? modTime;
  const btime = extra?.birthTime ?? modTime;

  const dataSize = 4 + 2 + 2 + 32;
  const out = new Uint8Array(4 + dataSize);
  const view = new DataView(out.buffer);

  view.setUint16(0, NTFS_TIMESTAMP_ID, true);
  view.setUint16(2, dataSize, true);

  // reserved
  view.setUint32(4, 0, true);

  // attribute tag 0x0001, size 32
  view.setUint16(8, 0x0001, true);
  view.setUint16(10, 32, true);

  let cursor = 12;
  view.setBigUint64(cursor, fileTimeFromDate(modTime), true);
  cursor += 8;
  view.setBigUint64(cursor, fileTimeFromDate(atime), true);
  cursor += 8;
  view.setBigUint64(cursor, fileTimeFromDate(ctime), true);
  cursor += 8;
  view.setBigUint64(cursor, fileTimeFromDate(btime), true);

  return out;
}

/**
 * DOS date/time helpers for ZIP files.
 */

/**
 * Convert Date to DOS time/date fields.
 *
 * Note: uses local time fields (getHours/getMinutes/getSeconds),
 * which matches common ZIP writer behavior.
 */
export function dateToDos(date: Date): [number, number] {
  const dosTime =
    ((date.getHours() & 0x1f) << 11) |
    ((date.getMinutes() & 0x3f) << 5) |
    ((date.getSeconds() >> 1) & 0x1f);

  const dosDate =
    (((date.getFullYear() - 1980) & 0x7f) << 9) |
    (((date.getMonth() + 1) & 0x0f) << 5) |
    (date.getDate() & 0x1f);

  return [dosTime, dosDate];
}

/**
 * Parse DOS date/time to JS Date.
 */
export function parseDosDateTimeUTC(date: number, time?: number): Date {
  const day = date & 0x1f;
  const month = (date >> 5) & 0x0f;
  const year = ((date >> 9) & 0x7f) + 1980;
  const seconds = time ? (time & 0x1f) * 2 : 0;
  const minutes = time ? (time >> 5) & 0x3f : 0;
  const hours = time ? time >> 11 : 0;

  return new Date(Date.UTC(year, month - 1, day, hours, minutes, seconds));
}

/**
 * How to write timestamps in ZIP headers.
 *
 * ZIP always has DOS date/time fields; `dos+utc` additionally writes the Info-ZIP
 * extended timestamp extra field (0x5455) for a UTC mtime.
 */
/**
 * - "dos": DOS date/time only
 * - "dos+utc": also writes Info-ZIP extended timestamp (0x5455) for UTC mtime (and optional atime/ctime)
 * - "dos+utc+ntfs": additionally writes NTFS timestamps (0x000a) including creation time
 */
export type ZipTimestampMode = "dos" | "dos+utc" | "dos+utc+ntfs";

export function resolveZipLastModifiedDateFromUnixSeconds(
  dosDate: number,
  dosTime: number,
  mtimeUnixSeconds?: number
): Date {
  if (mtimeUnixSeconds === undefined) {
    return parseDosDateTimeUTC(dosDate, dosTime);
  }
  return new Date(mtimeUnixSeconds * 1000);
}

export function buildZipTimestampExtraField(
  modTime: Date,
  mode: ZipTimestampMode,
  extra?: ZipExtraTimestamps
): Uint8Array {
  if (mode === "dos") {
    return new Uint8Array(0);
  }

  const parts: Uint8Array[] = [buildExtendedTimestampExtraField(modTime, extra)];
  if (mode === "dos+utc+ntfs") {
    parts.push(buildNtfsTimestampExtraField(modTime, extra));
  }
  return concatUint8Arrays(parts);
}

export function dateToZipDos(modTime: Date): { dosTime: number; dosDate: number } {
  const [dosTime, dosDate] = dateToDos(modTime);
  return { dosTime, dosDate };
}

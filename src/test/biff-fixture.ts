/**
 * Declarative BIFF12 fixtures.
 *
 * Tests for a binary format have to be written against literal bytes, or they only
 * prove the code agrees with itself. But a test written as `Uint8Array.of(0x00,
 * 0x0a, 0x00, ...)` is unreadable and unreviewable — nobody can tell whether the
 * bytes match the specification, which is the only thing that matters.
 *
 * So fixtures are declared by record name and field values, and this module
 * assembles the bytes through the same spec table the production code uses:
 *
 * ```ts
 * biff([
 *   ["BrtBeginSheet"],
 *   ["BrtWsDim", { ref: { firstRow: 0, lastRow: 2, firstColumn: 0, lastColumn: 3 } }],
 *   ["BrtBeginSheetData"],
 *   ["BrtRowHdr", { rw: 0, ixfe: 0, miyRw: 300, flags: 0 }],
 *   ["BrtCellIsst", { cell: { column: 0, styleIndex: 1 }, isst: 0 }],
 *   ["BrtEndSheetData"],
 *   ["BrtEndSheet"]
 * ]);
 * ```
 *
 * A misspelled record name or field throws, so a fixture cannot silently describe
 * something the format does not have. Output is deterministic, in the same spirit
 * as `buildPackage` in the OOXML validator fixtures.
 *
 * The corruption helpers exist because a validator is only worth having if its
 * negative cases are real. Hand-editing a byte offset in a test is fragile and
 * opaque; `truncate(bytes, { after: "BrtRowHdr" })` says what it is doing.
 */

import {
  encodeBiffRecord,
  encodeCell,
  encodeNullableWideString,
  encodeRange,
  encodeVarUInt,
  encodeWideString,
  iterateBiffRecords,
  type BiffCell,
  type BiffRange
} from "@excel/xlsb/binary";
import { requireRecordSpec, type BiffFieldType } from "@excel/xlsb/spec/records";
import { BinaryWriter, concatUint8Arrays } from "@utils/binary";

/** A field value, matching the type the spec declares for it. */
export type BiffFieldValue = number | string | undefined | BiffCell | BiffRange;

/**
 * One record in a fixture.
 *
 * `[name]` writes an empty payload, `[name, fields]` encodes the declared layout,
 * and `[name, bytes]` supplies the payload verbatim — needed for the records whose
 * layout the spec table does not describe, and for deliberately malformed cases.
 */
export type BiffRecordFixture =
  | readonly [name: string]
  | readonly [name: string, fields: Readonly<Record<string, BiffFieldValue>>]
  | readonly [name: string, payload: Uint8Array]
  // A bare numeric id, for a record the spec table has no name for. Needed to exercise the
  // reader's unknown-record path, which by definition cannot be reached with a named record.
  // Deliberately a separate arm rather than allowing a number where a name goes: a fixture that
  // could silently accept an unnamed record would stop guaranteeing that its records are real.
  | readonly [id: number, payload: Uint8Array];

/** Assemble a `.bin` part from a list of records. */
export function biff(records: readonly BiffRecordFixture[]): Uint8Array {
  const framed = records.map(record => {
    if (typeof record[0] === "number") {
      return encodeBiffRecord(record[0], record[1] as Uint8Array);
    }
    const spec = requireRecordSpec(record[0]);
    const payload =
      record.length === 1
        ? new Uint8Array(0)
        : record[1] instanceof Uint8Array
          ? record[1]
          : encodeFields(record[0], record[1] as Readonly<Record<string, BiffFieldValue>>);
    return encodeBiffRecord(spec.id, payload);
  });
  return concatUint8Arrays(
    framed,
    framed.reduce((total, chunk) => total + chunk.length, 0)
  );
}

function encodeFields(
  recordName: string,
  values: Readonly<Record<string, BiffFieldValue>>
): Uint8Array {
  const spec = requireRecordSpec(recordName);
  if (!spec.fields) {
    throw new Error(
      `${recordName} has no declared payload layout — supply the payload as bytes instead`
    );
  }

  const declared = new Set(spec.fields.map(field => field.name));
  for (const name of Object.keys(values)) {
    if (!declared.has(name)) {
      throw new Error(
        `${recordName} has no field ${name}; declared fields are ${[...declared].join(", ")}`
      );
    }
  }

  const chunks: Uint8Array[] = [];
  for (const field of spec.fields) {
    if (!(field.name in values)) {
      throw new Error(`${recordName}.${field.name} is missing from the fixture`);
    }
    chunks.push(encodeField(`${recordName}.${field.name}`, field.type, values[field.name]));
  }
  return concatUint8Arrays(
    chunks,
    chunks.reduce((total, chunk) => total + chunk.length, 0)
  );
}

function encodeField(where: string, type: BiffFieldType, value: BiffFieldValue): Uint8Array {
  const number = (): number => {
    if (typeof value !== "number") {
      throw new Error(`${where} expects a number, got ${typeof value}`);
    }
    return value;
  };
  switch (type) {
    case "u8":
      return new BinaryWriter().writeUint8(number()).toUint8Array();
    case "u16":
    case "i16":
      return new BinaryWriter().writeUint16(number()).toUint8Array();
    case "u32":
    case "rk":
      return new BinaryWriter().writeUint32(number()).toUint8Array();
    case "i32":
      return new BinaryWriter().writeInt32(number()).toUint8Array();
    case "f64":
      return new BinaryWriter().writeFloat64(number()).toUint8Array();
    case "wideString":
      if (typeof value !== "string") {
        throw new Error(`${where} expects a string, got ${typeof value}`);
      }
      return encodeWideString(value);
    case "nullableWideString":
      if (value !== undefined && typeof value !== "string") {
        throw new Error(`${where} expects a string or undefined, got ${typeof value}`);
      }
      return encodeNullableWideString(value);
    case "cell":
      assertShape(where, value, ["column", "styleIndex"]);
      return encodeCell(value as BiffCell);
    case "rfx":
      assertShape(where, value, ["firstRow", "lastRow", "firstColumn", "lastColumn"]);
      return encodeRange(value as BiffRange);
  }
}

function assertShape(where: string, value: BiffFieldValue, keys: readonly string[]): void {
  if (typeof value !== "object" || value === null) {
    throw new Error(`${where} expects an object with ${keys.join(", ")}`);
  }
  const record = value as unknown as Record<string, unknown>;
  for (const key of keys) {
    if (typeof record[key] !== "number") {
      throw new Error(`${where}.${key} must be a number`);
    }
  }
}

// =============================================================================
// Deliberate corruption
// =============================================================================

/** Locate a record by name, for the corruption helpers. */
function locate(
  bytes: Uint8Array,
  name: string
): { offset: number; headerLength: number; payloadLength: number } {
  const wanted = requireRecordSpec(name).id;
  for (const record of iterateBiffRecords(bytes, "fixture")) {
    if (record.id === wanted) {
      return {
        offset: record.offset,
        headerLength: record.payload.byteOffset - bytes.byteOffset - record.offset,
        payloadLength: record.payload.length
      };
    }
  }
  throw new Error(`fixture contains no ${name} record`);
}

/** Cut the stream immediately after a record, mid-part. */
export function truncateAfter(bytes: Uint8Array, name: string): Uint8Array {
  const found = locate(bytes, name);
  return bytes.slice(0, found.offset + found.headerLength + found.payloadLength);
}

/** Cut the stream *inside* a record's payload, so its declared length overruns. */
export function truncateInside(bytes: Uint8Array, name: string): Uint8Array {
  const found = locate(bytes, name);
  if (found.payloadLength === 0) {
    throw new Error(`${name} has an empty payload; there is nothing to truncate inside`);
  }
  return bytes.slice(0, found.offset + found.headerLength + found.payloadLength - 1);
}

/** Remove a record entirely — the way to unbalance a `Begin`/`End` pair. */
export function removeRecord(bytes: Uint8Array, name: string): Uint8Array {
  const found = locate(bytes, name);
  const end = found.offset + found.headerLength + found.payloadLength;
  return concatUint8Arrays([bytes.slice(0, found.offset), bytes.slice(end)]);
}

/** Overwrite a record's declared payload length, leaving the payload in place. */
export function overstateLength(bytes: Uint8Array, name: string, declared: number): Uint8Array {
  const found = locate(bytes, name);
  const spec = requireRecordSpec(name);
  const header = concatUint8Arrays([encodeVarUInt(spec.id, 2), encodeVarUInt(declared, 4)]);
  return concatUint8Arrays([
    bytes.slice(0, found.offset),
    header,
    bytes.slice(found.offset + found.headerLength)
  ]);
}

/** Append bytes that are not a valid record — a trailing-garbage case. */
export function appendGarbage(bytes: Uint8Array, garbage: Uint8Array): Uint8Array {
  return concatUint8Arrays([bytes, garbage]);
}

/** Replace one field's bytes in place, keeping the record's length. */
export function patchField(
  bytes: Uint8Array,
  name: string,
  field: string,
  value: BiffFieldValue
): Uint8Array {
  const spec = requireRecordSpec(name);
  if (!spec.fields) {
    throw new Error(`${name} has no declared payload layout`);
  }
  const index = spec.fields.findIndex(candidate => candidate.name === field);
  if (index === -1) {
    throw new Error(`${name} has no field ${field}`);
  }

  const found = locate(bytes, name);
  let fieldOffset = found.offset + found.headerLength;
  for (const earlier of spec.fields.slice(0, index)) {
    fieldOffset += encodeField(
      `${name}.${earlier.name}`,
      earlier.type,
      placeholderFor(earlier.type)
    ).length;
  }
  const replacement = encodeField(`${name}.${field}`, spec.fields[index]!.type, value);
  const out = bytes.slice();
  out.set(replacement, fieldOffset);
  return out;
}

/**
 * A value of the right *width* for a fixed-size field.
 *
 * `patchField` only needs to know how far to skip, and every field before a patch
 * target has to be fixed-width for that to be answerable — which the spec gate
 * already guarantees, since a variable-length field must come last.
 */
function placeholderFor(type: BiffFieldType): BiffFieldValue {
  switch (type) {
    case "cell":
      return { column: 0, styleIndex: 0 };
    case "rfx":
      return { firstRow: 0, lastRow: 0, firstColumn: 0, lastColumn: 0 };
    case "wideString":
    case "nullableWideString":
      throw new Error("cannot skip past a variable-length field");
    default:
      return 0;
  }
}

/**
 * A `BrtRowHdr` the length Excel writes.
 *
 * Twenty-five bytes: the four declared fields, then a byte, then a count of column spans and that
 * many `{first, last}` pairs. Fixtures used to hand-write the twelve-byte prefix, which is what the
 * writer used to emit — so every fixture agreed with the bug rather than with Excel. A helper means
 * there is one place that knows the length.
 */
export function rowHeader(options: {
  readonly row: number;
  readonly styleIndex?: number;
  readonly heightTwips?: number;
  readonly flags?: number;
  /** Inclusive column range the row's cells occupy. Defaults to `{0, 0}`. */
  readonly span?: { readonly first: number; readonly last: number };
}): Uint8Array {
  // Always one span, so the record is always the 25 bytes Excel writes. A "no spans" form is not
  // something the reference corpus contains, and a fixture in an unobserved shape would be testing
  // against this library's imagination rather than against Excel.
  return new BinaryWriter()
    .writeUint32(options.row)
    .writeUint32(options.styleIndex ?? 0)
    .writeUint16(options.heightTwips ?? 300)
    .writeUint16(options.flags ?? 0)
    .writeUint8(0)
    .writeUint32(1)
    .writeUint32(options.span?.first ?? 0)
    .writeUint32(options.span?.last ?? 0)
    .toUint8Array();
}

/**
 * Bytes from a hex string, for pasting a record verbatim out of a reference workbook.
 *
 * Shared because four test files had written their own, and a transcription helper is exactly the
 * place a subtle difference goes unnoticed — one that tolerated `0x` prefixes and one that did not
 * would silently disagree about the same paste.
 */
export function hexBytes(hex: string): Uint8Array {
  return new Uint8Array(
    hex
      .trim()
      .split(/\s+/)
      .map(pair => Number.parseInt(pair, 16))
  );
}

/** The inverse, for reporting what a codec produced next to what Excel wrote. */
export function toHex(value: Uint8Array): string {
  return [...value].map(byte => byte.toString(16).padStart(2, "0")).join(" ");
}

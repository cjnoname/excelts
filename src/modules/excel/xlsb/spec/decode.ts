/**
 * Spec-driven record decoding.
 *
 * Reads a record's payload according to the layout the table declares for it, and
 * hands back the fields by name. Every consumer that needs a field goes through
 * here.
 *
 * That indirection is the point. Before it existed, the disassembler, the coordinate
 * check and the index check each walked payloads with their own sequence of reads —
 * three implementations of the same offsets, none of which could be checked against
 * the table that was supposed to define them. A field's position is stated once, in
 * the table, and read once, here.
 *
 * ## Partial and broken payloads
 *
 * A payload shorter than its declared layout is a real condition, not an error to
 * throw on: the framing checker has already established the record is well-framed, so
 * a short payload is a fact about the record's *content* and callers want to describe
 * it rather than abort. Decoding therefore stops at the first field that does not fit,
 * records where it stopped, and returns what it has.
 */

import {
  decodeRk,
  readCell,
  readNullableWideString,
  readRange,
  readWideString,
  type BiffCell,
  type BiffRange,
  type BiffRecord
} from "@excel/xlsb/binary";
import { recordSpec, type BiffFieldSpec, type BiffRecordSpec } from "@excel/xlsb/spec/records";
import { BinaryReader } from "@utils/binary";

/** A decoded field value. */
export type BiffValue = number | string | undefined | BiffCell | BiffRange;

export interface DecodedRecord {
  readonly spec: BiffRecordSpec;
  /** Fields decoded, in declaration order. Absent when the layout is undeclared. */
  readonly fields: ReadonlyMap<string, BiffValue>;
  /** Bytes left after the declared layout — always reported, never dropped. */
  readonly trailingBytes: number;
  /** Name of the field the payload was too short for, when it was. */
  readonly truncatedAt?: string;
}

/**
 * Decode a record's payload.
 *
 * @returns `undefined` when the identifier is unknown or the layout is undeclared —
 *          two different kinds of "not decoded", both of which mean the caller must
 *          not pretend to know what the bytes say.
 */
export function decodeRecord(record: BiffRecord, context: string): DecodedRecord | undefined {
  const spec = recordSpec(record.id);
  if (!spec?.fields) {
    return undefined;
  }

  const reader = new BinaryReader(record.payload, 0, context);
  const fields = new Map<string, BiffValue>();
  for (const field of spec.fields) {
    let value: BiffValue;
    try {
      value = readField(reader, field, context);
    } catch {
      return { spec, fields, trailingBytes: 0, truncatedAt: field.name };
    }
    fields.set(field.name, value);
  }
  return { spec, fields, trailingBytes: reader.remaining };
}

function readField(reader: BinaryReader, field: BiffFieldSpec, context: string): BiffValue {
  switch (field.type) {
    case "u8":
      return reader.readUint8();
    case "u16":
      return reader.readUint16();
    case "u32":
      return reader.readUint32();
    case "i16":
      return reader.readInt16();
    case "i32":
      return reader.readInt32();
    case "f64":
      return reader.readFloat64();
    case "rk":
      return decodeRk(reader.readUint32());
    case "wideString":
      return readWideString(reader, context);
    case "nullableWideString":
      return readNullableWideString(reader, context);
    case "cell":
      return readCell(reader);
    case "rfx":
      return readRange(reader);
  }
}

/** A field as a number, or `undefined` when absent or of another type. */
export function numberField(decoded: DecodedRecord | undefined, name: string): number | undefined {
  const value = decoded?.fields.get(name);
  return typeof value === "number" ? value : undefined;
}

/** A field as a `Cell`, or `undefined`. */
export function cellField(decoded: DecodedRecord | undefined, name: string): BiffCell | undefined {
  const value = decoded?.fields.get(name);
  return isCell(value) ? value : undefined;
}

/** A field as a range, or `undefined`. */
export function rangeField(
  decoded: DecodedRecord | undefined,
  name: string
): BiffRange | undefined {
  const value = decoded?.fields.get(name);
  return isRange(value) ? value : undefined;
}

function isCell(value: BiffValue): value is BiffCell {
  return typeof value === "object" && value !== null && "column" in value && "styleIndex" in value;
}

function isRange(value: BiffValue): value is BiffRange {
  return typeof value === "object" && value !== null && "firstRow" in value;
}

/**
 * The style reference a record carries, whatever it is called there.
 *
 * A cell holds it inside its `Cell`; a row header holds it as `ixfe`. Both are style
 * references into the same table, and a checker should not have to know which record
 * spells it which way — that is a property of the layout, so it is read from the
 * layout.
 */
export function styleReference(decoded: DecodedRecord | undefined): number | undefined {
  if (!decoded) {
    return undefined;
  }
  for (const field of decoded.spec.fields ?? []) {
    if (field.type === "cell") {
      return cellField(decoded, field.name)?.styleIndex;
    }
    if (field.name === "ixfe") {
      return numberField(decoded, field.name);
    }
  }
  return undefined;
}

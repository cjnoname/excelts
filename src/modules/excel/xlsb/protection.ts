import { ExcelNotSupportedError, XlsbParseError } from "@excel/errors";
import type { XlsbBinaryReader } from "@excel/xlsb/binary";
import { createPayload, encodeWideString } from "@excel/xlsb/binary";
import { base64ToUint8Array, uint8ArrayToBase64 } from "@utils/utils";

export interface XlsbIsoPasswordData {
  algorithmName?: string;
  hashValue?: string;
  saltValue?: string;
}

export function parseIsoPasswordData(
  reader: XlsbBinaryReader,
  context: string
): XlsbIsoPasswordData {
  const hash = reader.slice(reader.u32());
  const salt = reader.slice(reader.u32());
  const algorithmName = reader.wideString();
  if (hash.length > 0 !== algorithmName.length > 0 || (salt.length > 0 && hash.length === 0)) {
    throw new XlsbParseError(context, "inconsistent ISO password hash, salt, and algorithm name");
  }
  return {
    ...(algorithmName ? { algorithmName } : {}),
    ...(hash.length > 0 ? { hashValue: uint8ArrayToBase64(hash) } : {}),
    ...(salt.length > 0 ? { saltValue: uint8ArrayToBase64(salt) } : {})
  };
}

export function encodeIsoPasswordData(value: XlsbIsoPasswordData, context: string): Uint8Array {
  const hasAny = [value.algorithmName, value.hashValue, value.saltValue].some(
    field => field !== undefined
  );
  const hasAll = [value.algorithmName, value.hashValue, value.saltValue].every(
    field => field !== undefined
  );
  if (hasAny && !hasAll) {
    throw new ExcelNotSupportedError(
      context,
      "algorithmName, hashValue and saltValue must be provided together"
    );
  }
  const hash = value.hashValue ? base64ToUint8Array(value.hashValue) : new Uint8Array(0);
  const salt = value.saltValue ? base64ToUint8Array(value.saltValue) : new Uint8Array(0);
  if (hasAll && hash.length === 0) {
    throw new ExcelNotSupportedError(context, "ISO protection requires a non-empty hash");
  }
  const algorithmName = value.algorithmName
    ? encodeWideString(value.algorithmName)
    : createPayload(4).bytes.fill(0xff);
  const payload = createPayload(8 + hash.length + salt.length + algorithmName.length);
  payload.view.setUint32(0, hash.length, true);
  payload.bytes.set(hash, 4);
  const saltOffset = 4 + hash.length;
  payload.view.setUint32(saltOffset, salt.length, true);
  payload.bytes.set(salt, saltOffset + 4);
  payload.bytes.set(algorithmName, saltOffset + 4 + salt.length);
  return payload.bytes;
}

export function validateProtectionSpinCount(spinCount: number, context: string): void {
  if (!Number.isInteger(spinCount) || spinCount < 0 || spinCount > 10_000_000) {
    throw new ExcelNotSupportedError(
      context,
      `spinCount must be an integer from 0 through 10000000, received ${spinCount}`
    );
  }
}

/**
 * `BrtWsProp` — the sheet's own properties: its tab colour and its VBA code name.
 *
 * **The layout self-checks.** The record ends in an `XLWideString`, so `23 + 2 × cch` must equal
 * the payload length. It does at all three lengths the corpus contains — 23 with no code name,
 * 33 for `Лист1` and 35 for `Sheet1` — which fixes the header at 23 bytes.
 *
 * Inside those 23, the eight bytes at offset 3 read `00 40 00 00 00 00 00 00`: a `BrtColor` with
 * `fValidRGB` clear and index 64, which is exactly the automatic colour as established in
 * `color.ts`. The eight after it are two `0xFFFFFFFF` sync positions. Both readings are consistent
 * with the record having no tab colour and no frozen sync point, which is what every corpus sheet
 * is.
 *
 * **So the tab colour's position is established and a real tab colour is not.** No sheet in the
 * corpus colours its tab. The colour *structure* is the one already confirmed four ways from the
 * font table, so what is unobserved here is narrow: that this particular `BrtColor` is the tab's.
 *
 * The code name, by contrast, is observed and varies — `Лист1`/`Лист2`/`Лист3` in the
 * Russian-locale workbook and `Sheet1` through `Sheet4` in another.
 */
import type { Color } from "@excel/types";
import { encodeWideString, readWideString } from "@excel/xlsb/binary";
import { COLOR_SIZE, automaticColor, encodeColor, readColor } from "@excel/xlsb/color";
import { BinaryReader, BinaryWriter, concatUint8Arrays } from "@utils/binary";

/**
 * Bytes before the code name's character count.
 *
 * Confirmed by `HEADER_SIZE + 4 + 2 × cch === payload.length` at all three lengths the corpus
 * contains. Exported so the test derives its self-check from it rather than restating the number —
 * a constant a test spells out as a literal is a constant no test is checking.
 */
export const HEADER_SIZE = 19;

/** The three flag bytes, verbatim from every corpus sheet. */
const FLAG_BYTES = [0xc9, 0x04, 0x02] as const;

/** Index of the automatic tab colour — "no colour chosen". */
const AUTOMATIC_TAB_INDEX = 64;

/** A sync position the record spells as absent. */
const NO_SYNC = 0xffffffff;

/** What a `BrtWsProp` says. */
export interface SheetProperties {
  readonly tabColor?: Partial<Color>;
  readonly codeName?: string;
}

/** Read a `BrtWsProp`. */
export function readSheetProperties(
  payload: Uint8Array,
  part: string
): SheetProperties | undefined {
  if (payload.length < HEADER_SIZE + 4) {
    return undefined;
  }
  const reader = new BinaryReader(payload, 0, part);
  reader.skip(3); // flags
  const tabColor = readColor(reader);
  reader.readUint32(); // rwSync
  reader.readUint32(); // colSync

  let codeName: string | undefined;
  try {
    const read = readWideString(reader, part);
    codeName = read.length === 0 ? undefined : read;
  } catch {
    // A truncated code name costs the code name, not the sheet.
  }

  const properties: SheetProperties = {
    // An automatic colour is the absence of a choice, so it is not reported as one.
    ...(Object.keys(tabColor).length === 0 ? {} : { tabColor }),
    ...(codeName === undefined ? {} : { codeName })
  };
  return Object.keys(properties).length === 0 ? undefined : properties;
}

/** Serialise a `BrtWsProp`. */
export function encodeSheetProperties(properties: SheetProperties | undefined): Uint8Array {
  const colorBytes =
    properties?.tabColor === undefined || Object.keys(properties.tabColor).length === 0
      ? // `fValidRGB` clear, which is how a sheet spells its absent tab colour — a font spells its
        // absent colour with the bit set. See `automaticColor`.
        automaticColor(AUTOMATIC_TAB_INDEX, false)
      : encodeColor(properties.tabColor);
  return concatUint8Arrays([
    new Uint8Array(FLAG_BYTES),
    colorBytes,
    new BinaryWriter().writeUint32(NO_SYNC).writeUint32(NO_SYNC).toUint8Array(),
    encodeWideString(properties?.codeName ?? "")
  ]);
}

/** Bytes a `BrtColor` occupies here, so a test can assert the header arithmetic. */
export const TAB_COLOR_SIZE = COLOR_SIZE;

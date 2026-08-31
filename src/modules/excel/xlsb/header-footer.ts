/**
 * `BrtBeginHeaderFooter` — what a sheet prints at the top and bottom of each page.
 *
 * **How the layout was established.** Three samples, and the reading self-checks: a `u16` of flags
 * followed by six `XLNullableWideString`s consumes exactly the payload in all three, at two very
 * different lengths (52 and 168 bytes). Had the field count or the nullable encoding been wrong, the
 * arithmetic would not have closed.
 *
 * The contents confirm it independently. `issue127.xlsb` carries `&C&A` and `&CPage &P` — centred
 * sheet name, centred page number, which are the standard header codes — and `date.xlsb` carries
 * `&C&"Times New Roman,Обычный"&12&A`, whose embedded font style is spelled in Russian in precisely
 * the workbook whose style name is `Обычный`. A string that tracks the document's language is not at
 * the wrong offset.
 *
 * **The codes are passed through, not parsed.** `&C`, `&P`, `&A`, `&"font,style"`, `&12` are a
 * miniature formatting language, and this module has no reason to understand it: the model holds the
 * same string an XLSX `<oddHeader>` holds, so both containers carry the author's text unaltered. A
 * parser here would be a second opinion about a syntax neither container interprets.
 */
import type { HeaderFooter } from "@excel/types";
import { encodeNullableWideString, readNullableWideString } from "@excel/xlsb/binary";
import { BinaryReader, BinaryWriter, concatUint8Arrays } from "@utils/binary";

/**
 * `fDifferentOddEven` and `fDifferentFirst`, the two flags that say whether the later strings mean
 * anything.
 *
 * All three corpus sheets read `0x000c`, with both of these clear — so the *values* of these bits are
 * not exercised, only their absence. They are written to match the model rather than hardcoded,
 * because a workbook that asks for a distinct first-page header and does not get the flag would show
 * the odd-page header on page one instead.
 */
const FLAG_DIFFERENT_ODD_EVEN = 0x0001;
const FLAG_DIFFERENT_FIRST = 0x0002;

/**
 * The remaining bits, verbatim from Excel.
 *
 * `0x000c` in every corpus sheet, which is `fScaleWithDoc | fAlignMargins` — both of which Excel
 * turns on by default. Written as the observed value rather than decomposed, because this module
 * interprets neither and naming them would imply otherwise.
 */
const FLAGS_DEFAULT = 0x000c;

/** Read a `BrtBeginHeaderFooter`, or `undefined` when it declares nothing. */
export function readHeaderFooter(
  payload: Uint8Array,
  part: string
): Partial<HeaderFooter> | undefined {
  if (payload.length < 2) {
    return undefined;
  }
  const reader = new BinaryReader(payload, 0, part);
  try {
    const flags = reader.readUint16();
    const fields = [
      "oddHeader",
      "oddFooter",
      "evenHeader",
      "evenFooter",
      "firstHeader",
      "firstFooter"
    ] as const;
    const result: Partial<HeaderFooter> = {};
    // The two flags that say whether the later strings mean anything. Reported, because a sheet that
    // carries an even-page header with the flag clear prints the odd-page one on every page — so the
    // flag is the difference between "this text is used" and "this text is ignored", not decoration.
    if ((flags & FLAG_DIFFERENT_ODD_EVEN) !== 0) {
      result.differentOddEven = true;
    }
    if ((flags & FLAG_DIFFERENT_FIRST) !== 0) {
      result.differentFirst = true;
    }
    for (const field of fields) {
      const text = readNullableWideString(reader, part);
      // An absent string and an empty one are different in the record and the same to a reader: both
      // mean "nothing is printed here". Reporting `""` would add a field the author never set.
      if (text !== undefined && text.length > 0) {
        result[field] = text;
      }
    }
    return Object.keys(result).length === 0 ? undefined : result;
  } catch {
    // A truncated record costs the header, not the sheet.
    return undefined;
  }
}

/** Serialise a `BrtBeginHeaderFooter`. */
export function encodeHeaderFooter(headerFooter: Partial<HeaderFooter> | undefined): Uint8Array {
  let flags = FLAGS_DEFAULT;
  // The flags are what make the later strings meaningful, so they follow the model rather than being
  // fixed: a distinct first-page header with the flag clear prints the odd-page header on page one.
  if (headerFooter?.evenHeader !== undefined || headerFooter?.evenFooter !== undefined) {
    flags |= FLAG_DIFFERENT_ODD_EVEN;
  }
  if (headerFooter?.firstHeader !== undefined || headerFooter?.firstFooter !== undefined) {
    flags |= FLAG_DIFFERENT_FIRST;
  }
  return concatUint8Arrays([
    new BinaryWriter().writeUint16(flags).toUint8Array(),
    ...(
      ["oddHeader", "oddFooter", "evenHeader", "evenFooter", "firstHeader", "firstFooter"] as const
    ).map(field => encodeNullableWideString(present(headerFooter?.[field])))
  ]);
}

/** True when a header/footer says anything worth writing a record for. */
export function hasHeaderFooter(headerFooter: Partial<HeaderFooter> | undefined): boolean {
  if (headerFooter === undefined) {
    return false;
  }
  return (
    ["oddHeader", "oddFooter", "evenHeader", "evenFooter", "firstHeader", "firstFooter"] as const
  ).some(field => {
    const value = headerFooter[field];
    return typeof value === "string" && value.length > 0;
  });
}

/**
 * Normalise the three ways the model spells "nothing here" into the one the record has.
 *
 * `undefined`, `null` and `""` all mean the same thing to a reader, and `XLNullableWideString` has a
 * single spelling for it — so they collapse here rather than widening the shared encoder's signature
 * for one caller.
 */
function present(value: string | null | undefined): string | undefined {
  return value === null || value === undefined || value.length === 0 ? undefined : value;
}

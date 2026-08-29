import { ExcelNotSupportedError, XlsbParseError } from "@excel/errors";
import type { Font, RichText } from "@excel/types";
import type { XlsbBinaryReader } from "@excel/xlsb/binary";
import { createPayload, encodeWideString } from "@excel/xlsb/binary";
import { addFont, type XlsbStyleRegistry } from "@excel/xlsb/styles";

const MAX_RICH_TEXT_RUNS = 0x7fff;
const MAX_RICH_TEXT_OFFSET = 0xffff;

export interface ParsedXlsbRichString {
  text: string;
  richText?: RichText[];
  hasPhoneticData: boolean;
}

export function parseXlsbRichString(
  reader: XlsbBinaryReader,
  context: string,
  fonts: readonly Partial<Font>[]
): ParsedXlsbRichString {
  const flags = reader.u8();
  const text = reader.wideString();
  const richText = (flags & 1) !== 0 ? parseRuns(reader, context, text, fonts) : undefined;
  const hasPhoneticData = (flags & 2) !== 0;
  if (hasPhoneticData) {
    skipPhoneticData(reader, context);
  }
  if (reader.remaining !== 0) {
    throw new XlsbParseError(context, "unexpected trailing rich-string data");
  }
  return { text, richText, hasPhoneticData };
}

export function writeXlsbRichString(
  richText: readonly RichText[],
  styles: XlsbStyleRegistry,
  operation: string
): Uint8Array {
  const runs = richText.filter(run => run.text.length > 0);
  const value = runs.map(run => run.text).join("");
  if (runs.length > MAX_RICH_TEXT_RUNS) {
    throw new ExcelNotSupportedError(
      operation,
      `rich text exceeds the BIFF12 limit of ${MAX_RICH_TEXT_RUNS} formatting runs`
    );
  }
  if (value.length > MAX_RICH_TEXT_OFFSET) {
    throw new ExcelNotSupportedError(
      operation,
      `rich text exceeds the BIFF12 formatting-run offset limit of ${MAX_RICH_TEXT_OFFSET} UTF-16 code units`
    );
  }

  const encoded = encodeWideString(value);
  const payload = createPayload(1 + encoded.length + 4 + runs.length * 4);
  payload.bytes[0] = 1;
  payload.bytes.set(encoded, 1);
  payload.view.setUint32(1 + encoded.length, runs.length, true);
  let characterOffset = 0;
  runs.forEach((run, index) => {
    const offset = 1 + encoded.length + 4 + index * 4;
    payload.view.setUint16(offset, characterOffset, true);
    payload.view.setUint16(offset + 2, run.font ? addFont(styles, run.font) : 0, true);
    characterOffset += run.text.length;
  });
  return payload.bytes;
}

function parseRuns(
  reader: XlsbBinaryReader,
  context: string,
  value: string,
  fonts: readonly Partial<Font>[]
): RichText[] {
  const count = reader.u32();
  if (count > MAX_RICH_TEXT_RUNS || count * 4 > reader.remaining) {
    throw new XlsbParseError(context, `invalid text-run count ${count}`);
  }
  const runs = Array.from({ length: count }, () => ({
    start: reader.u16(),
    fontId: reader.u16()
  }));
  const richText: RichText[] = [];
  for (let index = 0; index < runs.length; index++) {
    const run = runs[index]!;
    const end = runs[index + 1]?.start ?? value.length;
    if (
      run.start >= value.length ||
      end <= run.start ||
      (index > 0 && run.start <= runs[index - 1]!.start) ||
      !fonts[run.fontId]
    ) {
      throw new XlsbParseError(context, "invalid text-run position or font index");
    }
    if (index === 0 && run.start > 0) {
      richText.push({ text: value.slice(0, run.start) });
    }
    richText.push({
      text: value.slice(run.start, end),
      font: fonts[run.fontId]
    });
  }
  return richText.length > 0 ? richText : [{ text: value }];
}

function skipPhoneticData(reader: XlsbBinaryReader, context: string): void {
  reader.wideString();
  const count = reader.u32();
  if (count > MAX_RICH_TEXT_RUNS) {
    throw new XlsbParseError(context, `invalid phonetic-run count ${count}`);
  }
  // Excel-produced files store three UInt16 values per mapping followed by one
  // shared font/phonetic-settings pair. Older protocol text described that pair
  // as part of every PhRun, so accept that layout as well when encountered.
  if (reader.remaining === count * 6 + 4) {
    reader.skip(count * 6 + 4);
    return;
  }
  if (reader.remaining === count * 10) {
    reader.skip(count * 10);
    return;
  }
  throw new XlsbParseError(context, "invalid phonetic-run payload length");
}

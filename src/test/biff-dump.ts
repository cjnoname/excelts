/**
 * BIFF12 disassembler.
 *
 * Same reasoning as `svg-geometry.ts` and `pdf-draw-record.ts`: describing what a
 * stream *says* — record names, nesting, decoded fields — compares the content
 * instead of the encoding, and produces something a human can diff.
 *
 * This is the first thing that should exist for a binary format, before any reader.
 * A record stream is opaque, and Excel's own diagnostic for a malformed one is
 * "we found a problem with some content", which names neither the part nor the
 * offset. Without a disassembler every subsequent bug is debugged blind, by
 * bisecting bytes.
 *
 * Two rules keep it honest:
 *
 *  * **It never claims to have decoded more than it has.** A record the spec table
 *    describes only partially shows its known fields and then `+N bytes`; a record
 *    with no declared layout shows its payload as hex. An identifier the table does
 *    not contain is `???` with its number, not a guess.
 *  * **It is a disassembler, not a semantic view.** Two encodings of the same value
 *    — `BrtCellRk` and `BrtCellReal` holding 42 — describe *differently*, on
 *    purpose. Anything comparing meaning rather than representation belongs at the
 *    model level, not here.
 */

import { iterateBiffRecords, type BiffRecord } from "@excel/xlsb/binary";
import { decodeRecord, type BiffValue } from "@excel/xlsb/spec/decode";
import { recordSpec } from "@excel/xlsb/spec/records";

export interface DescribeBiffOptions {
  /** Part name used in error text. Defaults to `"stream"`. */
  readonly context?: string;
  /**
   * Cap on hex bytes shown for an undecoded payload. Beyond this the remainder is
   * summarised, so a 40 KB shared-string table does not become the output.
   */
  readonly maxHexBytes?: number;
}

/**
 * Render a `.bin` part as indented, diffable text.
 *
 * Indentation follows `Begin`/`End` nesting, which makes an unbalanced pair visible
 * at a glance — the whole tail of the stream shifts.
 */
export function describeBiffStream(bytes: Uint8Array, options: DescribeBiffOptions = {}): string {
  const context = options.context ?? "stream";
  const maxHexBytes = options.maxHexBytes ?? 16;
  const lines: string[] = [];
  let depth = 0;

  for (const record of iterateBiffRecords(bytes, context)) {
    const spec = recordSpec(record.id);
    if (spec?.scope === "end") {
      depth = Math.max(0, depth - 1);
    }

    const name = spec?.name ?? `??? id=0x${record.id.toString(16).padStart(4, "0")}`;
    const detail = describePayload(record, context, maxHexBytes);
    lines.push(`${"  ".repeat(depth)}${name}${detail ? ` ${detail}` : ""}`);

    if (spec?.scope === "begin") {
      depth++;
    }
  }

  return lines.join("\n");
}

function describePayload(record: BiffRecord, context: string, maxHexBytes: number): string {
  if (record.payload.length === 0) {
    return "";
  }
  const decoded = decodeRecord(record, context);
  if (!decoded) {
    // Either the identifier is unknown or the layout is undeclared. Both mean the
    // bytes must be shown as bytes: a guess here would be the start of a wrong reader.
    return hex(record.payload, maxHexBytes);
  }

  const parts: string[] = [];
  for (const [name, value] of decoded.fields) {
    parts.push(`${name}=${formatValue(value)}`);
  }
  if (decoded.truncatedAt) {
    parts.push(`${decoded.truncatedAt}=<truncated>`);
  } else if (decoded.trailingBytes > 0) {
    parts.push(`+${decoded.trailingBytes} byte(s)`);
  }
  return parts.join(" ");
}

function formatValue(value: BiffValue): string {
  if (value === undefined) {
    return "null";
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    return String(value);
  }
  if ("column" in value) {
    return `col=${value.column},style=${value.styleIndex}`;
  }
  return `${value.firstRow}:${value.lastRow}×${value.firstColumn}:${value.lastColumn}`;
}

function hex(payload: Uint8Array, maxHexBytes: number): string {
  const shown = [...payload.subarray(0, maxHexBytes)]
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join(" ");
  return payload.length > maxHexBytes ? `<${shown} … ${payload.length} byte(s)>` : `<${shown}>`;
}

/**
 * Classic hex dump around an offset.
 *
 * The companion to the record listing: when a record's framing is wrong the listing
 * cannot reach it, and what is needed is the raw bytes with the offset marked.
 */
export function hexdump(bytes: Uint8Array, offset = 0, length = 64): string {
  const start = Math.max(0, offset - (offset % 16));
  const end = Math.min(bytes.length, start + length);
  const lines: string[] = [];
  for (let line = start; line < end; line += 16) {
    const slice = bytes.subarray(line, Math.min(line + 16, end));
    const bytesText = [...slice].map(byte => byte.toString(16).padStart(2, "0")).join(" ");
    const ascii = [...slice]
      .map(byte => (byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : "."))
      .join("");
    const marker = offset >= line && offset < line + 16 ? " <--" : "";
    lines.push(
      `${line.toString(16).padStart(8, "0")}  ${bytesText.padEnd(47)}  |${ascii}|${marker}`
    );
  }
  return lines.join("\n");
}

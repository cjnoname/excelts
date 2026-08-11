/**
 * `createCsvReadStream` must be a real byte stream.
 *
 * It used to emit `string` chunks from an object-mode readable side, which made
 * it indistinguishable by type from `Workbook.toStream()` while being unusable
 * anywhere bytes are expected — `Buffer.concat` threw, and `Readable.toWeb()`
 * happily produced a stream of strings. These tests pin the byte contract and,
 * crucially, that switching to bytes did not change the CSV itself.
 */
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { writeCsv } from "@excel/bridge/csv-bridge";
import { createCsvReadStream } from "@excel/bridge/csv.node";
import { Workbook, Worksheet } from "@excel/index";
import { describe, expect, it } from "vitest";

/** A sheet big enough to span several chunks, with quoting and multi-byte text. */
function buildSheet(rows = 3000): Workbook.Handle {
  const wb = Workbook.create();
  const ws = Workbook.addWorksheet(wb, "S");
  Worksheet.addRow(ws, ["name", "qty", "note"]);
  for (let i = 0; i < rows; i++) {
    // Embedded comma + quote force the formatter's quoting path; the Hebrew and
    // emoji text spans multiple UTF-8 bytes per character.
    Worksheet.addRow(ws, [`a,"${i}"`, i, `משהו שכתוב בעברית ${i} 🧮`]);
  }
  return wb;
}

describe("createCsvReadStream", () => {
  it("emits bytes, not strings", async () => {
    const wb = buildSheet(200);
    const stream = createCsvReadStream(wb);

    // The Node entry types this as a nominal `stream.Readable`; check the runtime
    // actually is one, so the declaration cannot drift from reality.
    expect(stream).toBeInstanceOf(Readable);
    expect(stream.readableObjectMode).toBe(false);

    const chunks: Uint8Array[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
      expect(typeof chunk).not.toBe("string");
      expect(chunk).toBeInstanceOf(Uint8Array);
    }
    expect(chunks.length).toBeGreaterThan(0);
  });

  it("produces exactly the same CSV as the string API", async () => {
    const wb = buildSheet();

    const chunks: Uint8Array[] = [];
    for await (const chunk of createCsvReadStream(wb)) {
      chunks.push(chunk);
    }

    // Concatenate first, then decode: a chunk boundary may fall inside a
    // multi-byte character, which is exactly why the byte stream must be
    // reassembled before decoding.
    const viaBytes = Buffer.concat(chunks).toString("utf8");
    expect(viaBytes).toBe(writeCsv(wb));
    expect(viaBytes).toContain("🧮");
  });

  it("feeds the byte consumers that an object-mode stream could not", async () => {
    const wb = buildSheet(100);
    const expected = writeCsv(wb);

    // `Buffer.concat` threw `must be an instance of Buffer or Uint8Array` before.
    const collected: Uint8Array[] = [];
    await pipeline(createCsvReadStream(wb), async source => {
      for await (const chunk of source) {
        collected.push(chunk as Uint8Array);
      }
    });
    expect(Buffer.concat(collected).toString("utf8")).toBe(expected);

    // `Readable.toWeb` used to hand out a stream of strings.
    const web = Readable.toWeb(createCsvReadStream(wb));
    const reader = web.getReader();
    const first = await reader.read();
    expect(first.value).toBeInstanceOf(Uint8Array);
    await reader.cancel();
  });

  it("still ends cleanly when the workbook has no matching worksheet", async () => {
    const wb = Workbook.create();
    const chunks: Uint8Array[] = [];
    for await (const chunk of createCsvReadStream(wb, { sheetName: "missing" })) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual([]);
  });

  it("does not let a caller inject rows through the underlying Transform", async () => {
    // The public type hides `write()` (see the `@ts-expect-error` assertions in
    // `__tests__/type/workbook-stream-surface.typecheck.ts`). This pins the
    // reason: the stream is already attached to a producer, so a write that got
    // through would land in the output. The cast reaches past the public type on
    // purpose, to prove what the type is protecting against.
    const wb = buildSheet(20000);
    const stream = createCsvReadStream(wb);
    (stream as unknown as { write(row: unknown): boolean }).write(["INJECTED", "ROW"]);

    const chunks: Uint8Array[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    expect(Buffer.concat(chunks).toString("utf8")).toContain("INJECTED");
  });
});

/**
 * The Node entry's IO types must match what Node actually hands back, so callers
 * never wrap or cast to reach the Node stream ecosystem.
 *
 * `toBuffer` is declared `Promise<Buffer>` — these tests prove the runtime keeps
 * that promise across package sizes, so the declaration is a fact rather than an
 * optimistic label. `toStream` is declared as the platform `Readable`, so it must
 * be usable directly as a nominal `stream.Readable`.
 */
import { createWriteStream } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { Workbook, Worksheet } from "@excel/index";
import { testFilePath } from "@test/utils";
import { describe, expect, it } from "vitest";

function buildWorkbook(rows: number): Workbook.Handle {
  const wb = Workbook.create();
  const ws = Workbook.addWorksheet(wb, "S");
  for (let i = 0; i < rows; i++) {
    Worksheet.addRow(ws, [`cell-${i}`, i, `padding text to grow the package ${i}`]);
  }
  return wb;
}

describe("Workbook.toBuffer (Node)", () => {
  // A workbook large enough to span several internal buffers took the
  // `StreamBuf` branch that concatenates, which is where a plain `Uint8Array`
  // could leak out; the small cases take the single-buffer branch.
  it.each([0, 1, 5000, 50000])("returns a Buffer for %i rows", async rows => {
    const bytes = await Workbook.toBuffer(buildWorkbook(rows));
    expect(Buffer.isBuffer(bytes)).toBe(true);
    expect(bytes.length).toBeGreaterThan(0);
  });

  it("returns bytes that still parse back into a workbook", async () => {
    // The `Buffer.isBuffer` fallback wraps existing memory with an explicit
    // `byteOffset` / `byteLength`. Getting either wrong would silently hand back
    // a truncated or shifted package, so re-read what we produced.
    const bytes = await Workbook.toBuffer(buildWorkbook(500));
    expect(bytes.subarray(0, 2).toString("latin1")).toBe("PK");

    const reread = Workbook.create();
    await Workbook.read(reread, bytes);
    const ws = Workbook.getWorksheet(reread, "S");
    expect(ws).toBeDefined();
    expect(Worksheet.rowCount(ws!)).toBe(500);
  });
});

describe("Workbook.toStream (Node)", () => {
  it("is a byte-mode stream.Readable", () => {
    const stream = Workbook.toStream(buildWorkbook(10));
    expect(stream).toBeInstanceOf(Readable);
    expect(stream.readableObjectMode).toBe(false);
    stream.destroy();
  });

  it("goes straight into stream.pipeline without an adapter", async () => {
    const target = testFilePath("to-stream-node-interop", ".xlsx");
    try {
      await pipeline(Workbook.toStream(buildWorkbook(2000)), createWriteStream(target));

      const written = await readFile(target);
      // "PK" — a real zip package arrived, not a stringified stream.
      expect(written.subarray(0, 2).toString("latin1")).toBe("PK");

      const reread = Workbook.create();
      await Workbook.read(reread, written);
      expect(Workbook.getWorksheet(reread, "S")).toBeDefined();
    } finally {
      await rm(target, { force: true });
    }
  });

  it("emits Buffer chunks that reassemble into a readable package", async () => {
    const chunks: Uint8Array[] = [];
    for await (const chunk of Workbook.toStream(buildWorkbook(1000))) {
      expect(Buffer.isBuffer(chunk)).toBe(true);
      chunks.push(chunk);
    }

    const wb = Workbook.create();
    await Workbook.read(wb, Buffer.concat(chunks));
    expect(Workbook.getWorksheet(wb, "S")).toBeDefined();
  });

  it("converts to a web stream for SDK bodies", async () => {
    const web = Readable.toWeb(Workbook.toStream(buildWorkbook(50)));
    const reader = web.getReader();
    const first = await reader.read();
    expect(first.value).toBeInstanceOf(Uint8Array);
    await reader.cancel();
  });
});

// The `toStream` doc block describes these three teardown paths. They are Node's
// async-iterator semantics rather than this stream's, which is exactly why they
// need pinning: if Node ever changes, the documentation is wrong and this tells
// us. A workbook large enough to trigger backpressure keeps the producer parked
// at the break, so teardown is actually exercised.
describe("Workbook.toStream early exit (Node semantics)", () => {
  const settle = () => new Promise(resolve => setTimeout(resolve, 200));

  it("break destroys with an AbortError, which a listener sees", async () => {
    const stream = Workbook.toStream(buildWorkbook(40000));
    const seen: Error[] = [];
    stream.on("error", error => seen.push(error));

    let chunks = 0;
    for await (const _chunk of stream) {
      if (++chunks >= 3) {
        break;
      }
    }
    await settle();

    expect(stream.destroyed).toBe(true);
    expect(stream.errored).toBeInstanceOf(Error);
    expect((stream.errored as Error).name).toBe("AbortError");
    expect(seen.map(error => error.message)).toEqual(["The operation was aborted"]);
  });

  it("destroying before the break is silent", async () => {
    const stream = Workbook.toStream(buildWorkbook(40000));
    const seen: Error[] = [];
    stream.on("error", error => seen.push(error));

    let chunks = 0;
    for await (const _chunk of stream) {
      if (++chunks >= 3) {
        stream.destroy();
        break;
      }
    }
    await settle();

    expect(stream.destroyed).toBe(true);
    expect(stream.errored).toBeNull();
    expect(seen).toEqual([]);
  });

  it("destroyOnReturn:false is silent but leaves the stream open", async () => {
    const stream = Workbook.toStream(buildWorkbook(40000));
    const seen: Error[] = [];
    stream.on("error", error => seen.push(error));

    let chunks = 0;
    try {
      for await (const _chunk of stream.iterator({ destroyOnReturn: false })) {
        if (++chunks >= 3) {
          break;
        }
      }
      await settle();
      // The caller now owns teardown — this is the half of the contract that is
      // easy to miss, and skipping it leaves the serializer parked.
      expect(stream.destroyed).toBe(false);
      expect(stream.errored).toBeNull();
    } finally {
      stream.destroy();
    }
    await settle();

    expect(stream.destroyed).toBe(true);
    expect(stream.errored).toBeNull();
    expect(seen).toEqual([]);
  });
});

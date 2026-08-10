/**
 * `Workbook.toStream` / `Workbook.writeStream` contract.
 *
 * These two functions are the same code on every runtime — the pull-source
 * adapter lives in `core/xlsx-stream.ts` and only the `@stream` `Readable`
 * underneath it is platform specific — so this suite deliberately avoids Node
 * APIs and runs in both Node and a real browser.
 */
import { createXlsxByteStream } from "@excel/core/xlsx-stream";
import { Cell, Image, Workbook } from "@excel/index";
import { describe, it, expect } from "vitest";

const PAYLOAD = "0123456789abcdef".repeat(32);

/** Build a workbook whose package comfortably exceeds a stream buffer. */
function buildWorkbook(rows: number): Workbook.Handle {
  const wb = Workbook.create();
  const ws = Workbook.addWorksheet(wb, "Stream");
  for (let row = 1; row <= rows; row++) {
    Cell.setValue(ws, `A${row}`, `${row}-${PAYLOAD}`);
  }
  return wb;
}

/**
 * Build a workbook dominated by many sizeable, poorly compressible images, i.e.
 * a package whose bulk arrives through buffered parts rather than worksheet XML.
 */
function buildImageWorkbook(count: number, bytesEach: number): Workbook.Handle {
  const wb = Workbook.create();
  const ws = Workbook.addWorksheet(wb, "S");
  Cell.setValue(ws, "A1", "x");
  for (let i = 0; i < count; i++) {
    const buffer = new Uint8Array(bytesEach);
    let seed = i + 1;
    for (let b = 0; b < bytesEach; b++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      buffer[b] = seed & 0xff;
    }
    Image.place(ws, Image.add(wb, { buffer, extension: "png" }), `B${2 + i * 6}:D${6 + i * 6}`);
  }
  return wb;
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let totalLength = 0;
  for await (const chunk of source) {
    chunks.push(chunk);
    totalLength += chunk.length;
  }
  const bytes = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

/**
 * A sink that is permanently backpressured and never drains, so the writer is
 * guaranteed to be parked in `waitForDrain()` by the time the test fires a
 * lifecycle event at it. Lets the failure paths be exercised deterministically,
 * without depending on any platform stream's buffering thresholds.
 */
function createStalledSink(): Workbook.XlsxWritable & {
  emit(event: string, ...args: unknown[]): void;
} {
  const listeners = new Map<string, Set<(...args: any[]) => void>>();
  return {
    write() {
      return false;
    },
    end() {},
    on(event, listener) {
      let bucket = listeners.get(event);
      if (!bucket) {
        bucket = new Set();
        listeners.set(event, bucket);
      }
      bucket.add(listener);
      return this;
    },
    once(event, listener) {
      return this.on(event, listener);
    },
    off(event, listener) {
      listeners.get(event)?.delete(listener);
      return this;
    },
    emit(event, ...args) {
      for (const listener of [...(listeners.get(event) ?? [])]) {
        listener(...args);
      }
    }
  };
}

describe("Workbook.toStream", () => {
  it("starts serializing only once the consumer reads", async () => {
    const source = Workbook.toStream(buildWorkbook(500), { highWaterMark: 1024 });

    // Nothing may be produced while the consumer has not asked for bytes —
    // otherwise an abandoned stream silently retains a whole worksheet.
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(source.readableLength).toBe(0);

    const iterator = source[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(first.value!.length).toBeGreaterThan(0);

    await iterator.return?.();
  });

  it("round-trips output larger than the readable buffer", async () => {
    const source = Workbook.toStream(buildWorkbook(2_000), { highWaterMark: 1024 });

    // Deliberately let the source sit idle first: unlike `writeStream` there is
    // no ordering contract, so a late consumer must still get every byte.
    await new Promise(resolve => setTimeout(resolve, 10));
    const bytes = await collect(source);

    const loaded = Workbook.create();
    await Workbook.read(loaded, bytes);
    expect(Cell.getValue(Workbook.getWorksheet(loaded, "Stream")!, "A2000")).toBe(
      `2000-${PAYLOAD}`
    );
  });

  it("emits the same bytes as toBuffer()", async () => {
    const wb = buildWorkbook(200);

    const buffered = await Workbook.toBuffer(wb);
    const streamed = await collect(Workbook.toStream(wb, { highWaterMark: 1024 }));

    // `toBuffer` may hand back a Node Buffer; compare plain byte views so the
    // assertion is about content rather than the concrete typed-array class.
    expect(new Uint8Array(streamed)).toEqual(new Uint8Array(buffered));
  });

  it("surfaces serialization failures to the consumer", async () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Stream");
    Cell.setValue(ws, "A1", "x");
    // `AAAA` is past Excel's XFD column limit, so rendering pageSetup throws.
    ws.pageSetup.printArea = "A1:AAAA5";

    await expect(collect(Workbook.toStream(wb))).rejects.toThrow(/Column AAAA is out of bounds/);
  });

  it("releases the writer when the consumer cancels while backpressured", async () => {
    const source = Workbook.toStream(buildWorkbook(2_000), { highWaterMark: 1 });
    const iterator = source[Symbol.asyncIterator]();
    expect((await iterator.next()).done).toBe(false);

    source.destroy();

    await new Promise<void>((resolve, reject) => {
      source.once("close", resolve);
      source.once("error", reject);
    });
    expect(source.destroyed).toBe(true);
  });

  it("forwards readable backpressure to the serializer", async () => {
    let accepted: boolean | void | Promise<boolean> | undefined;
    let didWrite!: () => void;
    const written = new Promise<void>(resolve => {
      didWrite = resolve;
    });
    const source = createXlsxByteStream(
      async sink => {
        accepted = sink.write(new Uint8Array(1024));
        didWrite();
      },
      { highWaterMark: 1 }
    );

    // Start the lazy serializer without taking bytes out of its queue. The
    // chunk exceeds the 1-byte mark, so `Readable.push()` and therefore the
    // sink handed to the serializer must return false.
    source.read(0);
    await written;
    expect(accepted).toBe(false);

    source.destroy();
  });

  it("keeps buffering near one part for a package built from buffered entries", async () => {
    // Images are written as already-materialised parts, so this is the path that
    // bypassed flow control entirely: every image was queued before anything
    // asked the reader whether it could keep up. Measured before the fix, the
    // queue held the whole package (5,245,333 of 5,253,330 bytes on Node,
    // 4,982,444 in Chromium); afterwards it stays near a single image.
    const wb = buildImageWorkbook(12, 128 * 1024);
    const packageSize = (await Workbook.toBuffer(wb)).length;
    const source = Workbook.toStream(wb, { highWaterMark: 1024 });

    let peak = 0;
    for await (const chunk of source) {
      void chunk;
      peak = Math.max(peak, source.readableLength);
      // Consume deliberately slowly: a writer that ignores the reader has every
      // opportunity to run ahead here.
      await new Promise(resolve => setTimeout(resolve, 0));
    }

    // Half the package is a deliberately loose bound — the point is the
    // difference between "one part" and "everything", not an exact figure.
    expect(peak).toBeLessThan(packageSize / 2);
  }, 60000);

  it("uses the same buffer thresholds on every runtime", async () => {
    // Node and browser resolve the default through the same `@stream` helper;
    // pinning it here catches a platform variant drifting to its own default.
    const defaulted = Workbook.toStream(buildWorkbook(1));
    expect(defaulted.readableHighWaterMark).toBe(64 * 1024);

    const configured = Workbook.toStream(buildWorkbook(1), { highWaterMark: 4096 });
    expect(configured.readableHighWaterMark).toBe(4096);

    defaulted.destroy();
    configured.destroy();
  });
});

describe("Workbook.writeStream", () => {
  it("resolves once a consumed sink has accepted the package", async () => {
    const wb = buildWorkbook(50);
    const chunks: Uint8Array[] = [];
    const sink: Workbook.XlsxWritable = {
      write(data) {
        chunks.push(typeof data === "string" ? new TextEncoder().encode(data) : data);
        return true;
      },
      end() {},
      on() {
        return this;
      },
      once() {
        return this;
      },
      off() {
        return this;
      }
    };

    await expect(Workbook.writeStream(wb, sink)).resolves.toBeUndefined();
    expect(chunks.reduce((sum, chunk) => sum + chunk.length, 0)).toBeGreaterThan(0);
  });

  it("rejects when the sink closes before the package is complete", async () => {
    const sink = createStalledSink();
    const written = Workbook.writeStream(buildWorkbook(50), sink);

    sink.emit("close");

    await expect(written).rejects.toThrow(/destination closed/);
  });

  it("rejects with the sink's own error", async () => {
    const sink = createStalledSink();
    const written = Workbook.writeStream(buildWorkbook(50), sink);

    sink.emit("error", new Error("sink exploded"));

    await expect(written).rejects.toThrow(/sink exploded/);
  });
});

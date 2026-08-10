import { gzipTarChunks } from "@archive/tar/gzip-tar-stream";
import { Transform } from "@stream";
import { describe, expect, it } from "vitest";

function createBlockedGzip(): {
  stream: Transform;
  releaseWrite: () => void;
  written: Promise<void>;
} {
  let releaseWrite: (() => void) | undefined;
  let markWritten: (() => void) | undefined;
  const written = new Promise<void>(resolve => {
    markWritten = resolve;
  });
  const stream = new Transform({
    writableHighWaterMark: 1,
    transform(chunk, _encoding, callback) {
      releaseWrite = () => {
        this.push(chunk);
        callback();
      };
      markWritten!();
    }
  });

  return {
    stream,
    written,
    releaseWrite: () => releaseWrite!()
  };
}

function expectNoPumpListeners(stream: Transform): void {
  expect(stream.listenerCount("data")).toBe(0);
  expect(stream.listenerCount("drain")).toBe(0);
  expect(stream.listenerCount("error")).toBe(0);
  expect(stream.listenerCount("close")).toBe(0);
}

describe("gzipTarChunks", () => {
  it("does not read the next TAR chunk before drain", async () => {
    const gzip = createBlockedGzip();
    let reads = 0;
    const tarChunks: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          next() {
            reads++;
            return Promise.resolve(
              reads === 1
                ? { done: false as const, value: new Uint8Array([1, 2]) }
                : { done: true as const, value: undefined }
            );
          }
        };
      }
    };

    const output = gzipTarChunks(tarChunks, gzip.stream)[Symbol.asyncIterator]();
    const firstOutput = output.next();
    await gzip.written;

    expect(reads).toBe(1);

    gzip.releaseWrite();
    const first = await firstOutput;
    expect(first.done).toBe(false);
    expect(Array.from(first.value!)).toEqual([1, 2]);
    await expect(output.next()).resolves.toEqual({ done: true, value: undefined });
    expectNoPumpListeners(gzip.stream);
  });

  it("rejects a backpressure wait on error and removes listeners", async () => {
    const gzip = createBlockedGzip();
    const error = new Error("gzip failed");
    const output = gzipTarChunks(
      (async function* () {
        yield new Uint8Array([1, 2]);
      })(),
      gzip.stream
    )[Symbol.asyncIterator]();
    const pending = output.next();
    await gzip.written;

    gzip.stream.destroy(error);

    await expect(pending).rejects.toBe(error);
    expectNoPumpListeners(gzip.stream);
  });

  it("rejects a backpressure wait on close and removes listeners", async () => {
    const gzip = createBlockedGzip();
    const output = gzipTarChunks(
      (async function* () {
        yield new Uint8Array([1, 2]);
      })(),
      gzip.stream
    )[Symbol.asyncIterator]();
    const pending = output.next();
    await gzip.written;

    gzip.stream.destroy();

    await expect(pending).rejects.toThrow("Gzip stream closed before completing");
    expectNoPumpListeners(gzip.stream);
  });
});

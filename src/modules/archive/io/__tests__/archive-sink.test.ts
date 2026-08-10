import { EventEmitter } from "node:events";

import { pipeIterableToSink } from "@archive/io/archive-sink";
import { describe, expect, it } from "vitest";

async function* chunks(): AsyncIterable<Uint8Array> {
  yield new Uint8Array([1]);
  yield new Uint8Array([2]);
  yield new Uint8Array([3]);
}

describe("pipeIterableToSink", () => {
  it("awaits writes strictly serially", async () => {
    const written: number[] = [];
    let activeWrites = 0;

    await pipeIterableToSink(chunks(), {
      async write(chunk) {
        activeWrites++;
        expect(activeWrites).toBe(1);
        await Promise.resolve();
        written.push(chunk[0]!);
        activeWrites--;
      }
    });

    expect(written).toEqual([1, 2, 3]);
  });

  it("propagates write promise rejections", async () => {
    await expect(
      pipeIterableToSink(chunks(), {
        write: () => Promise.reject(new Error("write failed"))
      })
    ).rejects.toThrow("write failed");
  });

  it("removes a pre-registered drain listener when write rejects", async () => {
    const emitter = new EventEmitter();
    const sink = Object.assign(emitter, {
      write: () => Promise.reject(new Error("write failed"))
    });
    await expect(pipeIterableToSink(chunks(), sink)).rejects.toThrow("write failed");
    expect(emitter.listenerCount("drain")).toBe(0);
  });

  it("does not miss drain emitted before an asynchronous false settles", async () => {
    const emitter = new EventEmitter();
    const sink = Object.assign(emitter, {
      write() {
        emitter.emit("drain");
        return Promise.resolve(false);
      }
    });

    await expect(pipeIterableToSink(chunks(), sink)).resolves.toBeUndefined();
  });

  it("captures an error after early drain but before async write settles", async () => {
    const emitter = new EventEmitter();
    const error = new Error("sink failed after drain");
    const sink = Object.assign(emitter, {
      write() {
        emitter.emit("drain");
        emitter.emit("error", error);
        return Promise.resolve(false);
      }
    });
    await expect(pipeIterableToSink(chunks(), sink)).rejects.toBe(error);
  });

  it("observes finish emitted synchronously by end", async () => {
    const emitter = new EventEmitter();
    const sink = Object.assign(emitter, {
      write: () => true,
      end() {
        emitter.emit("finish");
      }
    });

    await expect(pipeIterableToSink(chunks(), sink)).resolves.toBeUndefined();
  });
});

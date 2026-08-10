import { EventEmitter } from "node:events";

import { SinkAdapter } from "@stream/core/sink-adapter";
import { describe, expect, it, vi } from "vitest";

describe("SinkAdapter", () => {
  it("waits for drain when an asynchronous write resolves false", async () => {
    const emitter = new EventEmitter();
    const sink = Object.assign(emitter, {
      write: () => Promise.resolve(false),
      end: () => undefined
    });
    const adapter = new SinkAdapter(sink);

    let settled = false;
    const writing = adapter.write(new Uint8Array([1])).then(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    emitter.emit("drain");
    await writing;
    expect(settled).toBe(true);
  });

  it("does not miss drain emitted before an asynchronous false settles", async () => {
    const emitter = new EventEmitter();
    const sink = Object.assign(emitter, {
      write() {
        emitter.emit("drain");
        return Promise.resolve(false);
      },
      end: () => undefined
    });

    await expect(new SinkAdapter(sink).write(new Uint8Array([1]))).resolves.toBeUndefined();
  });

  it("captures an error after early drain but before async write settles", async () => {
    const emitter = new EventEmitter();
    const error = new Error("sink failed after drain");
    const sink = Object.assign(emitter, {
      write() {
        emitter.emit("drain");
        emitter.emit("error", error);
        return Promise.resolve(false);
      },
      end: () => undefined
    });
    await expect(new SinkAdapter(sink).write(new Uint8Array([1]))).rejects.toBe(error);
  });

  it("propagates write promise rejections", async () => {
    const adapter = new SinkAdapter({
      write: () => Promise.reject(new Error("write failed")),
      end: () => undefined
    });

    await expect(adapter.write(new Uint8Array([1]))).rejects.toThrow("write failed");
  });

  it("removes a pre-registered drain listener when write rejects", async () => {
    const emitter = new EventEmitter();
    const sink = Object.assign(emitter, {
      write: () => Promise.reject(new Error("write failed")),
      end: () => undefined
    });
    await expect(new SinkAdapter(sink).write(new Uint8Array([1]))).rejects.toThrow("write failed");
    expect(emitter.listenerCount("drain")).toBe(0);
  });

  it("awaits non-Promise thenables", async () => {
    let settled = false;
    const thenable: PromiseLike<boolean> = {
      then(onfulfilled, onrejected) {
        return Promise.resolve(true)
          .then(value => {
            settled = true;
            return value;
          })
          .then(onfulfilled, onrejected);
      }
    };
    const adapter = new SinkAdapter({
      write: () => thenable,
      end: () => undefined
    });

    await adapter.write(new Uint8Array([1]));

    expect(settled).toBe(true);
  });

  it("does not wait for events on a listener-less duck sink", async () => {
    const end = vi.fn();
    const adapter = new SinkAdapter({ write: () => false, end });

    await adapter.write(new Uint8Array([1]));
    await adapter.end();

    expect(end).toHaveBeenCalledOnce();
  });
});

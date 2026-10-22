/**
 * The module's contract at the Web boundary, run on every entry and in a real
 * browser: `pipeline`, `compose`, `finished`, `toWritable`, the safe Web
 * conversions, `isDisturbed`, `PullStream` and `SinkAdapter`.
 *
 * Both entries may run shared code here, so agreement between them proves
 * nothing; each case asserts the invariant directly: no data lost or invented,
 * every callback once, no lock or source left behind, no unhandled error.
 * Timing is driven by promises the test releases, not by sleeps.
 */

import { describe, expect, it } from "vitest";

type Api = any;

function released(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>(resolve => {
    release = resolve;
  });
  return { promise, release };
}

const settledWithin = <T>(p: Promise<T>, ms = 500): Promise<"settled" | "hung"> =>
  Promise.race([
    p.then(
      () => "settled" as const,
      () => "settled" as const
    ),
    new Promise<"hung">(resolve => setTimeout(() => resolve("hung"), ms))
  ]);

function webSource(values: unknown[]): ReadableStream<unknown> {
  return new ReadableStream({
    start(controller) {
      for (const v of values) {
        controller.enqueue(v);
      }
      controller.close();
    }
  });
}

function collector(S: Api, out: unknown[]): any {
  return new S.Writable({
    objectMode: true,
    write(chunk: unknown, _e: string, cb: () => void) {
      out.push(chunk);
      cb();
    }
  });
}

// =============================================================================
// Node oracle
// =============================================================================

/**
 * Failures that escaped to the host — an uncaught exception or an unhandled
 * rejection: `uncaughtException` / `unhandledRejection` in Node, `error` /
 * `unhandledrejection` in a browser.
 */
function watchUncaught(): { errors: unknown[]; stop: () => void } {
  const errors: unknown[] = [];
  const host = (
    globalThis as {
      process?: {
        on(event: string, listener: (error: unknown) => void): unknown;
        off(event: string, listener: (error: unknown) => void): unknown;
      };
    }
  ).process;
  if (typeof host?.on === "function") {
    const onError = (error: unknown): void => {
      errors.push(error);
    };
    host.on("uncaughtException", onError);
    host.on("unhandledRejection", onError);
    return {
      errors,
      stop: () => {
        host.off("uncaughtException", onError);
        host.off("unhandledRejection", onError);
      }
    };
  }
  const onError = (event: ErrorEvent): void => {
    errors.push(event.error);
    event.preventDefault();
  };
  const onRejection = (event: PromiseRejectionEvent): void => {
    errors.push(event.reason);
    event.preventDefault();
  };
  globalThis.addEventListener("error", onError);
  globalThis.addEventListener("unhandledrejection", onRejection);
  return {
    errors,
    stop: () => {
      globalThis.removeEventListener("error", onError);
      globalThis.removeEventListener("unhandledrejection", onRejection);
    }
  };
}

/**
 * The chunks a stream emits, from 'data' events. Not `for await`: Node's async
 * iterator is an async generator, and `yield` awaits a thenable chunk, so a
 * promise pushed by mistake would read back as its value.
 */
function emitted(stream: any): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const out: unknown[] = [];
    stream.on("data", (chunk: unknown) => out.push(chunk));
    stream.on("end", () => resolve(out));
    stream.on("error", reject);
  });
}

export { emitted, released, webSource };

/** The module contract, against one entry's exports. */
export function runStreamContractTests(S: Api): void {
  describe("pipeline across the Web boundary", () => {
    it("carries undefined from a Web stream to an object-mode Writable", async () => {
      const out: unknown[] = [];
      await S.pipeline(webSource([undefined, 1]), collector(S, out));
      expect(out).toEqual([undefined, 1]);
    });

    it("fails on null instead of ending early and dropping what follows", async () => {
      const out: unknown[] = [];
      await expect(S.pipeline(webSource([null, 1]), collector(S, out))).rejects.toMatchObject({
        code: "ERR_STREAM_NULL_VALUES"
      });
      expect(out).toEqual([]);
    });

    it("an abort settles only after the Web source has finished cancelling", async () => {
      const cancelStarted = released();
      const cancelGate = released();
      let cancelDone = false;
      const source = new ReadableStream({
        cancel() {
          cancelStarted.release();
          return cancelGate.promise.then(() => {
            cancelDone = true;
          });
        }
      });
      const ac = new AbortController();
      const run = S.pipeline(source, collector(S, []), { signal: ac.signal });
      ac.abort();
      await cancelStarted.promise;
      expect(await settledWithin(run, 50)).toBe("hung");
      cancelGate.release();
      await expect(run).rejects.toMatchObject({ name: "AbortError" });
      expect(cancelDone).toBe(true);
    });

    it("an abort cancels a Web source that is waiting for data", async () => {
      const cancelled = released();
      const source = new ReadableStream({
        pull() {},
        cancel() {
          cancelled.release();
        }
      });
      const ac = new AbortController();
      const run = S.pipeline(source, collector(S, []), { signal: ac.signal });
      ac.abort();
      await expect(run).rejects.toMatchObject({ name: "AbortError" });
      await cancelled.promise;
    });
  });

  describe("pipeline resource ownership", () => {
    it("end:false hands a Web writable back unlocked, with everything written", async () => {
      const got: unknown[] = [];
      const ws = new WritableStream({
        write(chunk) {
          got.push(chunk);
        }
      });
      await S.pipeline(S.Readable.from([1, 2]), ws, { end: false });
      expect(ws.locked).toBe(false);
      expect(got).toEqual([1, 2]);
      const writer = ws.getWriter();
      await writer.write(3);
      expect(got).toEqual([1, 2, 3]);
    });

    it("a stage rejected before connecting leaves every stage untouched", async () => {
      const source = S.Readable.from([1, 2, 3]);
      const middle = new S.PassThrough({ objectMode: true });
      await expect(S.pipeline(source, middle, 42)).rejects.toMatchObject({
        code: "ERR_INVALID_ARG_TYPE"
      });
      expect(source.destroyed).toBe(false);
      expect(source.readableFlowing).toBe(null);
      expect(middle.destroyed).toBe(false);
    });

    it("a stage that only fails once connected tears down every stage it was given", async () => {
      // No error listeners on purpose: the failure is the pipeline's rejection,
      // and must not also surface as an unhandled 'error' from a stage.
      const uncaught = watchUncaught();
      try {
        const source = S.Readable.from([1, 2, 3]);
        const middle = new S.PassThrough({ objectMode: true });
        const sink = collector(S, []);
        const notIterable = () => 42;
        await expect(S.pipeline(source, middle, notIterable, sink)).rejects.toMatchObject({
          code: "ERR_INVALID_RETURN_VALUE"
        });
        expect([source.destroyed, middle.destroyed, sink.destroyed]).toEqual([true, true, true]);
        await new Promise(resolve => setTimeout(resolve, 10));
        expect(uncaught.errors).toEqual([]);
      } finally {
        uncaught.stop();
      }
    });
  });

  describe("pipeline checks before it creates anything", () => {
    it("a rejected stage creates nothing, and nothing it was given escapes", async () => {
      // Checking used to convert as it went: the promise became a Duplex
      // before the last stage was rejected, and that Duplex's error escaped.
      const uncaught = watchUncaught();
      try {
        const readable = new ReadableStream();
        const writable = new WritableStream();
        const middle = new S.PassThrough();
        await expect(
          S.pipeline(Promise.reject(new Error("source failed")), { readable, writable }, middle, 5)
        ).rejects.toMatchObject({ code: "ERR_INVALID_ARG_TYPE" });
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(uncaught.errors).toEqual([]);
        expect([readable.locked, writable.locked, middle.destroyed]).toEqual([false, false, false]);
      } finally {
        uncaught.stop();
      }
    });

    it("a promise inside a { readable, writable } stage does not escape either", async () => {
      const uncaught = watchUncaught();
      try {
        const nested = {
          readable: Promise.reject(new Error("nested failed")),
          writable: new S.PassThrough()
        };
        await expect(S.pipeline(S.Readable.from([1]), nested, 5)).rejects.toMatchObject({
          code: "ERR_INVALID_ARG_TYPE"
        });
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(uncaught.errors).toEqual([]);
      } finally {
        uncaught.stop();
      }
    });

    it("takes a thenable that calls back at once, which Duplex.from itself cannot", async () => {
      const out: unknown[] = [];
      const immediate = {
        then(resolve: (value: string) => void) {
          resolve("now");
        }
      };
      await S.pipeline(immediate, collector(S, out));
      expect(out).toEqual(["now"]);
    });

    it("an invalid side of a { readable, writable } object is found without touching the other", async () => {
      const readable = new ReadableStream();
      await expect(
        S.pipeline(S.Readable.from([1]), { readable, writable: 5 }, new S.PassThrough())
      ).rejects.toMatchObject({ code: "ERR_INVALID_ARG_TYPE" });
      expect(readable.locked).toBe(false);
    });

    it("a stage that fails once connected settles only after unconnected stages finished destroying", async () => {
      const destroyed = released();
      let destroyDone = false;
      const sink = new S.Writable({
        objectMode: true,
        write(_c: unknown, _e: string, cb: () => void) {
          cb();
        },
        destroy(err: Error | null, cb: (err: Error | null) => void) {
          setTimeout(() => {
            destroyDone = true;
            destroyed.release();
            cb(err);
          }, 30);
        }
      });
      const notIterable = () => 42;
      await expect(S.pipeline(S.Readable.from([1]), notIterable, sink)).rejects.toMatchObject({
        code: "ERR_INVALID_RETURN_VALUE"
      });
      expect(destroyDone).toBe(true);
      expect(sink.closed).toBe(true);
      await destroyed.promise;
    });
  });

  describe("readableFromWeb with an encoding in object mode", () => {
    it("fails the stream, not the process, on a chunk the decoder cannot take", async () => {
      // push() throws for it, inside a promise reaction: unhandled, that ends
      // the process. Node's own Readable.fromWeb lets it escape.
      const uncaught = watchUncaught();
      try {
        const source = new ReadableStream<unknown>({
          start(controller) {
            controller.enqueue("text");
            controller.enqueue({ not: "bytes" });
            controller.close();
          }
        });
        const readable = S.readableFromWeb(source, { objectMode: true, encoding: "utf8" });
        await expect(emitted(readable)).rejects.toMatchObject({ code: "ERR_INVALID_ARG_TYPE" });
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(uncaught.errors).toEqual([]);
        expect(source.locked).toBe(false);
      } finally {
        uncaught.stop();
      }
    });
  });

  describe("createReadableFromPromise", () => {
    it("settles once for a thenable that calls back twice", async () => {
      const readable = S.createReadableFromPromise({
        then(resolve: (value: string) => void) {
          resolve("first");
          resolve("second");
        }
      });
      expect(await emitted(readable)).toEqual(["first"]);
    });

    it("fails the stream, not the call, when then() throws", async () => {
      const readable = S.createReadableFromPromise({
        then() {
          throw new Error("then threw");
        }
      });
      await expect(emitted(readable)).rejects.toThrow("then threw");
    });

    it("pushes the value, not the promise", async () => {
      const readable = S.createReadableFromPromise(Promise.resolve("value"));
      expect(await emitted(readable)).toEqual(["value"]);
    });
  });

  describe("createTransform", () => {
    it("awaits a thenable the transform returns, as await would", async () => {
      const transform = S.createTransform(
        (n: number) => ({
          then(resolve: (value: number) => void) {
            resolve(n + 1);
          }
        }),
        { objectMode: true }
      );
      transform.end(1);
      expect(await emitted(transform)).toEqual([2]);
    });

    it("settles once for a thenable that calls back twice or throws after resolving", async () => {
      const transform = S.createTransform(
        (n: number) => ({
          then(resolve: (value: number) => void, reject: (error: Error) => void) {
            resolve(n);
            resolve(n + 100);
            reject(new Error("late"));
            throw new Error("later");
          }
        }),
        { objectMode: true }
      );
      transform.end(7);
      expect(await emitted(transform)).toEqual([7]);
    });
  });

  describe("pipeline of Web streams only", () => {
    it("settles only after the source has finished cancelling", async () => {
      const cancelStarted = released();
      const cancelGate = released();
      let cancelDone = false;
      const source = new ReadableStream({
        pull(controller) {
          controller.enqueue(1);
        },
        cancel() {
          cancelStarted.release();
          return cancelGate.promise.then(() => {
            cancelDone = true;
          });
        }
      });
      const sink = new WritableStream({
        write() {
          throw new Error("sink failed");
        }
      });
      const run = S.pipeline(source, new TransformStream(), new TransformStream(), sink);
      await cancelStarted.promise;
      expect(await settledWithin(run, 50)).toBe("hung");
      cancelGate.release();
      await expect(run).rejects.toThrow("sink failed");
      expect(cancelDone).toBe(true);
    });

    it("rejects an object that only looks like a Web stream instead of piping it natively", async () => {
      const lookalike = {
        getReader() {
          return { read: async () => ({ done: true, value: undefined }) };
        }
      };
      await expect(S.pipeline(lookalike, new WritableStream())).rejects.toMatchObject({
        code: "ERR_INVALID_ARG_TYPE"
      });
    });

    it("starts nothing when a stage is already locked", async () => {
      const source = webSource([1]);
      const middle = new TransformStream();
      const destination = new WritableStream();
      destination.getWriter();
      await expect(S.pipeline(source, middle, destination)).rejects.toThrow(TypeError);
      expect(source.locked).toBe(false);
      expect(middle.writable.locked).toBe(false);
    });
  });

  describe("toWritable", () => {
    it("destroy() aborts the underlying Web stream", async () => {
      const aborted = released();
      const ws = new WritableStream({
        abort() {
          aborted.release();
        }
      });
      const w = S.toWritable(ws);
      w.on("error", () => {});
      w.destroy(new Error("stop"));
      await aborted.promise;
    });
  });

  describe("safe Web conversions", () => {
    it("writableToWeb: a write made while 'drain' is pending still reaches _write", async () => {
      const got: unknown[] = [];
      const pending: Array<() => void> = [];
      const w = new S.Writable({
        objectMode: true,
        highWaterMark: 1,
        write(chunk: unknown, _e: string, cb: () => void) {
          got.push(chunk);
          pending.push(cb);
        }
      });
      w.write("a");
      const write = S.writableToWeb(w).getWriter().write("b");
      pending.shift()!();
      for (let i = 0; i < 10 && got.length < 2; i++) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      pending.splice(0).forEach(cb => cb());
      await write;
      expect(got).toEqual(["a", "b"]);
    });

    it("readableToWeb: strings from setEncoding() can be read later", async () => {
      const r = new S.Readable({ read() {} });
      r.setEncoding("utf8");
      const web = S.readableToWeb(r);
      r.push(new TextEncoder().encode("hi"));
      r.push(null);
      await new Promise(resolve => setTimeout(resolve, 0));
      let text = "";
      const reader = web.getReader();
      for (let x = await reader.read(); !x.done; x = await reader.read()) {
        text += x.value;
      }
      expect(text).toBe("hi");
    });

    it("readableFromWeb / writableFromWeb hand the lock back once done", async () => {
      const rs = webSource([1]);
      for await (const _ of S.readableFromWeb(rs, { objectMode: true })) {
        // drain
      }
      expect(rs.locked).toBe(false);

      const ws = new WritableStream();
      const w = S.writableFromWeb(ws);
      w.end("x");
      await S.finished(w);
      expect(ws.locked).toBe(false);
    });

    it("readableFromWeb fails on null instead of ending early", async () => {
      const r = S.readableFromWeb(webSource([null, 1]), { objectMode: true });
      await expect(r.toArray()).rejects.toMatchObject({ code: "ERR_STREAM_NULL_VALUES" });
    });
  });

  describe("isDisturbed on a Web stream", () => {
    it("tells a read or cancelled stream from a fresh one, without touching it", async () => {
      const fresh = webSource(["x"]);
      expect(S.isDisturbed(fresh)).toBe(false);
      // Probing neither locks nor consumes it.
      expect(fresh.locked).toBe(false);
      const reader = fresh.getReader();
      expect(await reader.read()).toEqual({ done: false, value: "x" });
      reader.releaseLock();
      expect(S.isDisturbed(fresh)).toBe(true);

      const cancelled = new ReadableStream();
      await cancelled.cancel();
      expect(S.isDisturbed(cancelled)).toBe(true);
    });

    it("reports a locked but unread stream as not disturbed", () => {
      const locked = new ReadableStream();
      locked.getReader();
      expect(S.isDisturbed(locked)).toBe(false);
    });
  });

  describe("round-five boundaries", () => {
    it("a destination that refuses a chunk settles only after the source finished cancelling", async () => {
      const cancelGate = released();
      let cancelDone = false;
      const source = new ReadableStream({
        start(controller) {
          controller.enqueue(null);
        },
        cancel() {
          return cancelGate.promise.then(() => {
            cancelDone = true;
          });
        }
      });
      const sink = collector(S, []);
      sink.on("error", () => {});
      const run = S.pipeline(source, sink);
      expect(await settledWithin(run, 50)).toBe("hung");
      cancelGate.release();
      await expect(run).rejects.toMatchObject({ code: "ERR_STREAM_NULL_VALUES" });
      expect(cancelDone).toBe(true);
    });

    it("compose with a Web tail: destroy closes it and hands the Web stream back", async () => {
      const tail = new TransformStream();
      const composed = S.compose(new S.PassThrough(), tail);
      composed.on("error", () => {});
      composed.resume();
      const closed = new Promise(resolve => composed.on("close", resolve));
      composed.destroy();
      await closed;
      expect(tail.readable.locked).toBe(false);
      expect(tail.writable.locked).toBe(false);
    });

    it("compose with a Web tail: a normal end hands the Web stream back too", async () => {
      const tail = new TransformStream();
      const composed = S.compose(new S.PassThrough(), tail);
      const out: number[] = [];
      composed.on("data", (chunk: Uint8Array) => out.push(...chunk));
      const closed = new Promise(resolve => composed.on("close", resolve));
      composed.end(new Uint8Array([1, 2]));
      await closed;
      expect(out).toEqual([1, 2]);
      expect(tail.readable.locked).toBe(false);
      expect(tail.writable.locked).toBe(false);
    });

    it("rejects a stream used twice before connecting anything", async () => {
      const source = new ReadableStream({
        pull(controller) {
          controller.enqueue(1);
        }
      });
      const middle = new TransformStream();
      await expect(S.pipeline(source, middle, middle, new WritableStream())).rejects.toThrow(
        TypeError
      );
      expect(source.locked).toBe(false);

      const through = new S.PassThrough({ objectMode: true });
      await expect(
        S.pipeline(S.Readable.from([1]), through, through, collector(S, []))
      ).rejects.toThrow(TypeError);
    });
  });

  describe("PullStream", () => {
    it("finds a pattern that arrives after the buffer was reallocated", async () => {
      const s = new S.PullStream();
      const enc = new TextEncoder();
      s.write(enc.encode("abc"));
      await s.pull(2);
      const pending = s.pullUntil(enc.encode("d"));
      s.write(enc.encode("de"));
      expect(new TextDecoder().decode(await pending)).toBe("c");
    });

    it("rejects a negative or fractional size", async () => {
      const s = new S.PullStream();
      await expect(s.pull(-1)).rejects.toThrow(RangeError);
      await expect(s.pull(1.5)).rejects.toThrow(RangeError);
    });
  });

  describe("SinkAdapter", () => {
    it("releases a Web sink after end(), and end() is one shared promise", async () => {
      const ws = new WritableStream({ write() {} });
      const adapter = new S.SinkAdapter(ws);
      await adapter.write(new Uint8Array([1]));
      const first = adapter.end();
      expect(adapter.end()).toBe(first);
      await first;
      expect(ws.locked).toBe(false);
    });

    it("treats a close before 'finish' as a premature close, not success", async () => {
      const w = new S.Writable({
        write(_c: unknown, _e: string, cb: () => void) {
          cb();
        },
        final() {
          // never finishes
        }
      });
      const adapter = new S.SinkAdapter(w);
      const ending = adapter.end();
      w.destroy();
      await expect(ending).rejects.toMatchObject({ code: "ERR_STREAM_PREMATURE_CLOSE" });
    });

    it("abort() aborts and releases a Web sink", async () => {
      const aborted = released();
      const ws = new WritableStream({
        abort() {
          aborted.release();
        }
      });
      const adapter = new S.SinkAdapter(ws);
      await adapter.abort(new Error("producer failed"));
      await aborted.promise;
      expect(ws.locked).toBe(false);
    });
  });

  /**
   * Every place the module takes a Web reader or writer, driven down the error
   * path: the Web stream underneath fails. Whoever took the lock must hand it
   * back there too, not only on a clean end or a cancel.
   */
  describe("lock audit: the Web side fails", () => {
    const failingSource = (): ReadableStream<Uint8Array> => {
      let n = 0;
      return new ReadableStream({
        pull(controller) {
          if (n++ < 2) {
            controller.enqueue(new Uint8Array([n]));
          } else {
            controller.error(new Error("source broke"));
          }
        }
      });
    };
    const failingSink = (): WritableStream<Uint8Array> =>
      new WritableStream({
        write() {
          throw new Error("sink broke");
        }
      });
    const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 20));

    it("readableFromWeb", async () => {
      const rs = failingSource();
      const r = S.readableFromWeb(rs);
      r.on("error", () => {});
      r.resume();
      await settle();
      expect(rs.locked).toBe(false);
    });

    it("writableFromWeb", async () => {
      const ws = failingSink();
      const w = S.writableFromWeb(ws);
      w.on("error", () => {});
      w.write(new Uint8Array([1]));
      await settle();
      expect(ws.locked).toBe(false);
    });

    it("pipeline from a failing Web source", async () => {
      const rs = failingSource();
      const sink = new S.Writable({
        write(_c: unknown, _e: string, cb: () => void) {
          cb();
        }
      });
      await expect(S.pipeline(rs, sink)).rejects.toThrow("source broke");
      expect(rs.locked).toBe(false);
    });

    it("pipeline into a failing Web sink", async () => {
      const ws = failingSink();
      await expect(S.pipeline(S.Readable.from([new Uint8Array([1])]), ws)).rejects.toThrow(
        "sink broke"
      );
      expect(ws.locked).toBe(false);
    });

    it("all-Web pipeline from a failing source", async () => {
      const rs = failingSource();
      const ws = new WritableStream();
      await expect(S.pipeline(rs, ws)).rejects.toThrow("source broke");
      expect(rs.locked || ws.locked).toBe(false);
    });

    it("compose with a failing Web tail", async () => {
      const tail = new TransformStream({
        transform() {
          throw new Error("tail broke");
        }
      });
      const composed = S.compose(new S.PassThrough(), tail);
      composed.on("error", () => {});
      composed.resume();
      const closed = new Promise(resolve => composed.on("close", resolve));
      composed.write(new Uint8Array([1]));
      await closed;
      expect(tail.readable.locked || tail.writable.locked).toBe(false);
    });

    it("SinkAdapter over a failing Web sink", async () => {
      const ws = failingSink();
      const adapter = new S.SinkAdapter(ws);
      await expect(adapter.write(new Uint8Array([1]))).rejects.toThrow("sink broke");
      await settle();
      expect(ws.locked).toBe(false);
    });

    it("readableStreamToAsyncIterable over a failing source", async () => {
      const rs = failingSource();
      await expect(
        (async () => {
          for await (const _ of S.readableStreamToAsyncIterable(rs)) {
            // drain
          }
        })()
      ).rejects.toThrow("source broke");
      expect(rs.locked).toBe(false);
    });
  });
}

/**
 * Places where the browser kernel's classes do better than, or differ by
 * necessity from, the Node entry's native ones; run against the browser entry.
 */
export function runBrowserKernelContractTests(S: Api): void {
  describe("Duplex.fromWeb (browser kernel)", () => {
    it("cancels the readable side when the writable side fails", async () => {
      const cancelled = released();
      const readable = new ReadableStream({
        cancel() {
          cancelled.release();
        }
      });
      const writable = new WritableStream({
        write() {
          throw new Error("write failed");
        }
      });
      const duplex = S.Duplex.fromWeb({ readable, writable }, { objectMode: true });
      duplex.on("error", () => {});
      duplex.write("x");
      await cancelled.promise;
    });
  });

  describe("Web adapters (browser kernel)", () => {
    it("fromWeb leaves the stream unlocked when it cannot adapt it", () => {
      const rs = new ReadableStream();
      expect(() => S.Readable.fromWeb(rs, { highWaterMark: -1 })).toThrow();
      expect(rs.locked).toBe(false);

      const readable = new ReadableStream();
      const writable = new WritableStream();
      const reader = readable.getReader();
      expect(() => S.Duplex.fromWeb({ readable, writable })).toThrow(TypeError);
      expect(writable.locked).toBe(false);
      reader.releaseLock();
    });

    it("readableFromWeb with an already-aborted signal cancels and releases the source", async () => {
      const cancelled = released();
      const rs = new ReadableStream({
        cancel() {
          cancelled.release();
        }
      });
      const ac = new AbortController();
      ac.abort();
      const r = S.readableFromWeb(rs, { signal: ac.signal });
      r.on("error", () => {});
      await cancelled.promise;
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(r.destroyed).toBe(true);
      expect(rs.locked).toBe(false);
    });

    it("readableToWeb / writableToWeb remove their listeners from the source once done", async () => {
      const r = new S.Readable({ objectMode: true, read() {} });
      const web = S.readableToWeb(r);
      expect(r.listenerCount("data")).toBe(1);
      await web.cancel();
      expect(r.listenerCount("data")).toBe(0);

      const w = new S.Writable({
        objectMode: true,
        write(_c: unknown, _e: string, cb: () => void) {
          cb();
        }
      });
      await S.writableToWeb(w).getWriter().close();
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(w.listenerCount("drain")).toBe(0);
    });
  });

  describe("finished() on a Web stream", () => {
    it("refuses any Web stream at once and leaves it unlocked", async () => {
      // Even one from Readable.toWeb: its Node-style side ending says nothing
      // about whether the Web queue has been drained.
      for (const rs of [webSource([1]), S.Readable.toWeb(S.Readable.from(["a"]))]) {
        await expect(S.finished(rs)).rejects.toThrow(TypeError);
        expect(rs.locked).toBe(false);
      }
    });
  });
}

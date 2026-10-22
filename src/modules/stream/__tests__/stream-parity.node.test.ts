/**
 * Behaviour the browser kernel must share with `node:stream`.
 *
 * Every scenario runs against the Node entry (native `node:stream`) and the
 * browser entry (the kernel), so a case that passes only on one of them is a bug in the
 * kernel — or a wrong expectation — rather than a platform difference. Each
 * one is a regression the previous browser implementation got wrong.
 */
import * as nodeEntry from "@stream/index";
import * as browserEntry from "@stream/index.browser";
import { describe, expect, it } from "vitest";

const implementations = [
  ["node:stream", nodeEntry],
  ["browser kernel", browserEntry]
] as const;

type Impl = any;

const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));

describe.each(implementations)("stream parity (%s)", (_name, S: Impl) => {
  it("duplexPair: a write blocked by backpressure completes once the peer reads", async () => {
    const [a, b] = S.duplexPair({ objectMode: true, highWaterMark: 1 });
    let written = false;
    a.write({ n: 1 }, () => {
      written = true;
    });
    await tick();
    expect(written).toBe(false);
    expect(b.read()).toEqual({ n: 1 });
    await tick();
    expect(written).toBe(true);
  });

  it("pipeline: a Transform followed by a generator stage stays connected", async () => {
    const out: number[] = [];
    await new Promise<void>((resolve, reject) => {
      S.pipeline(
        S.Readable.from([1, 2]),
        new S.Transform({
          objectMode: true,
          transform(n: number, _e: string, cb: (e: null, v: number) => void) {
            cb(null, n * 2);
          }
        }),
        async function* (source: AsyncIterable<number>) {
          for await (const n of source) {
            yield n + 1;
          }
        },
        new S.Writable({
          objectMode: true,
          write(n: number, _e: string, cb: () => void) {
            out.push(n);
            cb();
          }
        }),
        (err?: Error | null) => (err ? reject(err) : resolve())
      );
    });
    expect(out).toEqual([3, 5]);
  });

  it("Readable.from: leaving early runs the source's finally block", async () => {
    let finalized = false;
    async function* source() {
      try {
        yield 1;
        yield 2;
      } finally {
        finalized = true;
      }
    }
    for await (const _ of S.Readable.from(source())) {
      break;
    }
    await tick();
    expect(finalized).toBe(true);
  });

  it("Writable.toWeb: writes and close go through the Writable's own state", async () => {
    const seen: number[] = [];
    const w = new S.Writable({
      objectMode: true,
      write(n: number, _e: string, cb: () => void) {
        seen.push(n);
        cb();
      }
    });
    const writer = S.Writable.toWeb(w).getWriter();
    await writer.write(1);
    await writer.close();
    expect(seen).toEqual([1]);
    expect(w.writableEnded).toBe(true);
    expect(w.writableFinished).toBe(true);
  });

  it("uncork: _writev waits for the _write already in progress", async () => {
    const calls: string[] = [];
    let release: (() => void) | undefined;
    const w = new S.Writable({
      objectMode: true,
      write(chunk: string, _e: string, cb: () => void) {
        calls.push(`write:${chunk}`);
        release = cb;
      },
      writev(chunks: Array<{ chunk: string }>, cb: () => void) {
        calls.push(`writev:${chunks.map(c => c.chunk).join(",")}`);
        cb();
      }
    });
    w.write("a");
    w.cork();
    w.write("b");
    w.write("c");
    w.uncork();
    expect(calls).toEqual(["write:a"]);
    release!();
    await tick();
    expect(calls).toEqual(["write:a", "writev:b,c"]);
  });

  it("pipe: a source with two destinations resumes only after both drain", async () => {
    let i = 0;
    const src = new S.Readable({
      objectMode: true,
      highWaterMark: 1,
      read(this: any) {
        this.push(i++ < 100 ? i : null);
      }
    });
    const pending: Array<() => void> = [];
    const slow = () =>
      new S.Writable({
        objectMode: true,
        highWaterMark: 1,
        write(_c: unknown, _e: string, cb: () => void) {
          pending.push(cb);
        }
      });
    const a = slow();
    const b = slow();
    src.pipe(a);
    src.pipe(b);
    await tick();

    // Release only A: B is still full, so the source must stay paused.
    while (pending.length) {
      pending.shift()!();
      await tick();
      if (a.writableLength === 0) {
        break;
      }
    }
    expect(b.writableLength).toBeGreaterThan(0);
    expect(src.isPaused()).toBe(true);
    src.unpipe();
  });

  it("Readable.fromWeb: iterator({ destroyOnReturn: false }) reads the source", async () => {
    const web = new ReadableStream({
      start(controller) {
        controller.enqueue(1);
        controller.enqueue(2);
        controller.close();
      }
    });
    const r = S.Readable.fromWeb(web, { objectMode: true });
    const got: number[] = [];
    for await (const n of r.iterator({ destroyOnReturn: false })) {
      got.push(n);
    }
    expect(got).toEqual([1, 2]);
  });

  it("Readable.fromWeb: destroy() before any read cancels the source", async () => {
    let cancelled = false;
    const web = new ReadableStream({
      cancel() {
        cancelled = true;
      }
    });
    const r = S.Readable.fromWeb(web);
    r.destroy();
    await tick();
    expect(cancelled).toBe(true);
  });

  it("write(): the callback of a synchronous _write never runs inside write()", async () => {
    let called = false;
    const w = new S.Writable({
      write(_c: unknown, _e: string, cb: () => void) {
        cb();
      }
    });
    w.write("x", () => {
      called = true;
    });
    expect(called).toBe(false);
    await tick();
    expect(called).toBe(true);
  });

  it("createDuplex: per-side highWaterMark is honoured", () => {
    const d = S.createDuplex({
      objectMode: true,
      readableHighWaterMark: 2,
      writableHighWaterMark: 3,
      read() {},
      write(_c: unknown, _e: string, cb: () => void) {
        cb();
      }
    });
    expect(d.readableHighWaterMark).toBe(2);
    expect(d.writableHighWaterMark).toBe(3);
  });

  describe("pipeline of Web streams only", () => {
    const source = (values: number[]) =>
      new ReadableStream<number>({
        start(controller) {
          for (const v of values) {
            controller.enqueue(v);
          }
          controller.close();
        }
      });
    const double = () =>
      new TransformStream<number, number>({
        transform(n, controller) {
          controller.enqueue(n * 2);
        }
      });
    const sink = (out: number[]) =>
      new WritableStream<number>({
        write(n) {
          out.push(n);
        }
      });

    it("runs to completion", async () => {
      const out: number[] = [];
      await S.pipeline(source([1, 2, 3]), double(), sink(out));
      expect(out).toEqual([2, 4, 6]);
    });

    it("rejects with the error a stage raised", async () => {
      const failing = new TransformStream<number, number>({
        transform() {
          throw new Error("stage failed");
        }
      });
      await expect(S.pipeline(source([1]), failing, sink([]))).rejects.toThrow("stage failed");
    });

    it("rejects with an AbortError when the signal aborts", async () => {
      const ac = new AbortController();
      const never = new ReadableStream<number>({ pull() {} });
      const run = S.pipeline(never, sink([]), { signal: ac.signal });
      ac.abort();
      await expect(run).rejects.toMatchObject({ name: "AbortError" });
    });
  });

  it("read(): data a synchronous _read pushes is returned by that read()", () => {
    const r = new S.Readable({
      objectMode: true,
      read(this: any) {
        this.push("x");
      }
    });
    expect(r.read()).toBe("x");
  });
});

describe("BufferedStream", () => {
  it("keeps write order when reads and writes interleave", () => {
    const s = new nodeEntry.BufferedStream();
    s.write(new Uint8Array([1, 2, 3, 4]));
    expect(Array.from(s.read(1)!)).toEqual([1]);
    s.write(new Uint8Array([5]));
    expect(Array.from(s.toUint8Array())).toEqual([2, 3, 4, 5]);
  });
});

describe("PullStream", () => {
  it("keeps its buffer proportional to the data held, not to the data passed through", async () => {
    const s = new nodeEntry.PullStream();
    const chunk = new Uint8Array(1000);
    for (let i = 0; i < 20_000; i++) {
      s.write(chunk);
      await s.pull(i === 0 ? 500 : 1000);
    }
    expect(s.length).toBe(500);
    // Internal capacity; it used to double on every reallocation and reach ~16 MB here.
    expect((s as unknown as { _buffer: Uint8Array })._buffer.length).toBeLessThan(64 * 1024);
  });
});

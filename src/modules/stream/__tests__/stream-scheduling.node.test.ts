/**
 * The scheduling contract, checked against Node itself.
 *
 * The browser has no `process.nextTick` that runs ahead of promise reactions,
 * so the kernel cannot reproduce every interleaving of stream events with a
 * caller's own `await` / `.then()` callbacks — that much is a documented
 * platform difference. What it must reproduce exactly is the order of the
 * stream's own events and callbacks relative to each other, because code
 * relies on it: a write callback before 'finish', 'finish' before 'close',
 * 'error' before 'close', 'end' only after the last 'data'. Each scenario
 * records that sequence under `node:stream` and under the kernel and requires
 * them to be identical.
 */
import * as nodeStream from "node:stream";

import * as kernel from "@stream/index.browser";
import { nextTick as kernelNextTick } from "@stream/kernel/state";
import { describe, expect, it } from "vitest";

type Api = any;

const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 20));

function track(stream: any, log: string[], events: string[]): void {
  for (const event of events) {
    stream.on(event, (arg?: unknown) => {
      log.push(event === "data" ? `data:${String(arg)}` : event);
    });
  }
}

const scenarios: Record<string, (S: Api) => Promise<string[]>> = {
  async "Writable: write callbacks, end callback, finish, close"(S) {
    const log: string[] = [];
    const w = new S.Writable({
      objectMode: true,
      write(chunk: unknown, _e: string, cb: () => void) {
        log.push(`_write:${String(chunk)}`);
        cb();
      }
    });
    track(w, log, ["drain", "prefinish", "finish", "close"]);
    w.write("a", () => log.push("cb:a"));
    w.write("b", () => log.push("cb:b"));
    w.end(() => log.push("cb:end"));
    log.push("sync-return");
    await settle();
    return log;
  },

  async "Writable with backpressure: drain after the queue empties"(S) {
    const log: string[] = [];
    const w = new S.Writable({
      objectMode: true,
      highWaterMark: 1,
      write(chunk: unknown, _e: string, cb: () => void) {
        log.push(`_write:${String(chunk)}`);
        setTimeout(cb, 0);
      }
    });
    track(w, log, ["drain", "finish", "close"]);
    log.push(`write:a=${w.write("a")}`);
    log.push(`write:b=${w.write("b")}`);
    // Wait on the events, not a timer: each write completes on its own timer.
    await new Promise(resolve => w.once("drain", resolve));
    w.end();
    await new Promise(resolve => w.once("close", resolve));
    await settle();
    return log;
  },

  async "Readable: data, end, close"(S) {
    const log: string[] = [];
    const r = new S.Readable({
      objectMode: true,
      read() {
        this.push(1);
        this.push(2);
        this.push(null);
      }
    });
    track(r, log, ["data", "end", "close", "pause", "resume"]);
    await settle();
    return log;
  },

  async "Readable: 'readable' and read()"(S) {
    const log: string[] = [];
    const r = new S.Readable({ objectMode: true, read() {} });
    r.on("readable", () => {
      log.push("readable");
      for (let chunk = r.read(); chunk !== null; chunk = r.read()) {
        log.push(`read:${String(chunk)}`);
      }
    });
    track(r, log, ["end", "close"]);
    r.push("a");
    r.push("b");
    await settle();
    r.push(null);
    await settle();
    return log;
  },

  async "Transform: both sides' events"(S) {
    const log: string[] = [];
    const t = new S.Transform({
      objectMode: true,
      transform(chunk: string, _e: string, cb: (e: null, v: string) => void) {
        cb(null, chunk.toUpperCase());
      },
      flush(cb: () => void) {
        log.push("flush");
        cb();
      }
    });
    track(t, log, ["data", "prefinish", "finish", "end", "close"]);
    t.write("a");
    t.write("b");
    t.end();
    await settle();
    return log;
  },

  async "destroy(error): error before close"(S) {
    const log: string[] = [];
    const r = new S.Readable({ read() {} });
    r.on("error", (err: Error) => log.push(`error:${err.message}`));
    track(r, log, ["end", "close"]);
    r.destroy(new Error("boom"));
    log.push("sync-return");
    await settle();
    return log;
  },

  async "pipe: source end, destination finish, both close"(S) {
    const log: string[] = [];
    const src = new S.Readable({
      objectMode: true,
      read() {
        this.push("x");
        this.push(null);
      }
    });
    const dst = new S.Writable({
      objectMode: true,
      write(chunk: unknown, _e: string, cb: () => void) {
        log.push(`dst:_write:${String(chunk)}`);
        cb();
      }
    });
    src.on("end", () => log.push("src:end"));
    src.on("close", () => log.push("src:close"));
    dst.on("pipe", () => log.push("dst:pipe"));
    dst.on("unpipe", () => log.push("dst:unpipe"));
    dst.on("finish", () => log.push("dst:finish"));
    dst.on("close", () => log.push("dst:close"));
    src.pipe(dst);
    await settle();
    return log;
  },

  async "Duplex with allowHalfOpen: false ends its writable side after 'end'"(S) {
    const log: string[] = [];
    const d = new S.Duplex({
      objectMode: true,
      allowHalfOpen: false,
      read() {},
      write(_c: unknown, _e: string, cb: () => void) {
        cb();
      }
    });
    track(d, log, ["end", "prefinish", "finish", "close"]);
    d.resume();
    d.push(null);
    await settle();
    return log;
  },

  async "Writable in byte mode: callbacks, drain, finish"(S) {
    const log: string[] = [];
    const w = new S.Writable({
      highWaterMark: 2,
      write(chunk: Uint8Array, _e: string, cb: () => void) {
        log.push(`_write:${chunk.length}`);
        cb();
      }
    });
    track(w, log, ["drain", "prefinish", "finish", "close"]);
    log.push(`write=${w.write(new Uint8Array(3), () => log.push("cb:1"))}`);
    log.push(`write=${w.write(new Uint8Array(1))}`);
    w.end(new Uint8Array(1), () => log.push("cb:end"));
    await settle();
    return log;
  },

  async "cork / uncork with _writev"(S) {
    const log: string[] = [];
    const w = new S.Writable({
      objectMode: true,
      write(chunk: unknown, _e: string, cb: () => void) {
        log.push(`_write:${String(chunk)}`);
        cb();
      },
      writev(chunks: Array<{ chunk: unknown }>, cb: () => void) {
        log.push(`_writev:${chunks.map(c => String(c.chunk)).join(",")}`);
        cb();
      }
    });
    track(w, log, ["finish", "close"]);
    w.cork();
    w.write("a", () => log.push("cb:a"));
    w.write("b", () => log.push("cb:b"));
    w.uncork();
    w.write("c", () => log.push("cb:c"));
    w.end();
    await settle();
    return log;
  },

  async "_write error: callback, error, close"(S) {
    const log: string[] = [];
    const w = new S.Writable({
      objectMode: true,
      write(_c: unknown, _e: string, cb: (err: Error) => void) {
        cb(new Error("nope"));
      }
    });
    w.on("error", (err: Error) => log.push(`error:${err.message}`));
    track(w, log, ["finish", "close"]);
    w.write("a", (err?: Error | null) => log.push(`cb:${err?.message}`));
    w.write("b", (err?: Error | null) => log.push(`cb2:${(err as { code?: string })?.code}`));
    await settle();
    return log;
  },

  async "_construct delays the first _read and _write"(S) {
    const log: string[] = [];
    const d = new S.Duplex({
      objectMode: true,
      construct(cb: () => void) {
        log.push("construct");
        setTimeout(() => {
          log.push("constructed");
          cb();
        }, 0);
      },
      read() {
        log.push("_read");
        this.push(null);
      },
      write(chunk: unknown, _e: string, cb: () => void) {
        log.push(`_write:${String(chunk)}`);
        cb();
      }
    });
    track(d, log, ["end", "finish", "close"]);
    d.write("a");
    d.end();
    d.resume();
    await settle();
    return log;
  },

  async "unshift and setEncoding"(S) {
    const log: string[] = [];
    const r = new S.Readable({ read() {} });
    r.setEncoding("utf8");
    r.push(new TextEncoder().encode("hello"));
    const first = r.read(2);
    log.push(`read:${first}`);
    r.unshift(first);
    log.push(`read:${r.read()}`);
    r.push(null);
    track(r, log, ["end", "close"]);
    r.resume();
    await settle();
    return log;
  },

  async "unpipe mid-stream pauses the source"(S) {
    const log: string[] = [];
    let i = 0;
    const src = new S.Readable({
      objectMode: true,
      read() {
        this.push(i < 5 ? i++ : null);
      }
    });
    const dst = new S.Writable({
      objectMode: true,
      write(chunk: unknown, _e: string, cb: () => void) {
        log.push(`_write:${String(chunk)}`);
        if (chunk === 1) {
          src.unpipe(dst);
        }
        cb();
      }
    });
    dst.on("unpipe", () => log.push("unpipe"));
    src.on("pause", () => log.push("pause"));
    src.pipe(dst);
    await settle();
    log.push(`flowing:${String(src.readableFlowing)}`);
    return log;
  }
};

describe("stream event order matches node:stream", () => {
  for (const [name, run] of Object.entries(scenarios)) {
    it(name, async () => {
      const expected = await run(nodeStream);
      expect(await run(kernel)).toEqual(expected);
    });
  }
});

/**
 * Interleaving with the caller's own `await` is where the browser is allowed
 * to differ: Node runs a promise continuation ahead of a tick queued from a
 * microtask, and no browser API can. Making the kernel defer ticks by an extra
 * microtask would match this case and break the opposite one — a tick queued
 * in synchronous code, which Node runs ahead of promises queued after it.
 * Only the invariants are checked: every chunk, in order; 'end' before 'close';
 * the loop finishing after both.
 */
describe("stream events around a caller's await (invariants only)", () => {
  it.each([
    ["node:stream", nodeStream],
    ["browser kernel", kernel]
  ] as const)("async iteration (%s)", async (_name, S: Api) => {
    const log: string[] = [];
    const r = S.Readable.from(["a", "b"]);
    track(r, log, ["end", "close"]);
    for await (const chunk of r) {
      log.push(`iter:${String(chunk)}`);
    }
    log.push("loop-done");
    await settle();
    expect(log.filter(e => e.startsWith("iter:"))).toEqual(["iter:a", "iter:b"]);
    expect(log.indexOf("end")).toBeLessThan(log.indexOf("close"));
    expect(log.indexOf("close")).toBeLessThan(log.indexOf("loop-done"));
  });
});

/**
 * Why the difference is a platform limit and not a missing trick, measured
 * rather than asserted. Node runs a tick queued from a task (an event handler,
 * a timer, I/O) before promise reactions, and a tick queued from inside a
 * promise continuation only once the whole microtask queue is empty. A
 * browser can schedule after a fixed number of microtasks or after a task,
 * and cannot tell which context it is in. The kernel takes one microtask,
 * which is exact for the first case; the second would need "after the
 * microtask queue drains", which no fixed hop reaches (a longer promise chain
 * always overtakes it) and a task overshoots (other tasks run first).
 */
describe("tick placement against promise reactions", () => {
  type Tick = (fn: () => void) => void;
  const ticks: Array<[string, Tick]> = [
    ["node", fn => process.nextTick(fn)],
    ["kernel", kernelNextTick]
  ];

  async function fromTask(tick: Tick): Promise<string[]> {
    const log: string[] = [];
    await new Promise<void>(resolve =>
      setTimeout(() => {
        tick(() => log.push("tick"));
        Promise.resolve()
          .then(() => log.push("p1"))
          .then(() => log.push("p2"));
        resolve();
      }, 0)
    );
    await settle();
    return log;
  }

  async function fromContinuation(tick: Tick): Promise<string[]> {
    const log: string[] = [];
    await new Promise<void>(resolve =>
      setTimeout(async () => {
        await Promise.resolve();
        tick(() => log.push("tick"));
        await Promise.resolve();
        log.push("c1");
        await Promise.resolve();
        log.push("c2");
        resolve();
      }, 0)
    );
    await settle();
    return log;
  }

  it.each(ticks)("from a task, the tick runs before promise reactions (%s)", async (_n, tick) => {
    expect(await fromTask(tick)).toEqual(["tick", "p1", "p2"]);
  });

  it("from a promise continuation, Node runs the tick only after the microtask queue drains", async () => {
    expect(await fromContinuation(fn => process.nextTick(fn))).toEqual(["c1", "c2", "tick"]);
  });

  it("from a promise continuation, the kernel runs the tick on the next microtask", async () => {
    expect(await fromContinuation(kernelNextTick)).toEqual(["tick", "c1", "c2"]);
  });
});

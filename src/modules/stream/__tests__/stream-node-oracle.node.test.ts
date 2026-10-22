/**
 * `node:stream` as the oracle. The classes are Node's on both entries —
 * `node:stream` itself on the Node entry, a port in the browser — so the same
 * call must give the same result on all three.
 *
 * The broad sweep reduces each outcome (a throw, the stream's shape, what it
 * yields or how it fails) to a string and compares them; the cases after it
 * pin specific behaviour, Node's defects included, that the browser port must
 * reproduce. Behaviour the module defines itself is not here: see
 * stream-contract.shared.ts.
 */

import * as nodeStream from "node:stream";

import { released, webSource } from "@stream/__tests__/stream-contract.shared";
import * as nodeEntry from "@stream/index";
import * as browserEntry from "@stream/index.browser";
import { describe, expect, it } from "vitest";

type Api = any;

const entries = [
  ["node entry", nodeEntry],
  ["browser entry", browserEntry]
] as const;

const web = (values: unknown[]): ReadableStream<unknown> =>
  new ReadableStream({
    start(controller) {
      for (const value of values) {
        controller.enqueue(value);
      }
      controller.close();
    }
  });

const describeValue = (v: unknown): string =>
  v instanceof Uint8Array ? `u8[${[...v]}]` : typeof v === "string" ? JSON.stringify(v) : String(v);

const errorCode = (error: unknown): string =>
  String((error as { code?: string; name?: string }).code ?? (error as Error).name);

const within = <T>(promise: Promise<T>, fallback: T): Promise<T> =>
  Promise.race([promise, new Promise<T>(resolve => setTimeout(() => resolve(fallback), 100))]);

async function drain(iterable: AsyncIterable<unknown>): Promise<string> {
  const out: string[] = [];
  try {
    const finished = await within(
      (async () => {
        for await (const value of iterable) {
          out.push(describeValue(value));
        }
        return true;
      })(),
      false
    );
    return out.join(",") + (finished ? "" : ",<pending>");
  } catch (error) {
    return `${out.join(",")} err:${errorCode(error)}`;
  }
}

async function outcomeOfNodeStyle(make: () => any): Promise<string> {
  let s: any;
  try {
    s = make();
  } catch (error) {
    return `throw:${errorCode(error)}`;
  }
  const shape = `r=${s.readable} w=${s.writable} om=${s.readableObjectMode}`;
  if (!s.readable) {
    let event = "";
    s.on("error", (error: unknown) => (event = ` error:${errorCode(error)}`));
    s.destroy();
    await new Promise(resolve => setTimeout(resolve, 10));
    return shape + event;
  }
  if (s.writable) {
    s.end();
  }
  return `${shape} ${await drain(s)}`;
}

async function outcomeOfWeb(make: () => any): Promise<string> {
  let w: any;
  try {
    w = make();
  } catch (error) {
    return `throw:${errorCode(error)}`;
  }
  if (w instanceof ReadableStream) {
    return `RS ${await drain(w as unknown as AsyncIterable<unknown>)}`;
  }
  if (w instanceof WritableStream) {
    const writer = w.getWriter();
    const result = writer
      .write(new Uint8Array([1]))
      .then(() => writer.close())
      .then(
        () => "ok",
        error => `err:${errorCode(error)}`
      );
    return `WS ${await within(result, "<pending>")}`;
  }
  return w?.readable && w?.writable ? "pair" : typeof w;
}

const sources: Record<string, () => unknown> = {
  "web bytes": () => web([new Uint8Array([1])]),
  "web numbers": () => web([1, 2]),
  "web with null": () => web([1, null, 2]),
  Blob: () => new Blob(["ab"]),
  string: () => "ab",
  array: () => [1, 2],
  Uint8Array: () => new Uint8Array([1, 2]),
  ArrayBuffer: () => new ArrayBuffer(2),
  promise: () => Promise.resolve("x"),
  "async generator": () =>
    (async function* () {
      yield "a";
    })(),
  TransformStream: () => new TransformStream(),
  WritableStream: () => new WritableStream(),
  null: () => null,
  number: () => 5
};

const factories: Record<string, (S: Api, v: unknown) => unknown> = {
  "Readable.from": (S, v) => S.Readable.from(v),
  "Duplex.from": (S, v) => S.Duplex.from(v),
  "Duplex.fromWeb": (S, v) => S.Duplex.fromWeb(v, { objectMode: true }),
  compose: (S, v) => S.compose(v),
  "compose with a PassThrough": (S, v) => S.compose(v, new S.PassThrough({ objectMode: true }))
};

const nodeStyleStreams: Record<string, (S: Api) => unknown> = {
  "object-mode Readable": S => S.Readable.from(["a", "b"]),
  "byte Readable": S => S.Readable.from([new Uint8Array([1])], { objectMode: false }),
  Writable: S =>
    new S.Writable({
      write(_c: unknown, _e: string, cb: () => void) {
        cb();
      }
    }),
  PassThrough: S => new S.PassThrough(),
  "destroyed Readable": S => {
    const r = S.Readable.from(["a"]);
    r.destroy();
    return r;
  },
  "ended Writable": S => {
    const w = new S.Writable({
      write(_c: unknown, _e: string, cb: () => void) {
        cb();
      }
    });
    w.end();
    return w;
  }
};

/** The source's listeners once the Web side is done, by event. */
const listenersOf = (s: any): string =>
  ["data", "drain", "error", "end", "finish", "close"]
    .map(event => `${event}:${s.listenerCount(event)}`)
    .join(" ");

const converters: Record<string, (S: Api, s: unknown) => unknown> = {
  "Readable.toWeb": (S, s) => S.Readable.toWeb(s),
  "Writable.toWeb": (S, s) => S.Writable.toWeb(s),
  "Duplex.toWeb": (S, s) => S.Duplex.toWeb(s)
};

const apis: Api[] = [nodeStream, nodeEntry, browserEntry];

/**
 * The oracle is whatever Node runs the tests, and the kernel is a port of Node
 * v26.8.1. Where an older supported line still behaves differently, the kernel
 * is held to the v26 outcome recorded here and the Node entry to its host —
 * which is that host's own classes. The line is not drawn by version number:
 * Node 24 picked these up part-way through its 24.x releases.
 */
const KERNEL_BASELINE: Record<string, string> = {
  // Earlier lines end the Web stream cleanly instead.
  "Readable.toWeb(destroyed Readable)":
    "RS  err:ABORT_ERR | data:0 drain:0 error:1 end:0 finish:0 close:0",
  // Earlier lines do not validate `options`.
  "Readable.toWeb(readable, 5)":
    "Bun" in globalThis
      ? "TypeError ERR_INVALID_ARG_TYPE"
      : 'TypeError ERR_INVALID_ARG_TYPE: The "options" argument must be of type object. Received type number (5)'
};

/**
 * Cases where a chunk is pushed from inside a promise continuation and the
 * source fails a few microtasks later. Node runs the 'readable' tick only once
 * the microtask queue drains, so the failure gets there first and the chunk is
 * dropped; no browser primitive can wait for that, so the kernel delivers the
 * chunk and then the same error. See "tick placement against promise
 * reactions" in stream-scheduling.node.test.ts.
 */
const SCHEDULING_LIMITED = new Map<string, string[]>([
  // What the source emits before it fails: `1`, then the null that fails it.
  ["compose with a PassThrough(web with null)", ["1"]]
]);

/** An outcome split into the stream's shape, the chunks it yielded, and how it failed. */
function parseOutcome(outcome: string): { shape: string; chunks: string[]; error?: string } {
  const match = /^(r=\S+ w=\S+ om=\S+) (.*?)(?: ?err:(\S+))?$/.exec(outcome);
  if (!match) {
    throw new Error(`unexpected outcome: ${outcome}`);
  }
  const [, shape, data, error] = match;
  return { shape, chunks: data ? data.split(",") : [], error };
}

const isPrefix = (prefix: string[], of: string[]): boolean =>
  prefix.length <= of.length && prefix.every((chunk, i) => chunk === of[i]);

describe("class statics give node:stream's result on every entry", () => {
  for (const [name, factory] of Object.entries(factories)) {
    it.each(Object.keys(sources))(`${name}(%s)`, async source => {
      const [native, nodeOutcome, browserOutcome] = await Promise.all(
        apis.map(S => outcomeOfNodeStyle(() => factory(S, sources[source]())))
      );
      expect(nodeOutcome).toBe(native);
      const emitted = SCHEDULING_LIMITED.get(`${name}(${source})`);
      if (emitted) {
        // Same stream, same failure. The kernel may hand over chunks that had
        // already arrived before the error does — only more of them than Node,
        // and only ones the source really emitted, in order.
        const expected = parseOutcome(native);
        const actual = parseOutcome(browserOutcome);
        expect(expected.error).toBeDefined();
        expect([actual.shape, actual.error]).toEqual([expected.shape, expected.error]);
        expect(isPrefix(expected.chunks, actual.chunks)).toBe(true);
        expect(isPrefix(actual.chunks, emitted)).toBe(true);
      } else {
        expect(browserOutcome).toBe(native);
      }
    });
  }

  for (const [name, convert] of Object.entries(converters)) {
    it.each(Object.keys(nodeStyleStreams))(`${name}(%s)`, async stream => {
      const [native, ...ours] = await Promise.all(
        apis.map(async S => {
          const source = nodeStyleStreams[stream](S);
          const outcome = await outcomeOfWeb(() => convert(S, source));
          return `${outcome} | ${listenersOf(source)}`;
        })
      );
      expect(ours[0]).toBe(native);
      expect(ours[1]).toBe(KERNEL_BASELINE[`${name}(${stream})`] ?? native);
    });
  }
});

describe.each([
  ["node:stream", nodeStream],
  ["browser kernel", browserEntry]
] as const)("Writable._writev (Node oracle: %s)", (_name, S: Api) => {
  it("runs every write callback once even if _writev consumes its array", async () => {
    const callbacks: string[] = [];
    const finished = released();
    const w = new S.Writable({
      objectMode: true,
      writev(chunks: unknown[], done: () => void) {
        chunks.splice(0, chunks.length);
        done();
      }
    });
    w.cork();
    w.write("a", () => callbacks.push("a"));
    w.write("b", () => callbacks.push("b"));
    w.end(finished.release);
    await finished.promise;
    expect(callbacks).toEqual(["a", "b"]);
  });
});

/**
 * The classes' `fromWeb` statics are Node's on both entries — native on the
 * Node entry, a port on the browser one — so the same code behaves the same
 * everywhere, Node's defects included. The module's own `readableFromWeb` /
 * `writableFromWeb` are the safe forms, and they too agree across entries.
 */
describe("fromWeb: same code, same behaviour on every entry", () => {
  const withNull = (): ReadableStream<unknown> =>
    new ReadableStream({
      start(c) {
        c.enqueue(1);
        c.enqueue(null);
        c.enqueue(2);
        c.close();
      }
    });
  const readAll = async (r: AsyncIterable<unknown>): Promise<unknown> => {
    const out: unknown[] = [];
    try {
      for await (const x of r) {
        out.push(x);
      }
      return out;
    } catch (error) {
      return (error as { code?: string }).code;
    }
  };
  const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 20));

  async function classStatics(S: Api): Promise<unknown[]> {
    const out: unknown[] = [await readAll(S.Readable.fromWeb(withNull(), { objectMode: true }))];
    const ended = webSource([1]);
    await readAll(S.Readable.fromWeb(ended, { objectMode: true }));
    out.push(ended.locked);
    const destroyed = new ReadableStream();
    S.Readable.fromWeb(destroyed).destroy();
    await settle();
    out.push(destroyed.locked);
    const ws = new WritableStream();
    const w = S.Writable.fromWeb(ws);
    w.end(new Uint8Array(1));
    await settle();
    out.push(ws.locked);
    const pair = { readable: webSource([1]), writable: new WritableStream() };
    const d = S.Duplex.fromWeb(pair, { objectMode: true });
    await readAll(d);
    d.end();
    await settle();
    out.push(pair.readable.locked, pair.writable.locked);

    // Writable.toWeb while 'drain' is pending: Node resolves the write
    // without handing the chunk over.
    const got: unknown[] = [];
    const callbacks: Array<() => void> = [];
    const sink = new S.Writable({
      objectMode: true,
      highWaterMark: 1,
      write(chunk: unknown, _e: string, cb: () => void) {
        got.push(chunk);
        callbacks.push(cb);
      }
    });
    sink.write("a");
    const write = S.Writable.toWeb(sink).getWriter().write("b");
    // Let the Web write reach the adapter while 'drain' is still pending.
    await settle();
    callbacks.shift()!();
    await settle();
    callbacks.splice(0).forEach(cb => cb());
    await write;
    out.push(got);

    return out;
  }

  // Node v26's behaviour, which the browser port follows: `null` ends the
  // stream, every lock is kept, and the write made during 'drain' is lost.
  const NODE_BASELINE = [[1], true, true, true, true, true, ["a"]];

  it("the Node entry's statics are the host runtime's own", async () => {
    expect(await classStatics(nodeEntry)).toEqual(await classStatics(nodeStream));
  });

  it("the browser entry's statics follow Node", async () => {
    expect(await classStatics(browserEntry)).toEqual(NODE_BASELINE);
  });

  // Bun ships its own node:stream, whose fromWeb releases the read lock.
  it.skipIf("Bun" in globalThis)("node:stream itself is the baseline", async () => {
    expect(await classStatics(nodeStream)).toEqual(NODE_BASELINE);
  });

  it.each(entries)(
    "readableFromWeb / writableFromWeb are the safe forms (%s)",
    async (_n, S: Api) => {
      expect(await readAll(S.readableFromWeb(withNull(), { objectMode: true }))).toBe(
        "ERR_STREAM_NULL_VALUES"
      );
      const ended = webSource([1]);
      await readAll(S.readableFromWeb(ended, { objectMode: true }));
      expect(ended.locked).toBe(false);
      const ws = new WritableStream();
      const w = S.writableFromWeb(ws);
      w.end(new Uint8Array(1));
      await S.finished(w);
      expect(ws.locked).toBe(false);
    }
  );
});

/**
 * Argument validation: the same bad call must fail with the same code and the
 * same message as `node:stream`, and leave nothing changed behind it.
 */
describe("argument validation matches node:stream", () => {
  // The kernel words its messages as Node does. Bun's node:stream builds its own
  // ("must be of type ReadableStream" for Node's "an instance of ReadableStream"),
  // so on Bun the name and code are compared and the wording is not.
  const onBun = "Bun" in globalThis;
  const describeError = (error: unknown): string => {
    const { name, code, message } = error as { name: string; code?: string; message: string };
    return onBun ? `${name} ${code}` : `${name} ${code}: ${message}`;
  };
  const failureOf = (call: () => unknown): string => {
    try {
      call();
      return "accepted";
    } catch (error) {
      return describeError(error);
    }
  };
  const implementations: Api[] = [nodeStream, browserEntry];

  it.each([-1, 1.5, Number.NaN, Infinity, 2 ** 53, "8", undefined, 0, 1024])(
    "setDefaultHighWaterMark(%s)",
    value => {
      const [native, kernel] = implementations.map((S: Api) => {
        const before = [S.getDefaultHighWaterMark(false), S.getDefaultHighWaterMark(true)];
        try {
          return [
            failureOf(() => S.setDefaultHighWaterMark(false, value)),
            failureOf(() => S.setDefaultHighWaterMark(true, value)),
            S.getDefaultHighWaterMark(false) === before[0],
            S.getDefaultHighWaterMark(true) === before[1]
          ];
        } finally {
          S.setDefaultHighWaterMark(false, before[0]);
          S.setDefaultHighWaterMark(true, before[1]);
        }
      });
      expect(kernel).toEqual(native);
    }
  );

  it.each([0, -1, 1.5, "2", 2 ** 53, Infinity])("map({ concurrency: %s })", concurrency => {
    const [native, kernel] = implementations.map((S: Api) =>
      failureOf(() => S.Readable.from([1]).map((x: unknown) => x, { concurrency }))
    );
    expect(kernel).toBe(native);
  });

  it.each([
    ["Readable.from(5)", (S: Api) => S.Readable.from(5)],
    ["Readable.from(null)", (S: Api) => S.Readable.from(null)],
    ["map(a string)", (S: Api) => S.Readable.from([1]).map("a".repeat(40))],
    ["map(an object)", (S: Api) => S.Readable.from([1]).map({})],
    ["filter(5)", (S: Api) => S.Readable.from([1]).filter(5)],
    ["take(-1)", (S: Api) => S.Readable.from([1]).take(-1)],
    ["Duplex.fromWeb(5)", (S: Api) => S.Duplex.fromWeb(5)],
    ["Duplex.fromWeb(null)", (S: Api) => S.Duplex.fromWeb(null)],
    ["Duplex.fromWeb(undefined)", (S: Api) => S.Duplex.fromWeb(undefined)],
    [
      "Duplex.fromWeb({ readable })",
      (S: Api) => S.Duplex.fromWeb({ readable: new ReadableStream() })
    ],
    ["Duplex.fromWeb(pair, 5)", (S: Api) => S.Duplex.fromWeb(new TransformStream(), 5)],
    ["Readable.fromWeb(stream, null)", (S: Api) => S.Readable.fromWeb(new ReadableStream(), null)],
    ["Writable.fromWeb(stream, [])", (S: Api) => S.Writable.fromWeb(new WritableStream(), [])],
    ["Readable.toWeb(readable, 5)", (S: Api) => S.Readable.toWeb(S.Readable.from([1]), 5)],
    [
      "map(fn, { signal: 5 })",
      (S: Api) => S.Readable.from([1]).map((x: unknown) => x, { signal: 5 })
    ],
    ["map(fn, 5)", (S: Api) => S.Readable.from([1]).map((x: unknown) => x, 5)],
    ["write(a number)", (S: Api) => new S.Writable({ write() {} }).write(5)],
    ["Duplex.from(5)", (S: Api) => S.Duplex.from(5)],
    ["Readable.toWeb(a function)", (S: Api) => S.Readable.toWeb(function named() {})]
  ] as const)("%s", (label, call) => {
    const [native, kernel] = implementations.map((S: Api) => failureOf(() => call(S)));
    const expected = KERNEL_BASELINE[label] ?? native;
    expect(expected).not.toBe("accepted");
    expect(kernel).toBe(expected);
  });

  it("push() of a non-chunk fails the stream with Node's error", async () => {
    const [native, kernel] = await Promise.all(
      implementations.map(
        (S: Api) =>
          new Promise<string>(resolve => {
            const readable = new S.Readable({ read() {} });
            readable.on("error", (error: Error) => resolve(describeError(error)));
            readable.push(5);
          })
      )
    );
    expect(kernel).toBe(native);
  });

  it("pipeline() of a non-stream fails with Node's error", async () => {
    // Node's callback form throws; the module's promise form rejects with the same error.
    const native = failureOf(() =>
      nodeStream.pipeline(5 as never, new nodeStream.PassThrough(), () => {})
    );
    const kernel = await (browserEntry as Api).pipeline(5, new browserEntry.PassThrough()).then(
      () => "accepted",
      (error: Error) => describeError(error)
    );
    expect(kernel).toBe(native);
  });
});

/**
 * With an encoding, Node runs every object-mode chunk through the decoder: a
 * string is kept, any binary view is decoded, anything else makes push() throw.
 */
describe("push() under an encoding in object mode matches node:stream", () => {
  const outcome = (S: Api): string => {
    const readable = new S.Readable({ objectMode: true, encoding: "utf8", read() {} });
    const pushes = [
      "text",
      new Uint16Array([0x6968]),
      new DataView(new Uint8Array([104, 105]).buffer),
      5,
      { not: "bytes" }
    ].map(chunk => {
      try {
        readable.push(chunk);
        return "pushed";
      } catch (error) {
        const { name, code, message } = error as Error & { code?: string };
        // Bun's node:stream words its messages its own way; the kernel words them as Node does.
        return "Bun" in globalThis ? `${name} ${code}` : `${name} ${code}: ${message}`;
      }
    });
    const read: unknown[] = [];
    for (let chunk = readable.read(); chunk !== null; chunk = readable.read()) {
      read.push(chunk);
    }
    return JSON.stringify({ pushes, read });
  };

  it("keeps strings, decodes binary views and throws for anything else", () => {
    expect(outcome(browserEntry)).toBe(outcome(nodeStream));
  });
});

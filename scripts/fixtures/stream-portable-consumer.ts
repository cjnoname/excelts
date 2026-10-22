/**
 * Portable consumer code, compiled against the published declarations twice by
 * `pnpm build:verify:node` and `pnpm build:verify:browser`: once as Node
 * resolves `documonster/stream`, once with the `browser` condition and no
 * `@types/node`.
 * Business code written against the module must compile unchanged on both —
 * this file is that promise, made checkable.
 */
import {
  Collector,
  Duplex,
  PassThrough,
  Readable,
  Transform,
  Writable,
  compose,
  type ComposedDuplex,
  type IPullStream,
  type IReadable,
  type PipelineStageLike,
  createCollector,
  createDuplex,
  createPullStream,
  createReadable,
  createReadableFromArray,
  createReadableFromPromise,
  createTransform,
  createWritable,
  finished,
  pipeline,
  readableFromWeb,
  readableStreamToAsyncIterable,
  readableToWeb,
  writableFromWeb,
  writableToWeb
} from "documonster/stream";

type IsEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

/** Bytes in, objects out: a Transform subclass with its own state. */
class LineSplitter extends Transform {
  private tail = "";
  private readonly decoder = new TextDecoder();

  constructor() {
    super({ readableObjectMode: true });
  }

  override _transform(
    chunk: Uint8Array,
    _encoding: string,
    callback: (error?: Error | null, data?: unknown) => void
  ): void {
    const lines = (this.tail + this.decoder.decode(chunk, { stream: true })).split("\n");
    this.tail = lines.pop() ?? "";
    for (const line of lines) {
      this.push({ line });
    }
    callback();
  }

  override _flush(callback: (error?: Error | null, data?: unknown) => void): void {
    if (this.tail) {
      this.push({ line: this.tail });
    }
    callback();
  }
}

/** A Readable subclass that overrides _read and _destroy. */
class Countdown extends Readable {
  constructor(private remaining: number) {
    super({ objectMode: true });
  }

  override _read(): void {
    this.push(this.remaining > 0 ? this.remaining-- : null);
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.remaining = 0;
    callback(error);
  }
}

/** A Writable subclass with a typed chunk, _final and _writev. */
class ByteCounter extends Writable {
  total = 0;

  override _write(
    chunk: Uint8Array,
    _encoding: string,
    callback: (error?: Error | null) => void
  ): void {
    this.total += chunk.byteLength;
    callback();
  }

  override _writev(
    chunks: Array<{ chunk: Uint8Array; encoding: string }>,
    callback: (error?: Error | null) => void
  ): void {
    for (const { chunk } of chunks) {
      this.total += chunk.byteLength;
    }
    callback();
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.emit("total", this.total);
    callback();
  }
}

/** A Duplex subclass: both sides overridden. */
class Echo extends Duplex {
  override _read(): void {}

  override _write(
    chunk: unknown,
    _encoding: string,
    callback: (error?: Error | null) => void
  ): void {
    this.push(chunk);
    callback();
  }
}

/** A generic wrapper over compose: its type parameters flow through. */
function through<In, Out>(...stages: PipelineStageLike[]): ComposedDuplex<In, Out> {
  return compose<In, Out>(...stages);
}

/** A Duplex subclass inherits the static Web adapters with Node's signatures. */
class Tagged extends Duplex {
  readonly tag = "tagged";
}

/** Options-style construction, with `this` inside the hooks. */
function counter(): Writable {
  let count = 0;
  return new Writable({
    objectMode: true,
    write(_chunk: unknown, _encoding: string, callback: (error?: Error | null) => void) {
      count++;
      this.emit("progress", count);
      callback();
    }
  });
}

export async function portableUsage(): Promise<string[]> {
  const out: string[] = [];

  // pipeline over Node-style stages, including a generator stage.
  await pipeline(
    Readable.from([new TextEncoder().encode("a\nb\n")]),
    new LineSplitter(),
    async function* (source: AsyncIterable<{ line: string }>) {
      for await (const { line } of source) {
        yield line.toUpperCase();
      }
    },
    new Writable({
      objectMode: true,
      write(line: string, _encoding: string, callback: (error?: Error | null) => void) {
        out.push(line);
        callback();
      }
    })
  );

  // Web interop both ways.
  const web = Readable.toWeb(Readable.from(["x"]));
  const back = Readable.fromWeb(web, { objectMode: true });
  for await (const chunk of back) {
    out.push(String(chunk));
  }

  // The module's own conversions: same guarantees on both builds.
  const safeWeb = readableToWeb(Readable.from(["y"]));
  for await (const chunk of readableFromWeb(safeWeb, { objectMode: true })) {
    out.push(String(chunk));
  }
  const sink = writableFromWeb(new WritableStream<string>(), { objectMode: true });
  sink.end("z");
  await finished(sink);
  writableToWeb(counter()).getWriter().releaseLock();

  // compose, factories, PassThrough, Duplex.from, finished.
  const upper = createTransform<string, string>(s => s.toUpperCase(), { objectMode: true });
  const composed = compose(upper, new PassThrough({ objectMode: true }));
  composed.end("c");
  for await (const chunk of composed) {
    out.push(String(chunk));
  }
  const duplex = Duplex.from(async function* (source: AsyncIterable<unknown>) {
    for await (const chunk of source) {
      yield chunk;
    }
  });
  duplex.end();
  await finished(counter().end());

  // Subclasses, used the way their base classes are.
  for await (const n of new Countdown(2)) {
    out.push(String(n));
  }
  const bytes = new ByteCounter();
  await pipeline(Readable.from([new Uint8Array(3)]), bytes);
  const total: number = bytes.total;
  const echo = new Echo({ objectMode: true });
  echo.end("e");
  for await (const chunk of echo) {
    out.push(String(chunk));
  }

  // Inference: a chunk read from a stream goes where its value is expected.
  for await (const word of Readable.from(["w"])) {
    const text: string = word;
    out.push(text);
  }

  // compose: generics for what goes in and out, the result a plain Duplex.
  const lengths = compose<string, number>(
    new PassThrough({ objectMode: true }),
    async function* (source: AsyncIterable<string>) {
      for await (const line of source) {
        yield line.length;
      }
    }
  );
  const asDuplex: Duplex = lengths;
  const named: ComposedDuplex<string, number> = lengths;
  const firstLength: number | null = lengths.read();
  // @ts-expect-error what is read out is the declared output type.
  const notALength: string | null = lengths.read();
  // @ts-expect-error what is written in is the declared input type.
  lengths.write(1);
  // @ts-expect-error end() takes the input type too.
  lengths.end(1);
  void named;
  void firstLength;
  void notALength;
  asDuplex.end("abc");
  for await (const n of lengths) {
    // @ts-expect-error iteration yields the declared output type.
    const notANumber: string = n;
    void notANumber;
    out.push(String(n + total));
  }
  // @ts-expect-error compose takes stages, not arbitrary values.
  compose(42);

  // A generic wrapper keeps the element types.
  const wrapped = through<string, number>(new PassThrough({ objectMode: true }));
  const wrappedRead: number | null = wrapped.read();
  // @ts-expect-error the wrapper's input type reaches write().
  wrapped.write(1);
  void wrappedRead;

  // Extracted and bound methods stay callable.
  const boundWrite = wrapped.write.bind(wrapped);
  boundWrite("x");
  const { destroyed } = wrapped;
  const boolean: boolean = destroyed;
  void boolean;

  // Statics through a subclass, and type utilities over them.
  const fromSubclass: Duplex = Tagged.fromWeb(new TransformStream());
  const subclassPair: Parameters<typeof Tagged.fromWeb>[0] = new TransformStream();
  // @ts-expect-error a lone ReadableStream is refused through a subclass too.
  Tagged.fromWeb(new ReadableStream());
  void [fromSubclass, subclassPair];

  // Web interop through the classes, with Node's signatures on both entries.
  const pair: Duplex = Duplex.fromWeb(new TransformStream(), { objectMode: true });
  const pairWeb: { readable: ReadableStream; writable: WritableStream } = Duplex.toWeb(pair);
  void pairWeb;
  const fromReadable: Readable = Readable.fromWeb(new ReadableStream<string>(), {
    objectMode: true
  });
  const toWebReadable: ReadableStream = Readable.toWeb(fromReadable);
  const toWebWritable: WritableStream = Writable.toWeb(counter());
  void toWebReadable;
  void toWebWritable;
  // Type utilities see the real signatures, as they do on node:stream.
  const pairArgument: Parameters<typeof Duplex.fromWeb>[0] = new TransformStream();
  const fromWebResult = (result: ReturnType<typeof Duplex.fromWeb>): Duplex => result;
  const toWebArgument: Parameters<typeof Duplex.toWeb>[0] = pair;
  void [pairArgument, fromWebResult, toWebArgument];
  // @ts-expect-error Node's Duplex.fromWeb takes a { readable, writable } pair only.
  Duplex.fromWeb(new ReadableStream());
  // @ts-expect-error Node's Duplex.toWeb takes a Duplex only.
  Duplex.toWeb(Readable.from([1]));

  // Explicit resource management.
  {
    await using stream = Readable.from([1, 2, 3]);
    for await (const n of stream) {
      out.push(String(n));
      break;
    }
  }
  return out;
}

/**
 * What each stream yields and accepts, as the published declarations state it:
 * the element type follows the conversions the runtime makes, hooks see the
 * stream as `this`, and inputs the runtime rejects do not type-check.
 */
export function declaredTypes(
  numbers: ReadableStream<number>,
  bytes: ReadableStream<Uint8Array>,
  strings: ReadableStream<string>,
  thenable: PromiseLike<number>
): void {
  const iterated = readableStreamToAsyncIterable(numbers);
  type _Iterated = Assert<IsEqual<typeof iterated, AsyncGenerator<number, void, unknown>>>;

  const decoded = readableFromWeb(bytes, { encoding: "utf8" });
  type _Decoded = Assert<IsEqual<typeof decoded, IReadable<string>>>;
  const asBytes = readableFromWeb(strings);
  type _Bytes = Assert<IsEqual<typeof asBytes, IReadable<Uint8Array>>>;
  const asObjects = readableFromWeb(numbers, { objectMode: true });
  type _Objects = Assert<IsEqual<typeof asObjects, IReadable<number>>>;
  // @ts-expect-error byte mode cannot carry numbers
  readableFromWeb(numbers);

  const byteArray = createReadableFromArray(["hi"], { objectMode: false });
  type _ByteArray = Assert<IsEqual<typeof byteArray, IReadable<Uint8Array>>>;
  const fromThenable = createReadableFromPromise(thenable);
  type _FromThenable = Assert<IsEqual<typeof fromThenable, IReadable<number>>>;

  const produced = createReadable<number>({
    read() {
      this.push(1);
      // @ts-expect-error a number stream's push takes numbers
      this.push("x");
    }
  });
  produced.push(null);
  createWritable<number>({
    write(chunk, _encoding, done) {
      this.emit("value", chunk + 1);
      done();
    }
  });
  createDuplex<string, number>({
    write(chunk, _encoding, done) {
      this.push(String(chunk));
      done();
    }
  });

  const collected: Uint8Array = createCollector<number>().toUint8Array();
  const collector = new Collector<number>();
  // @ts-expect-error a number collector takes numbers
  collector.write("x");
  const pull: IPullStream = createPullStream();

  void pipeline(
    // @ts-expect-error a sync generator as a middle stage fails with ERR_INVALID_RETURN_VALUE
    createReadableFromArray([1]),
    function* () {
      yield 1;
    },
    collector
  );
  void [collected, pull];
}

// This file is typechecked by `pnpm type` but is NOT executed by Vitest.
//
// Declarations must say what the stream actually yields. Each case below was
// a declaration that disagreed with the runtime: an element type that a
// conversion changes, a method the interface lacked or invented, a hook whose
// `this` was the options object or `any`, or an input the runtime rejects.
// Valid uses must type-check; the invalid ones must fail (`@ts-expect-error`
// fails the build when the line below it compiles).

import type * as NodeStreams from "@stream/index";
import type * as BrowserStreams from "@stream/index.browser";
import type { IPullStream, IPushableReadable, IReadable } from "@stream/types";

type IsEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

declare const node: typeof NodeStreams;
declare const browser: typeof BrowserStreams;
declare const numbers: ReadableStream<number>;
declare const bytes: ReadableStream<Uint8Array>;
declare const strings: ReadableStream<string>;

function sharedFunctions(S: typeof NodeStreams | typeof BrowserStreams): void {
  // --- readableStreamToAsyncIterable: the element type comes from the reader --
  const fromNumbers = S.readableStreamToAsyncIterable(numbers);
  type _Iterated = Assert<IsEqual<typeof fromNumbers, AsyncGenerator<number, void, unknown>>>;

  // --- readableFromWeb: byte mode by default, strings with an encoding --------
  const decoded = S.readableFromWeb(bytes, { encoding: "utf8" });
  type _Decoded = Assert<IsEqual<typeof decoded, IReadable<string>>>;
  const asBytes = S.readableFromWeb(strings);
  type _Bytes = Assert<IsEqual<typeof asBytes, IReadable<Uint8Array>>>;
  const asObjects = S.readableFromWeb(numbers, { objectMode: true });
  type _Objects = Assert<IsEqual<typeof asObjects, IReadable<number>>>;
  // @ts-expect-error byte mode cannot carry numbers
  S.readableFromWeb(numbers);
  // A mode known only at run time may be bytes: the input must suit both.
  const unknownMode = S.readableFromWeb(strings, { objectMode: Math.random() > 0.5 });
  type _Unknown = Assert<IsEqual<typeof unknownMode, IReadable<string | Uint8Array>>>;
  // @ts-expect-error numbers cannot be carried if the mode turns out to be bytes
  S.readableFromWeb(numbers, { objectMode: Math.random() > 0.5 });

  // --- object-mode factories: objectMode: false yields bytes ------------------
  const textArray = S.createReadableFromArray(["hi"]);
  type _TextArray = Assert<IsEqual<typeof textArray, IReadable<string>>>;
  const byteArray = S.createReadableFromArray(["hi"], { objectMode: false });
  type _ByteArray = Assert<IsEqual<typeof byteArray, IReadable<Uint8Array>>>;
  const sparse = S.createReadableFromArray([1, undefined, 2]);
  type _Sparse = Assert<IsEqual<typeof sparse, IReadable<number>>>;
  // @ts-expect-error byte mode cannot carry numbers
  S.createReadableFromArray([1, 2], { objectMode: false });
  const words: string[] = ["a"];
  const eitherArray = S.createReadableFromArray(words, { objectMode: Math.random() > 0.5 });
  type _EitherArray = Assert<IsEqual<typeof eitherArray, IReadable<string | Uint8Array>>>;

  // --- thenables are adopted, and what they resolve to is yielded -------------
  const thenable: PromiseLike<number> = { then: resolve => resolve?.(1) as never };
  const fromThenable = S.createReadableFromPromise(thenable);
  type _FromThenable = Assert<IsEqual<typeof fromThenable, IReadable<number>>>;
  const transform = S.createTransform((n: number) => thenable.then(v => `${v + n}`), {
    objectMode: true
  });
  type _TransformOut = Assert<
    IsEqual<typeof transform, ReturnType<typeof S.createTransform<number, string>>>
  >;
  const kept = S.filter((n: number) => Promise.resolve(n > 1));
  kept.write(1);

  // --- interfaces match the objects the factories return ----------------------
  const collected = S.createCollector<number>();
  const joined: Uint8Array = collected.toUint8Array();
  const text: string = collected.toString();
  const finished: boolean = collected.isFinished;
  const pull: IPullStream = S.createPullStream();
  // @ts-expect-error PullStream has no stream() method
  pull.stream(1);

  // --- hooks see the stream as `this` -----------------------------------------
  const produced = S.createReadable<number>({
    read() {
      this.push(1);
      // @ts-expect-error a number stream's push takes numbers
      this.push("x");
      this.push(null);
    }
  });
  const pushable: IPushableReadable<number> = produced;
  produced.push(2);
  S.createWritable<number>({
    write(chunk, _encoding, done) {
      this.emit("value", chunk);
      const total: number = chunk + 1;
      void total;
      done();
    }
  });
  S.createDuplex<string, number>({
    read() {
      this.push("out");
    },
    write(chunk, _encoding, done) {
      this.push(String(chunk + 1));
      done();
    }
  });

  // --- pipeline: a middle stage must be an async generator --------------------
  const source = S.createReadableFromArray([1, 2]);
  const sink = S.createCollector<number>();
  void S.pipeline(
    source,
    async function* (input: AsyncIterable<number>) {
      for await (const n of input) {
        yield n * 2;
      }
    },
    sink
  );
  void S.pipeline(
    // @ts-expect-error a sync generator as a middle stage fails with ERR_INVALID_RETURN_VALUE
    source,
    function* () {
      yield 1;
    },
    sink
  );

  void [joined, text, finished, pushable];
}

function collectorWrites(): void {
  // The element type constrains what is written, on both entries.
  const onNode = new node.Collector<number>();
  onNode.write(1);
  onNode.end(2);
  // @ts-expect-error a number collector takes numbers
  onNode.write("x");
  // @ts-expect-error a number collector takes numbers
  onNode.end("x");
  const onBrowser = new browser.Collector<number>();
  onBrowser.write(1);
  // @ts-expect-error a number collector takes numbers
  onBrowser.write("x");
}

function browserClasses(): void {
  // Readable.from awaits what it is given, and object mode is the default.
  const awaited = browser.Readable.from([Promise.resolve(1), 2]);
  type _Awaited = Assert<IsEqual<typeof awaited, BrowserStreams.Readable<number>>>;
  const byteMode = browser.Readable.from(["a"], { objectMode: false });
  type _ByteMode = Assert<IsEqual<typeof byteMode, BrowserStreams.Readable<Uint8Array>>>;
  // @ts-expect-error Readable.from rejects a Blob, as Node does (Duplex.from takes one)
  browser.Readable.from(new Blob(["a"]));
  // fromWeb is untyped, as Node declares it: what it yields depends on the mode.
  const fromWeb = browser.Readable.fromWeb(strings);
  type _FromWeb = Assert<IsEqual<typeof fromWeb, BrowserStreams.Readable>>;
}

void sharedFunctions;
void collectorWrites;
void browserClasses;

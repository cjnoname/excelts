/**
 * Stream factory functions shared by the Node and browser entry points.
 *
 * The bodies are identical on both platforms; only the stream classes differ,
 * so each entry point builds them with its own.
 */

import { BufferedStream } from "@stream/buffered-stream";
import { PullStream } from "@stream/pull-stream";
import type {
  BufferedStreamOptions,
  DuplexStreamOptions,
  IPassThrough,
  IPushableDuplex,
  IPushableReadable,
  IReadable,
  ITransform,
  IWritable,
  PullStreamOptions,
  ReadableStreamOptions,
  TransformStreamOptions,
  WritableStreamOptions
} from "@stream/types";
import { stringToUint8Array } from "@utils/binary";

type Ctor = new (options?: any) => any;

interface StreamClasses {
  Readable: Ctor & { from(iterable: unknown, options?: unknown): any };
  Writable: Ctor;
  Duplex: Ctor;
  Transform: Ctor;
  PassThrough: Ctor;
}

type Callback = (error?: Error | null) => void;

/** What a byte-mode stream accepts as a chunk; it reads back as `Uint8Array`. */
type ByteChunk = string | ArrayBufferView;

/** Options that leave the factory's default object mode on: chunks pass through as given. */
type ObjectModeOptions = ReadableStreamOptions & { objectMode?: true };

/** Options that switch to byte mode: every chunk reads back as a `Uint8Array`. */
type ByteModeOptions = ReadableStreamOptions & { objectMode: false };

/**
 * Options whose mode is a `boolean` known only at run time. The mode may turn
 * out to be bytes, so the input must be what byte mode carries, and the stream
 * yields either the chunks themselves or bytes. Required, not optional, so an
 * omitted mode resolves to the object-mode overload.
 */
type EitherModeOptions = ReadableStreamOptions & { objectMode: boolean };

/** A `destroy` hook, with the stream it destroys as `this`. */
type DestroyHook<S> = (
  this: S,
  error: Error | null,
  callback: (error?: Error | null) => void
) => void;

/**
 * The factories, typed by what each one actually yields.
 *
 * Where a factory defaults to object mode, `objectMode: false` is its own
 * overload: byte mode turns every chunk into a `Uint8Array`, so the element
 * type is not the input's. An option whose mode is only known at run time gets
 * the union of both. Hooks see the stream as `this`: a producer's `push` takes
 * the stream's element type, and a writer's stream is the writable itself.
 */
export interface StreamFactories {
  createPullStream(options?: PullStreamOptions): PullStream;
  createBufferedStream(options?: BufferedStreamOptions): BufferedStream;
  createReadable<T = Uint8Array>(
    options?: ReadableStreamOptions & {
      read?: (this: IPushableReadable<T>, size: number) => void;
      destroy?: DestroyHook<IPushableReadable<T>>;
    }
  ): IPushableReadable<T>;
  /** Values are awaited, as `Readable.from` awaits them. */
  createReadableFromAsyncIterable<T>(
    iterable: AsyncIterable<T>,
    options?: ObjectModeOptions
  ): IReadable<Awaited<T>>;
  createReadableFromAsyncIterable(
    iterable: AsyncIterable<ByteChunk>,
    options: ByteModeOptions
  ): IReadable<Uint8Array>;
  createReadableFromAsyncIterable<T extends ByteChunk>(
    iterable: AsyncIterable<T>,
    options: EitherModeOptions
  ): IReadable<Awaited<T> | Uint8Array>;
  /** `undefined` entries are skipped. */
  createReadableFromArray<T>(
    data: readonly T[],
    options?: ObjectModeOptions
  ): IReadable<Exclude<T, undefined>>;
  createReadableFromArray(
    data: readonly ByteChunk[],
    options: ByteModeOptions
  ): IReadable<Uint8Array>;
  createReadableFromArray<T extends ByteChunk>(
    data: readonly T[],
    options: EitherModeOptions
  ): IReadable<Exclude<T, undefined> | Uint8Array>;
  createReadableFromGenerator<T>(
    generator: () => AsyncGenerator<T, void, unknown>,
    options?: ObjectModeOptions
  ): IReadable<Awaited<T>>;
  createReadableFromGenerator(
    generator: () => AsyncGenerator<ByteChunk, void, unknown>,
    options: ByteModeOptions
  ): IReadable<Uint8Array>;
  createReadableFromGenerator<T extends ByteChunk>(
    generator: () => AsyncGenerator<T, void, unknown>,
    options: EitherModeOptions
  ): IReadable<Awaited<T> | Uint8Array>;
  /** Any thenable, adopted as `await` would; the stream yields what it resolves to. */
  createReadableFromPromise<T>(
    promise: PromiseLike<T>,
    options?: ObjectModeOptions
  ): IReadable<Awaited<T>>;
  createReadableFromPromise(
    promise: PromiseLike<ByteChunk>,
    options: ByteModeOptions
  ): IReadable<Uint8Array>;
  createReadableFromPromise<T extends ByteChunk>(
    promise: PromiseLike<T>,
    options: EitherModeOptions
  ): IReadable<Awaited<T> | Uint8Array>;
  createEmptyReadable<T = Uint8Array>(options?: ReadableStreamOptions): IReadable<T>;
  createWritable<T = Uint8Array>(
    options?: WritableStreamOptions & {
      write?: (this: IWritable<T>, chunk: T, encoding: string, callback: Callback) => void;
      final?: (this: IWritable<T>, callback: Callback) => void;
      destroy?: DestroyHook<IWritable<T>>;
    }
  ): IWritable<T>;
  createNullWritable<T = unknown>(options?: WritableStreamOptions): IWritable<T>;
  /**
   * A Transform from a function returning each output, or a thenable of it;
   * `undefined` pushes nothing.
   */
  createTransform<TInput = Uint8Array, TOutput = Uint8Array>(
    transformFn: (
      chunk: TInput,
      encoding?: string
    ) => TOutput | undefined | PromiseLike<TOutput | undefined>,
    options?: TransformStreamOptions & {
      flush?: () => TOutput | undefined | PromiseLike<TOutput | undefined>;
    }
  ): ITransform<TInput, TOutput>;
  createPassThrough<T = unknown>(options?: TransformStreamOptions): IPassThrough<T>;
  /** A byte stream of exactly `data`. */
  fromBytes(data: Uint8Array): IReadable<Uint8Array>;
  /** A byte stream of `str`, UTF-8 encoded. */
  fromString(str: string): IReadable<Uint8Array>;
  /** A byte stream of `data` as JSON text. */
  fromJSON(data: unknown): IReadable<Uint8Array>;
  /** A Transform from a function returning each output, or a thenable of it. */
  transform<TIn = Uint8Array, TOut = TIn>(
    fn: (chunk: TIn) => TOut | PromiseLike<TOut>
  ): ITransform<TIn, TOut>;
  /** An object-mode Transform keeping the chunks `predicate` accepts. */
  filter<T>(predicate: (chunk: T) => boolean | PromiseLike<boolean>): ITransform<T, T>;
  createDuplex<TRead = Uint8Array, TWrite = Uint8Array>(
    options?: DuplexStreamOptions & {
      allowHalfOpen?: boolean;
      read?: (this: IPushableDuplex<TRead, TWrite>, size: number) => void;
      write?: (
        this: IPushableDuplex<TRead, TWrite>,
        chunk: TWrite,
        encoding: string,
        callback: Callback
      ) => void;
      final?: (this: IPushableDuplex<TRead, TWrite>, callback: Callback) => void;
      destroy?: DestroyHook<IPushableDuplex<TRead, TWrite>>;
    }
  ): IPushableDuplex<TRead, TWrite>;
}

/**
 * Deliver a value that may be a promise to a Node-style callback; `undefined`
 * means "nothing to push".
 *
 * A promise is recognised as `await` recognises one — anything with a `then`
 * method — not with `instanceof Promise`, which is false for a promise from
 * another realm (an iframe, a `vm` context) and for any other thenable, and
 * pushed the promise itself as the chunk. `Promise.resolve` then adopts it as
 * `await` would, so a thenable that calls back twice or throws still settles
 * once. A plain value keeps the synchronous path.
 */
function settle<T>(
  run: () => T | undefined | PromiseLike<T | undefined>,
  callback: (error?: Error | null, data?: T) => void
): void {
  let result: T | undefined | PromiseLike<T | undefined>;
  try {
    result = run();
  } catch (err) {
    callback(err as Error);
    return;
  }
  if (typeof (result as { then?: unknown } | null | undefined)?.then === "function") {
    Promise.resolve(result as PromiseLike<T | undefined>).then(
      data => (data !== undefined ? callback(null, data) : callback()),
      err => callback(err as Error)
    );
  } else if (result !== undefined) {
    callback(null, result as T);
  } else {
    callback();
  }
}

function emptyRead(this: { push(chunk: unknown): boolean }): void {
  this.push(null);
}

function nullWrite(_chunk: unknown, _encoding: string, callback: Callback): void {
  callback();
}

/** `createPullStream`; platform-independent. */
export function createPullStream(options?: PullStreamOptions): PullStream {
  return new PullStream(options);
}

/** `createBufferedStream`; platform-independent. */
export function createBufferedStream(options?: BufferedStreamOptions): BufferedStream {
  return new BufferedStream(options);
}

// One maker per factory, each called once per platform with the one class it
// needs. A shared object of every class would make each factory keep all of
// them — the whole Readable/compose kernel behind a lone `createWritable`.

export function makeCreateReadable(
  Readable: StreamClasses["Readable"]
): StreamFactories["createReadable"] {
  return options => new Readable(options);
}

export function makeCreateReadableFromAsyncIterable(
  Readable: StreamClasses["Readable"]
): StreamFactories["createReadableFromAsyncIterable"] {
  return (iterable, options) =>
    Readable.from(iterable, { ...options, objectMode: options?.objectMode ?? true });
}

/**
 * `undefined` entries are skipped: a stream's end-of-data signal is a nullish
 * push, so there is no in-band way to carry an undefined chunk, while `0`, `""`
 * and `false` are ordinary values that must survive.
 */
export function makeCreateReadableFromArray(
  Readable: StreamClasses["Readable"]
): StreamFactories["createReadableFromArray"] {
  return <T>(data: T[], options?: ReadableStreamOptions): IReadable<T> => {
    let index = 0;
    return new Readable({
      ...options,
      objectMode: options?.objectMode ?? true,
      read(this: { push(chunk: unknown): boolean }) {
        while (index < data.length) {
          const chunk = data[index++];
          if (chunk === undefined) {
            continue;
          }
          if (!this.push(chunk)) {
            return;
          }
        }
        this.push(null);
      }
    });
  };
}

export function makeCreateReadableFromGenerator(
  Readable: StreamClasses["Readable"]
): StreamFactories["createReadableFromGenerator"] {
  return (generator, options) =>
    Readable.from(generator(), { ...options, objectMode: options?.objectMode ?? true });
}

export function makeCreateReadableFromPromise(
  Readable: StreamClasses["Readable"]
): StreamFactories["createReadableFromPromise"] {
  return <T>(promise: Promise<T>, options?: ReadableStreamOptions): IReadable<T> => {
    const readable = new Readable({
      ...options,
      objectMode: options?.objectMode ?? true,
      read() {}
    });
    // Adopted as `await` would: a promise from another realm or any thenable
    // works, one that calls back twice settles once, and a `then` that throws
    // fails the stream rather than the call.
    Promise.resolve()
      .then(() => promise)
      .then(
        value => {
          readable.push(value);
          readable.push(null);
        },
        err => readable.destroy(err)
      );
    return readable;
  };
}

export function makeCreateEmptyReadable(
  Readable: StreamClasses["Readable"]
): StreamFactories["createEmptyReadable"] {
  return options => new Readable({ ...options, read: emptyRead });
}

export function makeCreateWritable(
  Writable: StreamClasses["Writable"]
): StreamFactories["createWritable"] {
  return options => new Writable(options);
}

export function makeCreateNullWritable(
  Writable: StreamClasses["Writable"]
): StreamFactories["createNullWritable"] {
  return options => new Writable({ ...options, write: nullWrite });
}

/** The shorthand `transformFn` returns its result; `undefined` pushes nothing. */
export function makeCreateTransform(
  Transform: StreamClasses["Transform"]
): StreamFactories["createTransform"] {
  return <TInput, TOutput>(
    transformFn: (
      chunk: TInput,
      encoding?: string
    ) => TOutput | undefined | PromiseLike<TOutput | undefined>,
    options?: TransformStreamOptions & {
      flush?: () => TOutput | undefined | PromiseLike<TOutput | undefined>;
    }
  ): ITransform<TInput, TOutput> => {
    const flush = options?.flush;
    return new Transform({
      ...options,
      transform(
        chunk: TInput,
        encoding: string,
        callback: (e?: Error | null, d?: TOutput) => void
      ) {
        settle(() => transformFn(chunk, encoding), callback);
      },
      flush: flush
        ? (callback: (e?: Error | null, d?: TOutput) => void) => settle(flush, callback)
        : undefined
    });
  };
}

export function makeCreatePassThrough(
  PassThrough: StreamClasses["PassThrough"]
): StreamFactories["createPassThrough"] {
  return options => new PassThrough(options);
}

export function makeCreateDuplex(Duplex: StreamClasses["Duplex"]): StreamFactories["createDuplex"] {
  return options => new Duplex(options);
}

export function makeFromBytes(Readable: StreamClasses["Readable"]): StreamFactories["fromBytes"] {
  return data =>
    new Readable({
      read(this: { push(chunk: unknown): boolean }) {
        this.push(data);
        this.push(null);
      }
    });
}

export function makeFromString(Readable: StreamClasses["Readable"]): StreamFactories["fromString"] {
  const fromBytes = makeFromBytes(Readable);
  return str => fromBytes(stringToUint8Array(str));
}

export function makeFromJSON(Readable: StreamClasses["Readable"]): StreamFactories["fromJSON"] {
  const fromString = makeFromString(Readable);
  return data => fromString(JSON.stringify(data));
}

export function makeTransform(Transform: StreamClasses["Transform"]): StreamFactories["transform"] {
  const createTransform = makeCreateTransform(Transform);
  return fn => createTransform(fn);
}

export function makeFilter(Transform: StreamClasses["Transform"]): StreamFactories["filter"] {
  const createTransform = makeCreateTransform(Transform);
  return <T>(predicate: (chunk: T) => boolean | Promise<boolean>) =>
    createTransform<T, T>(async chunk => ((await predicate(chunk)) ? chunk : undefined), {
      objectMode: true
    });
}

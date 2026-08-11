/**
 * Structural stream contracts for the public XLSX IO surface.
 *
 * Kept in its own module so both platform IO variants (`xlsx-io.ts` /
 * `xlsx-io.browser.ts`), the serializer (`xlsx/xlsx.browser.ts`), and the
 * pull-source adapter (`xlsx-stream.ts`) share one definition instead of each
 * declaring a look-alike shape — and so `core/` never has to import a type from
 * the module it is imported by.
 */
import type { IReadable } from "@stream";

/**
 * Event listener shape. Node's `EventEmitter` passes heterogeneous arguments
 * whose types depend on the event, so `any[]` is the only signature that lets
 * callers declare precisely typed listeners (`(err: Error) => void`) without a
 * cast.
 */
export type XlsxStreamListener = (...args: any[]) => void;

/** Minimal event-emitter contract used by XLSX stream IO. */
export interface XlsxEmitterLike {
  on(event: string, listener: XlsxStreamListener): this;
  once(event: string, listener: XlsxStreamListener): this;
  off(event: string, listener: XlsxStreamListener): this;
}

/**
 * Minimal writable destination accepted by `Workbook.writeStream`.
 *
 * Anything that behaves like a Node `Writable` satisfies this — `fs.WriteStream`,
 * `PassThrough`, an HTTP response, an upload body, or the `@stream` `Writable`.
 */
export interface XlsxWritable extends XlsxEmitterLike {
  write(data: string | Uint8Array): boolean | void | Promise<boolean>;
  end(): void;
  // `pipe` is the Node stream ecosystem's polymorphic dispatcher; its return
  // type depends entirely on the destination. Typed as `any` so callers can
  // freely chain `.pipe(next).pipe(another)` without forced type assertions.
  pipe?(destination: any): any;
}

/**
 * Cross-platform readable XLSX byte source.
 *
 * Identical in the Node and browser builds on purpose: this is the name a
 * cross-platform program writes against, so it must mean the same thing in both.
 * An earlier revision intersected it with the platform `Readable`, which made the
 * two builds' `XlsxReadable` mutually unassignable — an isomorphic helper typed
 * `XlsxReadable` silently got a different, incompatible type per platform.
 *
 * The platform refinement lives on `toStream`'s return type instead: on Node it
 * returns `XlsxReadable & Readable`, which is *assignable to* `XlsxReadable`, so
 * Node callers get a nominal `stream.Readable` for `stream.pipeline()`,
 * `Readable.toWeb()`, or an SDK upload body while portable code keeps compiling
 * unchanged against this type.
 *
 * Both platforms' concrete streams are async-iterable and byte-mode
 * (`objectMode` is off), so every chunk really is bytes.
 */
export type XlsxReadable = IReadable<Uint8Array>;

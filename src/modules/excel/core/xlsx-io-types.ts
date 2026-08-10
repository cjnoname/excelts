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
 * Cross-platform readable XLSX byte source returned by `Workbook.toStream`.
 *
 * On Node the concrete instance is a `stream.Readable`, so it can be handed to
 * `stream.pipeline()`, `Readable.toWeb()`, or an SDK upload body; in the browser
 * it is the `@stream` `Readable`. Both are async-iterable, which is the
 * cast-free way to consume it.
 */
export type XlsxReadable = IReadable<Uint8Array>;

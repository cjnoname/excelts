/**
 * Node.js Stream - Writable
 *
 * Extended Writable class with browser-compatible API.
 */

import { Writable as NodeWritable } from "stream";

import { getDefaultHighWaterMark } from "@stream/core/utils";
import type { WritableStreamOptions, WritableLike } from "@stream/types";

// =============================================================================
// Unified Writable class (compatible with browser API)
// =============================================================================

/**
 * Extended Writable options that match browser API
 * Supports wrapping an existing Node.js stream
 */
export interface WritableOptions<T = Uint8Array> extends WritableStreamOptions {
  /** Existing Node.js Writable stream to wrap (for API compatibility with browser) */
  stream?: NodeWritable;
  autoDestroy?: boolean;
  emitClose?: boolean;
  decodeStrings?: boolean;
  defaultEncoding?: string;
  signal?: AbortSignal;
  write?: (
    this: Writable<T>,
    chunk: T,
    encoding: string,
    callback: (error?: Error | null) => void
  ) => void;
  writev?: (
    this: Writable<T>,
    chunks: Array<{ chunk: T; encoding: string }>,
    callback: (error?: Error | null) => void
  ) => void;
  final?: (this: Writable<T>, callback: (error?: Error | null) => void) => void;
  destroy?: (
    this: Writable<T>,
    error: Error | null,
    callback: (error?: Error | null) => void
  ) => void;
  construct?: (this: Writable<T>, callback: (error?: Error | null) => void) => void;
}

/**
 * Unified Writable class - wraps Node.js Writable with browser-compatible API
 *
 * Supports the same `{ stream }` option as browser version for wrapping existing streams.
 */
export class Writable<T = Uint8Array> extends NodeWritable {
  /**
   * Duck-typing check so that native Duplex/Transform (which extend native
   * stream.Writable, not our wrapper) pass `instanceof Writable`.
   */
  static [Symbol.hasInstance](instance: unknown): boolean {
    return instance instanceof NodeWritable;
  }

  constructor(options?: WritableOptions<T>) {
    // If wrapping an existing stream, proxy to it
    if (options?.stream) {
      const underlying = options.stream;

      // Create a pass-through wrapper that proxies to the underlying stream
      super({
        highWaterMark:
          options?.highWaterMark ?? getDefaultHighWaterMark(options?.objectMode ?? false),
        objectMode: options?.objectMode,
        autoDestroy: options?.autoDestroy,
        emitClose: options?.emitClose,
        decodeStrings: options?.decodeStrings,
        defaultEncoding: options?.defaultEncoding as BufferEncoding | undefined,
        signal: options?.signal,
        write(chunk, encoding, callback) {
          underlying.write(chunk, encoding, callback);
        },
        final(callback) {
          underlying.end(callback);
        }
      });

      // Proxy events from underlying stream, but ensure we clean up listeners so
      // the underlying stream cannot retain this wrapper longer than necessary.
      const onUnderlyingError = (err: Error): void => {
        this.emit("error", err);
      };
      const onUnderlyingClose = (): void => {
        this.emit("close");
      };
      const cleanup = (): void => {
        underlying.off("error", onUnderlyingError);
        underlying.off("close", onUnderlyingClose);
      };

      underlying.on("error", onUnderlyingError);
      underlying.on("close", onUnderlyingClose);

      this.once("close", cleanup);
      this.once("finish", cleanup);
    } else {
      super({
        highWaterMark:
          options?.highWaterMark ?? getDefaultHighWaterMark(options?.objectMode ?? false),
        objectMode: options?.objectMode,
        autoDestroy: options?.autoDestroy,
        emitClose: options?.emitClose,
        decodeStrings: options?.decodeStrings,
        defaultEncoding: options?.defaultEncoding as BufferEncoding | undefined,
        signal: options?.signal,
        write: options?.write,
        writev: options?.writev,
        final: options?.final,
        destroy: options?.destroy,
        construct: options?.construct
      });
    }
  }
}

// =============================================================================
// Cross-environment stream normalization
// =============================================================================

/**
 * Normalize a user-provided writable into a Node.js-compatible Writable.
 *
 * This keeps Web/Node branching at the stream-module boundary.
 *
 * A Node `Writable` is accepted (and fast-pathed below) — it satisfies the
 * structural {@link WritableLike}, so the signature does not name Node's class.
 * Naming it made the browser variant's declaration require `@types/node`, and
 * the two platforms' signatures must stay identical (see
 * `excel/__tests__/type/stream-api-parity.typecheck.ts`).
 */
export function toWritable<T = Uint8Array>(stream: WritableLike | WritableStream<T>): WritableLike {
  if (stream instanceof Writable) {
    return stream;
  }

  // Node.js Writable: already compatible, avoid extra wrapper allocation.
  if (stream instanceof NodeWritable) {
    return stream as WritableLike;
  }

  // Web WritableStream: detect by getWriter() (avoid relying on global WritableStream).
  // Avoid `Writable.fromWeb()` — it is buggy on some runtimes (e.g. Bun).
  // Instead, wrap manually by piping through the WritableStream's writer.
  if ((stream as { getWriter?: unknown }).getWriter) {
    const ws = stream as WritableStream<T>;
    let writer: WritableStreamDefaultWriter<T> | undefined;
    const getWriter = () => (writer ??= ws.getWriter());

    return new Writable({
      write(_chunk: T, _encoding: string, callback: (error?: Error | null) => void) {
        getWriter()
          .write(_chunk)
          .then(() => callback(null), callback);
      },
      final(callback: (error?: Error | null) => void) {
        const w = getWriter();
        w.close().then(
          () => {
            w.releaseLock();
            callback(null);
          },
          (err: Error) => {
            w.releaseLock();
            callback(err);
          }
        );
      }
    }) as WritableLike;
  }

  // Assume it structurally matches Node's Writable.
  return stream as WritableLike;
}

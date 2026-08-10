/**
 * Pull-side adapter for the XLSX writer.
 *
 * `XLSX.write(sink)` is push-shaped: it drives bytes into a destination and
 * only parks when that destination signals backpressure. That forces callers to
 * arrange the consumer *before* the producer runs, and getting the order wrong
 * parks the write forever on a `'drain'` that can never arrive.
 *
 * This module inverts the shape. The workbook is exposed as a readable byte
 * source whose reads are what drive serialization, so there is no ordering
 * contract to violate and the deadlock is structurally impossible. `@stream`
 * supplies the platform `Readable`, so the Node and browser IO surfaces share
 * this single implementation.
 */
import type { XlsxReadable, XlsxStreamListener, XlsxWritable } from "@excel/core/xlsx-io-types";
import type { XlsxWriteOptions } from "@excel/xlsx/xlsx.browser";
import { createReadable } from "@stream";

/** Options accepted by `Workbook.toStream`. */
export interface XlsxStreamOptions extends XlsxWriteOptions {
  /**
   * Readable-side buffer threshold in bytes, i.e. the amount of queued output
   * after which the writer is asked to pause. Defaults to the `@stream` default
   * (64 KB).
   *
   * This is **not** a hard memory bound. Backpressure is sampled after each ZIP
   * entry, and a worksheet is rendered as one entry, so peak
   * buffering may substantially exceed this value and is usually driven by the
   * largest worksheet. Use `Stream.WorkbookWriter` when row-level flow control
   * is required.
   */
  highWaterMark?: number;
}

/** The `XLSX.write`-shaped producer that feeds a stream. */
type XlsxSerializer = (sink: XlsxWritable, options?: XlsxWriteOptions) => Promise<unknown>;

/**
 * `IReadable` deliberately omits `push()` (it is a consumer-facing contract),
 * but the concrete stream returned by `createReadable` is the platform
 * `Readable`, which has it. Narrowed here so the producer can feed the queue.
 */
interface PushableByteStream extends XlsxReadable {
  push(chunk: Uint8Array | null): boolean;
}

const textEncoder = new TextEncoder();

/**
 * Wrap a push-shaped XLSX serializer in a demand-driven readable byte stream.
 *
 * Serialization starts on the first read and is throttled by the reader: every
 * accepted chunk lands in the readable queue, and `push()` returning `false` is
 * the backpressure signal the writer parks on at its next ZIP-entry boundary.
 */
export function createXlsxByteStream(
  serialize: XlsxSerializer,
  options?: XlsxStreamOptions
): XlsxReadable {
  const { highWaterMark, ...writeOptions } = options ?? {};
  const listeners = new Map<string, Set<XlsxStreamListener>>();
  let started = false;
  let ended = false;
  let cancelled = false;

  // `handleRead` / `handleDestroy` are hoisted function declarations, and no
  // platform `Readable` invokes `_read` from its constructor, so both closures
  // only ever run after `source` and `sink` are initialised.
  const source = createReadable<Uint8Array>({
    highWaterMark,
    read: handleRead,
    destroy: handleDestroy
  }) as PushableByteStream;

  /**
   * The destination handed to the serializer. Only the pieces
   * `StreamingZipWriterAdapter` actually uses are implemented: `write`, `end`,
   * and the `'drain'` / `'error'` / `'close'` event contract.
   */
  const sink: XlsxWritable = {
    write(data) {
      if (cancelled || source.destroyed) {
        return false;
      }
      return source.push(typeof data === "string" ? textEncoder.encode(data) : data);
    },
    end() {
      if (ended || cancelled || source.destroyed) {
        return;
      }
      ended = true;
      source.push(null);
    },
    on(event, listener) {
      let bucket = listeners.get(event);
      if (!bucket) {
        bucket = new Set();
        listeners.set(event, bucket);
      }
      bucket.add(listener);
      return this;
    },
    once(event, listener) {
      const wrapped: XlsxStreamListener = (...args) => {
        sink.off(event, wrapped);
        listener(...args);
      };
      return sink.on(event, wrapped);
    },
    off(event, listener) {
      const bucket = listeners.get(event);
      if (bucket) {
        bucket.delete(listener);
        if (bucket.size === 0) {
          listeners.delete(event);
        }
      }
      return this;
    }
  };

  function emit(event: string, ...args: unknown[]): void {
    const bucket = listeners.get(event);
    if (!bucket) {
      return;
    }
    for (const listener of [...bucket]) {
      listener(...args);
    }
  }

  function handleRead(): void {
    if (cancelled) {
      return;
    }
    if (!started) {
      started = true;
      // Deferred through a microtask so a synchronous throw inside the
      // serializer surfaces as a stream error rather than escaping `_read()`.
      Promise.resolve()
        .then(() => serialize(sink, writeOptions))
        .then(() => {
          // Safety net: the writer always ends its destination, but if that
          // ever changed the consumer would wait forever for an EOF that never
          // arrives. `end()` is idempotent, so this cannot double-close.
          sink.end();
        })
        .catch((error: unknown) => {
          if (cancelled) {
            // The consumer already tore the stream down; whatever the writer
            // reported afterwards is a consequence of that, not a new failure.
            return;
          }
          source.destroy(error instanceof Error ? error : new Error(String(error)));
        });
      return;
    }
    // The queue dropped back below `highWaterMark`: release a writer parked in
    // `IZipWriter.waitForDrain()`.
    emit("drain");
  }

  function handleDestroy(error: Error | null, callback: (error: Error | null) => void): void {
    cancelled = true;
    // Tell the writer its destination is gone so a parked `waitForDrain()`
    // rejects instead of leaking a promise that never settles.
    if (error) {
      emit("error", error);
    } else {
      emit("close");
    }
    callback(error);
  }

  return source;
}

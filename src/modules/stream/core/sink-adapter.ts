/**
 * SinkAdapter — unified writable-sink view.
 *
 * Producers (zip writers, docx streamers, etc.) generate `Uint8Array`
 * chunks and want to push them through a user-supplied destination
 * without caring whether that destination is a Web `WritableStream`,
 * a Node `Writable`, or some duck-typed object.
 *
 * `SinkAdapter` collapses all three into one promise-based API:
 *   - `write(chunk)` resolves once the chunk has been accepted by the
 *     sink (after awaiting `drain` for Node-style sinks under
 *     backpressure, or `writer.ready` for Web streams).
 *   - `end()` finalises the sink and resolves on close.
 *   - The first sink error is captured and re-thrown from the next
 *     `write` / `end` so callers can't lose it.
 *
 * Producers are expected to either:
 *   - drive `await sink.write(chunk)` directly (preferred — gives
 *     true end-to-end backpressure), or
 *   - chain writes onto a single shared promise so a synchronous
 *     emit callback can still feed the adapter without blocking.
 */

import { createEventWaiter } from "@stream/core/event-utils";
import type { EventEmitterLike } from "@stream/types";

/**
 * Loose Node `Writable`-like contract. Matches `stream.Writable` but only
 * the subset SinkAdapter touches; intentionally avoids depending on
 * `node:stream` so the adapter compiles in browsers.
 */
export interface NodeWritableLike extends EventEmitterLike {
  write(chunk: Uint8Array, cb?: (err?: Error | null) => void): boolean | PromiseLike<boolean>;
  end(cb?: () => void): unknown;
  destroyed?: boolean;
}

/**
 * Object that implements just enough of a writable to be useful: a
 * `write` returning sync bool / Promise, plus `end`. Used as a fallback
 * for legacy producers that don't fit either Node or Web streams.
 */
export interface DuckSinkLike extends EventEmitterLike {
  write(chunk: Uint8Array): boolean | PromiseLike<boolean>;
  end(): unknown;
}

/** Anything SinkAdapter knows how to drive. */
export type AnySink = WritableStream<Uint8Array> | NodeWritableLike | DuckSinkLike;

function isWebWritable(s: unknown): s is WritableStream<Uint8Array> {
  return (
    typeof s === "object" &&
    s !== null &&
    typeof (s as WritableStream<Uint8Array>).getWriter === "function"
  );
}

function isNodeWritable(s: unknown): s is NodeWritableLike {
  return (
    typeof s === "object" &&
    s !== null &&
    typeof (s as NodeWritableLike).write === "function" &&
    typeof (s as NodeWritableLike).end === "function" &&
    (typeof (s as NodeWritableLike).once === "function" ||
      typeof (s as NodeWritableLike).on === "function")
  );
}

/** Unified sink view with awaited write + error capture. */
export class SinkAdapter {
  private readonly _kind: "web" | "node" | "duck";
  private readonly _webWriter?: WritableStreamDefaultWriter<Uint8Array>;
  private readonly _nodeSink?: NodeWritableLike;
  private readonly _duckSink?: DuckSinkLike;
  private _error: Error | null = null;
  private _ended = false;

  constructor(sink: AnySink) {
    if (isWebWritable(sink)) {
      this._kind = "web";
      this._webWriter = sink.getWriter();
      // Web writers expose .closed; surface termination errors through
      // the same _error channel so producers see them.
      this._webWriter.closed.catch((err: unknown) => {
        this._captureError(err);
      });
    } else if (isNodeWritable(sink)) {
      this._kind = "node";
      this._nodeSink = sink;
      this._attachErrorListener(sink);
    } else {
      this._kind = "duck";
      this._duckSink = sink as DuckSinkLike;
      this._attachErrorListener(sink as DuckSinkLike);
    }
  }

  /**
   * The first error reported by the sink (or `null`). Producers that
   * cannot await `write()` (synchronous emit callbacks) should poll
   * this between operations.
   */
  get error(): Error | null {
    return this._error;
  }

  async write(chunk: Uint8Array): Promise<void> {
    this._throwIfErrored();
    if (this._ended) {
      throw new Error("SinkAdapter: write after end");
    }
    if (chunk.length === 0) {
      return;
    }

    if (this._kind === "web") {
      const w = this._webWriter!;
      // `ready` resolves once the internal queue has drained below the
      // high-water mark; awaiting it gives backpressure for free.
      await w.ready;
      await w.write(chunk);
      return;
    }

    const sink = this._kind === "node" ? this._nodeSink! : this._duckSink!;
    // Register before write(): a duck sink may emit drain synchronously and
    // only resolve its Promise<boolean> afterwards.
    const drain = hasEvents(sink)
      ? createEventWaiter(sink, ["drain"], { keepErrorUntilCancel: true })
      : null;
    let result: boolean;
    try {
      result = await sink.write(chunk);
    } catch (error) {
      drain?.cancel();
      throw error;
    }
    if (drain?.error()) {
      throw drain.error()!;
    }
    if (!result && drain) {
      await drain.promise;
      drain.cancel();
      this._throwIfErrored();
    } else {
      drain?.cancel();
    }
  }

  async end(): Promise<void> {
    if (this._ended) {
      return;
    }
    this._ended = true;
    this._throwIfErrored();

    if (this._kind === "web") {
      // close() rejects if the stream has already errored — we let that
      // propagate so callers see the underlying failure.
      await this._webWriter!.close();
      return;
    }

    if (this._kind === "node") {
      const sink = this._nodeSink!;
      // Prefer the close event when available; some Node writables emit
      // 'finish' first and only emit 'close' on `destroy()`. We listen
      // for both.
      const finished = createEventWaiter(sink, ["close", "finish"]);
      try {
        await sink.end();
        await finished.promise;
      } catch (error) {
        finished.cancel();
        throw error;
      }
      this._throwIfErrored();
      return;
    }

    // duck
    const sink = this._duckSink!;
    if (hasEvents(sink)) {
      const finished = createEventWaiter(sink, ["close", "finish"]);
      try {
        await sink.end();
        await finished.promise;
      } catch (error) {
        finished.cancel();
        throw error;
      }
    } else {
      await sink.end();
    }
    this._throwIfErrored();
  }

  private _captureError(err: unknown): void {
    if (this._error) {
      return;
    }
    this._error = err instanceof Error ? err : new Error(String(err));
  }

  private _throwIfErrored(): void {
    if (this._error) {
      throw this._error;
    }
  }

  private _attachErrorListener(sink: EventEmitterLike): void {
    if (typeof sink.on === "function") {
      sink.on("error", (err: unknown) => {
        this._captureError(err);
      });
    } else if (typeof sink.once === "function") {
      // Best-effort: a once listener is enough to capture the first error.
      sink.once("error", (err: unknown) => {
        this._captureError(err);
      });
    }
  }
}

function hasEvents(sink: EventEmitterLike): boolean {
  return typeof sink.once === "function" || typeof sink.on === "function";
}

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
 *   - `end()` finalises the sink and resolves once it has really finished
 *     (`'finish'` for a Node-style sink — a `'close'` before it is a
 *     premature close). Calling it again returns the same promise.
 *   - `abort(reason)` gives the sink up after a producer failure.
 *   - A Web sink's writer is released once the sink is closed, aborted or
 *     errored, so the stream is not left locked.
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
  destroy?(error?: Error): unknown;
  destroyed?: boolean;
  writableFinished?: boolean;
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
  private _ending: Promise<void> | null = null;
  private _writerReleased = false;

  constructor(sink: AnySink) {
    if (isWebWritable(sink)) {
      this._kind = "web";
      this._webWriter = sink.getWriter();
      // Web writers expose .closed; surface termination errors through
      // the same _error channel so producers see them.
      this._webWriter.closed.catch((err: unknown) => {
        // Releasing our own lock rejects `closed` too; that is not a sink error.
        if (!this._writerReleased) {
          this._captureError(err);
          this._releaseWriter();
        }
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

  /** Finish the sink. Every call returns the same promise. */
  end(): Promise<void> {
    if (!this._ending) {
      this._ended = true;
      this._ending = this._finish();
    }
    return this._ending;
  }

  /**
   * Give the sink up after a producer failure: a Web sink is aborted and its
   * lock released, a Node-style one destroyed with `reason`.
   */
  async abort(reason?: unknown): Promise<void> {
    this._ended = true;
    const error = reason instanceof Error ? reason : new Error(String(reason ?? "aborted"));
    this._captureError(error);
    if (this._kind === "web") {
      if (!this._writerReleased) {
        await this._webWriter!.abort(error).catch(() => {});
        this._releaseWriter();
      }
      return;
    }
    const sink = (this._kind === "node" ? this._nodeSink : this._duckSink) as {
      destroy?: (error?: Error) => unknown;
      destroyed?: boolean;
    };
    if (typeof sink.destroy === "function" && !sink.destroyed) {
      sink.destroy(error);
    }
  }

  private async _finish(): Promise<void> {
    this._throwIfErrored();

    if (this._kind === "web") {
      // close() rejects if the stream has already errored — we let that
      // propagate so callers see the underlying failure.
      try {
        await this._webWriter!.close();
      } finally {
        this._releaseWriter();
      }
      return;
    }

    const sink = this._kind === "node" ? this._nodeSink! : this._duckSink!;
    if (hasEvents(sink)) {
      const finished = waitForFinish(sink);
      try {
        await sink.end();
      } catch (error) {
        finished.cancel();
        throw error;
      }
      await finished.promise;
    } else {
      await sink.end();
    }
    this._throwIfErrored();
  }

  private _releaseWriter(): void {
    if (!this._writerReleased) {
      this._writerReleased = true;
      this._webWriter!.releaseLock();
    }
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

/**
 * Resolve on `'finish'`; reject on `'error'`, or on a `'close'` that comes
 * first while the sink reports it has not finished — that is a premature
 * close, not a successful end.
 */
function waitForFinish(sink: EventEmitterLike): { promise: Promise<void>; cancel: () => void } {
  let cleanup = (): void => {};
  const promise = new Promise<void>((resolve, reject) => {
    const onFinish = (): void => {
      cleanup();
      resolve();
    };
    const onError = (err: unknown): void => {
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    const onClose = (): void => {
      cleanup();
      // A sink that reports no finished state (a duck sink signalling with
      // 'close' alone) is taken at its word; one that does must have finished.
      const finished = (sink as { writableFinished?: unknown }).writableFinished;
      if (typeof finished !== "boolean" || finished) {
        resolve();
        return;
      }
      const err = new Error("Premature close") as Error & { code: string };
      err.code = "ERR_STREAM_PREMATURE_CLOSE";
      reject(err);
    };
    const on = (sink.on ?? sink.once)!.bind(sink);
    on("finish", onFinish);
    on("error", onError);
    on("close", onClose);
    cleanup = () => {
      const off = (sink.off ?? sink.removeListener)?.bind(sink);
      off?.("finish", onFinish);
      off?.("error", onError);
      off?.("close", onClose);
    };
  });
  return { promise, cancel: () => cleanup() };
}

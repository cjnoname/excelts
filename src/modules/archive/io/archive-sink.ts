import { createEventWaiter } from "@stream/core/event-utils";
import { isWritableStream } from "@stream/core/type-guards";
import { concatUint8Arrays } from "@utils/binary";

export type ArchiveSink =
  | WritableStream<Uint8Array>
  | {
      write(chunk: Uint8Array): boolean | void | PromiseLike<unknown>;
      end?(cb?: () => void): unknown;
      // EventEmitter-style hooks (Node Writable). `...args: unknown[]` is the
      // standard emitter listener signature.
      on?(event: string, listener: (...args: unknown[]) => void): unknown;
      once?(event: string, listener: (...args: unknown[]) => void): unknown;
      off?(event: string, listener: (...args: unknown[]) => void): unknown;
      removeListener?(event: string, listener: (...args: unknown[]) => void): unknown;
    };

export async function pipeIterableToSink(
  iterable: AsyncIterable<Uint8Array>,
  sink: ArchiveSink
): Promise<void> {
  if (isWritableStream(sink)) {
    const writer = sink.getWriter();
    try {
      for await (const chunk of iterable) {
        await writer.write(chunk);
      }
      await writer.close();
    } finally {
      try {
        writer.releaseLock();
      } catch {
        // Ignore
      }
    }
    return;
  }

  // Node-style Writable
  for await (const chunk of iterable) {
    const hasEvents = typeof sink.once === "function" || typeof sink.on === "function";
    // Register first so an async-returning duck sink cannot emit drain before
    // its write promise settles and make us miss the event.
    const drain = hasEvents
      ? createEventWaiter(sink, ["drain"], { keepErrorUntilCancel: true })
      : null;
    let ok: unknown;
    try {
      ok = await sink.write(chunk);
    } catch (error) {
      drain?.cancel();
      throw error;
    }
    if (drain?.error()) {
      throw drain.error()!;
    }
    if (ok === false && drain) {
      await drain.promise;
      drain.cancel();
    } else {
      drain?.cancel();
    }
  }

  if (typeof sink.end === "function") {
    if (typeof sink.once === "function" || typeof sink.on === "function") {
      const finished = createEventWaiter(sink, ["finish", "close"]);
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
  }
}

export async function collect(iterable: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of iterable) {
    chunks.push(chunk);
    total += chunk.length;
  }
  return concatUint8Arrays(chunks, total);
}

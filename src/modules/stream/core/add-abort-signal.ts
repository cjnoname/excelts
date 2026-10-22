/**
 * Stream Module - Common Abort Signal Helper
 *
 * Platform-neutral abort signal handling, parameterized by
 * event listener management (Node.js uses `.on`/`.off`,
 * browser uses `addEmitterListener`/`removeEmitterListener`).
 */

import type { EventEmitterLike, ReadableLike, WritableLike } from "@stream/types";
import { createAbortError } from "@utils/errors";

// =============================================================================
// Types
// =============================================================================

interface ListenerOps {
  add(emitter: EventEmitterLike, event: string, listener: (...args: any[]) => void): void;
  remove(emitter: EventEmitterLike, event: string, listener: (...args: any[]) => void): void;
}

// =============================================================================
// Factory
// =============================================================================

/**
 * Create a platform-specific `addAbortSignal` function.
 */
export function createAddAbortSignal(ops: ListenerOps) {
  return function addAbortSignal<
    T extends (ReadableLike | WritableLike) & { destroy(error?: Error): any }
  >(signal: AbortSignal, stream: T): T {
    if (signal.aborted) {
      stream.destroy(createAbortError(signal.reason));
      return stream;
    }

    const cleanup = (): void => {
      signal.removeEventListener("abort", onAbort);
      ops.remove(stream, "close", onDone);
      ops.remove(stream, "end", onDone);
      ops.remove(stream, "finish", onDone);
      ops.remove(stream, "error", onError);
    };

    const onAbort = (): void => {
      cleanup();
      stream.destroy(createAbortError(signal.reason));
    };

    const onDone = (): void => {
      cleanup();
    };

    const onError = (): void => {
      cleanup();
    };

    signal.addEventListener("abort", onAbort, { once: true });
    ops.add(stream, "close", onDone);
    ops.add(stream, "end", onDone);
    ops.add(stream, "finish", onDone);
    ops.add(stream, "error", onError);

    return stream;
  };
}

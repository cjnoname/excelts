/**
 * Small event utilities for Node-style emitters.
 *
 * Prefer keeping this separate from the main stream implementation so other
 * modules (e.g. archive) can reuse it without pulling in the whole stream API.
 */

import type { EventEmitterLike } from "@stream/types";

function off(emitter: EventEmitterLike, event: string, listener: (...args: any[]) => void): void {
  if (typeof emitter.off === "function") {
    emitter.off(event, listener);
  } else if (typeof emitter.removeListener === "function") {
    emitter.removeListener(event, listener);
  }
}

/**
 * Resolve when an emitter fires `event`, reject on `error`.
 */
export function onceEvent(emitter: EventEmitterLike, event: string): Promise<void> {
  return createEventWaiter(emitter, [event]).promise;
}

export type EventWaiter = {
  promise: Promise<void>;
  cancel: () => void;
  error: () => Error | null;
};

/**
 * Register an error-aware event wait before starting an operation that may emit
 * synchronously. `cancel()` removes every listener when the operation turns out
 * not to need the event (for example, `write()` returns true).
 */
export function createEventWaiter(
  emitter: EventEmitterLike,
  events: readonly string[],
  options: { keepErrorUntilCancel?: boolean } = {}
): EventWaiter {
  let promiseSettled = false;
  let cancelled = false;
  let capturedError: Error | null = null;
  let resolvePromise!: () => void;
  let rejectPromise!: (error: Error) => void;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  const cleanup = (): void => {
    off(emitter, "error", onError);
    for (const event of events) {
      off(emitter, event, onDone);
    }
  };
  const removeDoneListeners = (): void => {
    for (const event of events) {
      off(emitter, event, onDone);
    }
  };
  const onError = (err: unknown): void => {
    if (cancelled) {
      return;
    }
    capturedError = err instanceof Error ? err : new Error(String(err));
    cleanup();
    if (!promiseSettled) {
      promiseSettled = true;
      rejectPromise(capturedError);
    }
  };
  const onDone = (): void => {
    if (cancelled || promiseSettled) {
      return;
    }
    promiseSettled = true;
    if (options.keepErrorUntilCancel) {
      removeDoneListeners();
    } else {
      cleanup();
    }
    resolvePromise();
  };
  const cancel = (): void => {
    if (cancelled) {
      return;
    }
    cancelled = true;
    cleanup();
    // A cancelled waiter is never observed, but settle it to avoid retaining
    // the promise's resolver graph.
    if (!promiseSettled) {
      promiseSettled = true;
      resolvePromise();
    }
  };

  if (typeof emitter.once === "function") {
    emitter.once("error", onError);
    for (const event of events) {
      emitter.once(event, onDone);
    }
  } else {
    emitter.on?.("error", onError);
    for (const event of events) {
      emitter.on?.(event, onDone);
    }
  }

  // A sink may emit error while the caller is still awaiting its write return;
  // mark the rejection handled immediately. Awaiting the original promise still
  // rejects with the same error when the event is the relevant outcome.
  void promise.catch(() => {});
  return { promise, cancel, error: () => capturedError };
}

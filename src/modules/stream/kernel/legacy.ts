/**
 * Stream kernel - common base class
 *
 * The browser counterpart of Node's `Stream`: an EventEmitter with the static
 * state inspectors every stream class inherits (`Readable.isDisturbed`,
 * `Writable.isErrored`, …).
 */

import {
  isDestroyed,
  isDisturbed,
  isErrored,
  isReadable,
  isWritable
} from "@stream/kernel/stream-utils";
import { EventEmitter } from "@utils/event-emitter";

export class Stream extends EventEmitter {
  static isDestroyed(stream: unknown): boolean | null {
    return isDestroyed(stream);
  }

  static isDisturbed(stream: unknown): boolean {
    return isDisturbed(stream);
  }

  static isErrored(stream: unknown): boolean {
    return isErrored(stream);
  }

  static isReadable(stream: unknown): boolean | null {
    return isReadable(stream);
  }

  static isWritable(stream: unknown): boolean | null {
    return isWritable(stream);
  }
}

/** Attach `fn` ahead of any user listener so stream bookkeeping runs first. */
export function prependListener(
  emitter: {
    prependListener?: (event: string, fn: (...args: any[]) => void) => unknown;
    on(event: string, fn: (...args: any[]) => void): unknown;
  },
  event: string,
  fn: (...args: any[]) => void
): void {
  if (typeof emitter.prependListener === "function") {
    emitter.prependListener(event, fn);
  } else {
    emitter.on(event, fn);
  }
}

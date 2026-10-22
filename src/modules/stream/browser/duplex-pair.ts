/**
 * Browser Stream - duplexPair()
 *
 * Its own module: `DuplexSide extends Duplex` is a top-level class, which a
 * bundler keeps — with the whole Duplex chain behind it — whenever the module
 * holding it is kept.
 */

import { Duplex } from "@stream/kernel/classes";
import { nextTick } from "@stream/kernel/state";
import type { DuplexStreamOptions, IDuplex } from "@stream/types";

type Callback = (error?: Error | null) => void;

/**
 * One end of a {@link duplexPair}: what is written here is pushed to the
 * other end, and the write completes only when the other end reads it.
 * Port of Node.js `lib/internal/streams/duplexpair.js`.
 */
class DuplexSide<T> extends Duplex<T, T> {
  private _otherSide: DuplexSide<T> | null = null;
  private _pendingCallback: Callback | null = null;

  _initOtherSide(otherSide: DuplexSide<T>): void {
    this._otherSide = otherSide;
  }

  override _read(_size?: number): void {
    // The other side's write waits for this read; release it.
    const callback = this._pendingCallback;
    if (callback) {
      this._pendingCallback = null;
      callback();
    }
  }

  override _write(chunk: T, _encoding: string, callback: Callback): void {
    const other = this._otherSide!;
    if ((chunk as { length?: number }).length === 0) {
      nextTick(callback);
    } else {
      other.push(chunk);
      other._pendingCallback = callback;
    }
  }

  override _final(callback: Callback): void {
    this._otherSide!.on("end", callback);
    this._otherSide!.push(null);
  }

  override _destroy(err: Error | null, callback: Callback): void {
    const other = this._otherSide;
    if (other !== null && !other.destroyed) {
      nextTick(() => {
        if (other.destroyed) {
          return;
        }
        if (err) {
          other.destroy();
        } else {
          other.push(null);
        }
      });
    }
    callback(err);
  }
}

/** Two connected Duplex streams: each one reads what the other writes. */
export function duplexPair<T = unknown>(
  options?: DuplexStreamOptions
): [IDuplex<T, T>, IDuplex<T, T>] {
  const side0 = new DuplexSide<T>(options);
  const side1 = new DuplexSide<T>(options);
  side0._initOtherSide(side1);
  side1._initOtherSide(side0);
  return [side0, side1];
}

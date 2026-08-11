/**
 * `AsyncQueue` must not keep consumed values reachable.
 *
 * The queue dequeues through a head index instead of `Array.shift()`, and only
 * compacts its backing arrays after a threshold. Without clearing each slot as
 * it is taken, every value and every producer/consumer closure below the head
 * stays reachable until that compaction — for a bounded queue draining chunk by
 * chunk, that is up to a thousand output buffers.
 *
 * This asserts reachability via `WeakRef`, not a heap-size reading: heap deltas
 * are meaningless in this suite (~400 files share one V8 heap), whereas
 * "is this object still reachable after a forced collection" is exact. A forced
 * collection needs `--expose-gc`, which plain `vitest run` does not set, so the
 * case skips itself rather than pretending to guard anything.
 */
import { createAsyncQueue } from "@archive/core/async-queue";
import { describe, expect, it } from "vitest";

const gc = (globalThis as { gc?: () => void }).gc;

describe("async-queue retention", () => {
  it.skipIf(!gc)(
    "releases consumed values before compaction",
    async () => {
      const queue = createAsyncQueue<Uint8Array>({ capacity: 1 });
      const iterator = queue.iterable[Symbol.asyncIterator]();
      const refs: WeakRef<Uint8Array>[] = [];

      // Stay well under the compaction threshold: this is the window in which a
      // head-index queue that never clears slots retains everything it produced.
      for (let i = 0; i < 500; i++) {
        const chunk = new Uint8Array(64 * 1024);
        refs.push(new WeakRef(chunk));
        await queue.push(chunk);
        await iterator.next();
      }

      gc!();
      await new Promise(resolve => setTimeout(resolve, 0));
      gc!();

      // Only the most recently dequeued value may still be held by the caller's
      // own frame; everything older must be collectable.
      const alive = refs.filter(ref => ref.deref() !== undefined).length;
      expect(alive).toBeLessThanOrEqual(2);
    },
    120000
  );
});

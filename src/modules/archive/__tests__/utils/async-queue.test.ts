import { createAsyncQueue } from "@archive/core/async-queue";
import { describe, expect, it } from "vitest";

describe("async-queue", () => {
  it("return() should cancel, resolve pending next(), and call onCancel once", async () => {
    let cancels = 0;
    const q = createAsyncQueue<number>({
      onCancel: () => {
        cancels++;
      }
    });

    const itor = q.iterable[Symbol.asyncIterator]();

    const pendingNext = itor.next();
    const ret = await itor.return!();

    expect(ret.done).toBe(true);
    expect(cancels).toBe(1);

    await expect(pendingNext).resolves.toEqual({ value: undefined, done: true });
    await expect(itor.next()).resolves.toEqual({ value: undefined, done: true });

    // Should ignore pushes after cancellation.
    await expect(q.push(123)).rejects.toThrow("closed");
    await expect(itor.next()).resolves.toEqual({ value: undefined, done: true });

    // Idempotent.
    await itor.return!();
    expect(cancels).toBe(1);
  });

  it("throw() should cancel, resolve pending next(), and reject with the provided error", async () => {
    let cancels = 0;
    const q = createAsyncQueue<number>({
      onCancel: () => {
        cancels++;
      }
    });

    const itor = q.iterable[Symbol.asyncIterator]();

    const pendingNext = itor.next();
    const err = new Error("boom");

    await expect(itor.throw!(err)).rejects.toBe(err);
    expect(cancels).toBe(1);

    await expect(pendingNext).resolves.toEqual({ value: undefined, done: true });
    await expect(itor.next()).resolves.toEqual({ value: undefined, done: true });
  });

  it("fail() should reject pending next() and all future next() calls", async () => {
    const q = createAsyncQueue<number>();
    const itor = q.iterable[Symbol.asyncIterator]();

    const pendingNext = itor.next();
    q.fail(new Error("x"));

    await expect(pendingNext).rejects.toThrow("x");
    await expect(itor.next()).rejects.toThrow("x");

    // close() after fail() should be ignored.
    q.close();
    await expect(itor.next()).rejects.toThrow("x");
  });

  it("should block at capacity and wake blocked producers on terminal states", async () => {
    const q = createAsyncQueue<number>({ capacity: 1 });
    const iterator = q.iterable[Symbol.asyncIterator]();
    await q.push(1);
    let admitted = false;
    const blocked = q.push(2).then(() => {
      admitted = true;
    });
    await Promise.resolve();
    expect(admitted).toBe(false);
    await expect(iterator.next()).resolves.toEqual({ value: 1, done: false });
    await blocked;

    const err = new Error("failed");
    const failed = createAsyncQueue<number>({ capacity: 1 });
    await failed.push(1);
    const failedPush = failed.push(2);
    failed.fail(err);
    await expect(failedPush).rejects.toBe(err);

    const closed = createAsyncQueue<number>({ capacity: 1 });
    await closed.push(1);
    const closedPush = closed.push(2);
    closed.close();
    await expect(closedPush).rejects.toThrow("closed");

    const cancelled = createAsyncQueue<number>({ capacity: 1, cancelError: () => err });
    await cancelled.push(1);
    const cancelledPush = cancelled.push(2);
    await cancelled.iterable[Symbol.asyncIterator]().return!();
    await expect(cancelledPush).rejects.toBe(err);
  });
});

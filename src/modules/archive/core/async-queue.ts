/**
 * Async producer/consumer queue.
 *
 * `push()` is asynchronous so a producer can be throttled by a slow consumer:
 * with a bounded `capacity`, it resolves only once the value has been handed to
 * a waiting consumer or has room in the buffer. It rejects when the queue has
 * already been closed, failed, or cancelled — a producer must observe that
 * instead of silently dropping data.
 *
 * All three FIFOs use a head index with periodic compaction rather than
 * `Array.shift()`, so an unbounded queue that buffers many values stays linear.
 * Consumed slots are cleared as they are taken: the head index alone would keep
 * every value — and every producer/consumer closure — reachable until the next
 * compaction, which for a bounded queue can be a thousand chunks of output.
 */
export type AsyncQueue<T> = {
  /** Hand a value to the queue, waiting while a bounded queue is full. */
  push: (value: T) => Promise<void>;
  fail: (err: Error) => void;
  close: () => void;
  iterable: AsyncIterable<T>;
};

type Consumer<T> = {
  resolve: (result: IteratorResult<T, undefined>) => void;
  reject: (err: Error) => void;
};

type Producer<T> = {
  value: T;
  resolve: () => void;
  reject: (err: Error) => void;
};

/** Compact a FIFO once its consumed prefix dominates the backing array. */
const COMPACT_THRESHOLD = 1024;

export function createAsyncQueue<T>(
  options: {
    /** Maximum buffered values before `push()` waits. Defaults to unbounded. */
    capacity?: number;
    onCancel?: () => void;
    /** Error used to reject producers blocked when the consumer cancels. */
    cancelError?: () => Error;
  } = {}
): AsyncQueue<T> {
  const capacity = options.capacity ?? Number.POSITIVE_INFINITY;
  if (!(capacity > 0) || (capacity !== Number.POSITIVE_INFINITY && !Number.isInteger(capacity))) {
    throw new RangeError("Async queue capacity must be a positive integer");
  }

  // Consumed entries are set to `undefined` rather than left in place, so the
  // slots below each head index hold no references between compactions.
  const values: Array<T | undefined> = [];
  let valuesHead = 0;
  const consumers: Array<Consumer<T> | undefined> = [];
  let consumersHead = 0;
  const producers: Array<Producer<T> | undefined> = [];
  let producersHead = 0;
  let done = false;
  let error: Error | null = null;
  let cancelled = false;

  function bufferedCount(): number {
    return values.length - valuesHead;
  }

  function compact<U>(items: Array<U | undefined>, head: number): number {
    if (head > COMPACT_THRESHOLD && head * 2 > items.length) {
      items.splice(0, head);
      return 0;
    }
    return head;
  }

  function takeValue(): T {
    const value = values[valuesHead] as T;
    values[valuesHead] = undefined;
    valuesHead = compact(values, valuesHead + 1);
    return value;
  }

  function takeConsumer(): Consumer<T> | undefined {
    if (consumersHead >= consumers.length) {
      return undefined;
    }
    const consumer = consumers[consumersHead];
    consumers[consumersHead] = undefined;
    consumersHead = compact(consumers, consumersHead + 1);
    return consumer;
  }

  function takeProducer(): Producer<T> | undefined {
    if (producersHead >= producers.length) {
      return undefined;
    }
    const producer = producers[producersHead];
    producers[producersHead] = undefined;
    producersHead = compact(producers, producersHead + 1);
    return producer;
  }

  function drainConsumers(settle: (consumer: Consumer<T>) => void): void {
    while (true) {
      const consumer = takeConsumer();
      if (!consumer) {
        break;
      }
      settle(consumer);
    }
  }

  function rejectProducers(err: Error): void {
    while (true) {
      const producer = takeProducer();
      if (!producer) {
        break;
      }
      producer.reject(err);
    }
  }

  function clearValues(): void {
    values.length = 0;
    valuesHead = 0;
  }

  /** Admit one blocked producer now that a slot is free. */
  function admitProducer(): void {
    if (done || error || bufferedCount() >= capacity) {
      return;
    }
    const producer = takeProducer();
    if (!producer) {
      return;
    }
    const consumer = takeConsumer();
    if (consumer) {
      consumer.resolve({ value: producer.value, done: false });
    } else {
      values.push(producer.value);
    }
    producer.resolve();
  }

  function cancel(): void {
    if (cancelled) {
      return;
    }
    cancelled = true;
    done = true;
    clearValues();
    drainConsumers(consumer => consumer.resolve({ value: undefined, done: true }));
    rejectProducers(options.cancelError?.() ?? new Error("Async queue was cancelled"));
    try {
      options.onCancel?.();
    } catch {
      // ignore
    }
  }

  function push(value: T): Promise<void> {
    if (error) {
      return Promise.reject(error);
    }
    if (done) {
      return Promise.reject(new Error("Async queue is closed"));
    }
    const consumer = takeConsumer();
    if (consumer) {
      consumer.resolve({ value, done: false });
      return Promise.resolve();
    }
    if (bufferedCount() < capacity) {
      values.push(value);
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => producers.push({ value, resolve, reject }));
  }

  function fail(err: Error): void {
    if (done || error) {
      return;
    }
    error = err;
    clearValues();
    rejectProducers(err);
    drainConsumers(consumer => consumer.reject(err));
  }

  function close(): void {
    if (done || error) {
      return;
    }
    done = true;
    rejectProducers(new Error("Async queue is closed"));
    drainConsumers(consumer => consumer.resolve({ value: undefined, done: true }));
  }

  const iterable: AsyncIterable<T> = {
    [Symbol.asyncIterator](): AsyncIterator<T, undefined> {
      return {
        next(): Promise<IteratorResult<T, undefined>> {
          if (error) {
            return Promise.reject(error);
          }
          if (bufferedCount() > 0) {
            const value = takeValue();
            admitProducer();
            return Promise.resolve({ value, done: false });
          }
          if (done) {
            return Promise.resolve({ value: undefined, done: true });
          }
          return new Promise((resolve, reject) => consumers.push({ resolve, reject }));
        },
        return(): Promise<IteratorResult<T, undefined>> {
          cancel();
          return Promise.resolve({ value: undefined, done: true });
        },
        throw(err?: unknown): Promise<IteratorResult<T, undefined>> {
          cancel();
          return Promise.reject(err);
        }
      };
    }
  };

  return { push, fail, close, iterable };
}

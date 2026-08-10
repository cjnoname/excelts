export type AsyncQueue<T> = {
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

export function createAsyncQueue<T>(
  options: { capacity?: number; onCancel?: () => void; cancelError?: () => Error } = {}
): AsyncQueue<T> {
  const capacity = options.capacity ?? Number.POSITIVE_INFINITY;
  if (!(capacity > 0) || (capacity !== Number.POSITIVE_INFINITY && !Number.isInteger(capacity))) {
    throw new RangeError("Async queue capacity must be a positive integer");
  }

  const values: T[] = [];
  const consumers: Consumer<T>[] = [];
  const producers: Producer<T>[] = [];
  let done = false;
  let error: Error | null = null;
  let cancelled = false;

  function admitProducer(): void {
    if (done || error || values.length >= capacity) {
      return;
    }
    const producer = producers.shift();
    if (!producer) {
      return;
    }
    const consumer = consumers.shift();
    if (consumer) {
      consumer.resolve({ value: producer.value, done: false });
    } else {
      values.push(producer.value);
    }
    producer.resolve();
  }

  function rejectProducers(err: Error): void {
    for (const producer of producers.splice(0)) {
      producer.reject(err);
    }
  }

  function cancel(): void {
    if (cancelled) {
      return;
    }
    cancelled = true;
    done = true;
    values.length = 0;
    for (const consumer of consumers.splice(0)) {
      consumer.resolve({ value: undefined, done: true });
    }
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
    const consumer = consumers.shift();
    if (consumer) {
      consumer.resolve({ value, done: false });
      return Promise.resolve();
    }
    if (values.length < capacity) {
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
    values.length = 0;
    rejectProducers(err);
    for (const consumer of consumers.splice(0)) {
      consumer.reject(err);
    }
  }

  function close(): void {
    if (done || error) {
      return;
    }
    done = true;
    rejectProducers(new Error("Async queue is closed"));
    for (const consumer of consumers.splice(0)) {
      consumer.resolve({ value: undefined, done: true });
    }
  }

  const iterable: AsyncIterable<T> = {
    [Symbol.asyncIterator](): AsyncIterator<T, undefined> {
      return {
        next(): Promise<IteratorResult<T, undefined>> {
          if (error) {
            return Promise.reject(error);
          }
          if (values.length > 0) {
            const value = values.shift()!;
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

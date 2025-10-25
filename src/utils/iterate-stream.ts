import type { EventEmitter } from "events";

interface Readable extends EventEmitter {
  resume(): void;
  pause(): void;
  on(event: "data", listener: (chunk: any) => void): this;
  on(event: "end", listener: () => void): this;
  on(event: "error", listener: (err: Error) => void): this;
}

async function* iterateStream(stream: Readable): AsyncGenerator<any> {
  const contents: any[] = [];
  let resolveDataPromise: (() => void) | null = null;

  const onData = (data: any) => {
    contents.push(data);
    if (resolveDataPromise) {
      resolveDataPromise();
      resolveDataPromise = null;
    }
  };
  stream.on("data", onData);

  let ended = false;
  const onEnd = () => {
    ended = true;
    if (resolveDataPromise) {
      resolveDataPromise();
      resolveDataPromise = null;
    }
  };
  stream.on("end", onEnd);

  let error: Error | false = false;
  const onError = (err: Error) => {
    error = err;
    if (resolveDataPromise) {
      resolveDataPromise();
      resolveDataPromise = null;
    }
  };
  stream.on("error", onError);

  try {
    while (!ended || contents.length > 0) {
      if (contents.length === 0) {
        stream.resume();
        await new Promise<void>(resolve => {
          resolveDataPromise = resolve;
        });
      } else {
        stream.pause();
        const data = contents.shift();
        yield data;
      }
      if (error) {
        throw error;
      }
    }
  } finally {
    // Clean up listeners
    stream.removeListener("data", onData);
    stream.removeListener("end", onEnd);
    stream.removeListener("error", onError);
  }
}

export { iterateStream };

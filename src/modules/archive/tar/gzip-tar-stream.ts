import type { GzipStream } from "@archive/compression/streaming-compress";

const GZIP_PREMATURE_CLOSE_MESSAGE = "Gzip stream closed before completing";

/** @internal */
export async function* gzipTarChunks(
  tarChunks: AsyncIterable<Uint8Array>,
  gzipStream: GzipStream
): AsyncIterable<Uint8Array> {
  const outputChunks: Uint8Array[] = [];
  let outputHead = 0;
  let gzipError: Error | null = null;
  let gzipClosed = false;
  let completed = false;

  function* drainOutput(): Iterable<Uint8Array> {
    while (outputHead < outputChunks.length) {
      yield outputChunks[outputHead++]!;
    }
    if (outputHead > 0) {
      outputChunks.length = 0;
      outputHead = 0;
    }
  }

  function onData(chunk: Uint8Array): void {
    outputChunks.push(chunk);
  }

  function onError(error: Error): void {
    gzipError ??= error;
  }

  function onClose(): void {
    gzipClosed = true;
  }

  function currentFailure(): Error | null {
    return gzipError ?? (gzipClosed ? new Error(GZIP_PREMATURE_CLOSE_MESSAGE) : null);
  }

  async function waitForDrain(): Promise<void> {
    const failure = currentFailure();
    if (failure) {
      throw failure;
    }

    await new Promise<void>((resolve, reject) => {
      function cleanup(): void {
        gzipStream.off("drain", handleDrain);
        gzipStream.off("error", handleError);
        gzipStream.off("close", handleClose);
      }

      function handleDrain(): void {
        cleanup();
        resolve();
      }

      function handleError(error: Error): void {
        cleanup();
        reject(error);
      }

      function handleClose(): void {
        cleanup();
        reject(gzipError ?? new Error(GZIP_PREMATURE_CLOSE_MESSAGE));
      }

      gzipStream.once("drain", handleDrain);
      gzipStream.once("error", handleError);
      gzipStream.once("close", handleClose);

      const racedFailure = currentFailure();
      if (racedFailure) {
        cleanup();
        reject(racedFailure);
      }
    });
  }

  async function finishGzip(): Promise<void> {
    const failure = currentFailure();
    if (failure) {
      throw failure;
    }

    await new Promise<void>((resolve, reject) => {
      function cleanup(): void {
        gzipStream.off("error", handleError);
        gzipStream.off("close", handleClose);
      }

      function handleError(error: Error): void {
        cleanup();
        reject(error);
      }

      function handleClose(): void {
        cleanup();
        reject(gzipError ?? new Error(GZIP_PREMATURE_CLOSE_MESSAGE));
      }

      gzipStream.once("error", handleError);
      gzipStream.once("close", handleClose);
      gzipStream.end(() => {
        cleanup();
        resolve();
      });
    });
  }

  gzipStream.on("data", onData);
  gzipStream.on("error", onError);
  gzipStream.on("close", onClose);

  try {
    for await (const tarChunk of tarChunks) {
      const failure = currentFailure();
      if (failure) {
        throw failure;
      }
      if (!gzipStream.write(tarChunk)) {
        await waitForDrain();
      }
      yield* drainOutput();
    }

    await finishGzip();
    completed = true;
    yield* drainOutput();
  } finally {
    if (!completed && !gzipStream.destroyed) {
      gzipStream.destroy();
    }
    gzipStream.off("data", onData);
    gzipStream.off("error", onError);
    gzipStream.off("close", onClose);
  }
}

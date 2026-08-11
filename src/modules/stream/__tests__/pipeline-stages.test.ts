import { createCollector, pipeline, Readable } from "@stream";
import { describe, expect, it } from "vitest";

/**
 * `pipeline` accepts more than plain streams, on both platforms:
 *
 * - a generator/async-generator transform in the middle of the chain, and
 * - a bare (async) iterable as the source.
 *
 * Both worked on Node but were rejected by the public types, and the bare
 * iterable additionally threw `current.pipe is not a function` in the browser
 * implementation. These assertions compile without a cast — that is half the
 * point — and pin the runtime behaviour on both platforms.
 */
describe("pipeline stage kinds", () => {
  it("accepts a generator stage in the middle of the chain", async () => {
    const source = Readable.from([new Uint8Array([1]), new Uint8Array([2])]);
    const sink = createCollector<Uint8Array>();
    const doubleUp = async function* (chunks: AsyncIterable<unknown>) {
      for await (const chunk of chunks) {
        yield chunk as Uint8Array;
      }
    };

    await pipeline(source, doubleUp, sink);

    expect(sink.chunks).toHaveLength(2);
  });

  it("accepts a bare iterable as the source", async () => {
    const sink = createCollector<Uint8Array>();

    await pipeline([new Uint8Array([1]), new Uint8Array([2])], sink);

    expect(sink.chunks).toHaveLength(2);
  });

  it("accepts an async iterable as the source", async () => {
    const sink = createCollector<Uint8Array>();
    const bytes = async function* () {
      yield new Uint8Array([7]);
    };

    await pipeline(bytes(), sink);

    expect(sink.chunks).toHaveLength(1);
  });
});

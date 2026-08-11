/**
 * Early-exit teardown semantics of the browser `Readable`.
 *
 * The `Workbook.toStream` doc blocks state that the two builds differ here: Node's
 * own async iterator destroys the stream with an `AbortError` when a `for await`
 * loop breaks, while this implementation destroys it with no error. That
 * difference is the reason `errored` is documented as *not* a portable way to tell
 * "the consumer stopped" from "serialization failed", so it needs a test — the
 * claim is otherwise only as good as the comment.
 *
 * The class is plain JavaScript, so it is exercised directly here rather than in
 * the Playwright suite; what is under test is the implementation's contract, not
 * anything browser-specific.
 */
import { Readable } from "@stream/index.browser";
import { describe, expect, it } from "vitest";

function infiniteByteStream(): Readable<Uint8Array> {
  let i = 0;
  return new Readable<Uint8Array>({
    read() {
      this.push(new Uint8Array([i++ & 0xff]));
    }
  });
}

const settle = () => new Promise(resolve => setTimeout(resolve, 50));

describe("browser Readable early exit", () => {
  it("destroys silently when a for-await loop breaks", async () => {
    const stream = infiniteByteStream();
    const seen: Error[] = [];
    stream.on("error", (error: Error) => seen.push(error));

    let chunks = 0;
    for await (const _chunk of stream) {
      if (++chunks >= 3) {
        break;
      }
    }
    await settle();

    // Unlike Node, no AbortError: the stream is torn down without an error.
    expect(stream.destroyed).toBe(true);
    expect(seen).toEqual([]);
  });

  it("leaves the stream open under destroyOnReturn:false", async () => {
    const stream = infiniteByteStream();
    const seen: Error[] = [];
    stream.on("error", (error: Error) => seen.push(error));

    let chunks = 0;
    try {
      for await (const _chunk of stream.iterator({ destroyOnReturn: false })) {
        if (++chunks >= 3) {
          break;
        }
      }
      await settle();
      expect(stream.destroyed).toBe(false);
    } finally {
      stream.destroy();
    }
    await settle();

    expect(stream.destroyed).toBe(true);
    expect(seen).toEqual([]);
  });
});

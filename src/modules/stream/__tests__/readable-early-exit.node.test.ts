/**
 * Early-exit teardown of a `Readable`, checked against Node's own implementation.
 *
 * `Workbook.toStream` documents that breaking out of `for await` destroys the
 * stream with an `AbortError` on both builds. The browser kernel is plain
 * JavaScript, so it is exercised here next to `node:stream` with one scenario.
 */
import { Readable as NodeReadable } from "node:stream";

import { Readable as BrowserReadable } from "@stream/index.browser";
import { describe, expect, it } from "vitest";

const implementations = [
  ["node:stream", NodeReadable],
  ["browser kernel", BrowserReadable]
] as const;

function infiniteByteStream(Readable: (typeof implementations)[number][1]): any {
  let i = 0;
  return new Readable({
    read(this: any) {
      this.push(new Uint8Array([i++ & 0xff]));
    }
  });
}

const settle = () => new Promise(resolve => setTimeout(resolve, 50));

describe.each(implementations)("Readable early exit (%s)", (_name, Readable) => {
  it("destroys with an AbortError when a for-await loop breaks", async () => {
    const stream = infiniteByteStream(Readable);
    const seen: Error[] = [];
    stream.on("error", (error: Error) => seen.push(error));

    let chunks = 0;
    for await (const _chunk of stream) {
      if (++chunks >= 3) {
        break;
      }
    }
    await settle();

    expect(stream.destroyed).toBe(true);
    expect(seen.map(e => e.name)).toEqual(["AbortError"]);
    expect(stream.errored?.name).toBe("AbortError");
  });

  it("leaves the stream open under destroyOnReturn:false", async () => {
    const stream = infiniteByteStream(Readable);
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

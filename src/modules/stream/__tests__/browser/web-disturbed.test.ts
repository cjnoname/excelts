/**
 * `isDisturbed` on a Web stream relies on a browser behaviour the Fetch spec
 * mandates — `new Response(stream)` throws for a disturbed stream and leaves an
 * undisturbed one alone — so it is checked in a real browser, not only in Node.
 */
import { isDisturbed } from "@stream";
import { describe, expect, it } from "vitest";

describe("isDisturbed on a Web ReadableStream (browser)", () => {
  it("is false for a fresh stream and leaves it unlocked and unread", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue("x");
        controller.close();
      }
    });
    expect(isDisturbed(stream)).toBe(false);
    expect(stream.locked).toBe(false);
    const reader = stream.getReader();
    expect(await reader.read()).toEqual({ done: false, value: "x" });
  });

  it("is true once the stream has been read or cancelled", async () => {
    const read = new ReadableStream({
      start(controller) {
        controller.enqueue(1);
        controller.enqueue(2);
      }
    });
    const reader = read.getReader();
    await reader.read();
    reader.releaseLock();
    expect(isDisturbed(read)).toBe(true);

    const cancelled = new ReadableStream();
    await cancelled.cancel();
    expect(isDisturbed(cancelled)).toBe(true);
  });
});

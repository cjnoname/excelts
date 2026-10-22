import { loadIife } from "@test/browser/load-iife";
import { describe, it, expect, beforeAll } from "vitest";

/**
 * Smoke test for the shipped `documonster.stream.iife.min.js` bundle: asserts
 * the `Documonster.Stream` surface and a `fromString` → `streamToString`
 * round-trip in a browser. (Source-import browser tests already cover the
 * stream primitives; this verifies the delivered IIFE artifact runs.)
 */
describe("Documonster.Stream IIFE bundle", () => {
  let Stream: any;

  beforeAll(async () => {
    Stream = await loadIife("stream", "Stream");
  }, 60000);

  it("exposes core stream constructors and helpers", () => {
    for (const member of ["Readable", "Writable", "Transform", "fromString", "streamToString"]) {
      expect(Stream[member], `Documonster.Stream.${member}`).toBeTruthy();
    }
  });

  it("round-trips a string through a readable stream", async () => {
    const readable = Stream.fromString("hello stream");
    const out: string = await Stream.streamToString(readable);
    expect(out).toBe("hello stream");
  });

  // Readable.prototype.compose depends on Duplex and pipeline, which depend on
  // Readable. The bundle is tree-shaken with `moduleSideEffects: false`, which
  // used to drop the side-effect registration that wired them together.
  it("keeps Readable.prototype.compose working after tree-shaking", async () => {
    const composed = Stream.Readable.from([1, 2, 3]).compose(async function* (
      source: AsyncIterable<number>
    ) {
      for await (const n of source) {
        yield n * 2;
      }
    });
    expect(await composed.toArray()).toEqual([2, 4, 6]);
  });
});

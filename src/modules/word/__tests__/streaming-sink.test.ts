/**
 * StreamingDocxWriter — sink-mode (true end-to-end streaming) tests.
 *
 * Verifies:
 *  - bytes delivered through a Web `WritableStream` match the buffered
 *    output (round-trip correctness),
 *  - `addAsync` actually awaits sink backpressure,
 *  - sink errors surface from `addAsync` / `finalize`,
 *  - `reset()` is rejected in sink mode.
 */

import { extractAll } from "@archive/unzip/extract";
import { ZipDeflate } from "@archive/zip/stream";
import { PartPath } from "@word/constants";
import { describe, it, expect, vi } from "vitest";

import { DocxWriteError, Build, Streaming } from "../index";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

/**
 * Describe a package by its entries' actual decompressed content.
 *
 * The comparison has to be on content, not on size. The previous version of this
 * test asserted the two packages had the same total byte length, which fails ~60%
 * of the time when the two builds straddle a clock second: `docProps/core.xml`
 * embeds `new Date()` at second resolution (`word/writer/parts-writer.ts`), and
 * the *digits* of that timestamp change how well the part deflates — measured at
 * 257, 258 and 259 bytes across one minute of timestamps.
 *
 * Comparing per-entry lengths instead would fix the flake and give up the test:
 * two documents differing in every character but not in length would pass. So the
 * entries are decompressed and compared byte for byte, with the timestamps inside
 * `core.xml` — and only the timestamps — normalised away.
 */
async function describePackage(bytes: Uint8Array): Promise<string> {
  const entries = await extractAll(bytes);
  const decoder = new TextDecoder();
  return [...entries.keys()]
    .sort()
    .map(path => {
      const data = entries.get(path)!.data;
      if (path === PartPath.CoreProps) {
        // Two independent builds legitimately disagree here, and only here.
        const xml = decoder.decode(data).replace(/>[^<]*T[^<]*Z</g, ">(timestamp)<");
        return `${path}\n${xml}`;
      }
      return `${path}\n${[...data].join(",")}`;
    })
    .join("\n---\n");
}

describe("StreamingDocxWriter — sink mode", () => {
  it("delivers equivalent output through a Web WritableStream", async () => {
    // Build the same document twice: once buffered, once via sink.
    const buffered = Streaming.createDocxStream();
    for (let i = 0; i < 50; i++) {
      buffered.add(Build.textParagraph(`Paragraph ${i}`));
    }
    const reference = await buffered.finalize();

    const collected: Uint8Array[] = [];
    const ws = new WritableStream<Uint8Array>({
      write(chunk): void {
        collected.push(chunk);
      }
    });

    const piped = Streaming.createDocxStream({ sink: ws });
    for (let i = 0; i < 50; i++) {
      piped.add(Build.textParagraph(`Paragraph ${i}`));
    }
    const result = await piped.finalize();
    expect(result.length).toBe(0); // sentinel — bytes are in `collected`

    const total = collected.reduce((n, c) => n + c.length, 0);
    const sinkBytes = new Uint8Array(total);
    let off = 0;
    for (const c of collected) {
      sinkBytes.set(c, off);
      off += c.length;
    }
    expect(await describePackage(sinkBytes)).toBe(await describePackage(reference));
    // ZIP magic
    expect(sinkBytes[0]).toBe(0x50);
    expect(sinkBytes[1]).toBe(0x4b);
  });

  it("addAsync awaits browser compression output and the corresponding sink write", async () => {
    const writeStarted = deferred();
    const releaseWrite = deferred();
    let firstWrite = true;
    const ws = new WritableStream<Uint8Array>({
      write(): Promise<void> | undefined {
        if (!firstWrite) {
          return;
        }
        firstWrite = false;
        writeStarted.resolve();
        return releaseWrite.promise;
      }
    });

    const writer = Streaming.createDocxStream({ sink: ws });
    const adding = writer.addAsync(Build.textParagraph("async-output-boundary-".repeat(5000)));
    await writeStarted.promise;

    let settled = false;
    void adding.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseWrite.resolve();
    await adding;
    await writer.finalize();
  });

  it("addAsync includes each non-final ZipDeflate push completion in its boundary", async () => {
    const pushCompleted = deferred();
    const releasePush = deferred();
    const originalPush = ZipDeflate.prototype.push;
    const pushSpy = vi
      .spyOn(ZipDeflate.prototype, "push")
      .mockImplementation(function (this: InstanceType<typeof ZipDeflate>, data, final, callback) {
        const completion = originalPush.call(this, data, final, callback);
        return final
          ? completion
          : completion.then(() => {
              pushCompleted.resolve();
              return releasePush.promise;
            });
      });

    try {
      const writer = Streaming.createDocxStream({
        sink: new WritableStream<Uint8Array>({ write(): void {} })
      });
      const adding = writer.addAsync(Build.textParagraph("tracked compression"));
      let settled = false;
      void adding.then(() => {
        settled = true;
      });
      await pushCompleted.promise;
      await Promise.resolve();
      expect(settled).toBe(false);

      releasePush.resolve();
      await adding;
      await writer.finalize();
    } finally {
      releasePush.resolve();
      pushSpy.mockRestore();
    }
  });

  it("finalize includes auxiliary final-push completion promises", async () => {
    const auxiliaryPushStarted = deferred();
    const releasePush = deferred();
    const originalPush = ZipDeflate.prototype.push;
    const pushSpy = vi
      .spyOn(ZipDeflate.prototype, "push")
      .mockImplementation(function (this: InstanceType<typeof ZipDeflate>, data, final, callback) {
        const completion = originalPush.call(this, data, final, callback);
        if (final && this.name === "word/styles.xml") {
          auxiliaryPushStarted.resolve();
          return completion.then(() => releasePush.promise);
        }
        return completion;
      });

    try {
      const writer = Streaming.createDocxStream({
        sink: new WritableStream<Uint8Array>({ write(): void {} })
      });
      writer.add(Build.textParagraph("auxiliary boundary"));
      const finalizing = writer.finalize();
      await auxiliaryPushStarted.promise;

      let settled = false;
      void finalizing.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);

      releasePush.resolve();
      await finalizing;
    } finally {
      releasePush.resolve();
      pushSpy.mockRestore();
    }
  });

  it("surfaces sink errors from addAsync", async () => {
    const ws = new WritableStream<Uint8Array>({
      write(_chunk): void {
        throw new Error("sink exploded");
      }
    });

    const writer = Streaming.createDocxStream({ sink: ws });
    const caught = await writer
      .addAsync(Build.textParagraph("sink-error-output-".repeat(5000)))
      .catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(DocxWriteError);
    expect(String(caught)).toMatch(/sink/i);
  });

  it("surfaces compression failures without an unhandled stream error", async () => {
    const compressionError = new Error("deflate exploded");
    const originalPush = ZipDeflate.prototype.push;
    const pushSpy = vi
      .spyOn(ZipDeflate.prototype, "push")
      .mockImplementation(function (this: InstanceType<typeof ZipDeflate>, data, final, callback) {
        if (this.name === PartPath.Document) {
          return Promise.reject(compressionError);
        }
        return originalPush.call(this, data, final, callback);
      });

    try {
      const writer = Streaming.createDocxStream({
        sink: new WritableStream<Uint8Array>({ write(): void {} })
      });
      const caught = await writer
        .addAsync(Build.textParagraph("compression failure"))
        .catch((e: unknown) => e);

      // Reported through the public writer contract rather than as an
      // unhandled `error` event on the internal document stream.
      expect(caught).toBeInstanceOf(DocxWriteError);
      expect((caught as DocxWriteError).cause).toBe(compressionError);
    } finally {
      pushSpy.mockRestore();
    }
  });

  it("rejects reset() in sink mode", async () => {
    const ws = new WritableStream<Uint8Array>({ write(): void {} });
    const writer = Streaming.createDocxStream({ sink: ws });
    writer.add(Build.textParagraph("once"));
    expect(() => writer.reset()).toThrow(/sink mode/);
    await writer.finalize();
  });

  it("synchronous add() throws after a sink write has already failed", async () => {
    // A sink whose every write throws. We drive the writer with `addAsync`
    // (which awaits the sink-write drain chain and surfaces `_streamError`)
    // until the failure is observed, rather than racing a fixed timeout —
    // this is deterministic on both the Node (sync deflate) and browser
    // (async CompressionStream deflate) paths.
    const failingSinkOpts = {
      sink: new WritableStream<Uint8Array>({
        write(_chunk): void {
          throw new Error("immediate fail");
        }
      })
    };
    const writer = Streaming.createDocxStream(failingSinkOpts);

    // Feed elements via addAsync until a sink write has actually failed and
    // been captured. The first compressed chunk reaching the sink rejects;
    // addAsync surfaces it. Bounded so a logic regression can't hang.
    let sinkFailed = false;
    for (let i = 0; i < 2000 && !sinkFailed; i++) {
      try {
        await writer.addAsync(Build.textParagraph(`P${i}`));
      } catch {
        sinkFailed = true;
      }
    }
    expect(sinkFailed).toBe(true);

    // Once the sink has failed, the synchronous add() path must throw
    // rather than queue more doomed work.
    let threw = false;
    try {
      writer.add(Build.textParagraph("never reaches sink"));
    } catch (e) {
      threw = true;
      expect(String(e)).toMatch(/sink already failed/);
    }
    expect(threw).toBe(true);

    // Drain finalize to keep the test cleanup graceful.
    await writer.finalize().catch(() => undefined);
  });

  it("buffered mode (no sink) is unaffected — finalize returns full bytes", async () => {
    const writer = Streaming.createDocxStream();
    writer.add(Build.textParagraph("alpha"));
    const bytes = await writer.finalize();
    expect(bytes.length).toBeGreaterThan(0);
    expect(bytes[0]).toBe(0x50); // 'P'
    expect(bytes[1]).toBe(0x4b); // 'K'
  });

  it("true streaming: bytes reach the sink incrementally, body is not buffered to finalize", async () => {
    // A large body whose compressed output far exceeds any per-entry buffering.
    // If the writer were buffering the whole document until finalize(), the
    // sink would receive (almost) nothing during the addAsync loop and then a
    // burst at finalize. True streaming delivers compressed bytes continuously.
    let bytesBeforeFinalize = 0;
    let totalBytes = 0;
    let sawFinalize = false;
    const ws = new WritableStream<Uint8Array>({
      write(chunk): void {
        totalBytes += chunk.length;
        if (!sawFinalize) {
          bytesBeforeFinalize += chunk.length;
        }
      }
    });

    const writer = Streaming.createDocxStream({ sink: ws });

    // ~6000 paragraphs of incompressible-ish text — multi-MB uncompressed body.
    const big = "x9q7-streaming-body-".repeat(120); // ~2.4 KB per paragraph
    for (let i = 0; i < 6000; i++) {
      await writer.addAsync(Build.textParagraph(`${i}:${big}`));
    }

    // The decisive assertion: a substantial fraction of the compressed output
    // must have already been delivered to the sink BEFORE finalize() runs.
    // (If the body were retained and only flushed at finalize, this would be
    // ~0.) We require the pre-finalize bytes to be the clear majority.
    expect(bytesBeforeFinalize).toBeGreaterThan(0);

    sawFinalize = true;
    await writer.finalize();

    expect(totalBytes).toBeGreaterThan(0);
    // Pre-finalize delivery should dominate: the document body was streamed
    // out during addAsync; finalize only appends the small trailing parts
    // (styles/settings/relationships/central directory).
    expect(bytesBeforeFinalize).toBeGreaterThan(totalBytes * 0.5);
  }, 120_000);
});

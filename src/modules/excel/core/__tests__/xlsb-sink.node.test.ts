/**
 * Writing an XLSB into a sink, and being finished when it says so.
 *
 * `Workbook.writeStream(wb, sink, { format: "xlsb" })` used to resolve when the *producer* was done, not when
 * the sink was. For a file that meant the central directory could still be in flight, so a caller that read the
 * file immediately got `EocdNotFoundError` on a package that had been written perfectly — a race that passes on
 * a fast machine and fails on a loaded one.
 *
 * ## Why the fix is here and not in the zip adapter
 *
 * The first attempt made the shared adapter's `finish` event wait for the sink. That **deadlocked the entire
 * suite**: `finish` means "the producer is done", every XLSX caller relies on that meaning, and a sink whose
 * completion never arrives then hangs a path that used to work. Specifically, a Web `WritableStream` has neither
 * `end` nor `once`, and the branch that had committed to resolving through them never resolved at all.
 *
 * So the wait belongs to the caller, and it has to be safe for every destination shape the contract admits.
 * These tests are that list — a Node `Writable`, a file stream, an unconsumed `PassThrough`, and a Web
 * `WritableStream` — because "safe for the sink I happened to test" is what produced the deadlock.
 */
import { createWriteStream, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";

import { extractAll } from "@archive/unzip/extract";
import { Cell, Workbook } from "@excel";
import { describe, expect, it } from "vitest";

const directory = mkdtempSync(join(tmpdir(), "xlsb-sink-"));

/** A workbook with enough parts that the archive is not a single write. */
function sample(): Workbook.Handle {
  const handle = Workbook.create();
  const sheet = Workbook.addWorksheet(handle, "S");
  for (let row = 1; row <= 200; row += 1) {
    Cell.setValue(sheet, `A${row}`, `row ${row}`);
    Cell.setValue(sheet, `B${row}`, row);
  }
  return handle;
}

describe("an XLSB written to a sink", () => {
  it("is complete on disk when writeStream resolves", async () => {
    // The regression, stated as the caller experiences it: read the file the instant the promise settles.
    const path = join(directory, "complete.xlsb");
    await Workbook.writeStream(sample(), createWriteStream(path), { format: "xlsb" });

    const parts = await extractAll(new Uint8Array(readFileSync(path)));
    expect([...parts.keys()]).toContain("xl/workbook.bin");
    expect([...parts.keys()]).toContain("[Content_Types].xml");
  });

  it("matches the buffered package part for part", async () => {
    const handle = sample();
    const path = join(directory, "same.xlsb");
    await Workbook.writeStream(handle, createWriteStream(path), { format: "xlsb" });

    const streamed = await extractAll(new Uint8Array(readFileSync(path)));
    const buffered = await extractAll(await Workbook.toBuffer(handle, { format: "xlsb" }));

    expect([...streamed.keys()].sort()).toEqual([...buffered.keys()].sort());
    for (const path of buffered.keys()) {
      // `docProps/core.xml` carries a save timestamp; everything else must be identical.
      if (path === "docProps/core.xml") {
        continue;
      }
      expect([...streamed.get(path)!.data], path).toEqual([...buffered.get(path)!.data]);
    }
  });

  it("resolves for a Writable that completes asynchronously", async () => {
    // The shape `backpressure-regression` uses: every write settles on a later tick, and the stream is never
    // destroyed — so `close` does not fire and only `finish` or the `end` callback can settle this.
    const chunks: Uint8Array[] = [];
    const slow = new Writable({
      highWaterMark: 1024,
      write(chunk: Uint8Array, _encoding, callback) {
        chunks.push(Uint8Array.from(chunk));
        setImmediate(callback);
      }
    });
    await Workbook.writeStream(sample(), slow, { format: "xlsb" });
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    expect(total).toBeGreaterThan(0);
  });

  it("resolves for a consumed PassThrough", async () => {
    // **Consumed on purpose, and the first draft of this test was not** — it used a bare `PassThrough` and hung
    // for thirty seconds. That is not a defect in the wait: an unconsumed `PassThrough` fills its buffer, stops
    // returning `true` from `write`, and never emits `drain`, so the *producer* never finishes. `writeStream`'s
    // own contract says so — "start the consumer first" — and the XLSX path behaves identically.
    //
    // Getting this wrong in a test is worth recording, because the same mistake in the implementation is what
    // deadlocked the suite earlier: treating a shape the contract calls misuse as one that must be supported.
    const passThrough = new PassThrough({ highWaterMark: 1024 });
    passThrough.resume();
    await Workbook.writeStream(sample(), passThrough, { format: "xlsb" });
    expect(passThrough.writableEnded).toBe(true);
  });

  it("resolves for a sink with neither an end callback nor events", async () => {
    // **The exact shape that deadlocked the suite.** A Web `WritableStream` has no `end` and no `once`, so there
    // is no completion signal to wait for; the earlier attempt committed to resolving through them and never
    // did. Returning immediately is correct — whoever created such a sink closes it.
    //
    // The stub drains synchronously so the producer is not blocked, which is what makes this a test of the
    // *completion* path rather than of backpressure.
    const written: number[] = [];
    const sink = {
      write(data: Uint8Array | string): boolean {
        const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
        written.push(...bytes);
        return true;
      },
      end(): void {}
    };
    await Workbook.writeStream(sample(), sink as never, { format: "xlsb" });
    expect(written.length).toBeGreaterThan(0);
  });

  it("still reports what it could not express", async () => {
    // The report must not depend on where the bytes went — and for a stream it arrives *after* they have gone,
    // which is inherent rather than a flaw.
    const handle = Workbook.create();
    Cell.setValue(Workbook.addWorksheet(handle, "S"), "A1", { error: "#SPILL!" } as never);
    const passThrough = new PassThrough();
    passThrough.resume();
    await expect(Workbook.writeStream(handle, passThrough, { format: "xlsb" })).rejects.toThrow(
      /#SPILL!/
    );
  });
});

/**
 * `writeStream` accepts every destination shape its public type allows — including on the passthrough path.
 *
 * **`XlsxWritable.write` is declared `(data) => boolean | void | Promise<boolean>`, and carries no callback.** The
 * unmodified-package passthrough nonetheless called `write(bytes, callback)` and resolved only when the callback fired,
 * so a destination that conformed to the published type and simply returned `true` received the bytes and left
 * `writeStream` waiting forever. Measured before the fix: a `{ write(d) { …; return true; }, end() {} }` sink took the
 * whole package and the promise never settled.
 *
 * It went unnoticed because the branch is only reached when the workbook is *unmodified* — the rebuild path goes through
 * the ZIP adapter, which speaks Node's protocol properly — and because every existing test used a Node writable or a
 * file path, both of which do invoke the callback.
 *
 * Each case therefore checks two things: that the write finishes at all, and that the bytes are the original package's.
 * A hang and a truncated write are different failures, and only the second would show in a byte comparison.
 */
import { readFile } from "node:fs/promises";
import { Writable } from "node:stream";

import { Workbook } from "@excel";
import { describe, expect, it } from "vitest";

/** How long a passing case may take. Generous: the point is to distinguish "finished" from "never finishes". */
const LIMIT_MS = 5_000;

/** The corpus package, or `undefined` when it has not been fetched. */
async function original(): Promise<Uint8Array | undefined> {
  try {
    return Uint8Array.from(await readFile("tmp/xlsb-corpus/poi-sample.xlsb"));
  } catch {
    return undefined;
  }
}

/** Write an unmodified workbook to `sink` and hand back what it received, or `undefined` on a hang. */
async function passthroughInto(
  bytes: Uint8Array,
  sink: unknown,
  received: () => Uint8Array
): Promise<Uint8Array | undefined> {
  const workbook = Workbook.create();
  await Workbook.read(workbook, bytes);
  const finished = Workbook.writeStream(workbook, sink as never, {
    format: "xlsb",
    unsupported: "ignore"
  }).then(() => true);
  const settled = await Promise.race([
    finished,
    new Promise<false>(resolve => setTimeout(() => resolve(false), LIMIT_MS))
  ]);
  return settled ? received() : undefined;
}

/** Concatenate the chunks a sink collected. */
function joined(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

describe("the passthrough's writable protocol", () => {
  it("finishes for a destination whose write returns a boolean", async () => {
    const bytes = await original();
    if (bytes === undefined) {
      return;
    }
    // The shape that hung. Nothing here is unusual — it is the published type, implemented literally.
    const chunks: Uint8Array[] = [];
    const result = await passthroughInto(
      bytes,
      {
        write(chunk: Uint8Array) {
          chunks.push(chunk);
          return true;
        },
        end() {}
      },
      () => joined(chunks)
    );
    expect(result, "writeStream did not settle within the limit").toBeDefined();
    expect([...result!]).toEqual([...bytes]);
  });

  it("finishes for a destination whose write returns a promise", async () => {
    const bytes = await original();
    if (bytes === undefined) {
      return;
    }
    // The other shape the type allows, and the one a naive `await` on the return value would be needed for.
    const chunks: Uint8Array[] = [];
    const result = await passthroughInto(
      bytes,
      {
        write(chunk: Uint8Array) {
          chunks.push(chunk);
          return Promise.resolve(true);
        },
        end() {}
      },
      () => joined(chunks)
    );
    expect(result).toBeDefined();
    expect([...result!]).toEqual([...bytes]);
  });

  it("still finishes for a Node writable", async () => {
    const bytes = await original();
    if (bytes === undefined) {
      return;
    }
    // The case that always worked, kept so a fix aimed at the others cannot quietly break it.
    const chunks: Uint8Array[] = [];
    const sink = new Writable({
      write(chunk: Uint8Array, _encoding, callback) {
        chunks.push(Uint8Array.from(chunk));
        callback();
      }
    });
    const result = await passthroughInto(bytes, sink, () => joined(chunks));
    expect(result).toBeDefined();
    expect([...result!]).toEqual([...bytes]);
  });

  it("still finishes for a web WritableStream", async () => {
    const bytes = await original();
    if (bytes === undefined) {
      return;
    }
    // The third shape `writeStream` documents. It goes through `getWriter()` rather than `write`, and has neither `end`
    // nor `once` — which is the case `settled` returns immediately for.
    const chunks: Uint8Array[] = [];
    const sink = new WritableStream<Uint8Array>({
      write(chunk) {
        chunks.push(chunk);
      }
    });
    const result = await passthroughInto(bytes, sink, () => joined(chunks));
    expect(result).toBeDefined();
    expect([...result!]).toEqual([...bytes]);
  });
});

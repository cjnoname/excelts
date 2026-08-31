/**
 * Streaming an already-assembled package.
 *
 * XLSB cannot be produced incrementally the way XLSX can. A ZIP central directory is written
 * last and the XLSB parts are built from a shared-string table that is only complete once
 * every worksheet has been visited, so there is no point in the process where a prefix of the
 * output is known. The package is assembled and then handed over.
 *
 * That is a real difference from the XLSX path, where `toStream` genuinely serialises on
 * demand and pauses under backpressure. Both keep the same contract from the caller's side —
 * a readable that yields bytes, a sink that receives them — and this file is where the
 * difference is confined so no caller has to know about it.
 */

import type { XlsxReadable, XlsxWritable } from "@excel/core/xlsx-io-types";
import { createReadable } from "@stream";

/** Write bytes to a duck-typed sink, respecting backpressure and settling on completion. */
export async function writeBytesToSink(sink: XlsxWritable, bytes: Uint8Array): Promise<void> {
  const writable = sink as {
    write(chunk: Uint8Array, callback?: (error?: Error | null) => void): boolean;
    end?(callback?: () => void): void;
    once?(event: string, listener: (error?: Error) => void): void;
  };

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const fail = (error?: Error): void => {
      if (!settled) {
        settled = true;
        reject(error ?? new Error("the sink errored while receiving the package"));
      }
    };
    writable.once?.("error", fail);

    writable.write(bytes, error => {
      if (error) {
        fail(error);
        return;
      }
      if (!writable.end) {
        if (!settled) {
          settled = true;
          resolve();
        }
        return;
      }
      writable.end(() => {
        if (!settled) {
          settled = true;
          resolve();
        }
      });
    });
  });
}

/**
 * A readable byte stream over a package assembled on first read.
 *
 * The assembly is deferred rather than eager so that constructing the stream costs nothing —
 * matching `toStream`'s contract that the consumer drives production, even though here
 * production is one step rather than many. An assembly failure reaches the consumer as an
 * `'error'` event, which is the same way an XLSX serialisation failure arrives.
 */
export function createXlsbReadable(
  produce: () => Promise<Uint8Array>,
  options?: { readonly highWaterMark?: number }
): XlsxReadable {
  let started = false;
  const source = createReadable<Uint8Array>({
    ...(options?.highWaterMark === undefined ? {} : { highWaterMark: options.highWaterMark }),
    read() {
      if (started) {
        return;
      }
      started = true;
      const pushable = source as unknown as {
        push(chunk: Uint8Array | null): boolean;
        destroy(error?: Error): void;
      };
      produce().then(
        bytes => {
          pushable.push(bytes);
          pushable.push(null);
        },
        (error: unknown) => {
          pushable.destroy(error instanceof Error ? error : new Error(String(error)));
        }
      );
    }
  });
  return source as XlsxReadable;
}

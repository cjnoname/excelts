/**
 * Example: PullStream + BufferedStream (cross-platform pull/buffer primitives)
 *
 * Demonstrates:
 * - createPullStream() / PullStream: pull-based reading with size and
 *   pattern matching (e.g. read up to the next newline)
 * - createBufferedStream() / BufferedStream: accumulate writes and drain the
 *   whole buffer as a single Uint8Array
 *
 * These are the stream module's signature primitives: instead of the
 * push/event flow of a normal Readable, the consumer *pulls* exactly the
 * bytes it wants, which is ideal for parsers (line readers, framed protocols).
 *
 * Usage: pnpm example --filter 04-pull-buffered-streams
 */

import { createBufferedStream, createPullStream } from "@stream";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * PullStream: pull bytes on demand, either by exact size or until a pattern.
 */
export async function examplePullStream(): Promise<void> {
  // highWaterMark opts into bounded-memory backpressure (default Infinity).
  const stream = createPullStream({ highWaterMark: 64 });

  stream.write(encoder.encode("Line1\nLine2\nLine3\n"));
  stream.end();

  // Pull until the newline pattern (exclude the delimiter from the result).
  const line1 = await stream.pull(encoder.encode("\n"), false);
  console.log("PullStream line 1:", decoder.decode(line1));

  // pullUntil is an alias for pull(pattern, includePattern).
  const line2 = await stream.pullUntil(encoder.encode("\n"), false);
  console.log("PullStream line 2:", decoder.decode(line2));
  console.log("PullStream last match position:", stream.matchPosition);

  // Pull an exact number of bytes ("Line3").
  const exact = await stream.pull(5);
  console.log("PullStream exact 5 bytes:", decoder.decode(exact));
  console.log("PullStream remaining length:", stream.length, "finished:", stream.isFinished);
}

/**
 * BufferedStream: accumulate string/byte writes, then drain as one Uint8Array.
 */
export function exampleBufferedStream(): void {
  const buffered = createBufferedStream({ batchSize: 1024 });

  // Accepts both strings and Uint8Array chunks.
  buffered.write("Hello ");
  buffered.write("World!");
  buffered.write(encoder.encode(" Streaming."));

  console.log("BufferedStream bufferedLength:", buffered.bufferedLength);

  // read(size) pulls a bounded slice out of the internal buffers.
  const head = buffered.read(5);
  console.log("BufferedStream read(5):", head ? decoder.decode(head) : null);

  // toUint8Array() drains everything that remains in a single allocation.
  const rest = buffered.toUint8Array();
  console.log("BufferedStream drained rest:", decoder.decode(rest));
  console.log("BufferedStream bufferedLength after drain:", buffered.bufferedLength);
}

export async function examplePullBufferedStreams(): Promise<void> {
  console.log("=== PullStream ===");
  await examplePullStream();
  console.log("\n=== BufferedStream ===");
  exampleBufferedStream();
}

await examplePullBufferedStreams();

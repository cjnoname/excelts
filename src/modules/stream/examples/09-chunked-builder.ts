/**
 * Example: ChunkedBuilder + TransactionalChunkedBuilder
 *
 * Demonstrates the string-accumulation builders:
 * - ChunkedBuilder: push()/pushAll() pieces, query cursor/length/stringLength/
 *   isEmpty, then materialize via toString() / toUint8Array(); clear() resets.
 * - TransactionalChunkedBuilder: adds snapshot()/commit()/rollback() so a run
 *   of appends can be tentatively staged and either kept or discarded.
 *
 * ChunkedBuilder consolidates accumulated pieces into chunks once `chunkSize`
 * pieces are buffered, keeping large concatenations cheap.
 *
 * Usage: pnpm example --filter 09-chunked-builder
 */

import { ChunkedBuilder, TransactionalChunkedBuilder } from "@stream";

const decoder = new TextDecoder();

/** ChunkedBuilder: accumulate pieces and materialize the final string. */
export function exampleChunkedBuilder(): void {
  // chunkSize controls how many pieces accumulate before consolidation.
  const builder = new ChunkedBuilder({ chunkSize: 3 });

  console.log("ChunkedBuilder isEmpty (initial):", builder.isEmpty);

  builder.push("Hello");
  builder.push(", ");
  builder.pushAll(["chunked", " ", "world", "!"]);

  console.log("ChunkedBuilder length (pieces+chunks):", builder.length);
  console.log("ChunkedBuilder stringLength (chars):", builder.stringLength);
  console.log("ChunkedBuilder cursor:", builder.cursor);
  console.log("ChunkedBuilder toString():", builder.toString());
  console.log("ChunkedBuilder toUint8Array() decoded:", decoder.decode(builder.toUint8Array()));

  builder.clear();
  console.log("ChunkedBuilder isEmpty (after clear):", builder.isEmpty);
}

/** TransactionalChunkedBuilder: commit a staged run of appends. */
export function exampleTransactionalCommit(): void {
  const builder = new TransactionalChunkedBuilder();
  builder.push("base");

  builder.snapshot();
  console.log("Transactional hasSnapshots (after snapshot):", builder.hasSnapshots);
  builder.push("-staged");

  // commit() drops the rollback point, keeping the staged appends.
  builder.commit();
  console.log("Transactional hasSnapshots (after commit):", builder.hasSnapshots);
  console.log("Transactional committed result:", builder.toString());
}

/** TransactionalChunkedBuilder: discard a staged run of appends. */
export function exampleTransactionalRollback(): void {
  const builder = new TransactionalChunkedBuilder();
  builder.push("keep-this");

  builder.snapshot();
  builder.push("-throwaway-1");
  builder.push("-throwaway-2");
  console.log("Transactional before rollback:", builder.toString());

  // rollback() restores the builder to the snapshot position.
  builder.rollback();
  console.log("Transactional after rollback:", builder.toString());
  console.log("Transactional hasSnapshots (after rollback):", builder.hasSnapshots);
}

export function exampleChunkedBuilders(): void {
  console.log("=== ChunkedBuilder ===");
  exampleChunkedBuilder();
  console.log("\n=== TransactionalChunkedBuilder (commit) ===");
  exampleTransactionalCommit();
  console.log("\n=== TransactionalChunkedBuilder (rollback) ===");
  exampleTransactionalRollback();
}

exampleChunkedBuilders();

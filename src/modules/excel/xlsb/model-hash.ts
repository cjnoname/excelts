/**
 * A content hash of a workbook model, for deciding whether it has changed since it was read.
 *
 * **Why a hash and not a snapshot.** The obvious way to answer "has this model changed" is to keep a deep copy and
 * compare, and that costs a second model — for a workbook whose whole problem is that it is large, doubling it is
 * the wrong trade. This keeps 32 bytes.
 *
 * **Why a generic walk and not a field list.** The dangerous failure here is a *false* "unchanged": returning the
 * bytes a file arrived as when the caller has edited it. A hash that enumerated the fields it knew about would go
 * stale the moment a field was added to the model, and the symptom would be an edit silently discarded. Walking the
 * object graph without naming anything is total by construction: a new field is hashed because it is there, not
 * because someone remembered it.
 *
 * **Why this is safe to act on at all.** `writeXlsbPackage(model, options)` is a function of the model and its
 * options — nothing else reaches it. So "the model is unchanged" already implies "the writer would produce what it
 * produced before"; returning the original bytes instead is not a shortcut past the writer's output, it is a
 * *better* answer than the writer can give, because the original carries the parts this library models imperfectly
 * exactly as they were.
 */
import { sha256 } from "@utils/crypto";

/**
 * Fields a *writer* stamps onto the caller's model, which say nothing about its content.
 *
 * **The only named fields in an otherwise total walk, and the exception is earned.** Serialising to XLSX writes back
 * onto the cells it visited: `ssId` is the index the cell's text took in that write's shared-string table, and
 * `styleId` the index its format took in that write's style table. Both are artefacts of a different container's
 * serialisation, and neither is read by `writeXlsbPackage` — it interns from the resolved `style`, `font`, `fill` and
 * the rest.
 *
 * Without this exception the passthrough guarantee quietly stopped applying to any workbook that had been written as
 * XLSX first. Measured on three of four corpus fixtures: `Workbook.toBuffer(wb, { format: "xlsx" })` changed the hash,
 * so the following XLSB write rebuilt the package instead of returning the bytes it was read from —
 * `cal-any_sheets.xlsb` came back as 10,460 bytes rather than its original 14,837, losing exactly the parts the
 * passthrough exists to protect. Converting a workbook to both formats is an ordinary thing to do; the MCP tool does it.
 *
 * The direction of risk is the safe one. A hash that ignores too much returns a *false unchanged* and silently
 * discards an edit — which is why this list is two fields rather than a policy — while ignoring nothing merely costs
 * the optimisation. So the assumption is checked rather than asserted:
 * `model-hash.node.test.ts` writes the same model with and without these fields and requires the XLSB bytes to be
 * identical, which fails if the writer ever starts reading one of them.
 *
 * The deeper cause is left alone deliberately: the XLSX writer should not be mutating its caller's model at all. That
 * is how it passes indices between its own passes, it predates this module, and changing it is a different piece of
 * work from making the hash mean what it says.
 */
const SERIALISATION_ARTIFACTS = new Set(["ssId", "styleId"]);

/** Tags that keep one shape from hashing as another — `{}` and `[]` are not the same model. */
const TAG_OBJECT = 0x01;
const TAG_ARRAY = 0x02;
const TAG_STRING = 0x03;
const TAG_NUMBER = 0x04;
const TAG_TRUE = 0x05;
const TAG_FALSE = 0x06;
const TAG_NULL = 0x07;
const TAG_UNDEFINED = 0x08;
const TAG_DATE = 0x09;
const TAG_BYTES = 0x0a;
const TAG_OTHER = 0x0b;
const TAG_CYCLE = 0x0c;

/**
 * A 32-byte digest of `value`, stable across runs and independent of key insertion order.
 *
 * Keys are sorted because two models that differ only in the order their properties were assigned are the same
 * model — and the order genuinely varies: a cell edited through one API gains its fields in a different sequence
 * than one built by a reader.
 *
 * `undefined` is hashed rather than skipped. A field present and undefined is not the same as an absent field to
 * every consumer, and treating them alike would let a deletion pass as no change.
 */
export function modelHash(value: unknown): Uint8Array {
  const writer = new FoldingHash();
  const encoder = new TextEncoder();
  // Objects already visited on the current path. A model has no cycles today — `getWorkbookModel` returns plain
  // data — but a back-pointer added later would turn this into a stack overflow rather than a wrong answer, so the
  // guard is here to keep the failure a hash mismatch instead of a crash.
  const seen = new Set<object>();

  const walk = (input: unknown): void => {
    if (input === null) {
      writer.byte(TAG_NULL);
      return;
    }
    if (input === undefined) {
      writer.byte(TAG_UNDEFINED);
      return;
    }
    switch (typeof input) {
      case "string":
        writer.byte(TAG_STRING);
        writer.text(encoder, input);
        return;
      case "number":
        writer.byte(TAG_NUMBER);
        // The bit pattern, so `-0` and `0` are told apart and `NaN` hashes consistently.
        writer.float64(input);
        return;
      case "boolean":
        writer.byte(input ? TAG_TRUE : TAG_FALSE);
        return;
      case "bigint":
        writer.byte(TAG_OTHER);
        writer.text(encoder, input.toString());
        return;
      case "object":
        break;
      default:
        // A function or a symbol cannot affect the writer's output, which reads data. Tagged rather than ignored so
        // that replacing a value with a function still registers as a change.
        writer.byte(TAG_OTHER);
        return;
    }
    const object = input as object;
    if (seen.has(object)) {
      writer.byte(TAG_CYCLE);
      return;
    }
    seen.add(object);
    if (object instanceof Date) {
      writer.byte(TAG_DATE);
      writer.float64(object.getTime());
    } else if (object instanceof Uint8Array) {
      // Fed through as bytes rather than walked element by element: preserved parts and media are megabytes, and one
      // tagged length plus the content says the same thing far more cheaply.
      writer.byte(TAG_BYTES);
      writer.uint32(object.length);
      writer.bytes(object);
    } else if (Array.isArray(object)) {
      writer.byte(TAG_ARRAY);
      writer.uint32(object.length);
      for (const item of object) {
        walk(item);
      }
    } else if (object instanceof Map) {
      writer.byte(TAG_OBJECT);
      for (const key of [...object.keys()].map(String).sort()) {
        writer.text(encoder, key);
        walk(object.get(key));
      }
    } else if (object instanceof Set) {
      writer.byte(TAG_ARRAY);
      for (const item of [...object].map(String).sort()) {
        writer.text(encoder, item);
      }
    } else {
      writer.byte(TAG_OBJECT);
      for (const key of Object.keys(object).sort()) {
        if (SERIALISATION_ARTIFACTS.has(key)) {
          continue;
        }
        writer.text(encoder, key);
        walk((object as Record<string, unknown>)[key]);
      }
    }
    seen.delete(object);
  };

  walk(value);
  return writer.digest();
}

/**
 * A content hash built in bounded memory.
 *
 * **The first version of this collected every token into an array of small `Uint8Array`s and concatenated them.**
 * That was 1,066 ms for a 10,000-row workbook against 27 ms for `JSON.stringify` of the same model — and measuring
 * `sha256` alone showed 10 MB hashing in 5 ms. So the cost was never the hash: it was tens of thousands of tiny
 * allocations and a 10 MB copy, and it also made the peak memory proportional to the model, which is exactly what
 * keeping a hash instead of a snapshot was supposed to avoid.
 *
 * This writes into one 64 KiB buffer and folds it into a running digest whenever it fills. Peak memory is the buffer,
 * whatever the workbook's size, and the digest still depends on every byte in order.
 *
 * The fold is `sha256(previous ‖ block)`, which is a hash chain rather than a single pass over the whole stream. That
 * is not SHA-256 of the content and does not need to be: what is required is that a different model produces a
 * different digest, and chaining preserves that while bounding the buffer.
 */
class FoldingHash {
  private static readonly BLOCK = 64 * 1024;
  private readonly buffer = new Uint8Array(FoldingHash.BLOCK);
  private readonly view = new DataView(this.buffer.buffer);
  private offset = 0;
  /** The chain so far. Starts empty, so a model that fits in one block hashes as `sha256(block)`. */
  private chain: Uint8Array | undefined;

  byte(value: number): void {
    this.reserve(1);
    this.buffer[this.offset++] = value;
  }

  uint32(value: number): void {
    this.reserve(4);
    this.view.setUint32(this.offset, value, true);
    this.offset += 4;
  }

  float64(value: number): void {
    this.reserve(8);
    this.view.setFloat64(this.offset, value, true);
    this.offset += 8;
  }

  /**
   * A length-prefixed string, so `["a","b"]` cannot hash as `["ab"]`.
   *
   * **The ASCII path is not a micro-optimisation, it is most of the cost.** A model of ten thousand rows holds tens
   * of thousands of short strings and just as many property keys, and `TextEncoder.encode` allocates a `Uint8Array`
   * for each — which measured as the difference between 383 ms and 96 ms. Almost every one of those strings is
   * ASCII: a column key, an address, a cell value. Non-ASCII falls back to the encoder, because guessing at UTF-8
   * by hand is how a hash starts disagreeing with itself across engines.
   */
  text(encoder: TextEncoder, value: string): void {
    let ascii = true;
    for (let index = 0; index < value.length; index++) {
      if (value.charCodeAt(index) > 0x7f) {
        ascii = false;
        break;
      }
    }
    if (!ascii) {
      const bytes = encoder.encode(value);
      this.uint32(bytes.length);
      this.bytes(bytes);
      return;
    }
    this.uint32(value.length);
    for (let index = 0; index < value.length; index++) {
      this.reserve(1);
      this.buffer[this.offset++] = value.charCodeAt(index);
    }
  }

  bytes(value: Uint8Array): void {
    let written = 0;
    while (written < value.length) {
      this.reserve(1);
      const room = FoldingHash.BLOCK - this.offset;
      const take = Math.min(room, value.length - written);
      this.buffer.set(value.subarray(written, written + take), this.offset);
      this.offset += take;
      written += take;
    }
  }

  digest(): Uint8Array {
    this.fold();
    return this.chain ?? sha256(new Uint8Array(0));
  }

  /** Make room for `need` bytes, folding the buffer away first if it cannot hold them. */
  private reserve(need: number): void {
    if (this.offset + need > FoldingHash.BLOCK) {
      this.fold();
    }
  }

  private fold(): void {
    if (this.offset === 0 && this.chain !== undefined) {
      return;
    }
    const block = this.buffer.subarray(0, this.offset);
    if (this.chain === undefined) {
      this.chain = sha256(block);
    } else {
      const combined = new Uint8Array(this.chain.length + block.length);
      combined.set(this.chain, 0);
      combined.set(block, this.chain.length);
      this.chain = sha256(combined);
    }
    this.offset = 0;
  }
}

/** Whether two digests are the same. Length-checked so a truncated digest cannot compare equal by prefix. */
export function sameHash(left: Uint8Array | undefined, right: Uint8Array | undefined): boolean {
  if (left === undefined || right === undefined || left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

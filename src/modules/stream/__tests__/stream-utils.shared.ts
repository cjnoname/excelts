/**
 * Shared tests for stream/utils.ts
 *
 * Tests for cross-platform stream utility functions.
 * Platform-agnostic — imported by both Node.js and browser test runners.
 */

import {
  createReadableFromArray,
  collect,
  text,
  json,
  bytes,
  fromString,
  fromJSON,
  fromBytes,
  transform,
  filter,
  isReadableStreamLike,
  readableStreamToAsyncIterable
} from "@stream";
import { stringToUint8Array } from "@utils/binary";
import { describe, it, expect } from "vitest";

// =============================================================================
// Helpers
// =============================================================================

/**
 * Collect an IReadable (Node stream with asyncIterator) to array.
 */
/**
 * The chunks a stream emits. A stream is read through its 'data' events, not
 * `for await`: Node's async iterator is an async generator whose `yield`
 * awaits a thenable chunk, so a promise pushed by mistake would read back as
 * its value and the test would pass.
 */
async function toArray<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const emitter = stream as unknown as {
    on?: (event: string, listener: (value?: any) => void) => unknown;
  };
  if (typeof emitter.on !== "function") {
    const result: T[] = [];
    for await (const chunk of stream) {
      result.push(chunk);
    }
    return result;
  }
  return new Promise((resolve, reject) => {
    const result: T[] = [];
    emitter.on!("data", chunk => result.push(chunk as T));
    emitter.on!("end", () => resolve(result));
    emitter.on!("error", reject);
  });
}

export function runStreamUtilsTests(): void {
  // ===========================================================================
  // collect
  // ===========================================================================
  describe("collect", () => {
    it("should collect all chunks from a stream", async () => {
      const stream = createReadableFromArray([1, 2, 3], { objectMode: true });
      const result = await collect(stream);
      expect(result).toEqual([1, 2, 3]);
    });

    it("should return empty array for empty stream", async () => {
      const stream = createReadableFromArray([], { objectMode: true });
      const result = await collect(stream);
      expect(result).toEqual([]);
    });

    it("should collect string chunks", async () => {
      const stream = createReadableFromArray(["a", "b", "c"], { objectMode: true });
      const result = await collect(stream);
      expect(result).toEqual(["a", "b", "c"]);
    });
  });

  // ===========================================================================
  // text
  // ===========================================================================
  describe("text", () => {
    it("should convert binary stream to text", async () => {
      const chunks = [stringToUint8Array("hello"), stringToUint8Array(" world")];
      const stream = createReadableFromArray(chunks, { objectMode: false });
      const result = await text(stream);
      expect(result).toBe("hello world");
    });

    it("should handle single chunk", async () => {
      const stream = createReadableFromArray([stringToUint8Array("test")], { objectMode: false });
      const result = await text(stream);
      expect(result).toBe("test");
    });

    it("should handle empty stream", async () => {
      const stream = createReadableFromArray([] as Uint8Array[], { objectMode: false });
      const result = await text(stream);
      expect(result).toBe("");
    });
  });

  // ===========================================================================
  // json
  // ===========================================================================
  describe("json", () => {
    it("should parse JSON from binary stream", async () => {
      const data = { key: "value", num: 42 };
      const stream = createReadableFromArray([stringToUint8Array(JSON.stringify(data))], {
        objectMode: false
      });
      const result = await json(stream);
      expect(result).toEqual(data);
    });

    it("should parse JSON array", async () => {
      const data = [1, 2, 3];
      const stream = createReadableFromArray([stringToUint8Array(JSON.stringify(data))], {
        objectMode: false
      });
      const result = await json(stream);
      expect(result).toEqual(data);
    });
  });

  // ===========================================================================
  // bytes
  // ===========================================================================
  describe("bytes", () => {
    it("should collect binary stream into single Uint8Array", async () => {
      const chunk1 = new Uint8Array([1, 2, 3]);
      const chunk2 = new Uint8Array([4, 5, 6]);
      const stream = createReadableFromArray([chunk1, chunk2], { objectMode: false });
      const result = await bytes(stream);
      expect(result).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6]));
    });

    it("should handle single chunk", async () => {
      const chunk = new Uint8Array([10, 20, 30]);
      const stream = createReadableFromArray([chunk], { objectMode: false });
      const result = await bytes(stream);
      expect(result).toEqual(new Uint8Array([10, 20, 30]));
    });
  });

  // ===========================================================================
  // fromString
  // ===========================================================================
  describe("fromString", () => {
    it("should create a readable stream from a string", async () => {
      const stream = fromString("hello world");
      const chunks = await toArray(stream);
      expect(chunks.length).toBe(1);
      expect(chunks[0]).toBeInstanceOf(Uint8Array);
      const decoded = new TextDecoder().decode(chunks[0] as Uint8Array);
      expect(decoded).toBe("hello world");
    });

    it("should handle empty string", async () => {
      // TextEncoder.encode("") returns a 0-length Uint8Array, which Node's
      // Readable treats as a no-op push (like pushing null), so the stream
      // ends with 0 chunks.
      const stream = fromString("");
      const chunks = await toArray(stream);
      expect(chunks.length).toBe(0);
    });

    it("should handle unicode string", async () => {
      const stream = fromString("\u4f60\u597d\u4e16\u754c");
      const chunks = await toArray(stream);
      const decoded = new TextDecoder().decode(chunks[0] as Uint8Array);
      expect(decoded).toBe("\u4f60\u597d\u4e16\u754c");
    });
  });

  // ===========================================================================
  // fromJSON
  // ===========================================================================
  describe("fromJSON", () => {
    it("should create a readable stream from JSON data", async () => {
      const data = { hello: "world" };
      const stream = fromJSON(data);
      const chunks = await toArray(stream);
      const decoded = new TextDecoder().decode(chunks[0] as Uint8Array);
      expect(JSON.parse(decoded)).toEqual(data);
    });

    it("should handle arrays", async () => {
      const data = [1, 2, 3];
      const stream = fromJSON(data);
      const chunks = await toArray(stream);
      const decoded = new TextDecoder().decode(chunks[0] as Uint8Array);
      expect(JSON.parse(decoded)).toEqual(data);
    });

    it("should handle primitives", async () => {
      const stream = fromJSON(42);
      const chunks = await toArray(stream);
      const decoded = new TextDecoder().decode(chunks[0] as Uint8Array);
      expect(JSON.parse(decoded)).toBe(42);
    });
  });

  // ===========================================================================
  // fromBytes
  // ===========================================================================
  describe("fromBytes", () => {
    it("should create a readable stream from Uint8Array", async () => {
      const data = new Uint8Array([1, 2, 3, 4, 5]);
      const stream = fromBytes(data);
      const chunks = await toArray(stream);
      expect(chunks.length).toBe(1);
      // In Node.js, chunk may be a Buffer (subclass of Uint8Array)
      expect(chunks[0]).toBeInstanceOf(Uint8Array);
      expect([...new Uint8Array(chunks[0] as Uint8Array)]).toEqual([1, 2, 3, 4, 5]);
    });

    it("should handle empty Uint8Array", async () => {
      // A 0-length Uint8Array push is treated as no-op (EOF) by Node Readable
      const data = new Uint8Array(0);
      const stream = fromBytes(data);
      const chunks = await toArray(stream);
      expect(chunks.length).toBe(0);
    });
  });

  // ===========================================================================
  // transform
  // ===========================================================================
  describe("transform", () => {
    it("should create a transform stream with sync function", async () => {
      const source = createReadableFromArray(
        [stringToUint8Array("hello"), stringToUint8Array(" world")],
        { objectMode: false }
      );
      const upper = transform<Uint8Array, Uint8Array>(chunk => {
        const str = new TextDecoder().decode(chunk).toUpperCase();
        return stringToUint8Array(str);
      });

      source.pipe(upper);
      const chunks = await toArray(upper);
      const result = chunks.map(c => new TextDecoder().decode(c as Uint8Array)).join("");
      expect(result).toBe("HELLO WORLD");
    });

    it("should create a transform stream with async function", async () => {
      const source = createReadableFromArray(
        [stringToUint8Array("abc"), stringToUint8Array("def")],
        { objectMode: false }
      );
      const upper = transform<Uint8Array, Uint8Array>(async chunk => {
        const str = new TextDecoder().decode(chunk).toUpperCase();
        return stringToUint8Array(str);
      });

      source.pipe(upper);
      const chunks = await toArray(upper);
      const result = chunks.map(c => new TextDecoder().decode(c as Uint8Array)).join("");
      expect(result).toBe("ABCDEF");
    });
  });

  // ===========================================================================
  // filter
  // ===========================================================================
  describe("filter", () => {
    it("should filter chunks with sync predicate", async () => {
      const source = createReadableFromArray([1, 2, 3, 4, 5], { objectMode: true });
      const evens = filter<number>(n => n % 2 === 0);

      source.pipe(evens);
      const result = await toArray(evens);
      expect(result).toEqual([2, 4]);
    });

    it("should filter chunks with async predicate", async () => {
      const source = createReadableFromArray(["hello", "", "world", ""], { objectMode: true });
      const nonEmpty = filter<string>(async s => s.length > 0);

      source.pipe(nonEmpty);
      const result = await toArray(nonEmpty);
      expect(result).toEqual(["hello", "world"]);
    });

    it("should return empty for all-rejected stream", async () => {
      const source = createReadableFromArray([1, 2, 3], { objectMode: true });
      const none = filter<number>(() => false);

      source.pipe(none);
      const result = await toArray(none);
      expect(result).toEqual([]);
    });
  });

  // ===========================================================================
  // isReadableStreamLike
  // ===========================================================================
  describe("isReadableStreamLike", () => {
    it("should return true for a ReadableStream", () => {
      const rs = new ReadableStream();
      expect(isReadableStreamLike(rs)).toBe(true);
    });

    it("should return true for an object with getReader", () => {
      expect(isReadableStreamLike({ getReader: () => ({}) })).toBe(true);
    });

    it("should return false for null", () => {
      expect(isReadableStreamLike(null)).toBe(false);
    });

    it("should return false for a plain object", () => {
      expect(isReadableStreamLike({})).toBe(false);
    });
  });

  // ===========================================================================
  // readableStreamToAsyncIterable
  // ===========================================================================
  describe("readableStreamToAsyncIterable", () => {
    it("should convert a ReadableStream to an async iterable", async () => {
      const rs = new ReadableStream<string>({
        start(controller) {
          controller.enqueue("a");
          controller.enqueue("b");
          controller.enqueue("c");
          controller.close();
        }
      });

      const result: string[] = [];
      for await (const chunk of readableStreamToAsyncIterable<string>(rs)) {
        result.push(chunk);
      }
      expect(result).toEqual(["a", "b", "c"]);
    });

    it("should handle an empty ReadableStream", async () => {
      const rs = new ReadableStream({
        start(controller) {
          controller.close();
        }
      });

      const result: unknown[] = [];
      for await (const chunk of readableStreamToAsyncIterable(rs)) {
        result.push(chunk);
      }
      expect(result).toEqual([]);
    });

    it("should convert binary ReadableStream", async () => {
      const data = new Uint8Array([1, 2, 3]);
      const rs = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(data);
          controller.close();
        }
      });

      const result: Uint8Array[] = [];
      for await (const chunk of readableStreamToAsyncIterable<Uint8Array>(rs)) {
        result.push(chunk);
      }
      expect(result).toEqual([data]);
    });

    it("yields every value, null and undefined included, as values() does", async () => {
      const source = (): ReadableStream<unknown> =>
        new ReadableStream({
          start(controller) {
            for (const value of [1, null, undefined, 2]) {
              controller.enqueue(value);
            }
            controller.close();
          }
        });
      const result: unknown[] = [];
      for await (const chunk of readableStreamToAsyncIterable<unknown>(source())) {
        result.push(chunk);
      }
      expect(result).toEqual([1, null, undefined, 2]);
      const reader = source().getReader();
      const native: unknown[] = [];
      for (let next = await reader.read(); !next.done; next = await reader.read()) {
        native.push(next.value);
      }
      expect(result).toEqual(native);
    });

    it("leaves a value that is not bytes to the byte consumers, whatever the source", async () => {
      // Through a Web stream or an async iterable, a null chunk is the same
      // unusable value; it used to be skipped on one route and rejected on the other.
      const web = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([104]));
          controller.enqueue(null as unknown as Uint8Array);
          controller.close();
        }
      });
      const iterable = (async function* () {
        yield new Uint8Array([104]);
        yield null as unknown as Uint8Array;
      })();
      const failures = await Promise.all(
        [web, iterable].map(source =>
          text(source as AsyncIterable<Uint8Array>).then(
            () => "accepted",
            (error: Error) => error.name
          )
        )
      );
      expect(failures[0]).not.toBe("accepted");
      expect(failures[0]).toBe(failures[1]);
    });

    it("should release lock after iteration completes", async () => {
      const rs = new ReadableStream<string>({
        start(controller) {
          controller.enqueue("x");
          controller.close();
        }
      });

      for await (const _chunk of readableStreamToAsyncIterable<string>(rs)) {
        // consume
      }

      // After iteration, we should be able to get a new reader
      // (lock was released)
      const reader = rs.getReader();
      const result = await reader.read();
      expect(result.done).toBe(true);
      reader.releaseLock();
    });
  });
}

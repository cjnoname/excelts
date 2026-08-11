import { EntrySizeMismatchError } from "@archive/core/errors";
import { processEntryDataStream, readLocalHeaderDataOffset } from "@archive/unzip/zip-extract-core";
import { ZipParser } from "@archive/unzip/zip-parser";
import { BinaryReader } from "@archive/zip-spec/binary";
import type { ZipEntryRecord } from "@archive/zip-spec/zip-entry-info";
import type { ZipEntry } from "@archive/zip/zip-bytes";
import { createZipSync } from "@archive/zip/zip-bytes";
/**
 * Tests for validateEntrySizes option - ZIP bomb protection
 */
import { describe, it, expect } from "vitest";

// Helper to create an async iterable from Uint8Array
async function* toAsyncIterable(data: Uint8Array): AsyncIterable<Uint8Array> {
  yield data;
}

// Helper to collect async iterable to buffer
async function collect(iterable: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of iterable) {
    chunks.push(chunk);
  }
  const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

// Helper to get entry and its compressed data from a ZIP buffer
function getEntryAndData(
  zipData: Uint8Array,
  entryPath: string
): { entry: ZipEntryRecord; compressedData: Uint8Array } {
  const parser = new ZipParser(zipData);
  const entry = parser.getEntries().find(e => e.path === entryPath);
  if (!entry) {
    throw new Error(`Entry not found: ${entryPath}`);
  }
  const reader = new BinaryReader(zipData, entry.localHeaderOffset);
  const dataOffset = readLocalHeaderDataOffset(reader, entry.localHeaderOffset);
  const compressedData = zipData.subarray(dataOffset, dataOffset + entry.compressedSize);
  return { entry, compressedData };
}

describe("validateEntrySizes", () => {
  describe("default behavior (enabled)", () => {
    it("should pass when actual size matches declared size", async () => {
      const content = "Hello, World!";
      const entries: ZipEntry[] = [{ name: "test.txt", data: new TextEncoder().encode(content) }];
      const zipData = createZipSync(entries);

      const { entry, compressedData } = getEntryAndData(zipData, "test.txt");

      // Extract with default options (validateEntrySizes = true)
      const result = await collect(processEntryDataStream(entry, toAsyncIterable(compressedData)));

      expect(new TextDecoder().decode(result)).toBe(content);
    });

    it("should throw EntrySizeMismatchError for too-many-bytes", async () => {
      // Create a ZIP with correct content
      const declaredContent = "short";
      const entries: ZipEntry[] = [
        { name: "test.txt", data: new TextEncoder().encode(declaredContent) }
      ];
      const zipData = createZipSync(entries);

      const { entry, compressedData } = getEntryAndData(zipData, "test.txt");

      // Manually tamper the entry to have a smaller declared size
      const tamperedEntry = { ...entry, uncompressedSize: 2 };

      // Should throw because actual (5 bytes) > declared (2 bytes)
      await expect(
        collect(processEntryDataStream(tamperedEntry, toAsyncIterable(compressedData)))
      ).rejects.toThrow(EntrySizeMismatchError);

      try {
        await collect(processEntryDataStream(tamperedEntry, toAsyncIterable(compressedData)));
      } catch (err) {
        expect(err).toBeInstanceOf(EntrySizeMismatchError);
        const error = err as EntrySizeMismatchError;
        expect(error.reason).toBe("too-many-bytes");
        expect(error.expected).toBe(2);
        expect(error.actual).toBeGreaterThan(2);
      }
    });

    it("should throw EntrySizeMismatchError for too-few-bytes", async () => {
      const content = "short";
      const entries: ZipEntry[] = [{ name: "test.txt", data: new TextEncoder().encode(content) }];
      const zipData = createZipSync(entries);

      const { entry, compressedData } = getEntryAndData(zipData, "test.txt");

      // Tamper entry to expect more bytes than actual
      const tamperedEntry = { ...entry, uncompressedSize: 100 };

      // Should throw because actual (5 bytes) < declared (100 bytes)
      await expect(
        collect(processEntryDataStream(tamperedEntry, toAsyncIterable(compressedData)))
      ).rejects.toThrow(EntrySizeMismatchError);

      try {
        await collect(processEntryDataStream(tamperedEntry, toAsyncIterable(compressedData)));
      } catch (err) {
        expect(err).toBeInstanceOf(EntrySizeMismatchError);
        const error = err as EntrySizeMismatchError;
        expect(error.reason).toBe("too-few-bytes");
        expect(error.expected).toBe(100);
        expect(error.actual).toBe(5);
      }
    });
  });

  describe("disabled validation", () => {
    it("should not throw when validateEntrySizes is false", async () => {
      const content = "Hello, World!";
      const entries: ZipEntry[] = [{ name: "test.txt", data: new TextEncoder().encode(content) }];
      const zipData = createZipSync(entries);

      const { entry, compressedData } = getEntryAndData(zipData, "test.txt");

      // Tamper entry to have wrong size
      const tamperedEntry = { ...entry, uncompressedSize: 2 };

      // Should NOT throw when validation is disabled
      const result = await collect(
        processEntryDataStream(tamperedEntry, toAsyncIterable(compressedData), {
          validateEntrySizes: false
        })
      );

      // Content should still be fully extracted
      expect(new TextDecoder().decode(result)).toBe(content);
    });
  });

  describe("ZIP bomb early abort", () => {
    it("should abort early when too many bytes are produced", async () => {
      // Create a small file but claim it's tiny
      const largeContent = "A".repeat(10000);
      const entries: ZipEntry[] = [
        { name: "bomb.txt", data: new TextEncoder().encode(largeContent) }
      ];
      const zipData = createZipSync(entries);

      const { entry, compressedData } = getEntryAndData(zipData, "bomb.txt");

      // Tamper to claim only 100 bytes
      const tamperedEntry = { ...entry, uncompressedSize: 100 };

      // Track how many bytes were yielded before error
      let bytesYielded = 0;
      const stream = processEntryDataStream(tamperedEntry, toAsyncIterable(compressedData));

      try {
        for await (const chunk of stream) {
          bytesYielded += chunk.length;
        }
        // Should not reach here
        expect.fail("Should have thrown EntrySizeMismatchError");
      } catch (err) {
        expect(err).toBeInstanceOf(EntrySizeMismatchError);
        // Should have aborted early, not after processing all 10000 bytes
        // The error is thrown when bytesYielded > 100
        expect(bytesYielded).toBeLessThanOrEqual(tamperedEntry.uncompressedSize);
      }
    });
  });

  describe("error message formatting", () => {
    it("should include entry path in too-many-bytes error message", async () => {
      const content = "short";
      const entries: ZipEntry[] = [
        { name: "path/to/file.txt", data: new TextEncoder().encode(content) }
      ];
      const zipData = createZipSync(entries);

      const { entry, compressedData } = getEntryAndData(zipData, "path/to/file.txt");
      const tamperedEntry = { ...entry, uncompressedSize: 2 };

      try {
        await collect(processEntryDataStream(tamperedEntry, toAsyncIterable(compressedData)));
        expect.fail("Should have thrown");
      } catch (err) {
        const error = err as EntrySizeMismatchError;
        expect(error.message).toContain("path/to/file.txt");
        expect(error.message).toContain("more bytes");
        expect(error.path).toBe("path/to/file.txt");
        // Test helper methods
        expect(error.isZipBomb()).toBe(true);
        expect(error.isCorruption()).toBe(false);
      }
    });

    it("should include entry path in too-few-bytes error message", async () => {
      const content = "short";
      const entries: ZipEntry[] = [
        { name: "another/file.txt", data: new TextEncoder().encode(content) }
      ];
      const zipData = createZipSync(entries);

      const { entry, compressedData } = getEntryAndData(zipData, "another/file.txt");
      const tamperedEntry = { ...entry, uncompressedSize: 100 };

      try {
        await collect(processEntryDataStream(tamperedEntry, toAsyncIterable(compressedData)));
        expect.fail("Should have thrown");
      } catch (err) {
        const error = err as EntrySizeMismatchError;
        expect(error.message).toContain("another/file.txt");
        expect(error.message).toContain("fewer bytes");
        expect(error.path).toBe("another/file.txt");
        // Test helper methods
        expect(error.isZipBomb()).toBe(false);
        expect(error.isCorruption()).toBe(true);
      }
    });
  });

  describe("empty entries", () => {
    it("should handle empty files correctly", async () => {
      const entries: ZipEntry[] = [{ name: "empty.txt", data: new Uint8Array(0) }];
      const zipData = createZipSync(entries);

      const { entry, compressedData } = getEntryAndData(zipData, "empty.txt");

      // Should pass without error
      const result = await collect(processEntryDataStream(entry, toAsyncIterable(compressedData)));
      expect(result.length).toBe(0);
    });

    it("should throw for empty file claiming non-zero size", async () => {
      const entries: ZipEntry[] = [{ name: "fake-empty.txt", data: new Uint8Array(0) }];
      const zipData = createZipSync(entries);

      const { entry, compressedData } = getEntryAndData(zipData, "fake-empty.txt");
      const tamperedEntry = { ...entry, uncompressedSize: 100 };

      await expect(
        collect(processEntryDataStream(tamperedEntry, toAsyncIterable(compressedData)))
      ).rejects.toThrow(EntrySizeMismatchError);
    });
  });
});

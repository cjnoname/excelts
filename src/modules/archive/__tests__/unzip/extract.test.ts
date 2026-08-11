import { readFileSync } from "fs";
import { fileURLToPath } from "url";

import { extractAll, extractFile, listFiles, forEachEntry } from "@archive/unzip/extract";
import { describe, it, expect } from "vitest";

// Path to test xlsx file (xlsx files are zip archives)
const testFilePath = fileURLToPath(new URL("./data/formulas.xlsx", import.meta.url));

describe("extract", () => {
  describe("extractAll", () => {
    it("should extract all files from ZIP", async () => {
      const zipData = readFileSync(testFilePath);
      const files = await extractAll(zipData);

      expect(files.size).toBeGreaterThan(0);
      expect(files.has("[Content_Types].xml")).toBe(true);
    });

    it("should preserve file content correctly", async () => {
      const zipData = readFileSync(testFilePath);
      const files = await extractAll(zipData);

      const contentTypes = files.get("[Content_Types].xml");
      expect(contentTypes).toBeDefined();
      const text = new TextDecoder().decode(contentTypes!.data);
      expect(text).toContain("<?xml");
      expect(text).toContain("ContentType");
    });

    it("should handle Uint8Array input", async () => {
      const zipData = new Uint8Array(readFileSync(testFilePath));
      const files = await extractAll(zipData);

      expect(files.size).toBeGreaterThan(0);
    });

    it("should set correct file properties", async () => {
      const zipData = readFileSync(testFilePath);
      const files = await extractAll(zipData);

      const contentTypes = files.get("[Content_Types].xml");
      expect(contentTypes).toBeDefined();
      expect(contentTypes!.path).toBe("[Content_Types].xml");
      expect(contentTypes!.type).toBe("file");
      expect(contentTypes!.size).toBeGreaterThan(0);
    });
  });

  describe("extractFile", () => {
    it("should extract single file from ZIP", async () => {
      const zipData = readFileSync(testFilePath);
      const content = await extractFile(zipData, "[Content_Types].xml");

      expect(content).not.toBeNull();
      expect(new TextDecoder().decode(content!)).toContain("<?xml");
    });

    it("should return null for non-existent file", async () => {
      const zipData = readFileSync(testFilePath);
      const content = await extractFile(zipData, "nonexistent.xml");

      expect(content).toBeNull();
    });

    it("should handle nested paths", async () => {
      const zipData = readFileSync(testFilePath);
      const content = await extractFile(zipData, "xl/workbook.xml");

      expect(content).not.toBeNull();
      expect(new TextDecoder().decode(content!)).toContain("workbook");
    });
  });

  describe("listFiles", () => {
    it("should list all file paths in ZIP", async () => {
      const zipData = readFileSync(testFilePath);
      const paths = await listFiles(zipData);

      expect(paths.length).toBeGreaterThan(0);
      expect(paths).toContain("[Content_Types].xml");
    });

    it("should include nested paths", async () => {
      const zipData = readFileSync(testFilePath);
      const paths = await listFiles(zipData);

      const xlPaths = paths.filter(p => p.startsWith("xl/"));
      expect(xlPaths.length).toBeGreaterThan(0);
    });
  });

  describe("forEachEntry", () => {
    it("should iterate over all entries", async () => {
      const zipData = readFileSync(testFilePath);
      const paths: string[] = [];

      await forEachEntry(zipData, async path => {
        paths.push(path);
      });

      expect(paths.length).toBeGreaterThan(0);
      expect(paths).toContain("[Content_Types].xml");
    });

    it("should allow reading data on demand", async () => {
      const zipData = readFileSync(testFilePath);
      let contentTypesContent = "";

      await forEachEntry(zipData, async (path, getData) => {
        if (path === "[Content_Types].xml") {
          const data = await getData();
          contentTypesContent = new TextDecoder().decode(data);
        }
      });

      expect(contentTypesContent).toContain("<?xml");
    });

    it("should allow stopping iteration early", async () => {
      const zipData = readFileSync(testFilePath);
      const paths: string[] = [];

      await forEachEntry(zipData, async path => {
        paths.push(path);
        if (paths.length >= 2) {
          return false; // Stop after 2 entries
        }
      });

      expect(paths.length).toBe(2);
    });

    it("should provide ZipEntryRecord for advanced use", async () => {
      const zipData = readFileSync(testFilePath);
      let hasEntryInfo = false;

      await forEachEntry(zipData, async (_path, _getData, entry) => {
        // ZipEntryRecord provides detailed info about the entry
        if (entry.compressedSize !== undefined && entry.uncompressedSize !== undefined) {
          hasEntryInfo = true;
          return false;
        }
      });

      expect(hasEntryInfo).toBe(true);
    });
  });
});

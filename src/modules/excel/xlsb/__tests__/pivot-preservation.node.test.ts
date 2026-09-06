import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { extractAll } from "@archive/unzip/extract";
import { ZipArchive } from "@archive/zip";
import { Workbook, Worksheet } from "@excel";
import { XLSB_CORPUS_CACHE } from "@excel/xlsb/corpus/paths";
import { describe, expect, it } from "vitest";

/**
 * A pivot table survives an XLSB read-modify-write, byte for byte.
 *
 * **This writer models pivot tables now** — `pivot-view.ts`, `pivot-cache.ts` and `pivot-model.ts` write the
 * view, the cache definition and the records against MS-XLSB section 3.8's worked example — so the sentence
 * that used to open this file, that "the binary form is not implementable against the published
 * specification", is gone. It is recorded rather than deleted because it was the reason this test exists.
 *
 * What the test still covers is the case modelling does *not* reach: a pivot table read from an **XLSB**, whose
 * three parts are carried through untouched by the opaque-part mechanism. That guarantee was completely
 * untested, which is the worst combination for a guarantee of this kind — a regression would not fail
 * anything; it would quietly delete a pivot table from someone's workbook.
 *
 * The XLSX→XLSB direction is covered separately, by `__tests__/pivot-conversion.test.ts`: a pivot read from an
 * XML container has no live source worksheet, and `pivotParts` used to require one and drop the pivot without
 * a word.
 *
 * There is no corpus file with a pivot table (0 of 23), so the fixture is built here by injecting the three
 * parts into a real corpus workbook. The bytes are deliberately recognisable rather than plausible: what is
 * under test is *preservation*, and a payload this writer cannot possibly have synthesised is the only kind
 * that proves it.
 *
 * Carries `.node` because it reads the corpus off disk.
 */

/** A corpus file, or `undefined` when the corpus has not been fetched. */
const corpus = (name: string): Uint8Array | undefined => {
  const path = join(XLSB_CORPUS_CACHE, name);
  return existsSync(path) ? new Uint8Array(readFileSync(path)) : undefined;
};

const RELATIONSHIPS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PIVOT_TABLE_BYTES = new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]);
const CACHE_DEFINITION_BYTES = new Uint8Array([0x11, 0x22, 0x33]);
const CACHE_RECORDS_BYTES = new Uint8Array([0x44, 0x55]);

/** A corpus workbook with the three pivot parts and their relationships injected. */
async function workbookWithPivotParts(): Promise<Uint8Array> {
  const source = await extractAll(corpus("poi-Simple.xlsb")!);
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const archive = new ZipArchive();
  for (const [name, entry] of source) {
    let data = entry.data;
    if (name === "[Content_Types].xml") {
      // The MS-XLSB content types, which are what makes these binary parts rather than the XML ones an
      // `.xlsx` would carry.
      data = encoder.encode(
        decoder
          .decode(data)
          .replace(
            "</Types>",
            `<Override PartName="/xl/pivotTables/pivotTable1.bin" ContentType="application/vnd.ms-excel.pivotTable"/>` +
              `<Override PartName="/xl/pivotCache/pivotCacheDefinition1.bin" ContentType="application/vnd.ms-excel.pivotCacheDefinition"/>` +
              `<Override PartName="/xl/pivotCache/pivotCacheRecords1.bin" ContentType="application/vnd.ms-excel.pivotCacheRecords"/></Types>`
          )
      );
    }
    if (name === "xl/_rels/workbook.bin.rels") {
      data = encoder.encode(
        decoder
          .decode(data)
          .replace(
            "</Relationships>",
            `<Relationship Id="rId99" Type="${RELATIONSHIPS}/pivotCacheDefinition" Target="pivotCache/pivotCacheDefinition1.bin"/></Relationships>`
          )
      );
    }
    if (name === "xl/worksheets/_rels/sheet1.bin.rels") {
      data = encoder.encode(
        decoder
          .decode(data)
          .replace(
            "</Relationships>",
            `<Relationship Id="rId98" Type="${RELATIONSHIPS}/pivotTable" Target="../pivotTables/pivotTable1.bin"/></Relationships>`
          )
      );
    }
    archive.add(name, data);
  }
  archive.add("xl/pivotTables/pivotTable1.bin", PIVOT_TABLE_BYTES);
  archive.add("xl/pivotCache/pivotCacheDefinition1.bin", CACHE_DEFINITION_BYTES);
  archive.add("xl/pivotCache/pivotCacheRecords1.bin", CACHE_RECORDS_BYTES);
  archive.add(
    "xl/pivotCache/_rels/pivotCacheDefinition1.bin.rels",
    encoder.encode(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="${RELATIONSHIPS}/pivotCacheRecords" Target="pivotCacheRecords1.bin"/></Relationships>`
    )
  );
  return archive.bytes();
}

describe.runIf(corpus("poi-Simple.xlsb") !== undefined)(
  "a pivot table survives an XLSB read-modify-write",
  () => {
    it("carries all three parts through unchanged", async () => {
      const workbook = Workbook.create();
      await Workbook.read(workbook, await workbookWithPivotParts());
      const written = await extractAll(
        await Workbook.toBuffer(workbook, { format: "xlsb", unsupported: "ignore" })
      );
      // Byte equality, not mere presence. A part rebuilt from a model this writer does not have would be a
      // different part, and "the entry exists" would not notice.
      // Compared through `Uint8Array.from` because the archive hands back a `Buffer` on Node: the bytes are
      // what is under test, not which view type carries them.
      const bytesAt = (path: string): Uint8Array => Uint8Array.from(written.get(path)!.data);
      expect(bytesAt("xl/pivotTables/pivotTable1.bin")).toEqual(PIVOT_TABLE_BYTES);
      expect(bytesAt("xl/pivotCache/pivotCacheDefinition1.bin")).toEqual(CACHE_DEFINITION_BYTES);
      expect(bytesAt("xl/pivotCache/pivotCacheRecords1.bin")).toEqual(CACHE_RECORDS_BYTES);
    });

    it("keeps every relationship that reaches them", async () => {
      // A preserved part nothing points at is not a preserved pivot table — Excel would ignore it. The three
      // edges are: workbook → cache definition, cache definition → records, sheet → pivot table.
      const workbook = Workbook.create();
      await Workbook.read(workbook, await workbookWithPivotParts());
      const written = await extractAll(
        await Workbook.toBuffer(workbook, { format: "xlsb", unsupported: "ignore" })
      );
      const decoder = new TextDecoder();
      const relsFor = (path: string): string => {
        const entry = written.get(path);
        return entry === undefined ? "" : decoder.decode(entry.data);
      };
      expect(relsFor("xl/_rels/workbook.bin.rels")).toContain(
        "pivotCache/pivotCacheDefinition1.bin"
      );
      expect(relsFor("xl/pivotCache/_rels/pivotCacheDefinition1.bin.rels")).toContain(
        "pivotCacheRecords1.bin"
      );
      const sheetRels = [...written.keys()].filter(name =>
        /worksheets\/_rels\/sheet\d+\.bin\.rels$/.test(name)
      );
      expect(sheetRels.some(name => relsFor(name).includes("pivotTables/pivotTable1.bin"))).toBe(
        true
      );
    });

    it("declares the binary content types the parts need", async () => {
      // Without the override a `.bin` part has no content type at all, and the package is malformed.
      const workbook = Workbook.create();
      await Workbook.read(workbook, await workbookWithPivotParts());
      const written = await extractAll(
        await Workbook.toBuffer(workbook, { format: "xlsb", unsupported: "ignore" })
      );
      const contentTypes = new TextDecoder().decode(written.get("[Content_Types].xml")!.data);
      expect(contentTypes).toContain("application/vnd.ms-excel.pivotTable");
      expect(contentTypes).toContain("application/vnd.ms-excel.pivotCacheDefinition");
      expect(contentTypes).toContain("application/vnd.ms-excel.pivotCacheRecords");
    });

    it("reports no loss, because nothing was lost", async () => {
      // The loss report names what this writer *drops*. A pivot table it carries through verbatim is not a
      // loss, and reporting one would send a caller looking for damage that is not there — the mirror of the
      // watermark false positive.
      const workbook = Workbook.create();
      await Workbook.read(workbook, await workbookWithPivotParts());
      await expect(Workbook.toBuffer(workbook, { format: "xlsb" })).resolves.toBeDefined();
      // And the model genuinely has no pivot table, which is why no *structured* loss check can fire: the
      // parts are opaque bytes, not a model this reader populated.
      const sheet = Workbook.getWorksheet(workbook, "Sheet1");
      expect(sheet).toBeDefined();
      expect(Worksheet.getModel(sheet!).pivotTables).toEqual([]);
    });
  }
);

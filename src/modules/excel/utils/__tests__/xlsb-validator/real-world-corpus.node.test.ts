/**
 * Validation and reading against a corpus of real, Excel-authored XLSB workbooks.
 *
 * These tests read from disk, which is why the file carries the `.node` suffix: the browser
 * config excludes `*.node.test.ts` by glob. The in-memory half of this coverage — which the
 * validator needs in a browser too — lives in `real-world-shapes.test.ts`.
 *
 * The corpus is not committed — the fixtures are other projects' test files, whose licensing is not
 * ours to assume and which do not belong in the published package — but it *is* pinned: every entry in
 * `xlsb/corpus/manifest.ts` names an upstream commit and a SHA-256, and `pnpm corpus:xlsb` fetches them
 * into `tmp/xlsb-corpus` after verifying each digest.
 *
 * That replaced a `DOCUMONSTER_XLSB_CORPUS_DIR` pointing at an arbitrary directory, which was not a
 * corpus but a private note: nobody else could confirm a single offset this module asserts, and nothing
 * said whether a later run used the same bytes. These tests skip when the cache is absent, so a
 * contributor who has not fetched it is never blocked — and one who has reads exactly the bytes every
 * layout claim here was read off.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { extractAll } from "@archive/unzip/extract";
import { Workbook } from "@excel";
import { validateXlsbBuffer } from "@excel/utils/xlsb-validator";
import { XLSB_CORPUS } from "@excel/xlsb/corpus/manifest";
import { XLSB_CORPUS_CACHE } from "@excel/xlsb/corpus/paths";
import { readSharedStrings, readWorkbookPart, readWorksheetPart } from "@excel/xlsb/read/parts";
import { describe, expect, it } from "vitest";

/**
 * Fixtures present in the cache, by local path.
 *
 * Read from the manifest rather than by scanning the directory, so a file the manifest does not pin
 * cannot join the corpus by being dropped into the folder. The two encrypted entries are excluded here
 * and asserted separately: they are not ZIP packages, and "refuses an encrypted workbook" is a
 * different claim from "validates a workbook".
 */
const available = await Promise.all(
  XLSB_CORPUS.map(async entry => {
    const path = join(XLSB_CORPUS_CACHE, entry.name);
    try {
      return { entry, bytes: new Uint8Array(await readFile(path)) };
    } catch {
      return undefined;
    }
  })
).then(entries =>
  entries.filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
);

/**
 * Grouped by how much authority each file has, which decides what may be asserted of it.
 *
 * Conformance — "every Excel-authored workbook has a `BrtFileVersion`", "this record is always N bytes"
 * — may only be asserted of `excel` files. A hand-reduced bug report legitimately omits records, and a
 * beta's output legitimately contradicts the specification; holding either to those checks would mean
 * either failing files this reader handles correctly or widening the checks until they catch nothing.
 *
 * *Readability* is asserted of all of them, which is the point of keeping the awkward ones.
 */
const packages = available.filter(({ entry }) => entry.authority !== "encrypted");
const conformant = available.filter(({ entry }) => entry.authority === "excel");
const encrypted = available.filter(({ entry }) => entry.authority === "encrypted");

/** A part by path, comparing case-insensitively as OPC requires. */
function findEntry(
  entries: Awaited<ReturnType<typeof extractAll>>,
  path: string
): Uint8Array | undefined {
  const lower = path.toLowerCase();
  for (const [candidate, file] of entries) {
    if (candidate.toLowerCase() === lower) {
      return file.data;
    }
  }
  return undefined;
}
describe.skipIf(available.length === 0)("real XLSB corpus", () => {
  it("has the whole pinned corpus cached", () => {
    // A gate over a partial corpus passes for the wrong reason: the file that would have failed is
    // simply the one that is missing.
    expect(available.map(({ entry }) => entry.name).sort()).toEqual(
      XLSB_CORPUS.map(entry => entry.name).sort()
    );
  });

  it("validates every Excel-authored workbook without a single problem", async () => {
    for (const { entry, bytes } of conformant) {
      const report = await validateXlsbBuffer(bytes, { includeWarnings: true });
      expect(
        report.problems.map(problem => `${problem.kind} @ ${problem.part}: ${problem.message}`),
        entry.name
      ).toEqual([]);
    }
  });

  it("reads the awkward ones too, without holding them to the conformance checks", async () => {
    // A reduced bug report and a beta's non-conformant output. Both are read; neither is evidence about
    // the format. `poi-Simple.xlsb` is the one that made this distinction necessary: its malformed sheet
    // records used to make a three-sheet workbook read back as having none.
    const awkward = available.filter(
      ({ entry }) => entry.authority === "reduced" || entry.authority === "nonconformant"
    );
    expect(awkward.length).toBeGreaterThan(0);
    for (const { entry, bytes } of awkward) {
      const workbook = Workbook.create();
      await Workbook.read(workbook, bytes);
      expect(Workbook.getWorksheets(workbook).length, entry.name).toBeGreaterThan(0);
    }
  });

  it("refuses the encrypted workbooks rather than mangling them", async () => {
    // Not ZIP packages at all — OLE-wrapped and encrypted. Pinned because a corpus of only files that
    // work is not a corpus of what people have, and because failing cleanly is a behaviour worth
    // asserting rather than assuming.
    expect(encrypted.length).toBe(2);
    for (const { entry, bytes } of encrypted) {
      await expect(
        (async () => {
          const workbook = Workbook.create();
          await Workbook.read(workbook, bytes);
        })(),
        entry.name
      ).rejects.toThrow();
    }
  });

  it("reads every workbook in the corpus without throwing", async () => {
    // Reading has to *complete* for every file. Yielding cells does not: a workbook holding a
    // picture, or one with eight empty sheets, is a legitimate workbook, and an earlier version
    // of this test demanded cells from each file because the corpus then happened to be two
    // files that both had them.
    let corpusCells = 0;
    let corpusSheets = 0;

    for (const { entry: manifestEntry, bytes: fileBytes } of packages) {
      const file = manifestEntry.name;
      const entries = await extractAll(fileBytes);
      // Case-insensitively, because OPC part names are compared that way and a real workbook in
      // this corpus names the part `xl/SharedStrings.bin`. An exact-match lookup here reported
      // every string cell as undecodable while the reader, which resolves case-insensitively,
      // read them correctly — so the test was wrong and the reader was right.
      const sst = findEntry(entries, "xl/sharedStrings.bin");
      const strings = sst ? readSharedStrings(sst, "sst").texts : [];
      const { sheetNames, definedNames } = readWorkbookPart(
        findEntry(entries, "xl/workbook.bin")!,
        "wb"
      );
      expect(sheetNames.length, `${file} declares no sheets`).toBeGreaterThan(0);
      corpusSheets += sheetNames.length;

      for (let index = 0; index < sheetNames.length; index++) {
        const part = findEntry(entries, `xl/worksheets/sheet${index + 1}.bin`);
        if (!part) {
          continue;
        }
        const read = readWorksheetPart(part, `sheet${index + 1}`, strings, {
          sheetNames,
          definedNames
        });
        corpusCells += read.cells.length;
        // A cell record this reader recognises but cannot decode is the one thing worth
        // failing on: it means a real file uses an encoding the spec table does not describe.
        expect(
          [...read.unreadRecords.keys()],
          `${file} sheet${index + 1} holds cell records this reader cannot decode`
        ).toEqual([]);
      }
    }

    // The corpus as a whole must exercise the reader, or it is not a corpus.
    expect(corpusSheets, "the corpus declares no sheets at all").toBeGreaterThan(0);
    expect(corpusCells, "the corpus yields no cells at all").toBeGreaterThan(0);
  });
});

/**
 * Validation and reading against a corpus of real, Excel-authored XLSB workbooks.
 *
 * These tests read from disk, which is why the file carries the `.node` suffix: the browser
 * config excludes `*.node.test.ts` by glob. The in-memory half of this coverage — which the
 * validator needs in a browser too — lives in `real-world-shapes.test.ts`.
 *
 * The corpus is not committed. Reference workbooks are large binaries whose licensing is not
 * ours to assume, and a fixture nobody can regenerate is worse than an opt-in gate. Point
 * `DOCUMONSTER_XLSB_CORPUS_DIR` at a directory of `.xlsb` files to run them.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { extractAll } from "@archive/unzip/extract";
import { validateXlsbBuffer } from "@excel/utils/xlsb-validator";
import { readSharedStrings, readWorkbookPart, readWorksheetPart } from "@excel/xlsb/read/parts";
import { describe, expect, it } from "vitest";

const corpusDirectory = process.env.DOCUMONSTER_XLSB_CORPUS_DIR;

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
describe.skipIf(!corpusDirectory)("real XLSB corpus", () => {
  it("validates every workbook in the corpus without a single problem", async () => {
    const files = (await readdir(corpusDirectory!)).filter(name => name.endsWith(".xlsb"));
    expect(files.length, `no .xlsb files in ${corpusDirectory}`).toBeGreaterThan(0);

    for (const file of files) {
      const bytes = await readFile(join(corpusDirectory!, file));
      const report = await validateXlsbBuffer(bytes, { includeWarnings: true });
      expect(
        report.problems.map(problem => `${problem.kind} @ ${problem.part}: ${problem.message}`),
        file
      ).toEqual([]);
    }
  });

  it("reads every workbook in the corpus without throwing", async () => {
    // Reading has to *complete* for every file. Yielding cells does not: a workbook holding a
    // picture, or one with eight empty sheets, is a legitimate workbook, and an earlier version
    // of this test demanded cells from each file because the corpus then happened to be two
    // files that both had them.
    const files = (await readdir(corpusDirectory!)).filter(name => name.endsWith(".xlsb"));
    let corpusCells = 0;
    let corpusSheets = 0;

    for (const file of files) {
      const entries = await extractAll(await readFile(join(corpusDirectory!, file)));
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

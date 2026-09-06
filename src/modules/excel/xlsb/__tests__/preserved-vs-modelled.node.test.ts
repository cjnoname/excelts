/**
 * A part the reader interpreted is not also preserved verbatim.
 *
 * **The rule `interpretedPaths` states, and the case where it was computed two different ways.** A part belongs in the
 * opaque set when *no* writer here authors it. A worksheet is authored, so it must not be preserved — otherwise the
 * writer emits it twice, once from the model and once from the preserved set, and `[Content_Types].xml` declares it
 * twice with it.
 *
 * `poi-Simple.xlsb` is the file that broke it. All three of its `BrtBundleSh` records are undecodable, so the read falls
 * back to the conventional `xl/worksheets/sheetN.bin` path — and `interpretedPaths` only marked a sheet interpreted when
 * its *relationship* resolved. So all three parts were read, modelled, **and** kept: a rebuild reported
 * `written twice, one copy dropped` for each, and the XLSX conversion refused them as sheet parts from the other
 * container. Two computations of "which paths did this reader read", disagreeing — which is what that function's own
 * comment warns about.
 *
 * The assertions are per-fixture over the whole corpus rather than on one file, because the property is general: any
 * package whose sheet records this reader cannot decode reaches the same fallback.
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { Cell, Workbook } from "@excel";
import { describe, expect, it } from "vitest";

const CORPUS = "tmp/xlsb-corpus";

/** Every fixture, or an empty list when the corpus has not been fetched. */
async function fixtures(): Promise<readonly string[]> {
  try {
    return (await readdir(CORPUS)).filter(name => name.endsWith(".xlsb")).sort();
  } catch {
    return [];
  }
}

/** Paths a writer authors, so a preserved copy of one is a duplicate rather than a rescue. */
const AUTHORED = /^xl\/(worksheets\/sheet\d+\.bin|workbook\.bin|styles\.bin|sharedStrings\.bin)$/i;

describe("what the XLSB reader preserves", () => {
  it("never keeps a part it also models", async () => {
    const names = await fixtures();
    if (names.length === 0) {
      return;
    }
    const offenders: string[] = [];
    for (const name of names) {
      const bytes = Uint8Array.from(await readFile(join(CORPUS, name)));
      const workbook = Workbook.create();
      try {
        await Workbook.read(workbook, bytes);
      } catch {
        // A refused package — `cal-pass_protected` is one — has nothing to say here.
        continue;
      }
      for (const part of Workbook.getModel(workbook).opaqueParts ?? []) {
        if (AUTHORED.test(part.path)) {
          offenders.push(`${name}: ${part.path}`);
        }
      }
    }
    // A chartsheet's `.bin` is deliberately absent from `AUTHORED`: this reader does *not* model one, so preserving it is
    // correct and is what makes an XLSB→XLSB round trip keep the tab.
    expect(offenders).toEqual([]);
  });

  it("rebuilds every fixture without writing a part twice", async () => {
    const names = await fixtures();
    if (names.length === 0) {
      return;
    }
    const offenders: string[] = [];
    for (const name of names) {
      const bytes = Uint8Array.from(await readFile(join(CORPUS, name)));
      const workbook = Workbook.create();
      try {
        await Workbook.read(workbook, bytes);
      } catch {
        continue;
      }
      const first = Workbook.getWorksheets(workbook)[0];
      if (first === undefined) {
        continue;
      }
      // Edited, so the passthrough does not answer instead of the writer — an unmodified package returns its own bytes
      // and would never exercise the collision guard.
      Cell.setValue(first, "ZZ997", "collision-probe");
      const report = await Workbook.toBuffer(workbook, { format: "xlsb" }).then(
        () => [] as readonly string[],
        (cause: unknown) => (cause as { items?: readonly string[] }).items ?? []
      );
      for (const entry of report.filter(item => item.includes("written twice"))) {
        offenders.push(`${name}: ${entry}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

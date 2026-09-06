/**
 * `modelHash`'s two named exceptions, and the assumption they rest on.
 *
 * The hash walks the model without naming any field, deliberately: the dangerous failure is a *false* unchanged —
 * returning the bytes a file arrived as after the caller edited it — and a walk that enumerated known fields would go
 * stale the moment one was added. `ssId` and `styleId` are the only exceptions, so they are the only place that
 * reasoning can be wrong.
 *
 * They are safe to ignore **because `writeXlsbPackage` does not read them**: it interns a cell's format from the
 * resolved `style`, `font`, `fill`, `border`, `alignment` and `numberFormat`, and its shared strings from the text.
 * That is an assumption about another module, so it is checked here rather than asserted in a comment — the same
 * workbook is written before and after the fields are stamped on, and the bytes must be identical.
 *
 * Why the exception exists: serialising to XLSX writes those two fields back onto the caller's cells, so any workbook
 * written as XLSX first had a different hash and lost the passthrough. Measured before the fix, on
 * `cal-any_sheets.xlsb`: 14,837 bytes read, 10,460 written back — the difference being exactly the parts this library
 * models imperfectly and the passthrough exists to protect.
 *
 * Every case works on **one** workbook rather than two, because the model carries `created` and `modified`: a second
 * `build()` is a different model a millisecond later, and comparing the two would fail for a reason that has nothing
 * to do with what is being tested.
 */
import { readFile } from "node:fs/promises";

import { Cell, Workbook, Worksheet } from "@excel";
import { modelHash, sameHash } from "@excel/xlsb/model-hash";
import { describe, expect, it } from "vitest";

/** A workbook with text and a format, so both artefacts have something to attach to. */
function build(): Workbook.Handle {
  const workbook = Workbook.create();
  const sheet = Workbook.addWorksheet(workbook, "S");
  Worksheet.addAoa(sheet, [
    ["alpha", 1],
    ["beta", 2]
  ]);
  Cell.setStyle(sheet, "A1", { font: { bold: true } });
  return workbook;
}

/**
 * Stamp `ssId`/`styleId` onto every cell of a model, in place, as an XLSX write leaves it.
 *
 * In place: a `JSON` round trip was tried first and is not a null operation on this model — it drops `undefined`
 * fields and turns `Date`s into strings, so the copy differed from its original for unrelated reasons.
 */
function stamp(model: ReturnType<typeof Workbook.getModel>): void {
  let counter = 0;
  for (const worksheet of model.worksheets ?? []) {
    for (const row of (worksheet as { rows?: readonly unknown[] }).rows ?? []) {
      for (const cell of (row as { cells?: unknown[] }).cells ?? []) {
        Object.assign(cell as object, { ssId: counter, styleId: counter % 3 });
        counter += 1;
      }
    }
  }
}

describe("the fields modelHash ignores", () => {
  it("hashes the same with and without them", () => {
    const workbook = build();
    const before = modelHash(Workbook.getModel(workbook));
    const model = Workbook.getModel(workbook);
    stamp(model);
    expect(sameHash(before, modelHash(model))).toBe(true);
  });

  it("still hashes differently when the content changes", () => {
    // The guard that keeps the case above from being vacuous: a hash that ignored too much would pass it while saying
    // nothing at all.
    const workbook = build();
    const before = modelHash(Workbook.getModel(workbook));
    Cell.setValue(Workbook.getWorksheets(workbook)[0]!, "A1", "changed");
    expect(sameHash(before, modelHash(Workbook.getModel(workbook)))).toBe(false);
  });

  it("produces identical XLSB bytes whether or not they are present", async () => {
    // **The assumption, checked.** If `writeXlsbPackage` ever begins reading `ssId` or `styleId`, these two packages
    // diverge and this fails — which is the signal that the exception in `modelHash` has stopped being true.
    const workbook = build();
    const left = await Workbook.toBuffer(workbook, { format: "xlsb", unsupported: "ignore" });
    const model = Workbook.getModel(workbook);
    stamp(model);
    Workbook.setModel(workbook, model);
    const right = await Workbook.toBuffer(workbook, { format: "xlsb", unsupported: "ignore" });
    expect([...right]).toEqual([...left]);
  });

  it("keeps the passthrough after the same workbook has been written as XLSX", async () => {
    // The behaviour the exception exists for, end to end and on a real Excel-authored file. Returns rather than fails
    // when the corpus has not been fetched, which is the shape every corpus-backed case here uses.
    let original: Uint8Array;
    try {
      original = Uint8Array.from(await readFile("tmp/xlsb-corpus/poi-sample.xlsb"));
    } catch {
      return;
    }
    const workbook = Workbook.create();
    await Workbook.read(workbook, original);
    await Workbook.toBuffer(workbook, { format: "xlsx", validate: false });
    const again = await Workbook.toBuffer(workbook, { format: "xlsb", unsupported: "ignore" });
    expect(again.length).toBe(original.length);
    expect([...again]).toEqual([...original]);
  });
});

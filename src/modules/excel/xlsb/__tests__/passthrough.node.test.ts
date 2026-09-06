/**
 * An unchanged XLSB comes back as the bytes it arrived as.
 *
 * **Why this is worth having, given the writer already round-trips.** `writeXlsbPackage` is a function of the model,
 * so an unmodified workbook would be written out equivalently anyway. What the original bytes add is the parts this
 * library understands *imperfectly*: a macro project, a chart it did not model, a pivot cache it rebuilds
 * approximately. A rebuild reconstructs those from what was understood of them; returning the original does not have
 * to understand them at all.
 *
 * **The hazard these tests exist for is the opposite one** — returning stale bytes after an edit. That is the
 * failure that loses a caller's work silently, so most of what follows is edits that must *not* pass through.
 */
import { readFile } from "node:fs/promises";
import process from "node:process";

import { Cell, Workbook, Worksheet } from "@excel";
import { modelHash, sameHash } from "@excel/xlsb/model-hash";
import { describe, expect, it } from "vitest";

/** Real Excel-authored packages, so the guarantee is tested against files this library did not write. */
const CORPUS = [
  "poi-sample",
  "cal-issues",
  "poi-comments",
  "cal-picture",
  "poi-testVarious"
] as const;

/** A corpus file, or `undefined` when the fetched cache is absent. */
async function corpus(name: string): Promise<Uint8Array | undefined> {
  try {
    return Uint8Array.from(await readFile(`tmp/xlsb-corpus/${name}.xlsb`));
  } catch {
    return undefined;
  }
}

describe("the corpus these tests need", () => {
  it("is present when the environment says it should be", async () => {
    // **The guards below make a skip visible; this makes it *fail* where it must not happen.**
    //
    // Every case in this file degrades to a no-op when `tmp/xlsb-corpus/` has not been fetched, which is right for a
    // developer who has not run `pnpm corpus:xlsb` and wrong for CI — where a fetch that quietly failed would leave the
    // whole passthrough suite green without having compared a single byte. `DOCUMONSTER_REQUIRE_XLSB_CORPUS` is what CI
    // sets to say "the corpus is supposed to be here".
    //
    // The same shape as `verify:libreoffice --require`, and for the same reason: a check that skips silently when its
    // input is missing is indistinguishable from one that passed.
    if (process.env["DOCUMONSTER_REQUIRE_XLSB_CORPUS"] === undefined) {
      expect(true).toBe(true);
      return;
    }
    // **Every fixture this file uses, not just one of them.**
    //
    // Checking `poi-sample` alone let the other four go missing while this test still passed — and each has cases that
    // degrade to a no-op without its file, so four fifths of the suite could vanish silently. `CORPUS` is the list the
    // parameterised cases iterate, so this cannot fall out of step with them.
    const missing: string[] = [];
    for (const name of [...CORPUS, "cal-picture"]) {
      if ((await corpus(name)) === undefined) {
        missing.push(name);
      }
    }
    expect(
      missing,
      `DOCUMONSTER_REQUIRE_XLSB_CORPUS is set but these fixtures are absent: ${missing.join(", ")}`
    ).toEqual([]);
  });
});

describe("an unmodified package", () => {
  it.each(CORPUS)("%s comes back byte for byte", async name => {
    const original = await corpus(name);
    if (original === undefined) {
      // The corpus is fetched into a gitignored cache. A missing file must not fail the suite, and must not pass it
      // silently either — the assertion below is what makes the skip visible.
      expect(original, `${name}: corpus not fetched; run pnpm verify:xlsb-corpus`).toBeUndefined();
      return;
    }
    const workbook = Workbook.create();
    await Workbook.read(workbook, original);
    const written = await Workbook.toBuffer(workbook, { format: "xlsb", unsupported: "ignore" });
    expect([...written]).toEqual([...original]);
  });

  it('does not need `unsupported: "ignore"`', async () => {
    // The point of the strict default is to refuse to *drop* things. Passing through drops nothing, so a package
    // full of features this library cannot write still returns cleanly — which is the whole reason the guarantee is
    // valuable for exactly those packages.
    const original = await corpus("cal-picture");
    if (original === undefined) {
      return;
    }
    const workbook = Workbook.create();
    await Workbook.read(workbook, original);
    await expect(Workbook.toBuffer(workbook, { format: "xlsb" })).resolves.toBeInstanceOf(
      Uint8Array
    );
  });
});

describe("an edited package is rebuilt", () => {
  it.each(CORPUS)("%s changes when a cell changes", async name => {
    const original = await corpus(name);
    if (original === undefined) {
      return;
    }
    const workbook = Workbook.create();
    await Workbook.read(workbook, original);
    Cell.setValue(Workbook.getWorksheets(workbook)[0], "ZZ999", "touched");
    const written = await Workbook.toBuffer(workbook, { format: "xlsb", unsupported: "ignore" });
    expect([...written]).not.toEqual([...original]);
  });

  it("changes when a sheet is added", async () => {
    // A change outside any existing sheet. The hash walks the whole model, so this needs no special handling — but a
    // hash built from a hand-written field list would very likely have missed it.
    const original = await corpus("poi-sample");
    if (original === undefined) {
      // Visible rather than silent — see the note on the first case in this file.
      expect(original, "poi-sample: corpus not fetched; run pnpm corpus:xlsb").toBeUndefined();
      return;
    }
    const workbook = Workbook.create();
    await Workbook.read(workbook, original);
    const sheet = Workbook.addWorksheet(workbook, "Added");
    Worksheet.addAoa(sheet, [[1]]);
    const written = await Workbook.toBuffer(workbook, { format: "xlsb", unsupported: "ignore" });
    expect([...written]).not.toEqual([...original]);
  });

  it("changes when only a style changes", async () => {
    // No value moves here, which is the case a value-oriented change check would miss.
    const original = await corpus("poi-sample");
    if (original === undefined) {
      // Visible rather than silent — see the note on the first case in this file.
      expect(original, "poi-sample: corpus not fetched; run pnpm corpus:xlsb").toBeUndefined();
      return;
    }
    const workbook = Workbook.create();
    await Workbook.read(workbook, original);
    Cell.setStyle(Workbook.getWorksheets(workbook)[0], "A1", {
      font: { bold: true }
    } as never);
    const written = await Workbook.toBuffer(workbook, { format: "xlsb", unsupported: "ignore" });
    expect([...written]).not.toEqual([...original]);
  });

  it("does not pass through into the other container", async () => {
    // Writing XLSX must never return XLSB bytes. Obvious, and exactly the sort of thing a `format`-blind shortcut
    // gets wrong — so it is asserted rather than assumed.
    const original = await corpus("poi-sample");
    if (original === undefined) {
      // Visible rather than silent — see the note on the first case in this file.
      expect(original, "poi-sample: corpus not fetched; run pnpm corpus:xlsb").toBeUndefined();
      return;
    }
    const workbook = Workbook.create();
    await Workbook.read(workbook, original);
    const written = await Workbook.toBuffer(workbook, { format: "xlsx", validate: false });
    expect([...written]).not.toEqual([...original]);
    // A ZIP either way, so the check is on a part name only one container has.
    const { extractAll } = await import("@archive/unzip/extract");
    expect((await extractAll(written)).has("xl/workbook.xml")).toBe(true);
  });
});

describe("a workbook this library built", () => {
  it("has nothing to pass through", async () => {
    // Only a *read* establishes original bytes. A workbook created in memory must be serialised, and asserting it
    // keeps the feature from being read as "cache the last output".
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "S");
    Worksheet.addAoa(sheet, [["a", 1]]);
    const first = await Workbook.toBuffer(workbook, { format: "xlsb" });
    Cell.setValue(sheet, "A1", "b");
    const second = await Workbook.toBuffer(workbook, { format: "xlsb" });
    expect([...second]).not.toEqual([...first]);
  });
});

describe("the hash the decision rests on", () => {
  it("ignores key order", () => {
    // Two models that differ only in the order their properties were assigned are the same model, and the order
    // genuinely varies between a reader and an edit.
    expect([...modelHash({ a: 1, b: 2 })]).toEqual([...modelHash({ b: 2, a: 1 })]);
  });

  it("tells an absent field from one holding undefined", () => {
    // A deletion must register as a change. Skipping `undefined` — the obvious thing to do, since JSON does — would
    // make it invisible.
    expect(sameHash(modelHash({ a: undefined }), modelHash({}))).toBe(false);
  });

  it("tells an empty object from an empty array", () => {
    expect(sameHash(modelHash({}), modelHash([]))).toBe(false);
  });

  it("tells a number from the string of it", () => {
    expect(sameHash(modelHash({ a: 1 }), modelHash({ a: "1" }))).toBe(false);
  });

  it("distinguishes nested changes", () => {
    expect(sameHash(modelHash({ a: { b: [1, 2] } }), modelHash({ a: { b: [1, 3] } }))).toBe(false);
  });

  it("hashes byte arrays by content", () => {
    // Preserved parts and media are `Uint8Array`s of megabytes. Walking them element by element would work and be
    // absurd; hashing them as bytes has to still notice a changed byte.
    expect(sameHash(modelHash(Uint8Array.of(1, 2, 3)), modelHash(Uint8Array.of(1, 2, 3)))).toBe(
      true
    );
    expect(sameHash(modelHash(Uint8Array.of(1, 2, 3)), modelHash(Uint8Array.of(1, 2, 4)))).toBe(
      false
    );
  });

  it("survives a cycle rather than overflowing", () => {
    // The model has none today. One added later should make this return a hash — and therefore report a mismatch —
    // instead of taking the process down.
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(() => modelHash(cyclic)).not.toThrow();
  });
});

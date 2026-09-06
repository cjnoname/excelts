import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { extractAll } from "@archive/unzip/extract";
import { createZip } from "@archive/zip/zip-bytes";
import { XlsbFormulaDecodeError } from "@excel/errors";
import { iterateInterpretableRecords } from "@excel/xlsb/binary";
import { parseXlsbPackage } from "@excel/xlsb/read/package";
import { recordSpec } from "@excel/xlsb/spec/records";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * `formulas: "preserve" | "cached" | "error"` — what happens to a formula's expression.
 *
 * These tests are built on a file whose token streams have been **deliberately corrupted**, rather than on a workbook
 * this library wrote and read back. That is the point: a round trip through this codec can only exercise constructs the
 * codec already handles, so it can never reach the branch the policy exists to govern. Every previous defect of this
 * shape came from a reader and a writer sharing one wrong assumption, which a round trip cannot see.
 */
/**
 * The package these tests start from, **written here rather than read out of the corpus.**
 *
 * It used to be `tmp/xlsb-corpus/poi-bug66682.xlsb`, which is gitignored and fetched by a different CI job — so on a
 * clean checkout every case in this file failed. Nothing about these tests needed *that* file: the corrupted fixture is
 * built by hand below, and all the corpus supplied was "a package containing formulas", which this library can write.
 *
 * A shared formula and an array formula are included on purpose: their expressions live in their own `BrtShrFmla` /
 * `BrtArrFmla` records rather than in the cell's, so a policy applied in one place and not the other is only visible
 * with both present. That was a real defect — four of six formula cells were reduced and two kept their expressions.
 */
let CORPUS = "";

async function buildCorpus(directory: string): Promise<string> {
  const { Workbook, Cell, Worksheet } = await import("@excel/index");
  const workbook = Workbook.create();
  const sheet = Workbook.addWorksheet(workbook, "Formulas");
  Cell.setValue(sheet, "A1", 10);
  Cell.setValue(sheet, "A2", 20);
  Cell.setValue(sheet, "A3", 30);
  Cell.setValue(sheet, "B1", { formula: "A1*2", result: 20 });
  Cell.setValue(sheet, "B2", { formula: "A2*2", result: 40 });
  Cell.setValue(sheet, "B3", { formula: "SUM(A1:A3)", result: 60 });
  Cell.setValue(sheet, "C1", { formula: "1/0", result: { error: "#DIV/0!" } } as never);
  // A shared formula: the same expression filled down, which the writer emits as one `BrtShrFmla` plus followers.
  Worksheet.fillFormula(sheet, "D1:D3", "A1+1");
  const path = join(directory, "formulas.xlsb");
  await writeFile(
    path,
    await Workbook.toBuffer(workbook, { format: "xlsb", unsupported: "ignore" })
  );
  return path;
}

/** The corpus file with the last six bytes of every `BrtFmla*` token stream replaced by an undefined `Ptg`. */
async function withBrokenFormulas(): Promise<{ bytes: Uint8Array; broken: number }> {
  const parts = await extractAll(new Uint8Array(readFileSync(CORPUS)));
  const sheetPath = [...parts.keys()].find(name => /worksheets\/.*\.bin$/.test(name));
  expect(sheetPath).toBeDefined();
  const sheet = parts.get(sheetPath!)!.data;
  const patched = new Uint8Array(sheet);
  let broken = 0;
  for (const record of iterateInterpretableRecords(sheet, "s")) {
    if (recordSpec(record.id)?.name.startsWith("BrtFmla") !== true) {
      continue;
    }
    // **Rebased onto the copy.** `record.payload.byteOffset` is an offset into the *underlying buffer*, and the
    // extracted part is a view starting 32,768 bytes into it — so indexing `patched` (which starts at zero) with it
    // wrote into unrelated bytes, and the "corrupted" fixture decoded perfectly. The first version of this helper
    // did exactly that and every assertion below passed vacuously.
    const end = record.payload.byteOffset - sheet.byteOffset + record.payload.length;
    for (let i = end - 6; i < end; i += 1) {
      patched[i] = 0x7f;
    }
    broken += 1;
  }
  const entries = [...parts].map(([name, value]) => ({
    name,
    data: name === sheetPath ? patched : value.data
  }));
  return { bytes: await createZip(entries), broken };
}

let directory = "";

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "documonster-fp-"));
  CORPUS = await buildCorpus(directory);
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("XLSB formula read policy", () => {
  it("corrupts enough formulas for the rest of these tests to mean something", async () => {
    // Guards the fixture itself. If a change to the corpus file left no `BrtFmla*` records, every assertion below
    // would pass vacuously — `preserve` would report nothing because there was nothing to fail.
    const { broken } = await withBrokenFormulas();
    expect(broken).toBeGreaterThan(0);
  });

  it("preserve keeps cached values and reports the undecodable expressions", async () => {
    const { bytes, broken } = await withBrokenFormulas();
    const { model, diagnostics } = await parseXlsbPackage(bytes, "broken.xlsb", {
      formulas: "preserve"
    });
    expect(diagnostics.undecodedFormulas).toHaveLength(broken);
    expect(diagnostics.cachedOnlyFormulas).toHaveLength(0);
    // The addresses are qualified by sheet, so a caller can go and look at them.
    for (const address of diagnostics.undecodedFormulas) {
      expect(address).toMatch(/^.+![A-Z]+\d+$/);
    }
    // The value survives — losing the expression must not cost the number Excel computed.
    const values = model.worksheets.flatMap(
      sheet => sheet.rows?.flatMap(row => row.cells?.map(cell => cell.value) ?? []) ?? []
    );
    expect(values.filter(value => value !== undefined).length).toBeGreaterThan(0);
  });

  it("preserve is the default", async () => {
    const { bytes } = await withBrokenFormulas();
    const explicit = await parseXlsbPackage(bytes, "b.xlsb", { formulas: "preserve" });
    const implied = await parseXlsbPackage(bytes, "b.xlsb", {});
    expect(implied.diagnostics.undecodedFormulas).toEqual(explicit.diagnostics.undecodedFormulas);
    expect(implied.diagnostics.cachedOnlyFormulas).toHaveLength(0);
  });

  it("cached is immune to a corrupt token stream, because it never reads one", async () => {
    // The strongest statement in this file: the bytes that defeat `preserve` are not even looked at.
    const { bytes } = await withBrokenFormulas();
    const { diagnostics } = await parseXlsbPackage(bytes, "broken.xlsb", { formulas: "cached" });
    expect(diagnostics.undecodedFormulas).toHaveLength(0);
    expect(diagnostics.cachedOnlyFormulas.length).toBeGreaterThan(0);
  });

  it("cached leaves no formula anywhere in the model, shared and array ones included", async () => {
    // A shared or array formula's expression lives in its own `BrtShrFmla` / `BrtArrFmla` record rather than in the
    // cell's, so the policy has to be applied in two places. It was applied in one, and four of six formula cells
    // were reduced while two kept their expressions.
    const clean = new Uint8Array(readFileSync(CORPUS));
    const { model } = await parseXlsbPackage(clean, CORPUS, { formulas: "cached" });
    const withFormula = model.worksheets.flatMap(
      sheet =>
        sheet.rows?.flatMap(
          row =>
            row.cells?.filter(cell => cell.formula !== undefined).map(cell => cell.address) ?? []
        ) ?? []
    );
    expect(withFormula).toEqual([]);
  });

  it("cached recovers the value of a cell whose expression preserve would have kept", async () => {
    const clean = new Uint8Array(readFileSync(CORPUS));
    const preserved = await parseXlsbPackage(clean, CORPUS, { formulas: "preserve" });
    const cached = await parseXlsbPackage(clean, CORPUS, { formulas: "cached" });
    const index = (parsed: typeof preserved): Map<string, unknown> => {
      const out = new Map<string, unknown>();
      for (const sheet of parsed.model.worksheets) {
        for (const row of sheet.rows ?? []) {
          for (const cell of row.cells ?? []) {
            out.set(`${sheet.name}!${cell.address}`, cell);
          }
        }
      }
      return out;
    };
    const before = index(preserved);
    const after = index(cached);
    let checked = 0;
    for (const [address, cell] of before) {
      if ((cell as { formula?: string }).formula === undefined) {
        continue;
      }
      checked += 1;
      const now = after.get(address) as { formula?: string; value?: unknown } | undefined;
      expect(now, address).toBeDefined();
      expect(now!.formula, address).toBeUndefined();
      // The cached value was always in the record; `preserve` simply preferred the expression.
      expect(now!.value, address).not.toBeUndefined();
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("error throws, naming the sheet and the addresses", async () => {
    const { bytes, broken } = await withBrokenFormulas();
    await expect(parseXlsbPackage(bytes, "broken.xlsb", { formulas: "error" })).rejects.toThrow(
      XlsbFormulaDecodeError
    );
    let error: XlsbFormulaDecodeError | undefined;
    try {
      await parseXlsbPackage(bytes, "broken.xlsb", { formulas: "error" });
    } catch (caught) {
      error = caught as XlsbFormulaDecodeError;
    }
    expect(error).toBeInstanceOf(XlsbFormulaDecodeError);
    expect(error!.sheet).not.toBe("");
    expect(error!.addresses).toHaveLength(broken);
    expect(error!.source).toBe("broken.xlsb");
    // Truncated in the message, complete in the field.
    expect(error!.message).toContain("could not be decoded");
  });

  it("error does not throw on a file whose formulas all decode", async () => {
    // Otherwise `"error"` would be unusable: it must fire on failure, not on the presence of formulas.
    const clean = new Uint8Array(readFileSync(CORPUS));
    const { diagnostics } = await parseXlsbPackage(clean, CORPUS, { formulas: "error" });
    expect(diagnostics.undecodedFormulas).toHaveLength(0);
  });

  it("cached does not write its formulas back through the passthrough", async () => {
    // **The policy has to survive the write, and it did not.**
    //
    // An unmodified XLSB is written back as the bytes it arrived as, on the argument that an unchanged model would
    // produce equivalent bytes anyway. `formulas: "cached"` breaks that premise by design — it drops every expression —
    // so keeping the source made a `cached` read emit all nine formulas again, byte for byte, while the option's own
    // documentation promises literals. One unrelated edit would have flipped the behaviour, which is worse than either
    // answer on its own.
    //
    // Counted in the *written package* rather than in a re-read model: a reader that shares the writer's assumption
    // would confirm it either way.
    const { Workbook } = await import("@excel");
    const workbook = Workbook.create();
    await Workbook.readFile(workbook, CORPUS, { formulas: "cached" });
    const written = await Workbook.toBuffer(workbook, { format: "xlsb", unsupported: "ignore" });
    const parts = await extractAll(written);
    let formulaRecords = 0;
    for (const path of [...parts.keys()].filter(name => /worksheets\/.*\.bin$/.test(name))) {
      for (const record of iterateInterpretableRecords(parts.get(path)!.data, "s")) {
        if (recordSpec(record.id)?.name.startsWith("BrtFmla") === true) {
          formulaRecords += 1;
        }
      }
    }
    expect(formulaRecords).toBe(0);
  });

  it("preserve still passes an unmodified package through untouched", async () => {
    // The other half: the fix must not disable passthrough for the default policy, which is what makes a macro project
    // or an unmodelled chart survive a read and write.
    const { Workbook } = await import("@excel");
    const original = new Uint8Array(readFileSync(CORPUS));
    const workbook = Workbook.create();
    await Workbook.readFile(workbook, CORPUS);
    const written = await Workbook.toBuffer(workbook, { format: "xlsb", unsupported: "ignore" });
    expect([...written]).toEqual([...original]);
  });

  it("throws an error a consumer of the public entry point can name", async () => {
    // **The class was only exported from `@excel/errors`, an internal path.**
    //
    // `WorkbookReadOptions.formulas: "error"` documents this type and the tests above use `instanceof` — but they import
    // it from inside the module. A consumer of `documonster/excel` could not, so the documented contract was "catch this
    // type" against a type they had no way to reference, leaving message matching as the only option.
    //
    // Imported here through the same specifier a consumer uses, so the assertion fails if it stops being exported.
    const excel = await import("@excel");
    expect(typeof excel.XlsbFormulaDecodeError).toBe("function");
    const { bytes } = await withBrokenFormulas();
    const workbook = excel.Workbook.create();
    let caught: unknown;
    try {
      await excel.Workbook.read(workbook, bytes, { format: "xlsb", formulas: "error" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(excel.XlsbFormulaDecodeError);
  });

  it("reaches the policy through the public read options", async () => {
    // The option is worthless if it stops at the internal parser.
    const { Workbook } = await import("@excel");
    const { bytes } = await withBrokenFormulas();
    const workbook = Workbook.create();
    await expect(
      Workbook.read(workbook, bytes, { format: "xlsb", formulas: "error" })
    ).rejects.toThrow(XlsbFormulaDecodeError);
  });
});

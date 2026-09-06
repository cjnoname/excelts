/**
 * Sheet protection, print areas and print titles.
 *
 * These three were on the loss list for the same underlying reason and came off it together: none of
 * them needed a new record. `BrtSheetProtection` was already written for every sheet — as an opaque byte
 * pattern whose fields nobody had interpreted — and print areas are not records at all but `_xlnm.*`
 * defined names, which needed sheet-local scope that the name writer refused to emit.
 */
import { extractAll } from "@archive/unzip/extract";
import { Cell, DefinedNames, Workbook, Worksheet } from "@excel";
import { iterateInterpretableRecords } from "@excel/xlsb/binary";
import { readSheetProtection, sheetProtection } from "@excel/xlsb/defaults";
import { recordSpec } from "@excel/xlsb/spec/records";
import { describe, expect, it } from "vitest";

/** A workbook's first sheet, after a round trip through XLSB. */
async function roundTrip(
  build: (workbook: ReturnType<typeof Workbook.create>) => Promise<void> | void
) {
  const workbook = Workbook.create();
  await build(workbook);
  const bytes = await Workbook.toBuffer(workbook, { format: "xlsb", unsupported: "ignore" });
  const reopened = Workbook.create();
  await Workbook.read(reopened, bytes);
  return Workbook.getModel(reopened);
}

describe("BrtSheetProtection", () => {
  it("is 66 bytes: a u16 verifier and sixteen 4-byte Booleans", () => {
    // `2 + 16 × 4`. This record was written as an opaque blob because an earlier attempt to assemble it
    // landed on 64 — the two missing bytes are `protpwd`, which is a `u16` and comes first.
    expect(sheetProtection({ sheet: true })).toHaveLength(66);
    expect(sheetProtection()).toHaveLength(66);
  });

  it("writes Excel's unprotected default when nothing is configured", () => {
    // Excel emits this record for every sheet whether protected or not, and the four `01` bytes sit at
    // offsets 6, 10, 46 and 62 — `fObjects`, `fScenarios`, `fSelLockedCells`, `fSelUnlockedCells`. Those
    // offsets were established from Excel's output before the field layout was; they agree.
    const bytes = sheetProtection();
    const set = [...bytes.entries()].filter(([, value]) => value !== 0).map(([offset]) => offset);
    expect(set).toEqual([6, 10, 46, 62]);
  });

  it("reports an unprotected sheet as unprotected, not as configured", () => {
    // `fLocked` is 0, and the specification then declares every field after it undefined. Returning a
    // protection object would make every sheet in every workbook look deliberately configured.
    expect(readSheetProtection(sheetProtection(), "test")).toBeUndefined();
    expect(readSheetProtection(sheetProtection({ sheet: false }), "test")).toBeUndefined();
  });

  it("round-trips all sixteen permissions, including the inverted ones", () => {
    const configured = {
      sheet: true,
      objects: false,
      scenarios: false,
      formatCells: true,
      formatColumns: true,
      formatRows: false,
      insertColumns: true,
      insertRows: false,
      insertHyperlinks: true,
      deleteColumns: false,
      deleteRows: true,
      selectLockedCells: false,
      sort: true,
      autoFilter: false,
      pivotTables: true,
      selectUnlockedCells: false
    } as const;
    expect(readSheetProtection(sheetProtection(configured), "test")).toEqual(configured);
  });

  it("defaults an unlisted permission to Excel's default rather than to false", () => {
    // A caller who protected a sheet without naming sixteen permissions did not mean to forbid
    // selecting a cell. `false` for everything would produce a sheet nobody can click in.
    const back = readSheetProtection(sheetProtection({ sheet: true }), "test");
    expect(back).toMatchObject({
      selectLockedCells: true,
      selectUnlockedCells: true,
      objects: true,
      scenarios: true,
      formatCells: false
    });
  });

  it("survives a truncated payload", () => {
    expect(readSheetProtection(new Uint8Array(3), "test")).toBeUndefined();
  });

  it("round-trips through a workbook", async () => {
    const model = await roundTrip(async workbook => {
      const sheet = Workbook.addWorksheet(workbook, "S");
      Cell.setValue(sheet, "A1", 1);
      await Worksheet.protect(sheet, "", {
        formatCells: true,
        insertRows: true,
        selectLockedCells: false
      } as never);
    });
    expect(model.worksheets[0].sheetProtection).toMatchObject({
      sheet: true,
      formatCells: true,
      insertRows: true,
      selectLockedCells: false
    });
  });

  it("leaves protpwd at zero and puts the password in the Iso record", async () => {
    // This test used to assert the opposite — that a password was refused, because `protpwd` is a 16-bit
    // verifier and a SHA-512 hash cannot be reversed into one. Both facts are true and neither mattered:
    // `BrtSheetProtectionIso` carries the hash itself, so nothing has to be reversed. The record that was
    // examined was simply the wrong one, and this test agreed with the mistake for as long as it existed.
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "S");
    Cell.setValue(sheet, "A1", 1);
    await Worksheet.protect(sheet, "secret", {} as never);
    await expect(Workbook.toBuffer(workbook, { format: "xlsb" })).resolves.toBeDefined();
  });
});

describe("print areas and print titles", () => {
  it("round-trips a print area", async () => {
    const model = await roundTrip(workbook => {
      const sheet = Workbook.addWorksheet(workbook, "Foo");
      Cell.setValue(sheet, "A1", 1);
      // Read the model once and hand the *same* object back. `getModel` returns a fresh snapshot, so
      // mutating one copy and passing another discards the edit.
      const current = Workbook.getModel(workbook);
      (current.worksheets[0] as { pageSetup?: unknown }).pageSetup = { printArea: "A1:C5" };
      Workbook.setModel(workbook, current);
    });
    expect(model.worksheets[0].pageSetup?.printArea).toBe("Foo!$A$1:$C$5");
  });

  it("round-trips print titles on each axis and both", async () => {
    for (const setup of [
      { printTitlesRow: "1:1" },
      { printTitlesColumn: "A:A" },
      { printTitlesRow: "1:2", printTitlesColumn: "A:B" }
    ] as const) {
      const model = await roundTrip(workbook => {
        const sheet = Workbook.addWorksheet(workbook, "Foo");
        Cell.setValue(sheet, "A1", 1);
        const current = Workbook.getModel(workbook);
        (current.worksheets[0] as { pageSetup?: unknown }).pageSetup = { ...setup };
        Workbook.setModel(workbook, current);
      });
      const back = model.worksheets[0].pageSetup ?? {};
      expect(
        { printTitlesRow: back.printTitlesRow, printTitlesColumn: back.printTitlesColumn },
        JSON.stringify(setup)
      ).toMatchObject(setup);
    }
  });

  it("keeps _xlnm names out of the caller's defined-name list", async () => {
    // They are how Excel *stores* a print area, not names a user made. Adding them as ordinary names
    // would put `_xlnm.Print_Area` in the list while `pageSetup.printArea` stayed empty — the feature
    // absent and its artefact visible.
    const model = await roundTrip(workbook => {
      const sheet = Workbook.addWorksheet(workbook, "Foo");
      Cell.setValue(sheet, "A1", 1);
      const current = Workbook.getModel(workbook);
      (current.worksheets[0] as { pageSetup?: unknown }).pageSetup = { printArea: "A1:B2" };
      Workbook.setModel(workbook, current);
    });
    expect(model.definedNames.map(entry => entry.name)).not.toContain("_xlnm.Print_Area");
  });

  it("round-trips a sheet-local defined name", async () => {
    const model = await roundTrip(workbook => {
      Cell.setValue(Workbook.addWorksheet(workbook, "S1"), "A1", 1);
      Cell.setValue(Workbook.addWorksheet(workbook, "S2"), "A1", 1);
      DefinedNames.add(Workbook.getDefinedNames(workbook), "S2!$A$1", "Local");
    });
    expect(model.definedNames.some(entry => entry.name === "Local")).toBe(true);
  });
});

describe("the protection password, which the legacy record cannot carry", () => {
  /** A workbook with both a sheet and a workbook password, written to XLSB and read back. */
  async function roundTrip(): Promise<{
    sheetBefore: Record<string, unknown>;
    sheetAfter: Record<string, unknown> | undefined;
    bookBefore: Record<string, unknown> | undefined;
    bookAfter: Record<string, unknown> | undefined;
    bytes: Uint8Array;
  }> {
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "S");
    Cell.setValue(sheet, "A1", 1);
    await Worksheet.protect(sheet, "secret", { formatCells: true });
    await Workbook.protect(workbook, "bookpass", { lockStructure: true });
    const sheetBefore = Worksheet.getModel(sheet).sheetProtection as Record<string, unknown>;
    const bookBefore = Workbook.getModel(workbook).protection as
      | Record<string, unknown>
      | undefined;
    const bytes = await Workbook.toBuffer(workbook, { format: "xlsb" });
    const reopened = Workbook.create();
    await Workbook.read(reopened, bytes);
    return {
      sheetBefore,
      sheetAfter: Worksheet.getModel(Workbook.getWorksheet(reopened, "S")!).sheetProtection as
        | Record<string, unknown>
        | undefined,
      bookBefore,
      bookAfter: Workbook.getModel(reopened).protection as Record<string, unknown> | undefined,
      bytes
    };
  }

  it("round-trips the hash, salt, algorithm and spin count for a sheet", async () => {
    // The hash is *copied*, not computed — which is the whole reason this works and the reason the previous
    // claim that it was impossible was wrong. `protpwd` is a 16-bit verifier and a SHA-512 hash cannot be
    // reversed into one, both true; `BrtSheetProtectionIso` simply carries the hash instead.
    const { sheetBefore, sheetAfter } = await roundTrip();
    expect(sheetAfter?.algorithmName).toBe(sheetBefore.algorithmName);
    expect(sheetAfter?.hashValue).toBe(sheetBefore.hashValue);
    expect(sheetAfter?.saltValue).toBe(sheetBefore.saltValue);
    expect(sheetAfter?.spinCount).toBe(sheetBefore.spinCount);
    // And the permissions still arrive, from the legacy record.
    expect(sheetAfter?.formatCells).toBe(true);
    expect(sheetAfter?.sheet).toBe(true);
  });

  it("round-trips the same four for a workbook", async () => {
    const { bookBefore, bookAfter } = await roundTrip();
    expect(bookAfter?.algorithmName).toBe(bookBefore?.algorithmName);
    expect(bookAfter?.hashValue).toBe(bookBefore?.hashValue);
    expect(bookAfter?.saltValue).toBe(bookBefore?.saltValue);
    expect(bookAfter?.spinCount).toBe(bookBefore?.spinCount);
    expect(bookAfter?.lockStructure).toBe(true);
  });

  it("puts each Iso record immediately before its legacy record", async () => {
    // MS-XLSB requires the pairing, in that order. It is also the only ordering authority available here,
    // since no corpus workbook has a password — so it is asserted rather than assumed.
    const { bytes } = await roundTrip();
    const parts = await extractAll(bytes);
    const namesIn = (path: string): string[] =>
      [...iterateInterpretableRecords(parts.get(path)!.data, "s")]
        .map(entry => recordSpec(entry.id)?.name ?? String(entry.id))
        .filter(name => /Protection/.test(name));
    const sheetPath = [...parts.keys()].find(name => /worksheets\/sheet\d+\.bin$/.test(name))!;
    expect(namesIn(sheetPath)).toEqual(["BrtSheetProtectionIso", "BrtSheetProtection"]);
    expect(namesIn("xl/workbook.bin")).toEqual(["BrtBookProtectionIso", "BrtBookProtection"]);
  });

  it("keeps protpwd at zero, as the pairing requires", async () => {
    // With an Iso record present the legacy verifier MUST be 0. A non-zero value there would be a second,
    // contradictory password.
    const { bytes } = await roundTrip();
    const parts = await extractAll(bytes);
    const sheetPath = [...parts.keys()].find(name => /worksheets\/sheet\d+\.bin$/.test(name))!;
    const legacy = [...iterateInterpretableRecords(parts.get(sheetPath)!.data, "s")].find(
      entry => recordSpec(entry.id)?.name === "BrtSheetProtection"
    )!;
    expect(
      new DataView(legacy.payload!.buffer, legacy.payload!.byteOffset).getUint16(0, true)
    ).toBe(0);
  });

  it("carries identical permission values in both records", async () => {
    // The specification requires all sixteen to match. They come from one shared table for that reason —
    // two copies of a sixteen-entry list with defaults attached is the reliable way to get two that differ.
    const { bytes } = await roundTrip();
    const parts = await extractAll(bytes);
    const sheetPath = [...parts.keys()].find(name => /worksheets\/sheet\d+\.bin$/.test(name))!;
    const records = [...iterateInterpretableRecords(parts.get(sheetPath)!.data, "s")];
    const iso = records.find(
      entry => recordSpec(entry.id)?.name === "BrtSheetProtectionIso"
    )!.payload!;
    const legacy = records.find(
      entry => recordSpec(entry.id)?.name === "BrtSheetProtection"
    )!.payload!;
    const isoView = new DataView(iso.buffer, iso.byteOffset);
    const legacyView = new DataView(legacy.buffer, legacy.byteOffset);
    for (let index = 0; index < 16; index += 1) {
      // The Iso record starts with a spin count; the legacy one with a 16-bit verifier.
      expect(isoView.getUint32(4 + index * 4, true)).toBe(
        legacyView.getUint32(2 + index * 4, true)
      );
    }
  });

  it("writes no Iso record when a sheet is protected without a password", async () => {
    // A protected sheet with no password is protected but not password-protected, and an `IsoPasswordData`
    // whose hash is empty is not a legal thing to announce.
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "S");
    Cell.setValue(sheet, "A1", 1);
    await Worksheet.protect(sheet, undefined as never, { formatCells: true });
    const parts = await extractAll(await Workbook.toBuffer(workbook, { format: "xlsb" }));
    const sheetPath = [...parts.keys()].find(name => /worksheets\/sheet\d+\.bin$/.test(name))!;
    const names = [...iterateInterpretableRecords(parts.get(sheetPath)!.data, "s")]
      .map(entry => recordSpec(entry.id)?.name ?? String(entry.id))
      .filter(name => /Protection/.test(name));
    expect(names).toEqual(["BrtSheetProtection"]);
  });

  it("reports no loss for a password it now writes", async () => {
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "S");
    Cell.setValue(sheet, "A1", 1);
    await Worksheet.protect(sheet, "secret", {});
    await Workbook.protect(workbook, "bookpass", { lockStructure: true });
    await expect(Workbook.toBuffer(workbook, { format: "xlsb" })).resolves.toBeDefined();
  });
});

/**
 * Where the workbook protection records go.
 *
 * **Verified against Excel, and the only thing that was ever wrong here was the position.** The pair sat
 * after `BrtCalcProp`, near the end of the stream, and Excel refused the file outright — no repair, no
 * removed feature, just a workbook that would not open. Every field was correct: the record id, the
 * 128-byte `BrtBookProtectionIso` layout down to `szAlgName`, the `wFlags` agreement the specification
 * requires between the pair, and the legacy record's zeroed `protpwd` fields. Moving the two records to
 * immediately after `BrtWbProp` — where ISO/IEC 29500 puts `<workbookProtection>` — was the entire fix.
 *
 * Two probe files settled it: one with the Iso record deleted but the legacy record left in the old place
 * still failed, and one with both moved here opened. So it is the position of the *pair*, not anything
 * about the Iso record.
 *
 * This is asserted as an index comparison rather than a byte offset because it is an ordering rule, and an
 * ordering rule is exactly what no amount of field checking will catch.
 */
describe("workbook protection record order", () => {
  it("puts the protection pair between BrtWbProp and BrtBeginBookViews", async () => {
    const workbook = Workbook.create();
    Cell.setValue(Workbook.addWorksheet(workbook, "S"), "A1", 1);
    await Workbook.protect(workbook, "b00kpass", { lockStructure: true });
    const parts = await extractAll(await Workbook.toBuffer(workbook, { format: "xlsb" }));
    const names = [...iterateInterpretableRecords(parts.get("xl/workbook.bin")!.data, "w")].map(
      entry => recordSpec(entry.id)?.name
    );

    const wbProp = names.indexOf("BrtWbProp");
    const iso = names.indexOf("BrtBookProtectionIso");
    const legacy = names.indexOf("BrtBookProtection");
    const bookViews = names.indexOf("BrtBeginBookViews");
    const calcProp = names.indexOf("BrtCalcProp");

    expect(iso).toBe(wbProp + 1);
    // The specification's own MUST: the Iso record is immediately followed by the legacy one.
    expect(legacy).toBe(iso + 1);
    expect(legacy).toBeLessThan(bookViews);
    // The old position, which Excel would not open.
    expect(legacy).toBeLessThan(calcProp);
  });
});

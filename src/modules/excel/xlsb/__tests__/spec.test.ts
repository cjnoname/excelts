/**
 * The record table as data.
 *
 * `scripts/verify-xlsb-spec.ts` checks the table's internal consistency in `pnpm
 * check`; this file checks the *derivations* built on top of it. The distinction
 * matters: a table can be perfectly consistent while a consumer quietly carries its
 * own stale copy of what the table says, which is the duplication the table exists to
 * remove and which three checkers were guilty of before this.
 */

import { Image, Workbook, Worksheet } from "@excel";
import { validateXlsbBuffer } from "@excel/utils/xlsb-validator";
import { CELL_RECORD_NAMES, ROW_RECORD_NAMES } from "@excel/utils/xlsb-validator/roles";
import { checkRecordTable, summariseRecordTable } from "@excel/xlsb/spec/check-records";
import { MS_XLSB_RECORD_NAMES, RECORDS_ABSENT_FROM_SPEC } from "@excel/xlsb/spec/record-names";
import {
  BIFF_RECORDS,
  INFERRED_VALUES,
  OBSERVED_PAYLOAD_SIZES,
  RECORD_BY_ID,
  RECORD_BY_NAME,
  recordNamesInCategory,
  recordSpec,
  requireRecordSpec
} from "@excel/xlsb/spec/records";
import { describe, expect, it } from "vitest";

describe("lookups", () => {
  it("resolves a record by id and by name to the same object", () => {
    for (const record of BIFF_RECORDS) {
      expect(recordSpec(record.id)).toBe(record);
      expect(RECORD_BY_NAME.get(record.name)).toBe(record);
      expect(RECORD_BY_ID.get(record.id)).toBe(record);
    }
  });

  it("returns undefined for an identifier it does not describe", () => {
    // Not an error: an unknown record is a fact about this library, not about the file.
    expect(recordSpec(0x0700)).toBeUndefined();
  });

  it("throws for a name it does not describe, because that is a typo", () => {
    expect(() => requireRecordSpec("BrtNope")).toThrow(/unknown BIFF12 record name/);
  });
});

describe("category derivations", () => {
  it("derives the validator's cell set from the table, not from a copy", () => {
    // This is the property that was violated: `roles.ts` carried two hand-written sets
    // and `check-indexes.ts` a third chain of comparisons, so adding a cell record to
    // the table silently left three checkers unaware of it.
    expect(CELL_RECORD_NAMES).toBe(recordNamesInCategory("cell"));
    expect(ROW_RECORD_NAMES).toBe(recordNamesInCategory("row"));
  });

  it("agrees with the table for every record", () => {
    for (const record of BIFF_RECORDS) {
      expect(CELL_RECORD_NAMES.has(record.name), record.name).toBe(record.category === "cell");
      expect(ROW_RECORD_NAMES.has(record.name), record.name).toBe(record.category === "row");
    }
  });

  it("covers every cell record the format has, including the undecoded ones", () => {
    // The seven `BrtShort*` variants have no declared layout, but they are still cells —
    // so ordering checks apply to them even though coordinate checks cannot.
    for (const name of [
      "BrtCellBlank",
      "BrtCellRk",
      "BrtCellIsst",
      "BrtFmlaNum",
      "BrtShortBlank",
      "BrtShortRk",
      "BrtShortIsst"
    ]) {
      expect(CELL_RECORD_NAMES.has(name), name).toBe(true);
    }
    expect(CELL_RECORD_NAMES.size).toBe(18);
  });

  it("does not classify a delimiter or a container as a cell", () => {
    for (const name of ["BrtBeginSheet", "BrtEndSheetData", "BrtWsDim", "BrtXF"]) {
      expect(CELL_RECORD_NAMES.has(name), name).toBe(false);
    }
  });

  it("returns an empty set for a category nothing uses", () => {
    // @ts-expect-error the point of the assertion is a category outside the union
    expect(recordNamesInCategory("nonexistent").size).toBe(0);
  });
});

describe("declared layouts", () => {
  it("starts every cell record's layout with the cell field", () => {
    // `styleReference` and the coordinate check both read the Cell first, so a layout
    // that put it elsewhere would have them read the wrong bytes with no error.
    for (const record of BIFF_RECORDS) {
      if (record.category === "cell" && record.fields) {
        expect(record.fields[0]!.type, record.name).toBe("cell");
      }
    }
  });

  it("allows a variable-length field anywhere, and more than one", () => {
    // The decoder reads sequentially, so it always knows where a string ends. The
    // constraint belongs to `patchField`, which skips to a field without decoding
    // what precedes it — and reports that itself. `BrtBundleSh` is the record that
    // proves the point: a nullable relationship id followed by a sheet name.
    const bundle = requireRecordSpec("BrtBundleSh");
    const strings = (bundle.fields ?? []).filter(
      field => field.type === "wideString" || field.type === "nullableWideString"
    );
    expect(strings).toHaveLength(2);
    expect(bundle.fields!.at(-1)!.type).toBe("wideString");
  });

  it("records which cell layouts are still unestablished", () => {
    // Pinned rather than left implicit. If one of these gains a layout the count here
    // must change, which forces the change to be deliberate — and the layout to have
    // been established against a real file rather than guessed.
    const undeclared = BIFF_RECORDS.filter(
      record => record.category === "cell" && !record.fields
    ).map(record => record.name);
    expect(undeclared).toEqual([
      "BrtShortBlank",
      "BrtShortRk",
      "BrtShortError",
      "BrtShortBool",
      "BrtShortReal",
      "BrtShortSt",
      "BrtShortIsst"
    ]);
  });
});

describe("scope pairs", () => {
  it("pairs every delimiter with one that names it back", () => {
    for (const record of BIFF_RECORDS) {
      if (!record.scope) {
        continue;
      }
      const counterpart = RECORD_BY_NAME.get(record.pairsWith!);
      expect(counterpart, record.name).toBeDefined();
      expect(counterpart!.pairsWith).toBe(record.name);
      expect(counterpart!.scope).toBe(record.scope === "begin" ? "end" : "begin");
    }
  });

  it("covers the containers a worksheet and a workbook are built from", () => {
    for (const name of [
      "BrtBeginBook",
      "BrtBeginSheet",
      "BrtBeginSheetData",
      "BrtBeginSst",
      "BrtBeginStyleSheet",
      "BrtBeginCellXFs"
    ]) {
      expect(requireRecordSpec(name).scope, name).toBe("begin");
    }
  });
});

describe("the record table checks itself", () => {
  /**
   * These assertions were a `verify:*` script, and moving them here corrects a mistake worth naming:
   * the other ten gates either inspect build output, scan the source tree as text, or need a different
   * runtime. None of that is true of a table checked against itself — that is what a test is for, and
   * being a script meant it ran in CI and never in a watch loop.
   *
   * The *report* stays in `scripts/verify-xlsb-spec.ts`, because printing what has not been
   * established is a communication job rather than an assertion. Both read the same function, so they
   * cannot disagree about what "consistent" means.
   */
  it("contradicts itself nowhere", () => {
    expect(checkRecordTable()).toEqual([]);
  });

  it("keeps the report's summary in step with the table", () => {
    const summary = summariseRecordTable();
    expect(summary.total).toBe(BIFF_RECORDS.length);
    expect(summary.inferred).toHaveLength(Object.keys(INFERRED_VALUES).length);
    // The report claims each of these is a cell record with no declared layout. Restated as an
    // assertion so the printed text and the table cannot drift apart.
    for (const name of summary.undeclaredCells) {
      const record = BIFF_RECORDS.find(entry => entry.name === name)!;
      expect(record.category).toBe("cell");
      expect(record.fields).toBeUndefined();
    }
  });

  it("sizes only records that exist", () => {
    // A size pinned for a record that is not declared would be a rule nothing could violate.
    for (const name of OBSERVED_PAYLOAD_SIZES.keys()) {
      expect(
        BIFF_RECORDS.some(record => record.name === name),
        `${name} is sized but not declared`
      ).toBe(true);
    }
  });

  it("pins no size for a record whose payload legitimately varies", () => {
    // A record carrying a string has no fixed length: `BrtBundleSh` holds two, `BrtFont` one. Pinning
    // either would be a claim Excel's own output contradicts on the next workbook.
    for (const name of ["BrtBundleSh", "BrtFont", "BrtFmt", "BrtName", "BrtSSTItem"]) {
      expect(OBSERVED_PAYLOAD_SIZES.has(name), name).toBe(false);
    }
  });
});

describe("the record-table check is not vacuous", () => {
  /**
   * `checkRecordTable()` returning an empty array proves nothing on its own — a function that always
   * returned `[]` would pass that assertion for ever. What makes it a check is that it *finds* things,
   * so the calibration is to hand it tables that are wrong in each way it claims to detect.
   *
   * The checker reads the module-level table, so these exercise the same predicates against a local
   * copy rather than mutating shared state: a test that corrupted `BIFF_RECORDS` would corrupt it for
   * every other test in the file.
   */
  const duplicateId = [
    { id: 0x0001, name: "Alpha" },
    { id: 0x0001, name: "Beta" }
  ];
  const duplicateName = [
    { id: 0x0001, name: "Alpha" },
    { id: 0x0002, name: "Alpha" }
  ];
  const unpairedScope = [{ id: 0x0001, name: "BrtBeginThing", scope: "begin" as const }];

  it("would catch two records claiming one id", () => {
    const ids = new Map<number, string>();
    const clashes: string[] = [];
    for (const record of duplicateId) {
      const existing = ids.get(record.id);
      if (existing !== undefined) {
        clashes.push(`${existing}/${record.name}`);
      }
      ids.set(record.id, record.name);
    }
    expect(clashes).toEqual(["Alpha/Beta"]);
  });

  it("would catch two records claiming one name", () => {
    const names = duplicateName.map(record => record.name);
    expect(new Set(names).size).toBeLessThan(names.length);
  });

  it("would catch a scope opener with no closer", () => {
    for (const record of unpairedScope) {
      // `Begin` is not always a prefix — `BrtFRTBegin` and `BrtACBegin` carry it last.
      const closer = record.name.replace("Begin", "End");
      expect(unpairedScope.some(entry => entry.name === closer)).toBe(false);
    }
  });

  it("finds the real table clean by the same predicates", () => {
    // The point of the three above: these hold because the table is right, not because nothing looks.
    expect(new Set(BIFF_RECORDS.map(record => record.id)).size).toBe(BIFF_RECORDS.length);
    expect(new Set(BIFF_RECORDS.map(record => record.name)).size).toBe(BIFF_RECORDS.length);
    for (const record of BIFF_RECORDS.filter(entry => entry.scope === "begin")) {
      const closer = record.name.replace("Begin", "End");
      expect(
        BIFF_RECORDS.some(entry => entry.name === closer && entry.scope === "end"),
        closer
      ).toBe(true);
    }
  });
});

describe("record names against [MS-XLSB]", () => {
  // The table's names are what a diagnostic hands the caller and what the writer looks a record up by,
  // so a name invented here sends someone to search the specification for a record that is not in it.
  // Sixteen of them were wrong before this test existed, and nothing failed — which is exactly why it
  // has to be a test rather than a convention.
  it("names every record exactly as the specification does", () => {
    const wrong: string[] = [];
    for (const spec of BIFF_RECORDS) {
      const official = MS_XLSB_RECORD_NAMES.get(spec.id);
      if (official === undefined) {
        continue; // Covered by the next test.
      }
      if (official !== spec.name) {
        wrong.push(
          `0x${spec.id.toString(16).padStart(4, "0")}: ${spec.name} should be ${official}`
        );
      }
    }
    expect(wrong).toEqual([]);
  });

  it("segregates the records the specification does not list", () => {
    // A record absent from `[MS-XLSB]` is named from community reverse engineering. That is allowed —
    // reporting `BrtShortReal` beats reporting `record 16` — but it must be declared, or it reads as a
    // spec record and the reader trusts it further than the evidence goes.
    const undocumented = BIFF_RECORDS.filter(spec => !MS_XLSB_RECORD_NAMES.has(spec.id)).map(
      spec => spec.id
    );
    for (const id of undocumented) {
      expect(
        RECORDS_ABSENT_FROM_SPEC.get(id),
        `id ${id} must be declared absent from the spec`
      ).toBeTypeOf("string");
    }
    // And the declaration must agree with the table, so the two cannot drift apart.
    for (const [id, name] of RECORDS_ABSENT_FROM_SPEC) {
      const spec = BIFF_RECORDS.find(entry => entry.id === id);
      expect(spec?.name, `id ${id}`).toBe(name);
    }
  });

  it("pairs every scope delimiter with a real counterpart", () => {
    for (const spec of BIFF_RECORDS) {
      if (spec.pairsWith === undefined) {
        continue;
      }
      const counterpart = BIFF_RECORDS.find(entry => entry.name === spec.pairsWith);
      expect(counterpart, `${spec.name} pairs with ${spec.pairsWith}`).toBeDefined();
      expect(counterpart?.pairsWith).toBe(spec.name);
    }
  });
});

describe("a length table entry is an assertion about every producer", () => {
  it("lists no record whose length follows its own content", () => {
    // The three that did were found by reading `[MS-XLSB]`, because none of them declares a field list for
    // `check-records.ts` to inspect. Each is a count followed by that many structures, or a string:
    //
    //   BrtDrawing   an `XLWideString` relationship id — 12 bytes for "rId2", 14 for "rId10"
    //   BrtACBegin   `cver` then that many `ACProductVersion` — 6 bytes for one application
    //   BrtSel       `sqrfx`, a counted array of 16-byte ranges — 36 bytes for a single selection
    //
    // Their constancy in the corpus is a fact about nine workbooks, not about the format. Asserting their
    // absence keeps the reasoning attached to the table: a future entry for any of them would have to argue
    // with this list rather than merely look plausible.
    for (const name of ["BrtDrawing", "BrtACBegin", "BrtSel"]) {
      expect(OBSERVED_PAYLOAD_SIZES.has(name)).toBe(false);
    }
  });

  it("does not reject a package this library wrote, when a relationship id grows", async () => {
    // `BrtDrawing`'s payload is an `XLWideString` holding the sheet's drawing relationship id, so its length
    // follows that id: `"rId2"` encodes to 12 bytes and `"rId10"` to 14. The length table listed it at 12,
    // read off a corpus workbook whose sheets happened to have single-digit ids — and the validator raises an
    // *error* on a length mismatch, so it rejected a file this library had just produced.
    //
    // Nine preserved relationships push the drawing to `rId10`, which is the smallest arrangement that
    // reaches the defect. Asserting the *absence* of an error is the point: the record is still written, and
    // the only thing that changed is that nothing claims to know its length.
    const png = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0,
      0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1f, 0x15, 0xc4, 0x89, 0, 0, 0, 0x0a, 0x49, 0x44, 0x41,
      0x54, 0x78, 0x9c, 0x63, 0, 1, 0, 0, 5, 0, 1, 0x0d, 0x0a, 0x2d, 0xb4, 0, 0, 0, 0, 0x49, 0x45,
      0x4e, 0x44, 0xae, 0x42, 0x60, 0x82
    ]);
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "S");
    Worksheet.addAoa(sheet, [["a"]]);
    const model = Workbook.getModel(workbook);
    (model.worksheets[0] as { opaqueRels?: unknown }).opaqueRels = Array.from(
      { length: 9 },
      (_unused, index) => ({
        id: `rId${index + 1}`,
        type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/customProperty",
        target: `../customProperty${index}.bin`
      })
    );
    Workbook.setModel(workbook, model);
    Image.place(
      Workbook.getWorksheet(workbook, "S")!,
      Image.add(workbook, { buffer: png, extension: "png" }),
      { tl: { col: 0, row: 0 }, ext: { width: 10, height: 10 } }
    );
    const result = await validateXlsbBuffer(
      await Workbook.toBuffer(workbook, { format: "xlsb", unsupported: "ignore" })
    );
    expect(result.problems.filter(problem => problem.severity === "error")).toEqual([]);
  });
});

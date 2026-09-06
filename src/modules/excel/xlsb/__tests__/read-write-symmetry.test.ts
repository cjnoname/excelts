/**
 * Read/write symmetry: a feature this writer emits must survive being read back and written again.
 *
 * **Why this exists.** `write/losses.ts` reports what a *write* drops, and it was built because the writer
 * silently discarded whole features. The reader had the mirror-image hole and nothing looked at it: a feature
 * the writer emits but the reader does not model is written correctly the first time, comes back absent from
 * the model, and is *gone from the second write* — with the loss report saying nothing, because from the
 * writer's point of view there was nothing there to drop.
 *
 * Measured when this was added: conditional formatting wrote four records, survived one round trip as zero
 * records, and reported no loss. Auto filter criteria, pivot tables and sparklines behaved the same way. That
 * is worse than a reported loss and worse than a crash — a read-modify-write deletes part of someone's
 * workbook and tells them it succeeded.
 *
 * **What this file asserts is the current state, not the desired one.** Each entry says whether a feature
 * round-trips today. A feature that gains a reader moves from `LOSES_ON_READ` to `SURVIVES`, and the test
 * fails if either list is wrong — so the gap cannot widen quietly, and closing it cannot be forgotten.
 */

import { extractAll } from "@archive/unzip/extract";
import { ZipArchive } from "@archive/zip";
import {
  Cell,
  Chart,
  Column,
  DefinedNames,
  Image,
  Pivot,
  Row,
  Sparkline,
  Table,
  Watermark,
  Workbook,
  Worksheet
} from "@excel";
import { encodeBiffRecords, iterateInterpretableRecords } from "@excel/xlsb/binary";
import { recordSpec } from "@excel/xlsb/spec/records";
import { describe, expect, it } from "vitest";

/** A feature, how to add it, and which records prove it reached the sheet. */
interface Feature {
  readonly name: string;
  /** Adds the feature to a sheet that already holds a small table in `A1:B3`. */
  readonly build: (workbook: Workbook.Handle, sheet: Worksheet.Handle) => void;
  /** Matches the records that only exist because the feature does. */
  readonly records: RegExp;
  /** Where those records live. `sheet` is the worksheet part; `package` is any part. */
  readonly scope?: "sheet" | "package";
}

const FEATURES: readonly Feature[] = [
  {
    name: "conditional formatting",
    build: (_workbook, sheet) =>
      Worksheet.addConditionalFormatting(sheet, {
        ref: "A2:A3",
        rules: [
          {
            type: "cellIs",
            operator: "greaterThan",
            formulae: ["1"],
            priority: 1,
            style: { font: { bold: true } }
          }
        ]
      } as never),
    records: /^BrtBeginConditionalFormatting$|^BrtBeginCFRule$/
  },
  {
    name: "auto filter criteria",
    build: (_workbook, sheet) => {
      const model = Worksheet.getModel(sheet);
      (model as { autoFilter?: string }).autoFilter = "A1:B3";
      (model as { autoFilterCriteria?: { ref: string; xml: string } }).autoFilterCriteria = {
        ref: "A1:B3",
        xml: '<filterColumn colId="0"><filters><filter val="a"/></filters></filterColumn>'
      };
      Worksheet.setModel(sheet, model);
    },
    records: /^BrtBeginFilterColumn$/
  },
  {
    name: "pivot table",
    build: (workbook, sheet) => {
      const target = Workbook.addWorksheet(workbook, "P");
      Pivot.add(target, {
        sourceSheet: sheet,
        rows: ["H"],
        columns: [],
        values: ["V"],
        metric: "sum"
      });
    },
    records: /^BrtBeginSXView$|^BrtBeginPivotCacheDef$/,
    scope: "package"
  },
  {
    name: "data validation",
    build: (_workbook, sheet) => {
      Cell.setValidation(sheet, "A2", {
        type: "whole",
        operator: "greaterThan",
        formulae: ["0"]
      } as never);
    },
    records: /^BrtDVal$/
  },
  {
    name: "auto filter range",
    build: (_workbook, sheet) => {
      const model = Worksheet.getModel(sheet);
      (model as { autoFilter?: string }).autoFilter = "A1:B3";
      Worksheet.setModel(sheet, model);
    },
    records: /^BrtBeginAFilter$/
  },
  {
    name: "merged cells",
    build: (_workbook, sheet) => {
      Worksheet.merge(sheet, "A1:B1");
    },
    records: /^BrtMergeCell$/
  },
  {
    name: "sheet protection",
    build: (_workbook, sheet) => {
      const model = Worksheet.getModel(sheet);
      (model as { sheetProtection?: unknown }).sheetProtection = { sheet: true, formatCells: true };
      Worksheet.setModel(sheet, model);
    },
    records: /^BrtSheetProtection$/
  },
  // Everything below was absent from this file, and three of them are lost on read. The list used to hold
  // seven entries and `LOSES_ON_READ` was empty, which read as "nothing is lost" — a claim the gate was in no
  // position to make about features it did not name. Its own completeness check compares the two lists against
  // `FEATURES`, so a feature missing from all three is invisible to it.
  {
    name: "sparklines",
    build: (_workbook, sheet) => {
      Sparkline.add(sheet, {
        type: "column",
        sparklines: [{ dataRef: "S!B2:B3", cellRef: "E2" }]
      });
    },
    records: /^BrtSparkline$/
  },
  {
    name: "images",
    build: (workbook, sheet) => {
      Image.place(sheet, Image.add(workbook, { buffer: PNG, extension: "png" }), {
        tl: { col: 4, row: 1 },
        br: { col: 6, row: 4 }
      } as never);
    },
    records: /^BrtDrawing$/
  },
  {
    name: "charts",
    build: (_workbook, sheet) => {
      Chart.addColumn(
        sheet as never,
        { series: [{ name: "V", categories: "S!$A$2:$A$3", values: "S!$B$2:$B$3" }] } as never,
        { tl: { col: 4, row: 1 }, br: { col: 9, row: 9 } } as never
      );
    },
    records: /^BrtDrawing$/
  },
  {
    name: "hyperlinks",
    build: (_workbook, sheet) => {
      Cell.setValue(sheet, "E2", {
        text: "x",
        hyperlink: "https://example.invalid/"
      } as never);
    },
    records: /^BrtHLink$/
  },
  {
    name: "cell comments",
    build: (_workbook, sheet) => {
      Cell.setComment(sheet, "A2", { texts: [{ text: "n" }] } as never);
    },
    records: /^BrtLegacyDrawing$/
  },
  {
    name: "row flags",
    build: (_workbook, sheet) => {
      Row.setHeight(sheet, 2, 30);
      Row.setHidden(sheet, 3, true);
      Row.setOutlineLevel(sheet, 3, 1);
    },
    records: /^BrtRowHdr$/
  },
  {
    name: "column flags",
    build: (_workbook, sheet) => {
      Column.setWidth(sheet, 1, 24);
      Column.setHidden(sheet, 2, true);
      Column.setOutlineLevel(sheet, 2, 1);
    },
    records: /^BrtColInfo$/
  },
  {
    name: "frozen panes",
    build: (_workbook, sheet) => {
      const model = Worksheet.getModel(sheet) as unknown as Record<string, unknown>;
      model.views = [{ state: "frozen", xSplit: 0, ySplit: 1, topLeftCell: "A2" }];
      Worksheet.setModel(sheet, model as never);
    },
    records: /^BrtPane$/
  },
  {
    name: "defined names",
    build: (workbook, _sheet) => {
      DefinedNames.add(Workbook.getDefinedNames(workbook) as never, "S!$B$2", "Threshold");
    },
    scope: "package",
    records: /^BrtName$/
  },
  {
    name: "tables",
    build: (_workbook, sheet) => {
      Table.add(
        sheet as never,
        {
          name: "T",
          ref: "D1",
          headerRow: true,
          columns: [{ name: "K" }, { name: "N" }],
          rows: [
            ["a", 1],
            ["b", 2]
          ]
        } as never
      );
    },
    // `BrtBeginList` lives in `xl/tables/tableN.bin`, not in the sheet — the sheet points at it with
    // `BrtListPart`, which this writer does not emit yet.
    scope: "package",
    records: /^BrtBeginList$/
  },
  {
    name: "header watermark",
    build: (workbook, sheet) => {
      Watermark.add(sheet, {
        imageId: Image.add(workbook, { buffer: PNG, extension: "png" }),
        mode: "header"
      } as never);
    },
    records: /^BrtLegacyDrawingHF$/
  }
];

/** A one-pixel PNG, for the features that need an image without needing a picture. */
const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1,
  0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1f, 0x15, 0xc4, 0x89, 0, 0, 0, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78,
  0x9c, 0x63, 0, 1, 0, 0, 5, 0, 1, 0x0d, 0x0a, 0x2d, 0xb4, 0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82
]);

/**
 * Features that survive a read-modify-write today, and features that do not.
 *
 * Split into two lists rather than one flag per entry so the shape of the gap is visible at a glance, and so
 * moving an entry is a deliberate edit rather than a character change.
 */
const SURVIVES: readonly string[] = [
  "data validation",
  "auto filter range",
  "merged cells",
  "sheet protection",
  // Not by being modelled — the three parts are opaque bytes. See the binding test below.
  "pivot table",
  // These two were the reason this file exists: written correctly, absent from the model on read, and
  // deleted by the second write with the loss report saying nothing. They have readers now.
  "conditional formatting",
  "auto filter criteria",
  "hyperlinks",
  "cell comments",
  "row flags",
  "column flags",
  "frozen panes",
  "defined names",
  "tables",
  "header watermark",
  // **By preservation, not by modelling.** `Workbook.read` does not put an image or a chart back into the
  // model — `media` and `charts` come back empty — but the drawing part is kept as opaque bytes and the
  // sheet's `BrtDrawing` pointer is re-emitted, so the *file* keeps its picture. The distinction matters:
  // a hand-written check on the model concluded these were lost, and they are not. Only what a caller can
  // *inspect* is missing, which is a different and smaller claim.
  "images",
  "charts",
  // Reads back through `readSparklineGroup`, and a second write is byte-identical. Getting here needed a fix
  // outside this module: `Worksheet.getModel` wrote `sparklineGroups` and `setSheetModel` never read it, so
  // every path that carries a sheet through its model dropped them — including `Workbook.read`, which builds
  // sheets internally and hands them over as a model. The records were being read correctly and discarded one
  // step later.
  "sparklines"
];

/**
 * Written correctly, then **deleted by the next write** because the reader does not model them.
 *
 * Each of these needs a reader. Until then the honest statement is that XLSB is a write target for them and
 * not a round-trip format — which is what this list records.
 */
const LOSES_ON_READ: readonly string[] = [
  // Empty — and unlike the empty list this file started with, that is now a claim with something behind it.
  // The point of the earlier criticism was not that the list was empty but that `FEATURES` named seven things,
  // so "nothing is lost" was a statement about a seventh of the surface. It names eighteen now, and the three
  // that were genuinely lost when they were added — sparklines, images and charts — were each investigated
  // rather than listed: sparklines gained a reader, and images and charts turned out to survive as opaque
  // parts, which is a smaller claim than "they round-trip" and is stated as such beside them.
  //
  // A feature added to `FEATURES` without an entry in either list fails the accounting test above, so the
  // next gap has to be classified rather than overlooked.
];

/** A workbook with a small source table and one feature applied. */
function workbookWith(feature: Feature): Workbook.Handle {
  const workbook = Workbook.create();
  const sheet = Workbook.addWorksheet(workbook, "S");
  Worksheet.addAoa(sheet, [
    ["H", "V"],
    ["a", 1],
    ["b", 2]
  ]);
  feature.build(workbook, sheet);
  return workbook;
}

/** How many records matching the feature's pattern the package holds. */
async function recordCount(bytes: Uint8Array, feature: Feature): Promise<number> {
  const parts = await extractAll(bytes);
  const paths =
    feature.scope === "package"
      ? [...parts.keys()].filter(name => name.endsWith(".bin"))
      : [...parts.keys()].filter(name => /worksheets\/sheet\d+\.bin$/.test(name));
  let total = 0;
  for (const path of paths) {
    try {
      // **The scope decides how an identifier resolves to a name**, and a few ids mean different records in a
      // worksheet than elsewhere. This passed `"s"` for every part, so a package-scoped feature whose records
      // live outside a worksheet — a table's `BrtBeginList`, in `xl/tables/tableN.bin` — was counted under
      // whatever name `"s"` gave that id, which is to say not counted at all.
      const scope = /worksheets\/|pivotTables\//.test(path) ? "s" : "w";
      for (const entry of iterateInterpretableRecords(parts.get(path)!.data, scope)) {
        if (feature.records.test(recordSpec(entry.id)?.name ?? "")) {
          total += 1;
        }
      }
    } catch {
      // A part this iterator cannot walk holds none of the records in question.
    }
  }
  return total;
}

describe("what a write emits, and what survives being read back", () => {
  it("accounts for every feature exactly once", () => {
    // The two lists together must name every feature and no others, so adding a feature without deciding
    // which list it belongs in fails here rather than being quietly untested.
    expect([...SURVIVES, ...LOSES_ON_READ].sort()).toEqual(FEATURES.map(f => f.name).sort());
  });

  it.each(FEATURES.map(feature => [feature.name, feature] as const))(
    "writes %s",
    async (_name, feature) => {
      // The precondition for the rest: if the first write emits nothing, the round-trip assertions below
      // would pass for the wrong reason.
      const written = await Workbook.toBuffer(workbookWith(feature), {
        format: "xlsb",
        unsupported: "ignore"
      });
      expect(await recordCount(written, feature)).toBeGreaterThan(0);
    }
  );

  it.each(SURVIVES.map(name => [name, FEATURES.find(f => f.name === name)!] as const))(
    "%s survives a read-modify-write",
    async (_name, feature) => {
      const first = await Workbook.toBuffer(workbookWith(feature), {
        format: "xlsb",
        unsupported: "ignore"
      });
      const reopened = Workbook.create();
      await Workbook.read(reopened, first);
      const second = await Workbook.toBuffer(reopened, {
        format: "xlsb",
        unsupported: "ignore"
      });
      expect(await recordCount(second, feature)).toBeGreaterThan(0);
    }
  );

  // Empty today, and kept because the shape is the point: a feature written without a reader belongs here,
  // and `it.each` over an empty list is a no-op rather than a failure — while the accounting test above still
  // forces a decision about which list a new feature joins.
  it.each(LOSES_ON_READ.map(name => [name, FEATURES.find(f => f.name === name)!] as const))(
    "%s is still lost on a read-modify-write, and this is the record of it",
    async (_name, feature) => {
      // Asserting the *defect*, deliberately. A feature that gains a reader will fail here, which is the
      // signal to move it to `SURVIVES` — the alternative is a gap nothing measures, which is how it got
      // here. The loss report says nothing for these, because from the writer's point of view the model it
      // was handed genuinely had no such feature.
      const first = await Workbook.toBuffer(workbookWith(feature), {
        format: "xlsb",
        unsupported: "ignore"
      });
      const reopened = Workbook.create();
      await Workbook.read(reopened, first);
      await expect(Workbook.toBuffer(reopened, { format: "xlsb" })).resolves.toBeDefined();
      const second = await Workbook.toBuffer(reopened, {
        format: "xlsb",
        unsupported: "ignore"
      });
      expect(await recordCount(second, feature)).toBe(0);
    }
  );

  it("brings conditional formatting back with its condition, not just its record", async () => {
    // Counting records proves the write happened; it does not prove the *rule* survived. A reader that
    // returned every rule as a bare `expression` would keep the count and change the meaning.
    //
    // `formulae` is the one field that does not come back: decoding an `Rgce` token stream to formula text
    // needs the reverse of `encodeParsedFormula`, which does not exist here. That is a narrowing this asserts
    // rather than hides — inventing a plausible operand would give a rule that looks complete and evaluates
    // differently.
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "S");
    Worksheet.addAoa(sheet, [["H"], [1], [9]]);
    Worksheet.addConditionalFormatting(sheet, {
      ref: "A2:A3",
      rules: [
        {
          type: "cellIs",
          operator: "greaterThan",
          formulae: ["5"],
          priority: 3,
          stopIfTrue: true,
          style: { font: { bold: true } }
        }
      ]
    } as never);
    const reopened = Workbook.create();
    await Workbook.read(
      reopened,
      await Workbook.toBuffer(workbook, { format: "xlsb", unsupported: "ignore" })
    );
    const blocks = Worksheet.getModel(Workbook.getWorksheet(reopened, "S")!)
      .conditionalFormattings as unknown as { ref: string; rules: Record<string, unknown>[] }[];
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.ref).toBe("A2:A3");
    expect(blocks[0]!.rules[0]).toMatchObject({
      type: "cellIs",
      operator: "greaterThan",
      stopIfTrue: true
    });
    expect(blocks[0]!.rules[0]!.formulae).toEqual([]);
    // And it keeps its *format*, which is a separate part of the package. Without reading `BrtDXF` back the
    // rule returned with a `dxfId` into a table nothing parsed, the next write found no `style` and wrote
    // "no format", and the rule then fired and displayed nothing — harder to notice than a missing rule,
    // because Excel still lists it in the conditional-formatting dialog.
    expect(blocks[0]!.rules[0]!.style).toMatchObject({ font: { bold: true } });
    // `dxfId` itself is gone: the model's rule holds a `style`, and an index into a table the next write
    // rebuilds from scratch would be a field nothing reads pointing at nothing in particular.
    expect(blocks[0]!.rules[0]).not.toHaveProperty("dxfId");
    // `priority` is *not* the value that went in, and that is deliberate rather than lossy: `iPri` MUST NOT
    // duplicate another rule's anywhere in the workbook, so the writer assigns it. What matters is that the
    // rule keeps *a* priority, which the reader has to carry for the next write to renumber from.
    expect(blocks[0]!.rules[0]!.priority).toEqual(expect.any(Number));
  });

  it("round-trips a conditional format's fill, font and border across generations", async () => {
    // Three generations because a differential format is written to `styles.bin` and referred to from the
    // sheet by index: a reader that resolved the index but dropped one facet would look right once.
    const style = {
      font: { bold: true, size: 14 },
      fill: { type: "pattern", pattern: "solid", bgColor: { argb: "FFFFFF00" } },
      border: { top: { style: "thin" } }
    };
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "S");
    Worksheet.addAoa(sheet, [["H"], [1], [9]]);
    Worksheet.addConditionalFormatting(sheet, {
      ref: "A2:A3",
      rules: [{ type: "cellIs", operator: "greaterThan", formulae: ["5"], priority: 1, style }]
    } as never);
    let bytes = await Workbook.toBuffer(workbook, { format: "xlsb", unsupported: "ignore" });
    for (let generation = 0; generation < 3; generation += 1) {
      const reopened = Workbook.create();
      await Workbook.read(reopened, bytes);
      const rules = (
        Worksheet.getModel(Workbook.getWorksheet(reopened, "S")!)
          .conditionalFormattings as unknown as { rules: { style?: unknown }[] }[]
      )[0]!.rules;
      expect(rules[0]!.style).toEqual(style);
      bytes = await Workbook.toBuffer(reopened, { format: "xlsb", unsupported: "ignore" });
    }
  });

  it("loses only the criteria when a filter collection is unterminated", async () => {
    // A file this writer cannot produce but a reader must survive. The first shape of the criteria reader
    // collected *everything* between `BrtBeginAFilter` and its end, so a missing end swallowed every record
    // after the filter — conditional formatting, validations, page setup. The cells escaped only because they
    // come earlier in the part, which is luck rather than design.
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "S");
    Worksheet.addAoa(sheet, [["H"], [1], [9]]);
    const model = Worksheet.getModel(sheet);
    (model as { autoFilter?: string }).autoFilter = "A1:A3";
    Worksheet.setModel(sheet, model);
    Worksheet.addConditionalFormatting(sheet, {
      ref: "A2:A3",
      rules: [
        {
          type: "cellIs",
          operator: "greaterThan",
          formulae: ["5"],
          priority: 1,
          style: { font: { bold: true } }
        }
      ]
    } as never);
    const parts = await extractAll(
      await Workbook.toBuffer(workbook, { format: "xlsb", unsupported: "ignore" })
    );
    const sheetPath = [...parts.keys()].find(name => /worksheets\/sheet\d+\.bin$/.test(name))!;
    const kept: { id: number; payload?: Uint8Array }[] = [];
    for (const entry of iterateInterpretableRecords(parts.get(sheetPath)!.data, "s")) {
      if (recordSpec(entry.id)?.name === "BrtEndAFilter") {
        continue;
      }
      kept.push({ id: entry.id, payload: entry.payload });
    }
    const archive = new ZipArchive();
    for (const [name, entry] of parts) {
      archive.add(name, name === sheetPath ? encodeBiffRecords(kept) : entry.data);
    }
    const reopened = Workbook.create();
    await Workbook.read(reopened, await archive.bytes());
    const read = Worksheet.getModel(Workbook.getWorksheet(reopened, "S")!);
    // The records after the filter are still there.
    expect(read.conditionalFormattings).toHaveLength(1);
    expect(read.rows?.flatMap(row => row.cells ?? [])).toHaveLength(3);
  });

  it("brings auto filter criteria back as the same XML it was given", async () => {
    // The model holds criteria as raw XML, so equality is checkable exactly — and it has to be, because the
    // XLSX writer replays this string verbatim. Two details would survive a record count and not this: `fAnd`
    // is inverted in the record, so reading it as written turns every AND into an OR, and `blank="1"` lives in
    // a field separate from the values it accompanies.
    const criteria =
      '<filterColumn colId="0"><filters blank="1"><filter val="a"/></filters></filterColumn>' +
      '<filterColumn colId="1"><customFilters and="1">' +
      '<customFilter operator="greaterThan" val="5"/></customFilters></filterColumn>';
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "S");
    Worksheet.addAoa(sheet, [
      ["H", "V"],
      ["a", 1]
    ]);
    const model = Worksheet.getModel(sheet);
    (model as { autoFilter?: string }).autoFilter = "A1:B2";
    (model as { autoFilterCriteria?: { ref: string; xml: string } }).autoFilterCriteria = {
      ref: "A1:B2",
      xml: criteria
    };
    Worksheet.setModel(sheet, model);
    // Three generations, because a reader that dropped one attribute per pass would still look right once.
    let bytes = await Workbook.toBuffer(workbook, { format: "xlsb", unsupported: "ignore" });
    for (let generation = 0; generation < 3; generation += 1) {
      const reopened = Workbook.create();
      await Workbook.read(reopened, bytes);
      const read = Worksheet.getModel(Workbook.getWorksheet(reopened, "S")!) as {
        autoFilterCriteria?: { xml: string };
      };
      expect(read.autoFilterCriteria?.xml).toBe(criteria);
      bytes = await Workbook.toBuffer(reopened, { format: "xlsb", unsupported: "ignore" });
    }
  });

  it("keeps the cache binding in step with the preserved parts across generations", async () => {
    // A pivot table survives by *preservation*: the three parts are opaque bytes. But
    // `BrtBeginPivotCacheID` lives in `workbook.bin`, which is rebuilt — so the parts came back while the
    // record announcing them did not, leaving a cache definition nothing declared. That is the reverse of a
    // dangling reference and equally a repair prompt, and it looked like a clean round trip.
    //
    // Four generations, because the defect hid at the *second*: the workbook relationships are renumbered on
    // each write, so a binding that kept its incoming id (`rId3`) named a relationship the new package did
    // not contain — and the first write reproduced that id by coincidence.
    const feature = FEATURES.find(entry => entry.name === "pivot table")!;
    let bytes = await Workbook.toBuffer(workbookWith(feature), {
      format: "xlsb",
      unsupported: "ignore"
    });
    const decoder = new TextDecoder();
    for (let generation = 1; generation <= 4; generation += 1) {
      const parts = await extractAll(bytes);
      const bindings: { cacheId: number; relationshipId: string }[] = [];
      for (const entry of iterateInterpretableRecords(parts.get("xl/workbook.bin")!.data, "s")) {
        if (recordSpec(entry.id)?.name !== "BrtBeginPivotCacheID") {
          continue;
        }
        const view = new DataView(entry.payload!.buffer, entry.payload!.byteOffset);
        const characters = view.getUint32(4, true);
        bindings.push({
          cacheId: view.getUint32(0, true),
          relationshipId: String.fromCharCode(
            ...new Uint16Array(entry.payload!.buffer, entry.payload!.byteOffset + 8, characters)
          )
        });
      }
      const definitions = [...parts.keys()].filter(name =>
        /pivotCacheDefinition\d+\.bin$/.test(name)
      );
      // One binding per definition part, which is what the specification requires.
      expect(bindings).toHaveLength(definitions.length);
      expect(new Set(bindings.map(binding => binding.cacheId)).size).toBe(bindings.length);
      // The cache id is carried across unchanged, because the view's `idCache` still refers to it.
      expect(bindings.map(binding => binding.cacheId)).toEqual([10]);
      // And each binding names a relationship this package actually declares.
      const workbookRels = decoder.decode(parts.get("xl/_rels/workbook.bin.rels")!.data);
      for (const binding of bindings) {
        expect(workbookRels).toContain(`Id="${binding.relationshipId}"`);
      }
      const reopened = Workbook.create();
      await Workbook.read(reopened, bytes);
      bytes = await Workbook.toBuffer(reopened, { format: "xlsb", unsupported: "ignore" });
    }
  });
});

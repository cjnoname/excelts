/**
 * A pivot table read from one container must reach the other.
 *
 * `pivotParts` used to require `pivot.source` — the live worksheet adapter a pivot gets from `Pivot.add` — and
 * returned `undefined` without it. A pivot *read from a file* has no `source`: the reader normalises it into
 * `cacheFields`, `cacheDefinition` and `cacheRecords`, which is the same information already resolved. So
 * every XLSX→XLSB conversion silently dropped its pivot tables, and the `continue` that did it recorded
 * nothing — `unsupported: "error"` did not even refuse.
 *
 * These tests convert rather than round-trip. A round trip through `Pivot.add` keeps `source` alive and
 * therefore cannot see the defect at all, which is why it survived: the whole point is the *absence* of the
 * field the old code tested for.
 */
import { extractAll } from "@archive/unzip/extract";
import { Pivot, Workbook, Worksheet } from "@excel";
import { validateXlsbBuffer } from "@excel/utils/xlsb-validator";
import { iterateInterpretableRecords } from "@excel/xlsb/binary";
import { recordSpec } from "@excel/xlsb/spec/records";
import { describe, expect, it } from "vitest";

/** A workbook with one pivot over a small source, built the ordinary way. */
function authored(): Workbook.Handle {
  const handle = Workbook.create();
  const source = Workbook.addWorksheet(handle, "Data");
  Worksheet.addAoa(source, [
    ["Region", "Product", "Units", "Year"],
    ["APAC", "Widget", 10, 2024],
    ["EMEA", "Widget", 20, 2024],
    ["APAC", "Gadget", 30, 2025],
    ["EMEA", "Gadget", 40, 2025]
  ]);
  Pivot.add(
    Workbook.addWorksheet(handle, "P") as never,
    {
      sourceTable: undefined,
      sourceSheet: source,
      rows: ["Region"],
      columns: ["Product"],
      pages: ["Year"],
      values: ["Units"],
      anchor: "A3"
    } as never
  );
  return handle;
}

/** The same workbook after a trip through XLSX, which is where `source` is lost. */
async function viaXlsx(): Promise<Workbook.Handle> {
  const reopened = Workbook.create();
  await Workbook.read(reopened, await Workbook.toBuffer(authored(), { format: "xlsx" }));
  return reopened;
}

/** Part paths and record counts of a workbook's XLSB form. */
async function xlsbShape(handle: Workbook.Handle): Promise<{
  readonly views: number;
  readonly caches: number;
  readonly records: number;
  readonly fields: number;
  readonly problems: readonly string[];
  readonly dropped: readonly string[];
}> {
  let dropped: readonly string[] = [];
  try {
    await Workbook.toBuffer(handle, { format: "xlsb", unsupported: "error" });
  } catch (cause) {
    const items = (cause as { items?: readonly string[] }).items;
    if (items === undefined) {
      throw cause;
    }
    dropped = items;
  }
  const bytes = await Workbook.toBuffer(handle, { format: "xlsb", unsupported: "ignore" });
  const parts = await extractAll(bytes);
  const count = (pattern: RegExp) => [...parts.keys()].filter(path => pattern.test(path)).length;

  let records = 0;
  let fields = 0;
  const recordsPath = [...parts.keys()].find(path => /pivotCacheRecords\d+\.bin$/.test(path));
  if (recordsPath !== undefined) {
    for (const record of iterateInterpretableRecords(parts.get(recordsPath)!.data, "w")) {
      if (recordSpec(record.id)?.name === "BrtPCRRecord") {
        records += 1;
      }
    }
  }
  const definitionPath = [...parts.keys()].find(path => /pivotCacheDefinition\d+\.bin$/.test(path));
  if (definitionPath !== undefined) {
    for (const record of iterateInterpretableRecords(parts.get(definitionPath)!.data, "w")) {
      if (recordSpec(record.id)?.name === "BrtBeginPCDField") {
        fields += 1;
      }
    }
  }

  const validation = await validateXlsbBuffer(bytes);
  return {
    views: count(/pivotTables\/pivotTable\d+\.bin$/),
    caches: count(/pivotCacheDefinition\d+\.bin$/),
    records,
    fields,
    problems: [...new Set((validation.problems ?? []).map(problem => problem.kind))],
    dropped
  };
}

describe("a pivot table converted between containers", () => {
  it("reaches the XLSB when the workbook came from an XLSX", async () => {
    const shape = await xlsbShape(await viaXlsx());
    expect(shape.dropped).toEqual([]);
    expect(shape.views).toBe(1);
    expect(shape.caches).toBe(1);
  });

  it("carries the same cache as the authored workbook", async () => {
    // The parsed branch must not re-derive the cache differently: same field count, same record count. Four
    // source rows and four columns, and the source is built so a wrong reading of either would not coincide.
    const direct = await xlsbShape(authored());
    const converted = await xlsbShape(await viaXlsx());
    expect(converted.fields).toBe(direct.fields);
    expect(converted.records).toBe(direct.records);
    expect(converted.records).toBe(4);
  });

  it("passes the validator either way", async () => {
    expect((await xlsbShape(authored())).problems).toEqual([]);
    expect((await xlsbShape(await viaXlsx())).problems).toEqual([]);
  });

  it("names the loss when there is genuinely no cache to write", async () => {
    // The one case that must still refuse: a pivot with neither a live source nor parsed records. Reported
    // rather than skipped in silence, which is what the `continue` used to do for *every* converted pivot.
    const handle = await viaXlsx();
    const model = Workbook.getModel(handle);
    Workbook.setModel(handle, {
      ...model,
      worksheets: model.worksheets.map(sheet => ({
        ...sheet,
        pivotTables: ((sheet as { pivotTables?: readonly object[] }).pivotTables ?? []).map(
          pivot => ({ ...pivot, cacheRecords: undefined, source: undefined })
        )
      }))
    } as never);
    const shape = await xlsbShape(handle);
    expect(shape.views).toBe(0);
    expect(shape.dropped.join(" ")).toMatch(/pivot table/);
  });
});

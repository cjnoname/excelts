import { extractAll } from "@archive/unzip/extract";
import { createZip } from "@archive/zip/zip-bytes";
import { getWorkbookModel } from "@excel/core/workbook.browser";
import { Cell, Pivot, Workbook } from "@excel/index";
import { describe, expect, it } from "vitest";

/**
 * Each preserved pivot cache has to be reconnected to the `cacheId` that announces *it*.
 *
 * On a rewrite the writer replays the bindings the reader collected from `workbook.bin` and matches them against the
 * preserved cache-definition parts. It matched them **by array position** — and those two lists have different orderings:
 * bindings come in declaration order, parts come in ZIP order, and nothing in OPC ties the two together. Two caches
 * delivered in the opposite order therefore bound each `cacheId` to the other one's definition. Every part present, the
 * package valid, both pivots reading the wrong data, and neither a validator nor a round trip through this library able
 * to see it.
 *
 * The fixture reverses the cache parts inside the ZIP deliberately. That is a legal package — entry order is not part of
 * the contract — which is exactly why relying on it was wrong.
 */
async function twoPivots(): Promise<Uint8Array> {
  const workbook = Workbook.create();
  const data = Workbook.addWorksheet(workbook, "Data");
  Cell.setValue(data, "A1", "Region");
  Cell.setValue(data, "B1", "Units");
  ["APAC", "EMEA"].forEach((region, index) => {
    Cell.setValue(data, `A${index + 2}`, region);
    Cell.setValue(data, `B${index + 2}`, (index + 1) * 10);
  });
  for (const name of ["First", "Second"]) {
    const sheet = Workbook.addWorksheet(workbook, name);
    Pivot.add(sheet, {
      sourceSheet: data,
      ref: "A3",
      rows: ["Region"],
      columns: [],
      values: ["Units"],
      metric: "sum"
    } as never);
  }
  return Workbook.toBuffer(workbook, { format: "xlsb", unsupported: "ignore" });
}

/** The same package with its cache-definition entries in the opposite ZIP order. */
async function withReversedCaches(bytes: Uint8Array): Promise<Uint8Array> {
  const parts = await extractAll(bytes);
  const names = [...parts.keys()];
  const caches = names.filter(name => /pivotCacheDefinition\d+\.bin$/.test(name));
  expect(caches.length).toBeGreaterThan(1);
  const reversed = [...caches].reverse();
  const order = names.map(name => {
    const at = caches.indexOf(name);
    return at === -1 ? name : reversed[at]!;
  });
  return createZip(order.map(name => ({ name, data: parts.get(name)!.data })));
}

describe("preserved pivot cache bindings", () => {
  it("resolves each binding to its own definition part", async () => {
    const workbook = Workbook.create();
    await Workbook.read(workbook, await twoPivots());
    const bindings = (
      getWorkbookModel(workbook) as unknown as {
        xlsbPivotCaches?: readonly { cacheId: number; definitionPath?: string }[];
      }
    ).xlsbPivotCaches;
    expect(bindings).toHaveLength(2);
    // Distinct paths, and each one resolved rather than left to positional guessing.
    const paths = bindings!.map(binding => binding.definitionPath);
    expect(paths.every(path => path !== undefined)).toBe(true);
    expect(new Set(paths).size).toBe(2);
  });

  it("keeps each cacheId with its own definition when the ZIP order is reversed", async () => {
    // The case position-matching got wrong. The binding for the first cache must still name the first definition.
    const natural = await twoPivots();
    const shuffled = await withReversedCaches(natural);

    const read = async (bytes: Uint8Array) => {
      const workbook = Workbook.create();
      await Workbook.read(workbook, bytes);
      const bindings = (
        getWorkbookModel(workbook) as unknown as {
          xlsbPivotCaches?: readonly { cacheId: number; definitionPath?: string }[];
        }
      ).xlsbPivotCaches;
      return new Map(bindings!.map(binding => [binding.cacheId, binding.definitionPath]));
    };

    // Entry order must not change which definition a cache id names.
    expect(await read(shuffled)).toEqual(await read(natural));
  });

  it("rewrites a reordered package without losing a cache", async () => {
    const shuffled = await withReversedCaches(await twoPivots());
    const workbook = Workbook.create();
    await Workbook.read(workbook, shuffled);
    Cell.setValue(Workbook.getWorksheets(workbook)[0]!, "ZZ999", "edited");
    const written = await Workbook.toBuffer(workbook, { format: "xlsb", unsupported: "ignore" });
    const parts = await extractAll(written);
    expect(
      [...parts.keys()].filter(name => /pivotCacheDefinition\d+\.bin$/.test(name))
    ).toHaveLength(2);
  });
});

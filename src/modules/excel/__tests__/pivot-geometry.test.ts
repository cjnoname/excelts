import { extractAll } from "@archive/unzip/extract";
/**
 * The pivot body's geometry must agree with the pivot lines actually written.
 *
 * `BrtBeginSXLocation` describes the rectangle the pivot occupies and `BrtBeginSXLI` records enumerate its row
 * lines. **Those were computed by two different functions from two different rules**, and the comment on the
 * geometry claimed they were "derived from the same number":
 *
 * - the rectangle multiplied each row field's item count — a cross product;
 * - the line records walked the cache records and emitted only combinations the data contains.
 *
 * For two row fields over three source rows that is 3×3+1 = 10 against the true 7, so the body claimed three
 * rows it never fills. Neither function could catch it, because each was self-consistent; the disagreement was
 * only visible from outside, and only by counting one against the other.
 *
 * These tests count. They are end-to-end because the invariant spans the cache, the model and both encoders.
 */
import { Pivot, Workbook, Worksheet } from "@excel";
import { iterateInterpretableRecords } from "@excel/xlsb/binary";
import { recordSpec } from "@excel/xlsb/spec/records";
import { describe, expect, it } from "vitest";

/**
 * A source sheet whose cross product is much larger than its real combinations.
 *
 * Three rows, each with a distinct region *and* a distinct date: two row fields with three items each, so the
 * cross product is nine while only three pairs exist. A source where every combination happened to be present
 * would let the old cross-product formula pass.
 */
function workbookWith(options: {
  readonly rows: readonly string[];
  readonly columns?: readonly string[];
  readonly pages?: readonly string[];
}): Workbook.Handle {
  const handle = Workbook.create();
  const source = Workbook.addWorksheet(handle, "Data");
  Worksheet.addAoa(source, [
    // `Year`, `Tier` and `Channel` exist so the page-filter cases have fields that are not already on the row
    // axis — a field may sit on only one axis area, which the model enforces.
    ["Region", "Units", "Sold", "Year", "Tier", "Channel"],
    ["APAC", 10, new Date(Date.UTC(2024, 0, 15)), 2024, "A", "Web"],
    ["EMEA", 20, new Date(Date.UTC(2024, 1, 20)), 2025, "B", "Retail"],
    ["AMER", 30, new Date(Date.UTC(2024, 2, 25)), 2026, "C", "Direct"]
  ]);
  Pivot.add(
    Workbook.addWorksheet(handle, "P") as never,
    {
      sourceSheet: source,
      rows: options.rows,
      columns: options.columns ?? [],
      pages: options.pages ?? [],
      values: ["Units"],
      anchor: "A3"
    } as never
  );
  return handle;
}

/** The `BrtBeginSXLocation` fields, and how many `BrtBeginSXLI` records the same part carries. */
async function geometryOf(handle: Workbook.Handle): Promise<{
  readonly rowFirst: number;
  readonly rowLast: number;
  readonly rowFirstData: number;
  readonly columnFirstData: number;
  readonly columnLast: number;
  readonly lineCount: number;
}> {
  const parts = await extractAll(
    await Workbook.toBuffer(handle, { format: "xlsb", unsupported: "ignore" })
  );
  const path = [...parts.keys()].find(
    name => /pivotTable\d+\.bin$/i.test(name) && !name.includes("_rels")
  );
  expect(path, "the package should contain a pivot table part").toBeDefined();

  let location: DataView | undefined;
  let lineCount = 0;
  // **Row lines only.** `BrtBeginSXLI` appears in two collections — `BrtBeginSXLIRws` and `BrtBeginSXLICols` —
  // and counting both together mixes the two axes. A pivot with no column fields still emits one entry-less
  // column line, so a flat count is always one too many and the invariant would never hold.
  let inRowLines = false;
  for (const record of iterateInterpretableRecords(parts.get(path!)!.data, "s")) {
    const name = recordSpec(record.id)?.name;
    if (name === "BrtBeginSXLocation") {
      location = new DataView(
        record.payload.buffer,
        record.payload.byteOffset,
        record.payload.byteLength
      );
    }
    if (name === "BrtBeginSXLIRws") {
      inRowLines = true;
    }
    if (name === "BrtEndSXLIRws") {
      inRowLines = false;
    }
    if (name === "BrtBeginSXLI" && inRowLines) {
      lineCount += 1;
    }
  }
  expect(location, "the pivot part should carry a location").toBeDefined();
  return {
    rowFirst: location!.getUint32(0, true),
    rowLast: location!.getUint32(4, true),
    columnLast: location!.getUint32(12, true),
    rowFirstData: location!.getUint32(20, true),
    columnFirstData: location!.getUint32(24, true),
    lineCount
  };
}

describe("the pivot body's rectangle", () => {
  it.each([
    ["one row field", { rows: ["Region"] }],
    ["two row fields", { rows: ["Region", "Sold"] }],
    ["a row and a column field", { rows: ["Region"], columns: ["Sold"] }]
  ] as const)("spans exactly the lines written, with %s", async (_name, options) => {
    const geometry = await geometryOf(workbookWith(options));
    // **The invariant.** The rectangle runs from where the data starts to `rowLast`, and that span is the number
    // of row lines. A body one row taller than its content is what the cross-product estimate produced.
    expect(geometry.rowLast - geometry.rowFirstData + 1).toBe(geometry.lineCount);
  });

  it("counts only the combinations the data contains", async () => {
    // Three source rows over two row fields: three parents, three children, one grand total. Seven, not the
    // 3×3+1 = 10 a cross product gives — and the source is built so the two differ.
    const geometry = await geometryOf(workbookWith({ rows: ["Region", "Sold"] }));
    expect(geometry.lineCount).toBe(7);
    expect(geometry.rowLast).toBe(9);
  });

  /**
   * Page filters push the body down, and the two containers have to agree by how much.
   *
   * `ref` anchors the whole displayed block — filters, a blank separator, then the table — while the range in
   * `BrtBeginSXLocation` addresses the body alone. The XLSB writer used the anchor row directly, so a pivot
   * with page filters claimed a body overlapping its own filter rows: Excel removed the part outright for two
   * or more filters and repaired it for one. `crwPage` was correct the whole time, which is what made it look
   * like the page fields were being handled.
   *
   * Asserted against the **XLSX writer's own `location/@ref`** rather than against a formula repeated here.
   * Both writers describe one model's geometry, only one of them was believed by Excel, and a constant copied
   * into this test could drift with neither of them.
   */
  it.each([0, 1, 2, 3])("starts the body below %i page filters", async count => {
    const pages = ["Year", "Tier", "Channel"].slice(0, count);
    const handle = workbookWith({ rows: ["Region"], pages });
    const geometry = await geometryOf(handle);

    const xlsx = await extractAll(await Workbook.toBuffer(handle, { format: "xlsx" }));
    const part = [...xlsx.keys()].find(path => /pivotTables\/pivotTable\d+\.xml$/.test(path))!;
    const ref = /ref="([^"]+)"/.exec(new TextDecoder().decode(xlsx.get(part)!.data))![1]!;
    // `A3` → row 3 one-based → row index 2. `rowFirst` is zero-based.
    const xlsxFirstRow = Number(/\d+/.exec(ref.split(":")[0]!)![0]) - 1;

    expect(geometry.rowFirst).toBe(xlsxFirstRow);
    // And the offset is what it claims to be: one row per filter, plus a separator when there is any filter.
    expect(geometry.rowFirst).toBe(2 + (count > 0 ? count + 1 : 0));
  });

  it("gives each row field its own column", async () => {
    // `fCompactData` is left clear — a tabular layout — so two row fields occupy two columns. This was fixed at
    // one column regardless, which contradicted the flag the same writer emits.
    expect((await geometryOf(workbookWith({ rows: ["Region"] }))).columnFirstData).toBe(1);
    expect((await geometryOf(workbookWith({ rows: ["Region", "Sold"] }))).columnFirstData).toBe(2);
  });

  it("moves the data down one row per column field", async () => {
    // A column field puts its items on their own row, so `rwFirstData` is no longer equal to `rwFirstHead`.
    const flat = await geometryOf(workbookWith({ rows: ["Region"] }));
    const withColumn = await geometryOf(workbookWith({ rows: ["Region"], columns: ["Sold"] }));
    expect(flat.rowFirstData).toBe(flat.rowFirst + 1);
    expect(withColumn.rowFirstData).toBe(withColumn.rowFirst + 2);
  });

  it("widens the body for the column axis", async () => {
    // Without column fields the value fields sit side by side; with them, every enumerated column line gets its
    // own set. Three dates plus a grand total is four, so the body reaches column 4 rather than column 1.
    expect((await geometryOf(workbookWith({ rows: ["Region"] }))).columnLast).toBe(1);
    expect(
      (await geometryOf(workbookWith({ rows: ["Region"], columns: ["Sold"] }))).columnLast
    ).toBe(4);
  });
});

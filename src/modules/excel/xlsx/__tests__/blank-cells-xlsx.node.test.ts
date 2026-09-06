/**
 * `blankCells: "collapse"` in the XML container, and the point is that it is lossless *here too*.
 *
 * **One representation, both containers.** `<c r="A9" s="3"/>` and `BrtCellBlank` are the same thing — a cell whose only
 * content is its format — and Excel writes one per cell of a formatted region. Both readers collapse them into the
 * `styledBlankRanges` rectangles in `core/styled-blanks`, and both writers expand them again. An option whose fidelity
 * depended on which container a workbook came from would be the worse API, so the central assertion is the same one the
 * XLSB test makes: read with `"collapse"`, write, and get the bytes a `"keep"` read produces.
 *
 * Three things had to be right for that, and each was wrong first:
 *
 * 1. A row's `spans` is rendered from `min`/`max`, not from a `spans` field. Setting the latter produced cells that were
 *    byte-identical inside a row tag missing its attribute.
 * 2. A style **index** is meaningless once the style table is rebuilt, and a style no cell references is never
 *    registered at all — the output came out with `<fills count="2">` where the source had 3. The index is resolved to a
 *    style object during `reconcile`, which is what the XLSB reader had been doing all along.
 * 3. The stored dimension is computed from materialised cells, so a collapsed read reported `A1:H200` for a sheet whose
 *    formatting reached H8000. Excel treats the dimension as advisory, which is why a wrong one ships unnoticed.
 */
import { extractAll } from "@archive/unzip/extract";
import { Cell, Workbook } from "@excel";
import { beforeAll, describe, expect, it } from "vitest";

/** Rows 1–20 hold data; rows 21–400 carry a fill and nothing else, across eight columns. */
const DATA_ROWS = 20;
const LAST_ROW = 400;
const COLUMNS = 8;

let source = new Uint8Array(0);

/** Read `source` in one mode, and what it was written back to. */
async function readAs(
  blankCells: "keep" | "collapse"
): Promise<{ readonly handle: Workbook.Handle; readonly written: Uint8Array }> {
  const handle = Workbook.create();
  await Workbook.read(handle, source, { blankCells });
  const written = Uint8Array.from(
    await Workbook.toBuffer(handle, { format: "xlsx", validate: false })
  );
  return { handle, written };
}

function physicalRows(handle: Workbook.Handle): number {
  return (Workbook.getModel(handle).worksheets[0].rows ?? []).length;
}

beforeAll(async () => {
  const handle = Workbook.create();
  const sheet = Workbook.addWorksheet(handle, "S");
  for (let row = 1; row <= DATA_ROWS; row++) {
    for (let column = 1; column <= COLUMNS; column++) {
      Cell.setValue(sheet, row, column, row * column);
    }
  }
  for (let row = DATA_ROWS + 1; row <= LAST_ROW; row++) {
    for (let column = 1; column <= COLUMNS; column++) {
      Cell.setStyle(sheet, row, column, {
        fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FFEEEEEE" } }
      } as never);
    }
  }
  source = Uint8Array.from(await Workbook.toBuffer(handle, { format: "xlsx", validate: false }));
});

describe("the fixture", () => {
  it("really is dominated by styled blanks", async () => {
    // Stated first: every measurement below is meaningless if the file does not have the shape the option exists for.
    const parts = await extractAll(source);
    const sheet = new TextDecoder().decode(parts.get("xl/worksheets/sheet1.xml")!.data);
    const blanks = (sheet.match(/<c r="[A-Z]+\d+" s="\d+"\/>/g) ?? []).length;
    expect(blanks).toBe((LAST_ROW - DATA_ROWS) * COLUMNS);
  });
});

describe("collapse is lossless in XLSX too", () => {
  it("writes byte-identical output to keep", async () => {
    const [kept, collapsed] = await Promise.all([readAs("keep"), readAs("collapse")]);
    const left = await extractAll(kept.written);
    const right = await extractAll(collapsed.written);
    expect([...right.keys()].sort()).toEqual([...left.keys()].sort());
    for (const path of left.keys()) {
      if (path === "docProps/core.xml") {
        continue;
      }
      expect([...right.get(path)!.data], path).toEqual([...left.get(path)!.data]);
    }
  });

  it("keeps the row spans", async () => {
    // The first of the three failures, asserted where it can be read: a row whose cells were collapsed away has no
    // `min`/`max`, and the attribute is rendered from those.
    const collapsed = await readAs("collapse");
    const sheet = new TextDecoder().decode(
      (await extractAll(collapsed.written)).get("xl/worksheets/sheet1.xml")!.data
    );
    const rows = sheet.match(/<row r="(\d+)"[^>]*>/g) ?? [];
    expect(rows.length).toBe(LAST_ROW);
    expect(rows.every(row => row.includes("spans="))).toBe(true);
  });

  it("registers the blank cells' fill in the rebuilt style table", async () => {
    // The second. A style nothing in the model references is never registered, and the index the rectangle carried then
    // pointed at whatever landed there instead.
    const [kept, collapsed] = await Promise.all([readAs("keep"), readAs("collapse")]);
    const fills = async (bytes: Uint8Array): Promise<string | undefined> =>
      /<fills count="(\d+)"/.exec(
        new TextDecoder().decode((await extractAll(bytes)).get("xl/styles.xml")!.data)
      )?.[1];
    expect(await fills(collapsed.written)).toBe(await fills(kept.written));
  });

  it("keeps the dimension the formatting reaches", async () => {
    // The third. Advisory to Excel, which is why it ships wrong.
    const collapsed = await readAs("collapse");
    const sheet = new TextDecoder().decode(
      (await extractAll(collapsed.written)).get("xl/worksheets/sheet1.xml")!.data
    );
    expect(sheet).toContain(`<dimension ref="A1:H${LAST_ROW}"/>`);
  });
});

describe("collapse changes the model, not the file", () => {
  it("does not materialise the empty rows", async () => {
    const [kept, collapsed] = await Promise.all([readAs("keep"), readAs("collapse")]);
    expect(physicalRows(kept.handle)).toBe(LAST_ROW);
    expect(physicalRows(collapsed.handle)).toBe(DATA_ROWS);
  });

  it("keeps every value", async () => {
    const collapsed = await readAs("collapse");
    const sheet = Workbook.getWorksheets(collapsed.handle)[0];
    expect(Cell.getValue(sheet, "A1")).toBe(1);
    expect(Cell.getValue(sheet, "H20")).toBe(160);
  });
});

describe("the two containers agree", () => {
  it("collapses to the same rectangles from either form", async () => {
    // The claim the shared representation exists for: the same workbook, read through either container with the same
    // option, produces the same model. Row counts stand in for the model because they are the number the policy
    // changes.
    const viaXlsx = Workbook.create();
    await Workbook.read(viaXlsx, source, { blankCells: "collapse" });
    const asXlsb = await Workbook.toBuffer(viaXlsx, { format: "xlsb", unsupported: "ignore" });
    const viaXlsb = Workbook.create();
    await Workbook.read(viaXlsb, asXlsb, { blankCells: "collapse" });
    expect(physicalRows(viaXlsb)).toBe(physicalRows(viaXlsx));
    const sheet = Workbook.getWorksheets(viaXlsb)[0];
    expect(Cell.getValue(sheet, "A1")).toBe(1);
    expect(Cell.getValue(sheet, "H20")).toBe(160);
  });
});

describe("keep is still the default", () => {
  it("materialises the blanks when nothing is asked for", async () => {
    const handle = Workbook.create();
    await Workbook.read(handle, source);
    expect(physicalRows(handle)).toBe(LAST_ROW);
  });
});

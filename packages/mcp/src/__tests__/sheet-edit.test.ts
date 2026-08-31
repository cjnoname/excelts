/**
 * `sheet_edit` tests.
 *
 * Two properties matter more than the individual operations. Edits must be
 * atomic — a failing op must leave the file byte-identical, because a
 * half-edited spreadsheet is worse than a rejected request. And `dryRun` must
 * write nothing at all, since it exists precisely for the case where the model
 * is not yet sure the edit is right.
 */

import { mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Cell, Workbook, Worksheet } from "documonster/excel";

import { resolveConfig, type ServerConfig } from "../config.js";
import { McpToolError } from "../errors.js";
import { sheetEditTool } from "../tools/sheet-edit.js";
import { sheetWriteTool } from "../tools/sheet-write.js";

interface Fixture {
  readonly config: ServerConfig;
  readonly root: string;
}

async function fixture(args: readonly string[] = []): Promise<Fixture> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "documonster-mcp-sheetedit-")));
  const base = resolveConfig(args, { cwd: root });
  // Business-behaviour tests use the explicit compatibility layout; dedicated
  // sandbox regressions below cover the secure dual-root default.
  return {
    config: { ...base, outputRoot: root, allowInPlace: true },
    root
  };
}

async function edit(fx: Fixture, args: Record<string, unknown>): Promise<string> {
  const result = await sheetEditTool.handler(args, { config: fx.config });
  const text = result.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map(block => block.text)
    .join("\n");
  if (result.isError === true) {
    throw new Error(text);
  }
  return text;
}

/** A two-sheet workbook: edits must not disturb the second sheet. */
async function makeWorkbook(fx: Fixture, name = "book.xlsx"): Promise<string> {
  const wb = Workbook.create();
  const data = Workbook.addWorksheet(wb, "Data");
  Worksheet.addAoa(data, [
    ["region", "units", "price"],
    ["APAC", 10, 25.5],
    ["EMEA", 4, 30],
    ["AMER", 7, 19.75]
  ]);
  const notes = Workbook.addWorksheet(wb, "Notes");
  Worksheet.addAoa(notes, [["do not touch"]]);
  await Workbook.writeFile(wb, path.join(fx.root, name));
  return name;
}

async function reopen(fx: Fixture, name: string) {
  const wb = Workbook.create();
  await Workbook.readFile(wb, path.join(fx.root, name));
  return wb;
}

describe("sheet_edit — operations", () => {
  it("sets a single cell", async () => {
    const fx = await fixture();
    const file = await makeWorkbook(fx);
    await edit(fx, { path: file, ops: [{ op: "set_cell", ref: "B2", value: 99 }] });

    const wb = await reopen(fx, file);
    expect(Cell.getValue(Workbook.getWorksheet(wb, "Data")!, "B2")).toBe(99);
  });

  it("edits XLSB atomically and preserves formulas, styles and other sheets", async () => {
    const fx = await fixture();
    const file = await makeWorkbook(fx, "book.xlsb");
    await edit(fx, {
      path: file,
      ops: [
        { op: "set_cell", ref: "D1", value: "revenue" },
        { op: "set_formula", range: "D2:D4", formula: "=B2*C2" },
        { op: "set_style", range: "D2:D4", numFmt: "#,##0.00", bold: true }
      ]
    });

    const wb = await reopen(fx, file);
    const data = Workbook.getWorksheet(wb, "Data")!;
    expect(Cell.getFormula(data, "D2")).toBe("B2*C2");
    expect(Cell.getResult(data, "D2")).toBe(255);
    expect(Cell.getNumFmt(data, "D2")).toBe("#,##0.00");
    expect(Cell.getStyle(data, "D2").font?.bold).toBe(true);
    expect(Worksheet.toAoa(Workbook.getWorksheet(wb, "Notes")!)).toEqual([["do not touch"]]);
  });

  it("sets a range from row-major values", async () => {
    const fx = await fixture();
    const file = await makeWorkbook(fx);
    await edit(fx, {
      path: file,
      ops: [
        {
          op: "set_range",
          range: "B2:C3",
          rows: [
            [1, 2],
            [3, 4]
          ]
        }
      ]
    });

    const ws = Workbook.getWorksheet(await reopen(fx, file), "Data")!;
    expect([Cell.getValue(ws, "B2"), Cell.getValue(ws, "C2")]).toEqual([1, 2]);
    expect([Cell.getValue(ws, "B3"), Cell.getValue(ws, "C3")]).toEqual([3, 4]);
  });

  it("does not write values beyond the stated range", async () => {
    const fx = await fixture();
    const file = await makeWorkbook(fx);
    // More rows supplied than the range covers: the extras must be ignored
    // rather than spilling into row 4.
    await edit(fx, {
      path: file,
      ops: [{ op: "set_range", range: "B2:B2", rows: [[1], [2], [3]] }]
    });

    const ws = Workbook.getWorksheet(await reopen(fx, file), "Data")!;
    expect(Cell.getValue(ws, "B2")).toBe(1);
    expect(Cell.getValue(ws, "B3")).toBe(4);
  });

  it("sets a formula across a range and evaluates it", async () => {
    const fx = await fixture();
    const file = await makeWorkbook(fx);
    await edit(fx, {
      path: file,
      ops: [
        { op: "set_cell", ref: "D1", value: "revenue" },
        { op: "set_formula", range: "D2:D4", formula: "=B2*C2" }
      ]
    });

    const ws = Workbook.getWorksheet(await reopen(fx, file), "Data")!;
    // The formula is stored without the leading "=" and has a computed result.
    expect(Cell.getValue(ws, "D2")).toMatchObject({ result: 255 });
  });

  it("clears a range", async () => {
    const fx = await fixture();
    const file = await makeWorkbook(fx);
    await edit(fx, { path: file, ops: [{ op: "clear", range: "A4:C4" }] });

    const ws = Workbook.getWorksheet(await reopen(fx, file), "Data")!;
    expect(Cell.getValue(ws, "A4")).toBeNull();
  });

  it("inserts and deletes rows", async () => {
    const fx = await fixture();
    const file = await makeWorkbook(fx);
    await edit(fx, {
      path: file,
      ops: [{ op: "insert_rows", at: 2, rows: [["NEW", 1, 2]] }]
    });

    let ws = Workbook.getWorksheet(await reopen(fx, file), "Data")!;
    expect(Cell.getValue(ws, "A2")).toBe("NEW");
    expect(Cell.getValue(ws, "A3")).toBe("APAC");

    await edit(fx, { path: file, ops: [{ op: "delete_rows", at: 2, count: 1 }] });
    ws = Workbook.getWorksheet(await reopen(fx, file), "Data")!;
    expect(Cell.getValue(ws, "A2")).toBe("APAC");
  });

  it("restyles a range", async () => {
    const fx = await fixture();
    const file = await makeWorkbook(fx);
    await edit(fx, {
      path: file,
      ops: [
        { op: "set_style", range: "A1:C1", bold: true, fillColor: "FFEB3B" },
        { op: "set_style", range: "C2:C4", numFmt: "#,##0.00" }
      ]
    });

    const ws = Workbook.getWorksheet(await reopen(fx, file), "Data")!;
    expect(Cell.getStyle(ws, "A1").font?.bold).toBe(true);
    expect(Cell.getNumFmt(ws, "C2")).toBe("#,##0.00");
  });

  it("adds a sheet", async () => {
    const fx = await fixture();
    const file = await makeWorkbook(fx);
    await edit(fx, {
      path: file,
      ops: [{ op: "add_sheet", name: "Summary", rows: [["total"], [42]] }]
    });
    const wb = await reopen(fx, file);
    const names = Workbook.getWorksheets(wb).map(ws => Worksheet.getModel(ws).name);
    expect(names).toContain("Summary");
    expect(names).toContain("Notes");
    expect(Cell.getValue(Workbook.getWorksheet(wb, "Summary")!, "A2")).toBe(42);
  });

  it("leaves other sheets untouched", async () => {
    const fx = await fixture();
    const file = await makeWorkbook(fx);
    await edit(fx, { path: file, ops: [{ op: "set_cell", ref: "A1", value: "changed" }] });

    const ws = Workbook.getWorksheet(await reopen(fx, file), "Notes")!;
    expect(Worksheet.toAoa(ws)).toEqual([["do not touch"]]);
  });

  it("applies ops in order", async () => {
    const fx = await fixture();
    const file = await makeWorkbook(fx);
    await edit(fx, {
      path: file,
      ops: [
        { op: "set_cell", ref: "A1", value: "first" },
        { op: "set_cell", ref: "A1", value: "second" }
      ]
    });

    const ws = Workbook.getWorksheet(await reopen(fx, file), "Data")!;
    expect(Cell.getValue(ws, "A1")).toBe("second");
  });
});

describe("sheet_edit — safety", () => {
  it("dryRun writes nothing at all", async () => {
    const fx = await fixture();
    const file = await makeWorkbook(fx);
    const before = await readFile(path.join(fx.root, file));

    const report = await edit(fx, {
      path: file,
      ops: [{ op: "set_cell", ref: "A1", value: "changed" }],
      dryRun: true
    });

    expect(report).toContain("Dry run");
    expect(report).toContain('set A1 = "changed"');
    // Byte-identical, and no backup created either.
    expect(await readFile(path.join(fx.root, file))).toEqual(before);
    await expect(stat(path.join(fx.root, `${file}.bak`))).rejects.toThrow();
  });

  it("is atomic: a failing op leaves the file byte-identical", async () => {
    // The property that makes editing a real file acceptable at all.
    const fx = await fixture();
    const file = await makeWorkbook(fx);
    const before = await readFile(path.join(fx.root, file));

    await expect(
      sheetEditTool.handler(
        {
          path: file,
          ops: [
            { op: "set_cell", ref: "A1", value: "changed" },
            { op: "set_cell", ref: "not-a-ref", value: 1 }
          ]
        },
        { config: fx.config }
      )
    ).rejects.toThrow(/is not a cell address/);

    expect(await readFile(path.join(fx.root, file))).toEqual(before);
  });

  it("rejects a lossy XLSB edit and leaves no partial output", async () => {
    const fx = await fixture();
    await sheetWriteTool.handler(
      {
        path: "charted.xlsx",
        sheets: [
          {
            name: "Data",
            rows: [
              ["label", "value"],
              ["A", 1]
            ],
            charts: [{ type: "column", categories: "A2:A2", values: "B2:B2" }]
          }
        ]
      },
      { config: fx.config }
    );

    await expect(
      sheetEditTool.handler(
        {
          path: "charted.xlsx",
          out: "charted.xlsb",
          ops: [{ op: "set_cell", ref: "B2", value: 2 }]
        },
        { config: fx.config }
      )
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof McpToolError &&
        error.code === "unsupported" &&
        error.message.includes("without discarding unsupported workbook state"),
      "expected a strict XLSB fidelity error"
    );
    await expect(stat(path.join(fx.root, "charted.xlsb"))).rejects.toThrow();
  });

  it("takes a backup by default and can be told not to", async () => {
    const fx = await fixture();
    const file = await makeWorkbook(fx);

    await edit(fx, { path: file, ops: [{ op: "set_cell", ref: "A1", value: "v2" }] });
    const backup = Workbook.create();
    await Workbook.readFile(backup, path.join(fx.root, `${file}.bak`));
    expect(Cell.getValue(Workbook.getWorksheet(backup, "Data")!, "A1")).toBe("region");

    const other = await makeWorkbook(fx, "second.xlsx");
    await edit(fx, {
      path: other,
      ops: [{ op: "set_cell", ref: "A1", value: "v2" }],
      backup: false
    });
    await expect(stat(path.join(fx.root, "second.xlsx.bak"))).rejects.toThrow();
  });

  it("reports the sheet names when the target sheet is wrong", async () => {
    const fx = await fixture();
    const file = await makeWorkbook(fx);
    await expect(
      sheetEditTool.handler(
        { path: file, sheet: "Nope", ops: [{ op: "set_cell", ref: "A1", value: 1 }] },
        { config: fx.config }
      )
    ).rejects.toSatisfy(
      (error: unknown) => error instanceof McpToolError && (error.hint ?? "").includes('"Data"'),
      "expected the error to list existing sheets"
    );
  });

  it("refuses a duplicate sheet name", async () => {
    const fx = await fixture();
    const file = await makeWorkbook(fx);
    await expect(
      sheetEditTool.handler(
        { path: file, ops: [{ op: "add_sheet", name: "Notes" }] },
        { config: fx.config }
      )
    ).rejects.toThrow(/already exists/);
  });

  it("refuses an unbounded range instead of hanging", async () => {
    const fx = await fixture();
    const file = await makeWorkbook(fx);
    await expect(
      sheetEditTool.handler(
        { path: file, ops: [{ op: "clear", range: "A1:XFD100000" }] },
        { config: fx.config }
      )
    ).rejects.toSatisfy(
      (error: unknown) => error instanceof McpToolError && error.code === "too_large",
      "expected a too_large error"
    );
  });

  it("rejects a non-workbook", async () => {
    const fx = await fixture();
    await writeFile(path.join(fx.root, "fake.xlsx"), "nope", "utf8");
    await expect(
      sheetEditTool.handler(
        { path: "fake.xlsx", ops: [{ op: "set_cell", ref: "A1", value: 1 }] },
        { config: fx.config }
      )
    ).rejects.toThrow(/could not read fake\.xlsx as a workbook/);
  });

  it("is withheld under --readonly", async () => {
    const fx = await fixture(["--readonly"]);
    await expect(
      sheetEditTool.handler(
        { path: "book.xlsx", ops: [{ op: "set_cell", ref: "A1", value: 1 }] },
        { config: fx.config }
      )
    ).rejects.toSatisfy(
      (error: unknown) => error instanceof McpToolError && error.code === "readonly",
      "expected a readonly error"
    );
  });

  it("cannot edit outside the sandbox root", async () => {
    const fx = await fixture();
    await expect(
      sheetEditTool.handler(
        { path: "../escape.xlsx", ops: [{ op: "set_cell", ref: "A1", value: 1 }] },
        { config: fx.config }
      )
    ).rejects.toSatisfy(
      (error: unknown) => error instanceof McpToolError && error.code === "outside_root",
      "expected an outside_root error"
    );
  });
});

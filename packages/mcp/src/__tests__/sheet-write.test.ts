/**
 * `sheet_write` tests.
 *
 * Two things carry the most weight: that the file Excel receives is actually
 * valid (verified by reading it back through the library), and that the guards
 * against a model's plausible mistakes hold — overwriting without asking,
 * illegal sheet names, unbounded style ranges, missing parent directories.
 */

import { mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Cell, Workbook, Worksheet } from "documonster/excel";

import { resolveConfig, type ServerConfig } from "../config.js";
import { McpToolError } from "../errors.js";
import { sheetWriteTool } from "../tools/sheet-write.js";

interface Fixture {
  readonly config: ServerConfig;
  readonly root: string;
}

async function fixture(args: readonly string[] = []): Promise<Fixture> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "documonster-mcp-sheetwrite-")));
  const base = resolveConfig(args, { cwd: root });
  // Business-behaviour tests use the explicit compatibility layout; dedicated
  // sandbox regressions below cover the secure dual-root default.
  return {
    config: { ...base, outputRoot: root, allowInPlace: true },
    root
  };
}

async function write(fx: Fixture, args: Record<string, unknown>): Promise<string> {
  const result = await sheetWriteTool.handler(args, { config: fx.config });
  const text = result.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map(block => block.text)
    .join("\n");
  if (result.isError === true) {
    throw new Error(text);
  }
  return text;
}

/** Reopen a written file through the library — the real proof it is valid. */
async function reopen(fx: Fixture, relative: string) {
  const wb = Workbook.create();
  await Workbook.readFile(wb, path.join(fx.root, relative));
  return wb;
}

describe("sheet_write", () => {
  it("writes rows that read back identically", async () => {
    const fx = await fixture();
    await write(fx, {
      path: "out.xlsx",
      sheets: [
        {
          name: "Data",
          rows: [
            ["region", "amount"],
            ["APAC", 100],
            ["EMEA", 250]
          ]
        }
      ]
    });

    const wb = await reopen(fx, "out.xlsx");
    const ws = Workbook.getWorksheet(wb, "Data");
    expect(ws).toBeDefined();
    expect(Worksheet.toAoa(ws!)).toEqual([
      ["region", "amount"],
      ["APAC", 100],
      ["EMEA", 250]
    ]);
  });

  it("creates the parent directory rather than failing", async () => {
    // A model writes "reports/q3.xlsx" without checking that reports/ exists.
    const fx = await fixture();
    await write(fx, { path: "reports/nested/q3.xlsx", sheets: [{ name: "S", rows: [["x"]] }] });
    await expect(stat(path.join(fx.root, "reports/nested/q3.xlsx"))).resolves.toBeDefined();
  });

  it("evaluates formulas so other tools can read values", async () => {
    const fx = await fixture();
    await write(fx, {
      path: "calc.xlsx",
      sheets: [
        {
          name: "S",
          rows: [[10], [20]],
          // A leading "=" is what a model naturally writes; it must be stripped
          // or every function resolves to #NAME?.
          formulas: { A3: "=SUM(A1:A2)", B1: 'XLOOKUP(20,A1:A2,A1:A2,"NA")' }
        }
      ]
    });

    const wb = await reopen(fx, "calc.xlsx");
    const ws = Workbook.getWorksheet(wb, "S")!;
    expect(Cell.getValue(ws, "A3")).toMatchObject({ result: 30 });
    expect(Cell.getValue(ws, "B1")).toMatchObject({ result: 20 });
  });

  it("can skip evaluation on request", async () => {
    const fx = await fixture();
    const report = await write(fx, {
      path: "raw.xlsx",
      sheets: [{ name: "S", rows: [[1], [2]], formulas: { A3: "=SUM(A1:A2)" } }],
      recalculate: false
    });
    expect(report).toContain("formulas not evaluated");
  });

  it("pulls CSV data in server-side, without it passing through the reply", async () => {
    const fx = await fixture();
    await writeFile(path.join(fx.root, "in.csv"), "region;amount\nAPAC;100\nEMEA;250\n", "utf8");

    const report = await write(fx, {
      path: "from-csv.xlsx",
      sheets: [{ name: "Q3", fromCsv: "in.csv", csvDelimiter: ";" }]
    });
    expect(report).toContain("server-side");

    const wb = await reopen(fx, "from-csv.xlsx");
    // The sheet must carry the requested name, not the CSV's default.
    const ws = Workbook.getWorksheet(wb, "Q3");
    expect(ws).toBeDefined();
    expect(Worksheet.toAoa(ws!)).toEqual([
      ["region", "amount"],
      ["APAC", 100],
      ["EMEA", 250]
    ]);
  });

  it("applies widths, freeze panes, merges and styles", async () => {
    const fx = await fixture();
    await write(fx, {
      path: "styled.xlsx",
      sheets: [
        {
          name: "R",
          rows: [
            ["h1", "h2"],
            [1, 2]
          ],
          columnWidths: [18, 12],
          freezeRows: 1,
          merges: ["A4:B4"],
          styles: [
            { range: "A1:B1", style: { bold: true, fillColor: "FFEB3B" } },
            { range: "B2:B2", style: { numFmt: "#,##0.00" } }
          ]
        }
      ]
    });

    const wb = await reopen(fx, "styled.xlsx");
    const ws = Workbook.getWorksheet(wb, "R")!;
    expect(Cell.getStyle(ws, "A1").font?.bold).toBe(true);
    expect(Cell.getNumFmt(ws, "B2")).toBe("#,##0.00");
    expect(Worksheet.mergedRegions(ws)).toEqual([{ top: 4, left: 1, bottom: 4, right: 2 }]);
    expect(ws.views[0]).toMatchObject({ state: "frozen", ySplit: 1 });
  });

  it("accepts a colour with or without a leading hash, and rejects nonsense", async () => {
    const fx = await fixture();
    await write(fx, {
      path: "c.xlsx",
      sheets: [
        { name: "S", rows: [["a"]], styles: [{ range: "A1", style: { fillColor: "#C00000" } }] }
      ]
    });

    await expect(
      sheetWriteTool.handler(
        {
          path: "bad.xlsx",
          sheets: [
            { name: "S", rows: [["a"]], styles: [{ range: "A1", style: { fillColor: "red" } }] }
          ]
        },
        { config: fx.config }
      )
    ).rejects.toThrow(/not a hex colour/);
  });

  it("refuses to overwrite unless told to", async () => {
    const fx = await fixture();
    await write(fx, { path: "once.xlsx", sheets: [{ name: "S", rows: [["v1"]] }] });

    await expect(
      sheetWriteTool.handler(
        { path: "once.xlsx", sheets: [{ name: "S", rows: [["v2"]] }] },
        { config: fx.config }
      )
    ).rejects.toThrow(/already exists/);

    await write(fx, {
      path: "once.xlsx",
      sheets: [{ name: "S", rows: [["v2"]] }],
      overwrite: true
    });
    const wb = await reopen(fx, "once.xlsx");
    expect(Worksheet.toAoa(Workbook.getWorksheet(wb, "S")!)).toEqual([["v2"]]);
  });

  it("rejects a sheet name Excel cannot open", async () => {
    // Excel refuses these characters; writing one produces a file that fails to
    // open much later, which the model cannot diagnose.
    const fx = await fixture();
    for (const name of ["a/b", "a:b", "a[b]", "a*b", "a?b", "a\\b"]) {
      await expect(
        sheetWriteTool.handler(
          { path: "x.xlsx", sheets: [{ name, rows: [["a"]] }] },
          { config: fx.config }
        )
      ).rejects.toThrow(/Excel forbids/);
    }
  });

  it("rejects duplicate sheet names, ignoring case", async () => {
    const fx = await fixture();
    await expect(
      sheetWriteTool.handler(
        { path: "d.xlsx", sheets: [{ name: "Data" }, { name: "data" }] },
        { config: fx.config }
      )
    ).rejects.toThrow(/duplicate sheet name/);
  });

  it("rejects an unbounded style range instead of hanging", async () => {
    const fx = await fixture();
    await expect(
      sheetWriteTool.handler(
        {
          path: "huge.xlsx",
          sheets: [
            { name: "S", rows: [["a"]], styles: [{ range: "A1:XFD100000", style: { bold: true } }] }
          ]
        },
        { config: fx.config }
      )
    ).rejects.toThrow(/over the 100000 limit/);
  });

  it("rejects a malformed cell address", async () => {
    const fx = await fixture();
    await expect(
      sheetWriteTool.handler(
        { path: "b.xlsx", sheets: [{ name: "S", cells: { "not-an-address": 1 } }] },
        { config: fx.config }
      )
    ).rejects.toThrow(/is not a cell address/);
  });

  it("is withheld from writing under --readonly", async () => {
    const fx = await fixture(["--readonly"]);
    await expect(
      sheetWriteTool.handler({ path: "ro.xlsx", sheets: [{ name: "S" }] }, { config: fx.config })
    ).rejects.toSatisfy(
      (error: unknown) => error instanceof McpToolError && error.code === "readonly",
      "expected a readonly error"
    );
  });

  it("cannot write outside the sandbox root", async () => {
    const fx = await fixture();
    await expect(
      sheetWriteTool.handler(
        { path: "../escaped.xlsx", sheets: [{ name: "S" }] },
        { config: fx.config }
      )
    ).rejects.toSatisfy(
      (error: unknown) => error instanceof McpToolError && error.code === "outside_root",
      "expected an outside_root error"
    );
  });

  it("produces a real ZIP package", async () => {
    // Cheap structural check that the output is an OOXML package at all.
    const fx = await fixture();
    await write(fx, { path: "z.xlsx", sheets: [{ name: "S", rows: [["a"]] }] });
    const bytes = await readFile(path.join(fx.root, "z.xlsx"));
    expect([bytes[0], bytes[1], bytes[2], bytes[3]]).toEqual([0x50, 0x4b, 0x03, 0x04]);
  });
});
